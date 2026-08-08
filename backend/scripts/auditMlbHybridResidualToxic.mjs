/**
 * Hybrid 殘餘毒片：正式 Under 影子 + R1 之後，normal（及其他）還剩什麼毒
 *
 *   node scripts/auditMlbHybridResidualToxic.mjs
 * 產物: tmp-hybrid-residual-toxic.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import { getCachedMlbGameWeather } from '../src/services/MlbGameWeatherService.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import {
  classifyMlbTotalsHybridCandidate,
  MLB_TOTALS_SATELLITE_HYBRID_SPEC,
  MLB_TOTALS_SATELLITE_SPEC,
} from '../src/services/MlbTotalsSatellite.js';
import { config } from '../src/config.js';
import { applyTotalsFragileUnderShadow } from '../src/services/MlbTotalsFragileUnderShadow.js';
import { applyTotalsUnderBlowupGapToCandidate } from '../src/services/MlbTotalsUnderBlowupGapShadow.js';
import { applyTotalsUnderPitcherToCandidate } from '../src/services/MlbTotalsUnderPitcherShadow.js';
import { buildMlbLayeredDecision } from '../src/services/MlbLayeredArchitecture.js';
import { readStarterEras } from '../src/services/MlbGameShapeShadow.js';

const STAKE = 50;
const BASE = MLB_TOTALS_SATELLITE_SPEC.rules;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-08-07' },
];

function settle(side, line, total) {
  if (side === 'over') {
    if (total > line) return 'win';
    if (total < line) return 'loss';
    return 'push';
  }
  if (total < line) return 'win';
  if (total > line) return 'loss';
  return 'push';
}

function summarize(bets) {
  const settled = bets.filter((b) => b.result !== 'push');
  if (!settled.length) return { n: 0, hits: 0, hr: null, roi: null, usd: 0 };
  let unit = 0;
  let hits = 0;
  for (const b of settled) {
    if (b.result === 'win') {
      hits += 1;
      unit += b.odds - 1;
    } else unit -= 1;
  }
  const n = settled.length;
  return {
    n,
    hits,
    hr: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd: Math.round(unit * STAKE * 100) / 100,
  };
}

function yearOk(y) {
  return (
    (y?.['2024'] ?? -999) >= -80 &&
    (y?.['2025'] ?? -999) >= -80 &&
    (y?.['2026'] ?? -999) >= -80
  );
}

function byYearDelta(pool, keepFn) {
  return Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const base = summarize(pool.filter((b) => b.year === y));
      const after = summarize(pool.filter((b) => b.year === y && keepFn(b)));
      return [y, Number((after.usd - base.usd).toFixed(2))];
    })
  );
}

function bucketGap(g) {
  if (g == null || !Number.isFinite(g)) return 'na';
  if (g < 0.6) return 'gap_lt_0.6';
  if (g < 0.9) return 'gap_0.6_0.9';
  if (g < 1.25) return 'gap_0.9_1.25';
  return 'gap_ge_1.25';
}

function bucketLine(line) {
  if (line == null) return 'na';
  if (line <= 7) return 'line_le_7';
  if (line <= 8) return 'line_7_8';
  if (line <= 9) return 'line_8_9';
  return 'line_gt_9';
}

function bucketOdds(o) {
  if (o < 1.75) return 'odds_lt_175';
  if (o < 1.9) return 'odds_175_190';
  if (o < 2.05) return 'odds_190_205';
  return 'odds_ge_205';
}

function bucketEra(maxEra) {
  if (maxEra == null) return 'era_na';
  if (maxEra < 3.5) return 'era_lt_35';
  if (maxEra < 4.25) return 'era_35_425';
  if (maxEra < 5) return 'era_425_5';
  return 'era_ge_5';
}

function bestTotals(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return { totals: null, homeOdds: null };
  let best = null;
  let homeOdds = null;
  const homeTeam = pit.home_team;
  for (const book of pit.bookmakers) {
    const h2h = book.markets?.find((m) => m.key === 'h2h');
    if (h2h && homeTeam) {
      const home = h2h.outcomes?.find((o) => o.name === homeTeam);
      if (home?.price && (homeOdds == null || Number(home.price) < homeOdds)) {
        homeOdds = Number(home.price);
      }
    }
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
      if (overOdds < BASE.pickOddsMin || underOdds < BASE.pickOddsMin) continue;
      if (overOdds > BASE.pickOddsMax || underOdds > BASE.pickOddsMax) continue;
      const vig = 1 / overOdds + 1 / underOdds;
      const fair = removeVig(
        decimalToImpliedProb(overOdds),
        decimalToImpliedProb(underOdds)
      );
      const cand = {
        line: Number(over.point),
        overOdds,
        underOdds,
        fairOver: fair.fairA,
        fairUnder: fair.fairB,
        vig,
      };
      if (!best || vig < best.vig) best = cand;
    }
  }
  return { totals: best, homeOdds };
}

function sliceBy(pool, keyFn) {
  const map = new Map();
  for (const b of pool) {
    const k = keyFn(b);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(b);
  }
  return [...map.entries()]
    .map(([key, rows]) => ({ key, ...summarize(rows) }))
    .sort((a, b) => (a.roi ?? 9) - (b.roi ?? 9) || (b.n || 0) - (a.n || 0));
}

console.log('[hybrid-residual] build…');
const model = getLatestMlbExpectedRunsValidation()?.model;
if (!model) {
  console.error('missing model');
  process.exit(1);
}

const residual = [];

for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
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
    features.parkFactor = resolveMlbParkFactor({
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    features.weather = getCachedMlbGameWeather(row.gameId)?.weather || null;
    const { totals, homeOdds } = bestTotals(row.gameId, row.commenceTime);
    if (!totals) continue;
    const pred = predictMlbGameRuns(model, features, { totalLine: totals.line });
    let cls = classifyMlbTotalsHybridCandidate({
      prediction: pred,
      totalsMarket: totals,
      parkFactor: features.parkFactor,
      spec: {
        ...MLB_TOTALS_SATELLITE_HYBRID_SPEC,
        rawOverMaxAbsGap: config.mlbTotalsRawOverMaxAbsGap,
      },
    });
    cls = applyTotalsFragileUnderShadow(cls, features);
    cls = applyTotalsUnderBlowupGapToCandidate(cls, features);
    cls = applyTotalsUnderPitcherToCandidate(cls);
    if (cls.tier !== 'actionable' || !cls.side) continue;

    const layered = buildMlbLayeredDecision({
      features,
      totalsLine: cls.line,
      homeOdds,
      gameId: row.gameId,
    });
    if (cls.side === 'over' && layered.route.bans.includes('totals_over')) continue;

    const total = +row.homeScore + +row.awayScore;
    const odds = cls.side === 'over' ? totals.overOdds : totals.underOdds;
    const eras = readStarterEras(features);
    const maxEra =
      eras.homeEra != null && eras.awayEra != null
        ? Math.max(eras.homeEra, eras.awayEra)
        : eras.homeEra ?? eras.awayEra ?? null;
    const pf = Number(features.parkFactor);

    residual.push({
      year: w.key,
      month: String(row.commenceTime).slice(0, 7),
      side: cls.side,
      odds,
      result: settle(cls.side, cls.line, total),
      type: layered.gameType.type,
      line: cls.line,
      absGap: Number(cls.absGap),
      hybridPath: cls.hybridPath || 'unknown',
      parkBucket: cls.parkBucket || (pf < 0.97 ? 'pitcher' : pf > 1.03 ? 'hitter' : 'mid'),
      parkFactor: Number.isFinite(pf) ? pf : null,
      maxEra,
      gapBucket: bucketGap(Number(cls.absGap)),
      lineBucket: bucketLine(cls.line),
      oddsBucket: bucketOdds(odds),
      eraBucket: bucketEra(maxEra),
    });
  }
}

const base = summarize(residual);
const normal = residual.filter((b) => b.type === 'normal');
const normalBase = summarize(normal);

const dims = {
  byType: sliceBy(residual, (b) => b.type),
  bySide: sliceBy(residual, (b) => b.side),
  byPath: sliceBy(residual, (b) => b.hybridPath),
  byPark: sliceBy(residual, (b) => b.parkBucket),
  byGap: sliceBy(residual, (b) => b.gapBucket),
  byLine: sliceBy(residual, (b) => b.lineBucket),
  byOdds: sliceBy(residual, (b) => b.oddsBucket),
  byEra: sliceBy(residual, (b) => b.eraBucket),
  normalBySide: sliceBy(normal, (b) => b.side),
  normalByPath: sliceBy(normal, (b) => b.hybridPath),
  normalByPark: sliceBy(normal, (b) => b.parkBucket),
  normalByGap: sliceBy(normal, (b) => b.gapBucket),
  normalByLine: sliceBy(normal, (b) => b.lineBucket),
  normalByOdds: sliceBy(normal, (b) => b.oddsBucket),
  normalByEra: sliceBy(normal, (b) => b.eraBucket),
  normalSidePath: sliceBy(normal, (b) => `${b.side}|${b.hybridPath}`),
  normalSidePark: sliceBy(normal, (b) => `${b.side}|${b.parkBucket}`),
  normalSideGap: sliceBy(normal, (b) => `${b.side}|${b.gapBucket}`),
  normalOverLine: sliceBy(
    normal.filter((b) => b.side === 'over'),
    (b) => b.lineBucket
  ),
  normalUnderLine: sliceBy(
    normal.filter((b) => b.side === 'under'),
    (b) => b.lineBucket
  ),
};

function toxicFrom(slices, minN = 12) {
  return slices
    .filter((s) => s.n >= minN && (s.roi ?? 1) < 0)
    .sort((a, b) => (a.usd ?? 0) - (b.usd ?? 0));
}

const toxicCandidates = [
  ...toxicFrom(dims.normalSidePath).map((s) => ({ dim: 'normalSidePath', ...s })),
  ...toxicFrom(dims.normalSidePark).map((s) => ({ dim: 'normalSidePark', ...s })),
  ...toxicFrom(dims.normalSideGap).map((s) => ({ dim: 'normalSideGap', ...s })),
  ...toxicFrom(dims.normalByLine).map((s) => ({ dim: 'normalByLine', ...s })),
  ...toxicFrom(dims.normalByOdds).map((s) => ({ dim: 'normalByOdds', ...s })),
  ...toxicFrom(dims.normalByEra).map((s) => ({ dim: 'normalByEra', ...s })),
  ...toxicFrom(dims.normalOverLine).map((s) => ({ dim: 'normalOverLine', ...s })),
  ...toxicFrom(dims.normalUnderLine).map((s) => ({ dim: 'normalUnderLine', ...s })),
  ...toxicFrom(dims.byPath).map((s) => ({ dim: 'allByPath', ...s })),
  ...toxicFrom(dims.byPark).map((s) => ({ dim: 'allByPark', ...s })),
].sort((a, b) => (a.usd ?? 0) - (b.usd ?? 0));

/** 把毒切片 key 轉成 keepFn，在 residual 池上試砍 */
function makeCutFn(dim, key) {
  if (dim === 'normalSidePath') {
    return (b) => !(b.type === 'normal' && `${b.side}|${b.hybridPath}` === key);
  }
  if (dim === 'normalSidePark') {
    return (b) => !(b.type === 'normal' && `${b.side}|${b.parkBucket}` === key);
  }
  if (dim === 'normalSideGap') {
    return (b) => !(b.type === 'normal' && `${b.side}|${b.gapBucket}` === key);
  }
  if (dim === 'normalByLine') {
    return (b) => !(b.type === 'normal' && b.lineBucket === key);
  }
  if (dim === 'normalByOdds') {
    return (b) => !(b.type === 'normal' && b.oddsBucket === key);
  }
  if (dim === 'normalByEra') {
    return (b) => !(b.type === 'normal' && b.eraBucket === key);
  }
  if (dim === 'normalOverLine') {
    return (b) => !(b.type === 'normal' && b.side === 'over' && b.lineBucket === key);
  }
  if (dim === 'normalUnderLine') {
    return (b) => !(b.type === 'normal' && b.side === 'under' && b.lineBucket === key);
  }
  if (dim === 'allByPath') {
    return (b) => b.hybridPath !== key;
  }
  if (dim === 'allByPark') {
    return (b) => b.parkBucket !== key;
  }
  return () => true;
}

