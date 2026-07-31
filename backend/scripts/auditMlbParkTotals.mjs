/**
 * Test park-factor impact on expected totals (2025 val + 2026 observed).
 */
import db from '../src/db/database.js';
import { getParkFactor } from '../src/data/parkFactors.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';

const TEAM_HOME_VENUE = {
  'Arizona Diamondbacks': 'Chase Field',
  'Atlanta Braves': 'Truist Park',
  'Baltimore Orioles': 'Oriole Park at Camden Yards',
  'Boston Red Sox': 'Fenway Park',
  'Chicago Cubs': 'Wrigley Field',
  'Chicago White Sox': 'Rate Field',
  'Cincinnati Reds': 'Great American Ball Park',
  'Cleveland Guardians': 'Progressive Field',
  'Colorado Rockies': 'Coors Field',
  'Detroit Tigers': 'Comerica Park',
  'Houston Astros': 'Minute Maid Park',
  'Kansas City Royals': 'Kauffman Stadium',
  'Los Angeles Angels': 'Angel Stadium',
  'Los Angeles Dodgers': 'Dodger Stadium',
  'Miami Marlins': 'loanDepot park',
  'Milwaukee Brewers': 'American Family Field',
  'Minnesota Twins': 'Target Field',
  'New York Mets': 'Citi Field',
  'New York Yankees': 'Yankee Stadium',
  'Athletics': 'Sutter Health Park',
  'Oakland Athletics': 'Sutter Health Park',
  'Philadelphia Phillies': 'Citizens Bank Park',
  'Pittsburgh Pirates': 'PNC Park',
  'San Diego Padres': 'Petco Park',
  'San Francisco Giants': 'Oracle Park',
  'Seattle Mariners': 'T-Mobile Park',
  'St. Louis Cardinals': 'Busch Stadium',
  'Tampa Bay Rays': 'Tropicana Field',
  'Texas Rangers': 'Globe Life Field',
  'Toronto Blue Jays': 'Rogers Centre',
  'Washington Nationals': 'Nationals Park',
};

function corr(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let c = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i += 1) {
    c += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  return c / Math.sqrt(Math.max(1e-12, vx * vy));
}

function brier(points) {
  return points.reduce((s, p) => s + (p.p - p.y) ** 2, 0) / points.length;
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

function parkForTeam(homeTeam) {
  return getParkFactor(TEAM_HOME_VENUE[homeTeam] || homeTeam);
}

function predictWithPark(model, features, homeTeam, marketOptions = {}) {
  const base = predictMlbGameRuns(model, features, marketOptions);
  const park = parkForTeam(homeTeam);
  const homeMean = base.homeExpectedRuns * park;
  const awayMean = base.awayExpectedRuns * park;
  const distribution = buildMlbScoreDistribution({
    homeMean,
    awayMean,
    homeDispersion: model.dispersion,
    awayDispersion: model.dispersion,
  });
  return {
    ...base,
    parkFactor: park,
    homeExpectedRuns: homeMean,
    awayExpectedRuns: awayMean,
    expectedTotal: homeMean + awayMean,
    markets: deriveMlbScoreMarkets(distribution, marketOptions),
  };
}

function loadSlice(whereSql) {
  return db.prepare(`
    SELECT
      f.game_id AS gameId,
      f.commence_time AS commenceTime,
      f.features_json AS featuresJson,
      g.home_team AS homeTeam,
      g.away_team AS awayTeam,
      g.home_score AS homeScore,
      g.away_score AS awayScore
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

function evaluate(rows, model, withPark) {
  let mae = 0;
  const expected = [];
  const actual = [];
  const modelPoints = [];
  const marketPoints = [];
  for (const row of rows) {
    const total = Number(row.homeScore) + Number(row.awayScore);
    const pred = withPark
      ? predictWithPark(model, row.features, row.homeTeam)
      : predictMlbGameRuns(model, row.features);
    mae += Math.abs(pred.expectedTotal - total);
    expected.push(pred.expectedTotal);
    actual.push(total);
    const totals = marketTotals(row);
    if (!totals || total === totals.line) continue;
    const lined = withPark
      ? predictWithPark(model, row.features, row.homeTeam, { totalLine: totals.line })
      : predictMlbGameRuns(model, row.features, { totalLine: totals.line });
    const push = lined.markets.total.pushProbability;
    const overP = lined.markets.total.overProbability / Math.max(1e-9, 1 - push);
    modelPoints.push({ p: overP, y: total > totals.line ? 1 : 0 });
    marketPoints.push({ p: totals.probability, y: total > totals.line ? 1 : 0 });
  }
  return {
    n: rows.length,
    totalMae: mae / rows.length,
    corrExpectedActual: corr(expected, actual),
    totalsN: modelPoints.length,
    modelBrier: modelPoints.length ? brier(modelPoints) : null,
    marketBrier: marketPoints.length ? brier(marketPoints) : null,
  };
}

const model = getLatestMlbExpectedRunsValidation().model;
const validation2025 = loadSlice(
  `f.commence_time >= '2025-08-16' AND f.commence_time < '2026-01-01'`
);
const observed2026 = loadSlice(`f.commence_time >= '2026-01-01'`);

console.log(JSON.stringify({
  validation2025: {
    baseline: evaluate(validation2025, model, false),
    withPark: evaluate(validation2025, model, true),
  },
  observed2026: {
    baseline: evaluate(observed2026, model, false),
    withPark: evaluate(observed2026, model, true),
  },
}, null, 2));
