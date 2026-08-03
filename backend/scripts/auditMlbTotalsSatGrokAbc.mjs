/**
 * Grok 建議：大小分衛星實驗 A（溫度校準）/ B（gap·edge 網格）/ C（分桶診斷）
 * 不動鎖定 B。產物：tmp-totals-sat-grok-abc.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import { getCachedMlbGameWeather } from '../src/services/MlbGameWeatherService.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  applyProbabilityTemperature,
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { MLB_TOTALS_SATELLITE_SPEC } from '../src/services/MlbTotalsSatellite.js';

const BASE = MLB_TOTALS_SATELLITE_SPEC.rules;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-28' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function bestTotals(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'totals');
    if (!market) continue;
    for (const over of market.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = market.outcomes.find(
        (o) => o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!over.price || !under?.price) continue;
      const overOdds = Number(over.price);
      const underOdds = Number(under.price);
      if (overOdds < 1.5 || underOdds < 1.5 || overOdds > 2.4 || underOdds > 2.4) continue;
      const vig = 1 / overOdds + 1 / underOdds;
      if (!best || vig < best.vig) {
        const fair = removeVig(decimalToImpliedProb(overOdds), decimalToImpliedProb(underOdds));
        best = {
          line: Number(over.point),
          overOdds,
          underOdds,
          fairOver: fair.fairA,
          fairUnder: fair.fairB,
          vig,
        };
      }
    }
  }
  return best;
}

function summarize(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, roi: null, usd50: 0 };
  let unit = 0;
  let hits = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  return {
    bets: bets.length,
    hitRate: Number((hits / bets.length).toFixed(4)),
    roi: Number((unit / bets.length).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}

function byYear(bets) {
  const out = {};
  for (const y of ['2024', '2025', '2026']) {
    out[y] = summarize(bets.filter((b) => b.year === y));
  }
  out.merged = summarize(bets);
  return out;
}

function buildUniverse(model) {
  const all = [];
  for (const w of WINDOWS) {
    const rows = db
      .prepare(
        `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
                g.home_team AS homeTeam, g.away_team AS awayTeam,
                g.home_score AS homeScore, g.away_score AS awayScore
         FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
         WHERE f.feature_version = ? AND g.completed = 1
           AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
           AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
         ORDER BY f.commence_time`
      )
      .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);

    for (const row of rows) {
      let features;
      try {
        features = JSON.parse(row.featuresJson);
      } catch {
        continue;
      }
      const actualTotal = Number(row.homeScore) + Number(row.awayScore);
      features.parkFactor = resolveMlbParkFactor({
        venueName: features.venueName,
        homeTeam: row.homeTeam,
      });
      features.weather = getCachedMlbGameWeather({
        gameId: row.gameId,
        commenceTime: row.commenceTime,
        venueName: features.venueName,
        homeTeam: row.homeTeam,
      });
      const market = bestTotals(row.gameId, row.commenceTime);
      if (!market || actualTotal === market.line) continue;

      const pred = predictMlbGameRuns(model, features, { totalLine: market.line });
      const expectedTotal = Number(pred.expectedTotal);
      const pushP = Number(pred.markets?.total?.pushProbability) || 0;
      const overRaw = Number(pred.markets?.total?.overProbability);
      const underRaw = Number(pred.markets?.total?.underProbability);
      if (!Number.isFinite(expectedTotal) || !Number.isFinite(overRaw)) continue;
      const overProb = overRaw / Math.max(1e-9, 1 - pushP);
      const underProb = underRaw / Math.max(1e-9, 1 - pushP);
      const gap = expectedTotal - market.line;
      const park = Number(features.parkFactor) || 1;
      const month = hk(row.commenceTime).slice(0, 7);

      all.push({
        year: w.key,
        month,
        day: hk(row.commenceTime),
        line: market.line,
        expectedTotal,
        absGap: Math.abs(gap),
        gap,
        overProb,
        underProb,
        overOdds: market.overOdds,
        underOdds: market.underOdds,
        fairOver: market.fairOver,
        fairUnder: market.fairUnder,
        park,
        isCoors: park >= 1.15,
        actualOver: actualTotal > market.line,
      });
    }
    console.log(`  ${w.key}: universe+=${all.filter((x) => x.year === w.key).length}`);
  }
  return all;
}

/** 用 overProb vs actualOver 擬合溫度（T≥1），校準集=2024+2025 */
function fitOverTemperature(rows, temperatures = [1, 1.05, 1.1, 1.15, 1.25, 1.35, 1.5, 1.75, 2]) {
  const points = rows.map((r) => ({ p: r.overProb, y: r.actualOver ? 1 : 0 }));
  let bestT = 1;
  let bestBrier = Infinity;
  const scored = [];
  for (const t of temperatures) {
    let brier = 0;
    for (const pt of points) {
      const p = applyProbabilityTemperature(pt.p, t);
      brier += (p - pt.y) ** 2;
    }
    brier /= Math.max(1, points.length);
    scored.push({ t, brier: Number(brier.toFixed(6)) });
    if (brier < bestBrier - 1e-12 || (Math.abs(brier - bestBrier) <= 1e-12 && t < bestT)) {
      bestBrier = brier;
      bestT = t;
    }
  }
  // reliability buckets on raw vs bestT
  function buckets(temp) {
    const bins = [
      { key: '0.45-0.50', lo: 0.45, hi: 0.5 },
      { key: '0.50-0.55', lo: 0.5, hi: 0.55 },
      { key: '0.55-0.60', lo: 0.55, hi: 0.6 },
      { key: '0.60-0.65', lo: 0.6, hi: 0.65 },
      { key: '0.65+', lo: 0.65, hi: 1.01 },
    ];
    return bins.map((b) => {
      const hit = points.filter((pt) => {
        const p = applyProbabilityTemperature(pt.p, temp);
        return p >= b.lo && p < b.hi;
      });
      if (!hit.length) return { ...b, n: 0, avgP: null, actual: null };
      const avgP =
        hit.reduce((s, pt) => s + applyProbabilityTemperature(pt.p, temp), 0) / hit.length;
      const actual = hit.reduce((s, pt) => s + pt.y, 0) / hit.length;
      return {
        ...b,
        n: hit.length,
        avgP: Number(avgP.toFixed(3)),
        actual: Number(actual.toFixed(3)),
        gap: Number((avgP - actual).toFixed(3)),
      };
    });
  }
  return {
    fitOn: '2024+2025',
    n: points.length,
    rawBrier: scored.find((s) => s.t === 1)?.brier,
    bestTemperature: bestT,
    bestBrier: Number(bestBrier.toFixed(6)),
    grid: scored,
    reliabilityRaw: buckets(1),
    reliabilityBestT: buckets(bestT),
  };
}

