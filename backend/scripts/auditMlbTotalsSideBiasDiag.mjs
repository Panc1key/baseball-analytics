/**
 * 大小分選邊偏差診斷：真實 Over/Under 結果 vs 模型選邊 vs 閘門漏斗
 * 用法: node scripts/auditMlbTotalsSideBiasDiag.mjs
 * 產物: tmp-totals-side-bias-diag.json
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
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

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

function bump(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}

console.log('Scanning…');
const model = getLatestMlbExpectedRunsValidation().model;

const games = []; // all with market + non-push
const funnel = {
  withMarket: 0,
  push: 0,
  nonPush: 0,
  modelLeanOver: 0, // gap > 0
  modelLeanUnder: 0, // gap < 0
  modelLeanZero: 0,
  // after side-agnostic gates (gap/ev/edge/prob/line) on the model's preferred side
  passGatesOver: 0,
  passGatesUnder: 0,
  // reject reasons by preferred side
  fail: {
    over: { gap: 0, ev: 0, edge: 0, prob: 0, line: 0, sideProb: 0 },
    under: { gap: 0, ev: 0, edge: 0, prob: 0, line: 0, sideProb: 0 },
  },
};

const byYearActual = {};
const byYearModelLean = {};
const byYearPassed = {};

for (const w of WINDOWS) {
  byYearActual[w.key] = { over: 0, under: 0, push: 0 };
  byYearModelLean[w.key] = { over: 0, under: 0, zero: 0 };
  byYearPassed[w.key] = { over: 0, under: 0 };

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
    if (!market) continue;
    funnel.withMarket += 1;

    if (actualTotal === market.line) {
      funnel.push += 1;
      byYearActual[w.key].push += 1;
      continue;
    }
    funnel.nonPush += 1;
    const actualSide = actualTotal > market.line ? 'over' : 'under';
    byYearActual[w.key][actualSide] += 1;

    const pred = predictMlbGameRuns(model, features, { totalLine: market.line });
    const expectedTotal = Number(pred.expectedTotal);
    const pushP = Number(pred.markets?.total?.pushProbability) || 0;
    const overProb =
      Number(pred.markets?.total?.overProbability) / Math.max(1e-9, 1 - pushP);
    const underProb =
      Number(pred.markets?.total?.underProbability) / Math.max(1e-9, 1 - pushP);
    const gap = expectedTotal - market.line;

    let lean;
    if (gap > 0) lean = 'over';
    else if (gap < 0) lean = 'under';
    else lean = 'zero';

    if (lean === 'over') {
      funnel.modelLeanOver += 1;
      byYearModelLean[w.key].over += 1;
    } else if (lean === 'under') {
      funnel.modelLeanUnder += 1;
      byYearModelLean[w.key].under += 1;
    } else {
      funnel.modelLeanZero += 1;
      byYearModelLean[w.key].zero += 1;
    }

    if (lean === 'zero') continue;

    const modelProb = lean === 'over' ? overProb : underProb;
    const pickOdds = lean === 'over' ? market.overOdds : market.underOdds;
    const fair = lean === 'over' ? market.fairOver : market.fairUnder;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const edge = modelProb - fair;
    const failKey = lean;
    const fails = funnel.fail[failKey];

    let pass = true;
    if (lean === 'over' && overProb < 0.5) {
      fails.sideProb += 1;
      pass = false;
    }
    if (lean === 'under' && underProb < 0.5) {
      fails.sideProb += 1;
      pass = false;
    }
    if (Math.abs(gap) < R.minAbsGap) {
      fails.gap += 1;
      pass = false;
    }
    if (ev < R.minimumExpectedValue) {
      fails.ev += 1;
      pass = false;
    }
    if (edge < R.minEdgeVsMarket) {
      fails.edge += 1;
      pass = false;
    }
    if (modelProb < R.minimumModelProbability) {
      fails.prob += 1;
      pass = false;
    }
    if (market.line > R.maxTotalLine) {
      fails.line += 1;
      pass = false;
    }

    if (pass) {
      if (lean === 'over') {
        funnel.passGatesOver += 1;
        byYearPassed[w.key].over += 1;
      } else {
        funnel.passGatesUnder += 1;
        byYearPassed[w.key].under += 1;
      }
    }

    games.push({
      year: w.key,
      line: market.line,
      actualTotal,
      actualSide,
      gap: Number(gap.toFixed(3)),
      absGap: Number(Math.abs(gap).toFixed(3)),
      lean,
      overProb: Number(overProb.toFixed(4)),
      underProb: Number(underProb.toFixed(4)),
      expectedTotal: Number(expectedTotal.toFixed(3)),
      overOdds: market.overOdds,
      underOdds: market.underOdds,
      fairOver: Number(market.fairOver.toFixed(4)),
      fairUnder: Number(market.fairUnder.toFixed(4)),
      ev: Number(ev.toFixed(4)),
      edge: Number(edge.toFixed(4)),
      pass,
      // market price skew
      overCheaper: market.overOdds > market.underOdds,
      underCheaper: market.underOdds > market.overOdds,
    });
  }
}

const n = games.length;
const actualOver = games.filter((g) => g.actualSide === 'over').length;
const actualUnder = games.filter((g) => g.actualSide === 'under').length;

// gap distribution
const gaps = games.map((g) => g.gap).sort((a, b) => a - b);
function pctile(arr, p) {
  if (!arr.length) return null;
  const i = Math.min(arr.length - 1, Math.floor((arr.length - 1) * p));
  return arr[i];
}
const meanGap = gaps.reduce((s, x) => s + x, 0) / Math.max(1, gaps.length);

const leanOver = games.filter((g) => g.lean === 'over');
const leanUnder = games.filter((g) => g.lean === 'under');

function sideStats(arr) {
  if (!arr.length) return null;
  const meanAbsGap =
    arr.reduce((s, g) => s + g.absGap, 0) / arr.length;
  const meanEv = arr.reduce((s, g) => s + g.ev, 0) / arr.length;
  const meanEdge = arr.reduce((s, g) => s + g.edge, 0) / arr.length;
  const meanProb =
    arr.reduce(
      (s, g) => s + (g.lean === 'over' ? g.overProb : g.underProb),
      0
    ) / arr.length;
  const passRate = arr.filter((g) => g.pass).length / arr.length;
  const hitWhenLean =
    arr.filter((g) => g.actualSide === g.lean).length / arr.length;
  return {
    n: arr.length,
    meanAbsGap: Number(meanAbsGap.toFixed(3)),
    meanEv: Number(meanEv.toFixed(4)),
    meanEdge: Number(meanEdge.toFixed(4)),
    meanModelProb: Number(meanProb.toFixed(4)),
    passRate: Number(passRate.toFixed(4)),
    leanHitRate: Number(hitWhenLean.toFixed(4)),
  };
}

// sequential first-fail funnel by lean (exclusive first reason)
function firstFailFunnel(arr) {
  const reasons = {
    sideProb: 0,
    gap: 0,
    ev: 0,
    edge: 0,
    prob: 0,
    line: 0,
    pass: 0,
  };
  for (const g of arr) {
    const modelProb = g.lean === 'over' ? g.overProb : g.underProb;
    if (modelProb < 0.5) {
      reasons.sideProb += 1;
      continue;
    }
    if (g.absGap < R.minAbsGap) {
      reasons.gap += 1;
      continue;
    }
    if (g.ev < R.minimumExpectedValue) {
      reasons.ev += 1;
      continue;
    }
    if (g.edge < R.minEdgeVsMarket) {
      reasons.edge += 1;
      continue;
    }
    if (modelProb < R.minimumModelProbability) {
      reasons.prob += 1;
      continue;
    }
    if (g.line > R.maxTotalLine) {
      reasons.line += 1;
      continue;
    }
    reasons.pass += 1;
  }
  return reasons;
}

// conditional: if we forced pick the opposite when gap favors over — not needed
// market odds asymmetry when lean under vs over
function oddsSkew(arr) {
  if (!arr.length) return null;
  const meanPickOdds =
    arr.reduce(
      (s, g) => s + (g.lean === 'over' ? g.overOdds : g.underOdds),
      0
    ) / arr.length;
  const meanOppOdds =
    arr.reduce(
      (s, g) => s + (g.lean === 'over' ? g.underOdds : g.overOdds),
      0
    ) / arr.length;
  const meanFairPick =
    arr.reduce(
      (s, g) => s + (g.lean === 'over' ? g.fairOver : g.fairUnder),
      0
    ) / arr.length;
  return {
    meanPickOdds: Number(meanPickOdds.toFixed(3)),
    meanOppOdds: Number(meanOppOdds.toFixed(3)),
    meanFairPick: Number(meanFairPick.toFixed(4)),
  };
}

const out = {
  experimentId: 'totals_side_bias_diag',
  rules: R,
  actualResults: {
    nonPushGames: n,
    over: actualOver,
    under: actualUnder,
    overShare: Number((actualOver / n).toFixed(4)),
    underShare: Number((actualUnder / n).toFixed(4)),
    byYear: Object.fromEntries(
      Object.entries(byYearActual).map(([y, v]) => {
        const t = v.over + v.under;
        return [
          y,
          {
            ...v,
            overShare: t ? Number((v.over / t).toFixed(4)) : null,
            underShare: t ? Number((v.under / t).toFixed(4)) : null,
          },
        ];
      })
    ),
    note: '真實總分相對盤口：Over=實際>線，Under=實際<線（已剔除 push）',
  },
  modelLean: {
    over: funnel.modelLeanOver,
    under: funnel.modelLeanUnder,
    zero: funnel.modelLeanZero,
    overShare: Number(
      (funnel.modelLeanOver / (funnel.modelLeanOver + funnel.modelLeanUnder)).toFixed(4)
    ),
    underShare: Number(
      (
        funnel.modelLeanUnder /
        (funnel.modelLeanOver + funnel.modelLeanUnder)
      ).toFixed(4)
    ),
    meanGap: Number(meanGap.toFixed(3)),
    gapPercentiles: {
      p10: pctile(gaps, 0.1),
      p25: pctile(gaps, 0.25),
      p50: pctile(gaps, 0.5),
      p75: pctile(gaps, 0.75),
      p90: pctile(gaps, 0.9),
    },
    byYear: byYearModelLean,
    note: 'lean = sign(μ − line)；>0 選大、<0 選小',
  },
  afterGates: {
    over: funnel.passGatesOver,
    under: funnel.passGatesUnder,
    overShare: Number(
      (
        funnel.passGatesOver /
        (funnel.passGatesOver + funnel.passGatesUnder)
      ).toFixed(4)
    ),
    underShare: Number(
      (
        funnel.passGatesUnder /
        (funnel.passGatesOver + funnel.passGatesUnder)
      ).toFixed(4)
    ),
    byYear: byYearPassed,
  },
  leanSideQuality: {
    whenLeanOver: sideStats(leanOver),
    whenLeanUnder: sideStats(leanUnder),
  },
  firstFailFunnel: {
    leanOver: firstFailFunnel(leanOver),
    leanUnder: firstFailFunnel(leanUnder),
  },
  oddsWhenLean: {
    leanOver: oddsSkew(leanOver),
    leanUnder: oddsSkew(leanUnder),
  },
  verdict: null,
};

const actualBalanced =
  Math.abs(out.actualResults.overShare - 0.5) < 0.03;
const modelSkew =
  out.modelLean.overShare - out.actualResults.overShare;
const gateAmplify =
  out.afterGates.overShare - out.modelLean.overShare;

out.verdict = {
  actualBalancedNear5050: actualBalanced,
  modelOverLeanBiasPp: Number((modelSkew * 100).toFixed(1)),
  gatesFurtherBoostOverPp: Number((gateAmplify * 100).toFixed(1)),
  plain:
    actualBalanced && out.modelLean.overShare > 0.65
      ? '賽果大致一半大一半小，但模型 μ 系統性偏高→大量 lean Over；閘門再放大。這是選邊偏差，不是賽果真有那麼多大。'
      : out.modelLean.overShare > out.actualResults.overShare + 0.1
        ? '模型 lean Over 明顯高於真實 Over 占比；主因算法／校準偏差。'
        : '需結合漏斗細節看。',
};

fs.writeFileSync(
  new URL('../tmp-totals-side-bias-diag.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
console.log('wrote tmp-totals-side-bias-diag.json');