const routeTrials = [];
const seen = new Set();
for (const cand of toxicCandidates.slice(0, 20)) {
  const id = `${cand.dim}::${cand.key}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const keep = makeCutFn(cand.dim, cand.key);
  const after = summarize(residual.filter(keep));
  const cut = summarize(residual.filter((b) => !keep(b)));
  const dUsd = Number((after.usd - base.usd).toFixed(2));
  const dHrPp =
    after.hr != null && base.hr != null
      ? Number(((after.hr - base.hr) * 100).toFixed(2))
      : null;
  const byYear = byYearDelta(residual, keep);
  routeTrials.push({
    id,
    dim: cand.dim,
    key: cand.key,
    cut,
    after,
    dUsd,
    dHrPp,
    byYearDeltaUsd: byYear,
    gatePassed:
      dUsd >= 0 &&
      (dHrPp ?? -1) >= -0.2 &&
      yearOk(byYear) &&
      cut.n >= 8,
  });
}
routeTrials.sort((a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999));

const promote = routeTrials.filter((r) => r.gatePassed);
const bestEvenIfFail = routeTrials[0] || null;

const out = {
  experimentId: 'hybrid-residual-toxic-2026-08-08',
  plain:
    '底座＝正式 Under 影子 + R1 禁對決 Over 之後的殘餘池；掃描 normal 毒片並試硬切門禁。',
  residualBase: base,
  normalBase,
  typeMix: Object.fromEntries(dims.byType.map((s) => [s.key, s.n])),
  dims: {
    byType: dims.byType,
    bySide: dims.bySide,
    byPath: dims.byPath,
    normalBySide: dims.normalBySide,
    normalByPath: dims.normalByPath,
    normalSidePath: dims.normalSidePath,
    normalSidePark: dims.normalSidePark,
    normalSideGap: dims.normalSideGap,
    normalOverLine: dims.normalOverLine,
    normalUnderLine: dims.normalUnderLine,
  },
  toxicCandidates: toxicCandidates.slice(0, 15),
  routeTrialsTop: routeTrials.slice(0, 12),
  promote,
  bestEvenIfFail,
  verdict:
    promote.length > 0
      ? 'FOUND_COMPARE_CANDIDATE'
      : toxicCandidates.length === 0
        ? 'NO_LARGE_TOXIC_SLICE'
        : 'TOXIC_SEEN_BUT_YEAR_GATE_FAIL',
};

fs.writeFileSync(
  new URL('../tmp-hybrid-residual-toxic.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log(
  JSON.stringify(
    {
      residualBase: base,
      normalBase,
      typeMix: out.typeMix,
      toxicTop: toxicCandidates.slice(0, 8),
      promote: promote.map((p) => ({
        id: p.id,
        dUsd: p.dUsd,
        dHrPp: p.dHrPp,
        cutN: p.cut.n,
        cutHr: p.cut.hr,
        byYear: p.byYearDeltaUsd,
      })),
      bestEvenIfFail: bestEvenIfFail
        ? {
            id: bestEvenIfFail.id,
            dUsd: bestEvenIfFail.dUsd,
            dHrPp: bestEvenIfFail.dHrPp,
            cutN: bestEvenIfFail.cut.n,
            cutHr: bestEvenIfFail.cut.hr,
            byYear: bestEvenIfFail.byYearDeltaUsd,
            passed: bestEvenIfFail.gatePassed,
          }
        : null,
      verdict: out.verdict,
    },
    null,
    2
  )
);
console.log('wrote tmp-hybrid-residual-toxic.json');