function selectBets(universe, { minGap, minEv, minEdge, minProb, maxLine, temperature = 1 }) {
  const out = [];
  for (const g of universe) {
    const overP = applyProbabilityTemperature(g.overProb, temperature);
    const underP = 1 - overP; // after decisive renormalization already; keep complementary for side pick
    // 定邊仍用 raw mean gap（結構訊號），機率用校準後
    const pickOver = g.gap > 0;
    if (pickOver && overP < 0.5) continue;
    if (!pickOver && underP < 0.5) continue;
    const modelProb = pickOver ? overP : underP;
    const pickOdds = pickOver ? g.overOdds : g.underOdds;
    const fair = pickOver ? g.fairOver : g.fairUnder;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const edge = modelProb - fair;
    if (g.absGap < minGap) continue;
    if (ev < minEv) continue;
    if (edge < minEdge) continue;
    if (modelProb < minProb) continue;
    if (g.line > maxLine) continue;
    out.push({
      year: g.year,
      month: g.month,
      side: pickOver ? 'over' : 'under',
      line: g.line,
      park: g.park,
      isCoors: g.isCoors,
      pickOdds,
      modelProb,
      ev,
      edge,
      absGap: g.absGap,
      hit: pickOver === g.actualOver,
    });
  }
  return out;
}

