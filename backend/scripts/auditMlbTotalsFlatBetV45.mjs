/**
 * v4.5 大小球均注回測（測試用，非推薦）。
 * 定邊：模型 overProbability（去 push）>= 0.5 押大，否則押小。
 * 另報：用 expectedTotal 對線定邊。
 */
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

function summarize(bets) {
  if (!bets.length) {
    return { samples: 0, wins: 0, winRate: null, roi: null, flatPnL2: null };
  }
  const wins = bets.filter((b) => b.won).length;
  const profits = bets.map((b) => (b.won ? b.odds - 1 : -1));
  const roi = profits.reduce((s, p) => s + p, 0) / bets.length;
  const variance = profits.reduce((s, p) => s + (p - roi) ** 2, 0) /
    Math.max(1, bets.length - 1);
  const margin95 = 1.96 * Math.sqrt(variance / bets.length);
  return {
    samples: bets.length,
    wins,
    losses: bets.length - wins,
    winRate: wins / bets.length,
    averageOdds: bets.reduce((s, b) => s + b.odds, 0) / bets.length,
    averageLine: bets.reduce((s, b) => s + b.line, 0) / bets.length,
    averageExpectedTotal:
      bets.reduce((s, b) => s + b.expectedTotal, 0) / bets.length,
    roi,
    roi95: [roi - margin95, roi + margin95],
    flatStake: 2,
    flatPnL: roi * bets.length * 2,
    breakEvenWinRate: null,
  };
}

function bestTotalsMarket(row) {
  const pit = resolvePitOdds(row.gameId, row.commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((entry) => entry.key === 'totals');
    if (!market) continue;
    for (const over of market.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = market.outcomes.find((outcome) =>
        outcome.name === 'Under' && Number(outcome.point) === Number(over.point)
      );
      if (!over.price || !under?.price) continue;
      const vig = 1 / over.price + 1 / under.price;
      if (!best || vig < best.vig) {
        best = {
          line: Number(over.point),
          overOdds: Number(over.price),
          underOdds: Number(under.price),
          fairOver: removeVig(
            decimalToImpliedProb(over.price),
            decimalToImpliedProb(under.price)
          ).fairA,
          vig,
        };
      }
    }
  }
  return best;
}

const latest = getLatestMlbExpectedRunsValidation();
if (!latest?.model || latest.modelVersion !== 'mlb-expected-runs-nb-v4.5') {
  throw new Error(`expected v4.5 model, got ${latest?.modelVersion}`);
}
const model = latest.model;

const rows = db.prepare(`
  SELECT f.game_id AS gameId, f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
         g.home_team AS homeTeam, g.away_team AS awayTeam,
         g.home_score AS homeScore, g.away_score AS awayScore
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  WHERE f.feature_version = ?
    AND g.completed = 1
    AND g.home_score IS NOT NULL
    AND g.away_score IS NOT NULL
    AND datetime(f.commence_time) >= datetime('2026-01-01')
  ORDER BY datetime(f.commence_time), f.game_id
`).all(MLB_BASELINE_FEATURE_VERSION).map((row) => {
  const features = JSON.parse(row.featuresJson);
  features.gameId = row.gameId;
  features.commenceTime = row.commenceTime;
  features.homeTeam = row.homeTeam;
  features.awayTeam = row.awayTeam;
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
  return {
    ...row,
    homeScore: Number(row.homeScore),
    awayScore: Number(row.awayScore),
    features,
  };
});

const byProb = [];
const byMean = [];
const marketSide = [];
let pushes = 0;
let mae = 0;
let corrNum = 0;
let corrDenPred = 0;
let corrDenAct = 0;
const predTotals = [];
const actTotals = [];

for (const row of rows) {
  const market = bestTotalsMarket(row);
  if (!market) continue;
  const actualTotal = row.homeScore + row.awayScore;
  if (actualTotal === market.line) {
    pushes += 1;
    continue;
  }
  const pred = predictMlbGameRuns(model, row.features, { totalLine: market.line });
  const expectedTotal = pred.expectedTotal;
  const overProb = pred.markets.total.overProbability /
    Math.max(1e-9, 1 - pred.markets.total.pushProbability);
  const actualOver = actualTotal > market.line;

  mae += Math.abs(expectedTotal - actualTotal);
  predTotals.push(expectedTotal);
  actTotals.push(actualTotal);

  // 1) 機率定邊
  const pickOverByProb = overProb >= 0.5;
  byProb.push({
    won: pickOverByProb === actualOver,
    odds: pickOverByProb ? market.overOdds : market.underOdds,
    line: market.line,
    expectedTotal,
    side: pickOverByProb ? 'over' : 'under',
  });

  // 2) 預期總分對線定邊
  const pickOverByMean = expectedTotal > market.line;
  byMean.push({
    won: pickOverByMean === actualOver,
    odds: pickOverByMean ? market.overOdds : market.underOdds,
    line: market.line,
    expectedTotal,
    side: pickOverByMean ? 'over' : 'under',
  });

  // 3) 市場公允機率定邊（對照）
  const pickOverByMarket = market.fairOver >= 0.5;
  marketSide.push({
    won: pickOverByMarket === actualOver,
    odds: pickOverByMarket ? market.overOdds : market.underOdds,
    line: market.line,
    expectedTotal,
    side: pickOverByMarket ? 'over' : 'under',
  });
}

const mean = (arr) => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
const mp = mean(predTotals);
const ma = mean(actTotals);
for (let i = 0; i < predTotals.length; i += 1) {
  corrNum += (predTotals[i] - mp) * (actTotals[i] - ma);
  corrDenPred += (predTotals[i] - mp) ** 2;
  corrDenAct += (actTotals[i] - ma) ** 2;
}

function withBreakEven(summary) {
  if (!summary.samples || !summary.averageOdds) return summary;
  return {
    ...summary,
    breakEvenWinRate: 1 / summary.averageOdds,
  };
}

console.log(JSON.stringify({
  modelVersion: latest.modelVersion,
  runId: latest.runId,
  observed2026Games: rows.length,
  decisiveTotalsBets: byProb.length,
  pushesSkipped: pushes,
  scoreFit: {
    totalRunsMae: mae / Math.max(1, byProb.length),
    expectedTotalVsActualCorr:
      corrNum / Math.sqrt(Math.max(1e-12, corrDenPred * corrDenAct)),
    averageExpectedTotal: mp,
    averageActualTotal: ma,
  },
  flatBetByModelProbability: withBreakEven(summarize(byProb)),
  flatBetByExpectedTotalVsLine: withBreakEven(summarize(byMean)),
  flatBetByMarketFairProbability: withBreakEven(summarize(marketSide)),
  note:
    '均注測試：每場選大或小一邊；ROI 以 1 單位本金計；flatPnL 為均注 $2。非推薦。',
}, null, 2));
