/**
 * 大小分衛星下一刀：在已盈利底座上再挖（24/25/26）
 * both vs under-only vs 日 TopK；不碰鎖定 B
 *
 * 用法: node scripts/auditMlbTotalsSatNextKnifeProfit.mjs
 * 產物: tmp-totals-sat-next-knife-profit.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import { getCachedMlbGameWeather } from '../src/services/MlbGameWeatherService.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { MLB_TOTALS_SATELLITE_SPEC } from '../src/services/MlbTotalsSatellite.js';

const R = MLB_TOTALS_SATELLITE_SPEC.rules;
const STAKE = 50;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
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
      if (overOdds < R.pickOddsMin || underOdds < R.pickOddsMin) continue;
      if (overOdds > R.pickOddsMax || underOdds > R.pickOddsMax) continue;
      const vig = 1 / overOdds + 1 / underOdds;
      if (!best || vig < best.vig) {
        const fair = removeVig(
          decimalToImpliedProb(overOdds),
          decimalToImpliedProb(underOdds)
        );
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
  if (!bets.length) {
    return { bets: 0, hits: 0, hitRate: null, roi: null, usd50: 0 };
  }
  let unit = 0;
  let hits = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hits,
    hitRate: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
  };
}

function byYear(bets) {
  const out = {};
  for (const y of ['2024', '2025', '2026']) {
    out[y] = summarize(bets.filter((b) => b.year === y));
  }
  return out;
}

function buildAll(model) {
  const all = [];
  for (const w of WINDOWS) {
    const rows = db
      .prepare(
        `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
                g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS hs, g.away_score AS ascore
         FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
         WHERE f.feature_version = ? AND g.completed = 1
           AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
           AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)`
      )
      .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);

    for (const row of rows) {
      let features;
      try {
        features = JSON.parse(row.featuresJson);
      } catch {
        continue;
      }
      const actualTotal = Number(row.hs) + Number(row.ascore);
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
      const overProb =
        Number(pred.markets?.total?.overProbability) / Math.max(1e-9, 1 - pushP);
      const underProb =
        Number(pred.markets?.total?.underProbability) / Math.max(1e-9, 1 - pushP);
      const gap = expectedTotal - market.line;
      const pickOver = gap > 0;
      if (pickOver && overProb < 0.5) continue;
      if (!pickOver && underProb < 0.5) continue;
      const modelProb = pickOver ? overProb : underProb;
      const pickOdds = pickOver ? market.overOdds : market.underOdds;
      const fair = pickOver ? market.fairOver : market.fairUnder;
      const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
      const edge = modelProb - fair;
      if (Math.abs(gap) < R.minAbsGap) continue;
      if (ev < R.minimumExpectedValue) continue;
      if (edge < R.minEdgeVsMarket) continue;
      if (modelProb < R.minimumModelProbability) continue;
      if (market.line > R.maxTotalLine) continue;
      all.push({
        gameId: row.gameId,
        year: w.key,
        day: hk(row.commenceTime),
        side: pickOver ? 'over' : 'under',
        pickOdds,
        ev,
        absGap: Math.abs(gap),
        hit: pickOver === actualTotal > market.line,
      });
    }
  }
  return all;
}

function dailyTopK(bets, k, filterFn = null) {
  const pool = filterFn ? bets.filter(filterFn) : bets;
  const byDay = new Map();
  for (const b of pool) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (a, b) => b.ev - a.ev || b.absGap - a.absGap
    );
    arr.slice(0, k).forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

function scorePolicy(id, bets, baselineUsd) {
  const s = summarize(bets);
  const y = byYear(bets);
  const yearDeltas = {
    '2024': y['2024'].usd50 - 0,
    '2025': y['2025'].usd50 - 0,
    '2026': y['2026'].usd50 - 0,
  };
  const threePos = ['2024', '2025', '2026'].every((k) => (y[k].roi ?? -1) > 0);
  const delta = s.usd50 - baselineUsd;
  const pass =
    s.usd50 > baselineUsd &&
    threePos &&
    (y['2026'].usd50 ?? 0) >= -50 &&
    s.bets >= 40;
  return {
    id,
    ...s,
    byYear: y,
    deltaUsdVsBothFlat: delta,
    threeWindowRoiPositive: threePos,
    passImproveOnBoth: pass,
  };
}

console.log('Building totals pool…');
const all = buildAll(getLatestMlbExpectedRunsValidation().model);
console.log('n', all.length);

const both = all;
const under = all.filter((b) => b.side === 'under');
const over = all.filter((b) => b.side === 'over');
const bothS = summarize(both);

const policies = [
  scorePolicy('both_flat_current', both, bothS.usd50),
  scorePolicy('under_only_flat', under, bothS.usd50),
  scorePolicy('over_only_flat', over, bothS.usd50),
  scorePolicy('both_daily_top1', dailyTopK(both, 1), bothS.usd50),
  scorePolicy('both_daily_top2', dailyTopK(both, 2), bothS.usd50),
  scorePolicy('both_daily_top3', dailyTopK(both, 3), bothS.usd50),
  scorePolicy('under_daily_top1', dailyTopK(under, 1), bothS.usd50),
  scorePolicy('under_daily_top2', dailyTopK(under, 2), bothS.usd50),
  scorePolicy(
    'both_ev_ge_05',
    both.filter((b) => b.ev >= 0.05),
    bothS.usd50
  ),
  scorePolicy(
    'under_ev_ge_05',
    under.filter((b) => b.ev >= 0.05),
    bothS.usd50
  ),
];

policies.sort((a, b) => b.usd50 - a.usd50);
const best = policies[0];
const passers = policies.filter((p) => p.passImproveOnBoth && p.id !== 'both_flat_current');

// 實用建議：衛星倉注碼（相對主星 $50）
const underS = summarize(under);
const suggestedSatelliteStake =
  underS.roi > 0.08 ? 25 : underS.roi > 0.04 ? 20 : 15;

const out = {
  experimentId: 'totals_sat_next_knife_profit',
  thesis: '主星飽和後，在已盈利大小分衛星上再挖 under / TopK / EV 過濾',
  baseRules: R,
  nPool: all.length,
  policies,
  passers: passers.map((p) => p.id),
  best: { id: best.id, usd50: best.usd50, roi: best.roi, bets: best.bets },
  recommendation: {
    keepResearching: true,
    preferredSatellite:
      underS.threeWindowRoiPositive !== false &&
      byYear(under)['2024'].roi > 0 &&
      byYear(under)['2025'].roi > 0 &&
      byYear(under)['2026'].roi > 0
        ? 'under_only_parallel'
        : 'both_sides_current',
    underOnly: {
      ...underS,
      byYear: byYear(under),
      note: 'ROI 更厚、注更少；適合作為衛星主打候選',
    },
    bothSides: {
      ...bothS,
      byYear: byYear(both),
      note: '量多、ROI 薄；可當寬衛星或對照',
    },
    suggestedStakeUsd: suggestedSatelliteStake,
    suggestedStakeNote: `主星仍 $50；大小分衛星建議 $${suggestedSatelliteStake}（約主星一半或更低）`,
    mixParlayOptional: '同日 R1獨贏×最佳大小分 @$25 歷史正（另審）；勿全組合彩票',
  },
  verdict: passers.length
    ? `TOTALS_EVOLVE_YES — 優於現行 both 平坦的有：${passers.map((p) => p.id).join(', ')}`
    : underS.usd50 > 0 &&
        byYear(under)['2024'].roi > 0 &&
        byYear(under)['2025'].roi > 0 &&
        byYear(under)['2026'].roi > 0
      ? 'TOTALS_KEEP_UNDER_FOCUS — 相對 both 未必更高總$，但 under-only 三窗更肥，建議衛星主攻 Under'
      : 'TOTALS_KEEP_CURRENT_BOTH — 維持現行 both 影子，繼續挖',
};

fs.writeFileSync(
  new URL('../tmp-totals-sat-next-knife-profit.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      both: out.recommendation.bothSides,
      under: out.recommendation.underOnly,
      board: policies.map((p) => ({
        id: p.id,
        usd: p.usd50,
        roi: p.roi,
        bets: p.bets,
        delta: p.deltaUsdVsBothFlat,
        threePos: p.threeWindowRoiPositive,
        pass: p.passImproveOnBoth,
      })),
      suggestedStake: suggestedSatelliteStake,
      verdict: out.verdict,
    },
    null,
    2
  )
);
console.log('wrote tmp-totals-sat-next-knife-profit.json');