function holdout2026(bets) {
  const test = bets.filter((b) => b.year === '2026' && (b.month === '2026-06' || b.month === '2026-07'));
  return summarize(test);
}

function expandingWfProxy(bets) {
  // 粗代理：2024→測2025；2024+2025→測2026（規則固定，非重擬合）
  return {
    fold_2025: summarize(bets.filter((b) => b.year === '2025')),
    fold_2026: summarize(bets.filter((b) => b.year === '2026')),
  };
}

function promoteCheck(byY, holdout) {
  const y24 = byY['2024'];
  const y25 = byY['2025'];
  const y26 = byY['2026'];
  const merged = byY.merged;
  const allRoiGe0 =
    (y24.roi ?? -1) >= 0 && (y25.roi ?? -1) >= 0 && (y26.roi ?? -1) >= 0;
  const mergedGe3 = (merged.roi ?? -1) >= 0.03;
  const nOk = y24.bets >= 200 && y25.bets >= 200 && y26.bets >= 200;
  const holdok = (holdout.roi ?? -1) >= 0.05;
  return {
    allRoiGe0,
    mergedGe3,
    nOk,
    holdout2026JunJulGe5: holdok,
    promoteQuasiFormal: allRoiGe0 && mergedGe3 && nOk && holdok,
    detail: { y24, y25, y26, merged, holdout },
  };
}

const latest = getLatestMlbExpectedRunsValidation();
console.log('[grok-abc] building universe…');
const universe = buildUniverse(latest.model);
console.log('universe', universe.length);

// ——— C：現行規則分桶診斷 ———
const currentBets = selectBets(universe, {
  minGap: BASE.minAbsGap,
  minEv: BASE.minimumExpectedValue,
  minEdge: BASE.minEdgeVsMarket,
  minProb: BASE.minimumModelProbability,
  maxLine: BASE.maxTotalLine,
  temperature: 1,
});

function bucketDiag(bets, keyFn, keys) {
  return Object.fromEntries(
    keys.map((k) => [k, summarize(bets.filter((b) => keyFn(b) === k))])
  );
}

const experimentC = {
  note: '只診斷，不改選注',
  onCurrentRule: {
    byLine: bucketDiag(
      currentBets,
      (b) => (b.line <= 8.5 ? '≤8.5' : b.line <= 10 ? '9-10' : '≥10.5'),
      ['≤8.5', '9-10', '≥10.5']
    ),
    // 現行已砍 >10，≥10.5 應接近空；另報未砍 maxLine 的宇宙對照
    byCoors: bucketDiag(currentBets, (b) => (b.isCoors ? 'coorsish' : 'other'), [
      'coorsish',
      'other',
    ]),
    byYearAndLine: Object.fromEntries(
      ['2024', '2025', '2026'].map((y) => [
        y,
        bucketDiag(
          currentBets.filter((b) => b.year === y),
          (b) => (b.line <= 8.5 ? '≤8.5' : '9-10'),
          ['≤8.5', '9-10']
        ),
      ])
    ),
  },
  // 若放寬到無 maxLine，高分盤表現
  ifNoMaxLine: (() => {
    const loose = selectBets(universe, {
      minGap: BASE.minAbsGap,
      minEv: BASE.minimumExpectedValue,
      minEdge: BASE.minEdgeVsMarket,
      minProb: BASE.minimumModelProbability,
      maxLine: 99,
      temperature: 1,
    });
    return {
      byLine: bucketDiag(
        loose,
        (b) => (b.line <= 8.5 ? '≤8.5' : b.line <= 10 ? '9-10' : '≥10.5'),
        ['≤8.5', '9-10', '≥10.5']
      ),
      highLineOnly: summarize(loose.filter((b) => b.line > 10)),
    };
  })(),
};

