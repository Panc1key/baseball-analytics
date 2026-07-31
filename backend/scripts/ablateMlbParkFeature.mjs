/**
 * Ablate learnable parkFactor on 2025 train/validation only.
 */
import db from '../src/db/database.js';
import { getParkFactor } from '../src/data/parkFactors.js';
import {
  MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS,
  MLB_EXPECTED_RUNS_BATTING_FEATURE_KEYS,
  buildMlbExpectedRunsSideFeatures,
  fitMlbExpectedRunsModel,
  predictMlbExpectedRunsMean,
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
  Athletics: 'Sutter Health Park',
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

function parkFor(homeTeam) {
  return getParkFactor(TEAM_HOME_VENUE[homeTeam] || homeTeam);
}

function sideFeatures(features, side) {
  const vector = buildMlbExpectedRunsSideFeatures(features, side);
  vector.parkFactor = Number(features.parkFactor ?? 1);
  return vector;
}

function predictGame(model, features, marketOptions = {}) {
  const homeMean = predictMlbExpectedRunsMean(model, sideFeatures(features, 'home'));
  const awayMean = predictMlbExpectedRunsMean(model, sideFeatures(features, 'away'));
  const distribution = buildMlbScoreDistribution({
    homeMean,
    awayMean,
    homeDispersion: model.dispersion,
    awayDispersion: model.dispersion,
  });
  return {
    homeExpectedRuns: homeMean,
    awayExpectedRuns: awayMean,
    expectedTotal: homeMean + awayMean,
    markets: deriveMlbScoreMarkets(distribution, marketOptions),
  };
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

function scoreMetrics(rows, model) {
  let totalAbs = 0;
  let sideSq = 0;
  let winBrier = 0;
  const totalPoints = [];
  const marketPoints = [];
  for (const row of rows) {
    const prediction = predictGame(model, row.features);
    totalAbs += Math.abs(prediction.expectedTotal - row.homeScore - row.awayScore);
    sideSq += (prediction.homeExpectedRuns - row.homeScore) ** 2 +
      (prediction.awayExpectedRuns - row.awayScore) ** 2;
    const yWin = row.homeScore > row.awayScore ? 1 : 0;
    winBrier += (prediction.markets.homeWinProbability - yWin) ** 2;
    const totals = marketTotals(row);
    if (totals && row.homeScore + row.awayScore !== totals.line) {
      const lined = predictGame(model, row.features, { totalLine: totals.line });
      const push = lined.markets.total.pushProbability;
      const overP = lined.markets.total.overProbability / Math.max(1e-9, 1 - push);
      const y = row.homeScore + row.awayScore > totals.line ? 1 : 0;
      totalPoints.push((overP - y) ** 2);
      marketPoints.push((totals.probability - y) ** 2);
    }
  }
  return {
    samples: rows.length,
    totalRunsMae: totalAbs / rows.length,
    sideRunsRmse: Math.sqrt(sideSq / (rows.length * 2)),
    moneylineBrier: winBrier / rows.length,
    totalsN: totalPoints.length,
    totalsBrier: totalPoints.length
      ? totalPoints.reduce((s, v) => s + v, 0) / totalPoints.length
      : null,
    marketTotalsBrier: marketPoints.length
      ? marketPoints.reduce((s, v) => s + v, 0) / marketPoints.length
      : null,
  };
}

const rows = db.prepare(`
  SELECT f.game_id AS gameId, f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
         g.home_team AS homeTeam, g.away_team AS awayTeam,
         g.home_score AS homeScore, g.away_score AS awayScore
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  WHERE f.feature_version = 'mlb-foundation-pit-v1'
    AND g.completed = 1
    AND g.home_score IS NOT NULL
    AND datetime(f.commence_time) >= datetime('2025-05-01')
  ORDER BY datetime(f.commence_time), f.game_id
`).all().map((row) => ({
  gameId: row.gameId,
  commenceTime: row.commenceTime,
  homeTeam: row.homeTeam,
  awayTeam: row.awayTeam,
  homeScore: Number(row.homeScore),
  awayScore: Number(row.awayScore),
  features: {
    ...JSON.parse(row.featuresJson),
    parkFactor: parkFor(row.homeTeam),
  },
}));

const development = rows.filter((row) => row.commenceTime < '2026-01-01');
const observed2026 = rows.filter((row) => row.commenceTime >= '2026-01-01');
const split = Math.floor(development.length * 0.7);
const train = development.slice(0, split);
const validation = development.slice(split);

const candidates = [
  {
    key: 'core_plus_batting',
    featureKeys: [
      ...MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_BATTING_FEATURE_KEYS,
    ],
  },
  {
    key: 'core_plus_batting_park',
    featureKeys: [
      ...MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_BATTING_FEATURE_KEYS,
      'parkFactor',
    ],
  },
];

const report = candidates.map((candidate) => {
  const trainExamples = train.flatMap((row) => [
    { targetRuns: row.homeScore, vector: sideFeatures(row.features, 'home') },
    { targetRuns: row.awayScore, vector: sideFeatures(row.features, 'away') },
  ]);
  const model = fitMlbExpectedRunsModel(trainExamples, {
    featureKeys: candidate.featureKeys,
  });
  return {
    key: candidate.key,
    parkWeight: model.weights.parkFactor ?? null,
    validation: scoreMetrics(validation, model),
    observed2026: scoreMetrics(observed2026, model),
  };
});

console.log(JSON.stringify(report, null, 2));
