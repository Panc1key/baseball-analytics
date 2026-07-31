/**
 * Diagnose why expected-runs totals lag the market (algorithm only).
 */
import db from '../src/db/database.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';

function corr(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let c = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    c += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  return c / Math.sqrt(Math.max(1e-12, vx * vy));
}

function brier(points) {
  if (!points.length) return null;
  return points.reduce((s, p) => s + (p.p - p.y) ** 2, 0) / points.length;
}

function reliability(points, bins = 10) {
  const buckets = Array.from({ length: bins }, () => ({ n: 0, sumP: 0, sumY: 0 }));
  for (const point of points) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(point.p * bins)));
    buckets[index].n += 1;
    buckets[index].sumP += point.p;
    buckets[index].sumY += point.y;
  }
  return buckets
    .map((bucket, index) => ({
      bin: index,
      n: bucket.n,
      avgP: bucket.n ? bucket.sumP / bucket.n : null,
      freq: bucket.n ? bucket.sumY / bucket.n : null,
    }))
    .filter((bucket) => bucket.n > 0);
}

function marketTotals(row) {
  const pit = resolvePitOdds(row.gameId, row.commenceTime);
  if (!pit.ok) return null;
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
      const fair = removeVig(
        decimalToImpliedProb(over.price),
        decimalToImpliedProb(under.price)
      );
      const vig = 1 / over.price + 1 / under.price;
      if (!best || vig < best.vig) {
        best = { probability: fair.fairA, line: Number(over.point), vig };
      }
    }
  }
  return best;
}

function loadSlice(whereSql) {
  return db.prepare(`
    SELECT
      f.game_id AS gameId,
      f.commence_time AS commenceTime,
      f.features_json AS featuresJson,
      g.home_score AS homeScore,
      g.away_score AS awayScore,
      g.home_team AS homeTeam,
      g.away_team AS awayTeam
    FROM mlb_historical_feature_rows f
    JOIN games g ON g.id = f.game_id
    WHERE f.feature_version = 'mlb-foundation-pit-v1'
      AND g.home_score IS NOT NULL
      AND ${whereSql}
    ORDER BY f.commence_time ASC
  `).all().map((row) => ({
    ...row,
    features: JSON.parse(row.featuresJson),
  }));
}

function evaluate(rows, model) {
  const modelPoints = [];
  const marketPoints = [];
  const expected = [];
  const actual = [];
  const lines = [];
  const modelMinusLine = [];
  const actualMinusLine = [];
  const marketMinusHalf = [];
  for (const row of rows) {
    const totals = marketTotals(row);
    if (!totals) continue;
    const total = Number(row.homeScore) + Number(row.awayScore);
    if (total === totals.line) continue;
    const prediction = predictMlbGameRuns(model, row.features, {
      totalLine: totals.line,
    });
    const push = prediction.markets.total.pushProbability;
    const overP = prediction.markets.total.overProbability / Math.max(1e-9, 1 - push);
    const y = total > totals.line ? 1 : 0;
    modelPoints.push({ p: overP, y });
    marketPoints.push({ p: totals.probability, y });
    expected.push(prediction.expectedTotal);
    actual.push(total);
    lines.push(totals.line);
    modelMinusLine.push(prediction.expectedTotal - totals.line);
    actualMinusLine.push(total - totals.line);
    marketMinusHalf.push(totals.probability - 0.5);
  }

  // temperature search on validation-style points
  const temps = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];
  const tempSweep = temps.map((temperature) => {
    const calibrated = modelPoints.map((point) => {
      const pRaw = Math.min(0.999, Math.max(0.001, point.p));
      const logit = Math.log(pRaw / (1 - pRaw));
      const p = 1 / (1 + Math.exp(-logit / temperature));
      return { p, y: point.y };
    });
    return { temperature, brier: brier(calibrated) };
  });

  return {
    n: modelPoints.length,
    modelBrier: brier(modelPoints),
    marketBrier: brier(marketPoints),
    corrExpectedActual: corr(expected, actual),
    corrLineActual: corr(lines, actual),
    corrModelEdgeOutcome: corr(modelMinusLine, actualMinusLine),
    corrMarketEdgeOutcome: corr(marketMinusHalf, actualMinusLine),
    reliability: reliability(modelPoints),
    meanAbsModelVsLine: modelMinusLine.reduce((s, v) => s + Math.abs(v), 0) /
      Math.max(1, modelMinusLine.length),
    tempSweep: tempSweep.sort((a, b) => a.brier - b.brier).slice(0, 4),
  };
}

const latest = getLatestMlbExpectedRunsValidation();
const model = latest?.model;
if (!model) {
  throw new Error('no_persisted_expected_runs_model');
}

const validation2025 = loadSlice(
  `f.commence_time >= '2025-08-16' AND f.commence_time < '2026-01-01'`
);
const observed2026 = loadSlice(`f.commence_time >= '2026-01-01'`);

console.log(JSON.stringify({
  modelVersion: model.modelVersion,
  dispersion: model.dispersion,
  validation2025: evaluate(validation2025, model),
  observed2026: evaluate(observed2026, model),
}, null, 2));