// ——— A：校準 ———
const fitRows = universe.filter((r) => r.year === '2024' || r.year === '2025');
const calib = fitOverTemperature(fitRows);
const tempsToTry = [...new Set([1, calib.bestTemperature, 1.1, 1.25, 1.5].filter(Boolean))].sort(
  (a, b) => a - b
);

const experimentA = {
  calibration: calib,
  variants: tempsToTry.map((t) => {
    const bets = selectBets(universe, {
      minGap: BASE.minAbsGap,
      minEv: BASE.minimumExpectedValue,
      minEdge: BASE.minEdgeVsMarket,
      minProb: BASE.minimumModelProbability,
      maxLine: BASE.maxTotalLine,
      temperature: t,
    });
    const y = byYear(bets);
    const hold = holdout2026(bets);
    return {
      id: `temp_${t}`,
      temperature: t,
      byYear: y,
      holdout2026JunJul: hold,
      wfProxy: expandingWfProxy(bets),
      promote: promoteCheck(y, hold),
      deltaMergedRoiVsT1: Number(((y.merged.roi ?? 0) - (byYear(currentBets).merged.roi ?? 0)).toFixed(4)),
      deltaY24Roi: Number(((y['2024'].roi ?? 0) - (byYear(currentBets)['2024'].roi ?? 0)).toFixed(4)),
      deltaY25Roi: Number(((y['2025'].roi ?? 0) - (byYear(currentBets)['2025'].roi ?? 0)).toFixed(4)),
      deltaY26Roi: Number(((y['2026'].roi ?? 0) - (byYear(currentBets)['2026'].roi ?? 0)).toFixed(4)),
    };
  }),
};

// ——— B：小網格（T=1 與 bestT 各一輪） ———
const GAPS = [0.4, 0.5, 0.6, 0.7];
const EDGES = [0.03, 0.04, 0.05, 0.06];
const EVS = [0.02, 0.03];
const gridTemps = [1, calib.bestTemperature];

const gridRows = [];
for (const temperature of gridTemps) {
  for (const minGap of GAPS) {
    for (const minEdge of EDGES) {
      for (const minEv of EVS) {
        const bets = selectBets(universe, {
          minGap,
          minEv,
          minEdge,
          minProb: BASE.minimumModelProbability,
          maxLine: BASE.maxTotalLine,
          temperature,
        });
        const y = byYear(bets);
        const hold = holdout2026(bets);
        const base = byYear(currentBets);
        const improveThin =
          (y['2024'].roi ?? -1) > (base['2024'].roi ?? 0) &&
          (y['2025'].roi ?? -1) > (base['2025'].roi ?? 0);
        const y26Ok = (y['2026'].roi ?? -1) >= 0.02;
        gridRows.push({
          id: `T${temperature}_g${minGap}_e${minEdge}_ev${minEv}`,
          temperature,
          minGap,
          minEdge,
          minEv,
          byYear: y,
          holdout2026JunJul: hold,
          promote: promoteCheck(y, hold),
          improveThinYears: improveThin,
          y26RoiGe2: y26Ok,
          passGrokB:
            improveThin &&
            y26Ok &&
            (y['2024'].roi ?? -1) >= 0 &&
            (y['2025'].roi ?? -1) >= 0 &&
            (y.merged.roi ?? -1) >= (base.merged.roi ?? 0),
        });
      }
    }
  }
}

gridRows.sort((a, b) => (b.byYear.merged.usd50 || 0) - (a.byYear.merged.usd50 || 0));
const passB = gridRows.filter((r) => r.passGrokB);
const promoteAny = gridRows.filter((r) => r.promote.promoteQuasiFormal);

const baseline = {
  id: 'current_sat',
  byYear: byYear(currentBets),
  holdout2026JunJul: holdout2026(currentBets),
  promote: promoteCheck(byYear(currentBets), holdout2026(currentBets)),
};

const bestA = [...experimentA.variants].sort(
  (a, b) =>
    Number(b.promote.promoteQuasiFormal) - Number(a.promote.promoteQuasiFormal) ||
    (b.byYear['2024'].roi ?? -1) + (b.byYear['2025'].roi ?? -1) -
      ((a.byYear['2024'].roi ?? -1) + (a.byYear['2025'].roi ?? -1))
)[0];

const bestB = passB[0] || gridRows.find((r) => r.improveThinYears && r.y26RoiGe2) || null;

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'shadow_research_grok_abc',
  baseline,
  experimentA,
  experimentB: {
    gridSize: gridRows.length,
    passGrokBCount: passB.length,
    promoteQuasiFormalCount: promoteAny.length,
    topByMergedUsd: gridRows.slice(0, 12),
    passGrokB: passB.slice(0, 8),
    best: bestB,
  },
  experimentC,
  verdict: {
    changeShadowSpec: Boolean(
      bestB?.passGrokB ||
        (bestA &&
          bestA.temperature !== 1 &&
          (bestA.byYear['2024'].roi ?? -1) >= 0.02 &&
          (bestA.byYear['2025'].roi ?? -1) >= 0.02 &&
          (bestA.byYear['2026'].roi ?? -1) >= 0.03)
    ),
    promoteQuasiFormal: Boolean(promoteAny[0] || bestA?.promote?.promoteQuasiFormal),
    recommendedNext: null,
    notes: [],
  },
};

if (bestB?.passGrokB) {
  payload.verdict.recommendedNext = {
    action: 'update_shadow_gates',
    from: bestB.id,
    rules: {
      minAbsGap: bestB.minGap,
      minimumExpectedValue: bestB.minEv,
      minEdgeVsMarket: bestB.minEdge,
      temperature: bestB.temperature,
      maxTotalLine: 10,
    },
  };
  payload.verdict.notes.push('實驗 B 找到抬薄年且 2026 不崩的參數組');
} else if (bestA && bestA.temperature !== 1 && (bestA.deltaY24Roi > 0 || bestA.deltaY25Roi > 0)) {
  payload.verdict.recommendedNext = {
    action: 'consider_temperature_only',
    temperature: bestA.temperature,
    byYear: bestA.byYear,
  };
  payload.verdict.notes.push('校準有幫助但未達準正式；可影子觀察 T');
} else {
  payload.verdict.recommendedNext = { action: 'keep_current_shadow' };
  payload.verdict.notes.push('A/B 未穩定抬 2024/2025；維持現行衛星，繼續活體觀察');
}

if (experimentC.ifNoMaxLine.highLineOnly.roi != null) {
  payload.verdict.notes.push(
    `無 maxLine 時高分盤(>10) n=${experimentC.ifNoMaxLine.highLineOnly.bets} roi=${experimentC.ifNoMaxLine.highLineOnly.roi}`
  );
}

fs.writeFileSync(
  new URL('../tmp-totals-sat-grok-abc.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);

console.log('BASELINE', baseline.byYear, 'hold', baseline.holdout2026JunJul);
console.log('CALIB', { bestT: calib.bestTemperature, rawBrier: calib.rawBrier, bestBrier: calib.bestBrier });
for (const v of experimentA.variants) {
  console.log(
    `A ${v.id}: y24=${v.byYear['2024'].roi} y25=${v.byYear['2025'].roi} y26=${v.byYear['2026'].roi} m=${v.byYear.merged.roi} hold=${v.holdout2026JunJul.roi} promote=${v.promote.promoteQuasiFormal}`
  );
}
console.log('B pass', passB.length, 'best', bestB?.id, bestB?.byYear);
console.log('C highLine', experimentC.ifNoMaxLine.highLineOnly);
console.log('C byLine current', experimentC.onCurrentRule.byLine);
console.log('VERDICT', payload.verdict);
