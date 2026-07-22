/**
 * MLB 預期得分地基模型。
 *
 * 一個共享的賽前特徵模型分別估計主客隊得分均值，再用負二項分布推導
 * 獨贏、讓分與大小球。市場賠率只用於外測，不進入模型。
 */
import { randomUUID } from 'crypto';
import db from '../db/database.js';
import { decimalToImpliedProb, removeVig } from '../utils/odds.js';
import { MLB_BASELINE_FEATURE_VERSION } from './MlbHistoricalBaseline.js';
import { resolvePitOdds } from './PitOddsService.js';

export const MLB_EXPECTED_RUNS_MODEL_VERSION = 'mlb-expected-runs-nb-v2';
export const MLB_EXPECTED_RUNS_FEATURE_KEYS = [
  'isHome',
  'offenseRecentRpg',
  'offenseObp',
  'offenseSlg',
  'offenseKMinusBbRate',
  'opponentRecentRaRpg',
  'opponentStarterEraContribution',
  'opponentStarterWhipContribution',
  'opponentStarterKMinusBb9Contribution',
  'opponentStarterRecentEraContribution',
  'opponentBullpenEraContribution',
  'opponentBullpenWhipContribution',
  'opponentStarterExpectedInnings',
  'opponentStarterRestDays',
  'starterKnown',
  'battingKnown',
  'bullpenKnown',
];
export const MLB_EXPECTED_RUNS_FALLBACK_FEATURE_KEYS = [
  'isHome',
  'offenseRecentRpg',
  'offenseObp',
  'offenseSlg',
  'offenseKMinusBbRate',
  'opponentRecentRaRpg',
  'battingKnown',
];

const FALLBACK = {
  runs: 4.4,
  era: 4.3,
  whip: 1.3,
  kMinusBb9: 5.5,
  restDays: 4,
  pitches: 90,
  obp: 0.32,
  slg: 0.41,
  kRate: 0.23,
  bbRate: 0.085,
};
const MAX_RUNS = 24;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function shrinkRate(value, sampleSize, priorMean, priorSize) {
  const sample = Math.max(0, finite(sampleSize));
  const observed = finite(value, priorMean);
  return (observed * sample + priorMean * priorSize) /
    Math.max(1e-9, sample + priorSize);
}

function sideFeatures(features, side) {
  const opponent = side === 'home' ? 'away' : 'home';
  const team = features?.[side] || {};
  const oppTeam = features?.[opponent] || {};
  const pitcher = features?.pitchers?.[opponent] || null;
  const recentPitcher = features?.pitchers?.[
    opponent === 'home' ? 'homeRecent' : 'awayRecent'
  ] || null;
  const batting = features?.recentBoxscore?.[side]?.batting || null;
  const bullpen = features?.recentBoxscore?.[opponent]?.bullpen || null;
  const starterKnown = [
    pitcher?.era,
    pitcher?.whip,
    pitcher?.strikeoutsPer9,
    pitcher?.walksPer9,
  ].every((value) => Number.isFinite(Number(value)));
  const bullpenKnown = [bullpen?.era, bullpen?.whip].every((value) =>
    Number.isFinite(Number(value))
  );
  const battingKnown = [
    batting?.obp,
    batting?.slg,
    batting?.kRate,
    batting?.bbRate,
  ].every((value) => Number.isFinite(Number(value)));
  const pitcherInnings = finite(pitcher?.inningsPitched);
  const pitcherStarts = finite(pitcher?.gamesStarted);
  const recentStarts = finite(recentPitcher?.startsObserved);
  const seasonExpectedInnings = pitcherStarts > 0
    ? clamp(pitcherInnings / pitcherStarts, 3, 7)
    : 5;
  const recentExpectedInnings = recentStarts > 0
    ? clamp(finite(recentPitcher?.recent3Innings) / recentStarts, 3, 7)
    : seasonExpectedInnings;
  const expectedInnings = shrinkRate(
    recentExpectedInnings,
    recentStarts,
    seasonExpectedInnings,
    3
  );
  const starterShare = expectedInnings / 9;
  const bullpenShare = 1 - starterShare;
  const starterEra = shrinkRate(
    pitcher?.era,
    pitcherInnings,
    FALLBACK.era,
    30
  );
  const starterWhip = shrinkRate(
    pitcher?.whip,
    pitcherInnings,
    FALLBACK.whip,
    30
  );
  const starterKMinusBb9 = shrinkRate(
    finite(pitcher?.strikeoutsPer9, FALLBACK.kMinusBb9 + 3) -
      finite(pitcher?.walksPer9, 3),
    pitcherInnings,
    FALLBACK.kMinusBb9,
    30
  );
  const recentInnings = finite(recentPitcher?.recent3Innings);
  const recentEra = shrinkRate(
    recentPitcher?.recent3Era,
    recentInnings,
    starterEra,
    18
  );
  const bullpenGames = finite(bullpen?.gamesObserved);
  const bullpenEra = shrinkRate(
    bullpen?.era,
    bullpenGames,
    FALLBACK.era,
    10
  );
  const bullpenWhip = shrinkRate(
    bullpen?.whip,
    bullpenGames,
    FALLBACK.whip,
    10
  );
  const battingGames = finite(batting?.gamesObserved);
  const recentGames = finite(team.recentGames);
  const opponentRecentGames = finite(oppTeam.recentGames);
  return {
    isHome: side === 'home' ? 1 : 0,
    offenseRecentRpg: shrinkRate(
      team.recentRunsPerGame,
      recentGames,
      FALLBACK.runs,
      10
    ),
    offenseObp: shrinkRate(batting?.obp, battingGames, FALLBACK.obp, 10),
    offenseSlg: shrinkRate(batting?.slg, battingGames, FALLBACK.slg, 10),
    offenseKMinusBbRate:
      shrinkRate(batting?.bbRate, battingGames, FALLBACK.bbRate, 10) -
      shrinkRate(batting?.kRate, battingGames, FALLBACK.kRate, 10),
    opponentRecentRaRpg: shrinkRate(
      oppTeam.recentRunsAllowedPerGame,
      opponentRecentGames,
      FALLBACK.runs,
      10
    ),
    opponentStarterEraContribution:
      (starterEra - FALLBACK.era) * starterShare,
    opponentStarterWhipContribution:
      (starterWhip - FALLBACK.whip) * starterShare,
    opponentStarterKMinusBb9Contribution:
      (starterKMinusBb9 - FALLBACK.kMinusBb9) * starterShare,
    opponentStarterRecentEraContribution:
      (recentEra - starterEra) * starterShare,
    opponentBullpenEraContribution:
      (bullpenEra - FALLBACK.era) * bullpenShare,
    opponentBullpenWhipContribution:
      (bullpenWhip - FALLBACK.whip) * bullpenShare,
    opponentStarterExpectedInnings: expectedInnings,
    opponentStarterRestDays: clamp(
      finite(recentPitcher?.restDays, FALLBACK.restDays),
      2,
      10
    ),
    starterKnown: starterKnown ? 1 : 0,
    battingKnown: battingKnown ? 1 : 0,
    bullpenKnown: bullpenKnown ? 1 : 0,
  };
}

export function buildMlbExpectedRunsExamples(gameRows) {
  return gameRows.flatMap((row) => [
    {
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      side: 'home',
      targetRuns: Number(row.homeScore),
      vector: sideFeatures(row.features, 'home'),
    },
    {
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      side: 'away',
      targetRuns: Number(row.awayScore),
      vector: sideFeatures(row.features, 'away'),
    },
  ]).filter((row) =>
    Number.isFinite(row.targetRuns) && row.targetRuns >= 0 &&
    MLB_EXPECTED_RUNS_FEATURE_KEYS.every((key) => Number.isFinite(row.vector[key]))
  );
}

function vectorStats(examples, featureKeys) {
  const means = {};
  const scales = {};
  for (const key of featureKeys) {
    const values = examples.map((row) => row.vector[key]);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      Math.max(1, values.length - 1);
    means[key] = mean;
    scales[key] = Math.max(0.01, Math.sqrt(variance));
  }
  return { means, scales };
}

function standardizedValue(model, vector, key) {
  return (finite(vector?.[key]) - finite(model.means?.[key])) /
    Math.max(0.01, finite(model.scales?.[key], 1));
}

export function predictMlbExpectedRunsMean(model, vector) {
  let linear = finite(model?.intercept, Math.log(FALLBACK.runs));
  for (const key of model?.featureKeys || MLB_EXPECTED_RUNS_FEATURE_KEYS) {
    linear += finite(model?.weights?.[key]) * standardizedValue(model, vector, key);
  }
  return clamp(Math.exp(clamp(linear, -2, 3)), 0.5, 12);
}

function estimateDispersion(examples, model) {
  let numerator = 0;
  let denominator = 0;
  for (const row of examples) {
    const mean = predictMlbExpectedRunsMean(model, row.vector);
    numerator += (row.targetRuns - mean) ** 2 - mean;
    denominator += mean ** 2;
  }
  const alpha = clamp(numerator / Math.max(1e-9, denominator), 0.02, 1);
  return 1 / alpha;
}

export function fitMlbExpectedRunsModel(examples, {
  epochs = 1200,
  learningRate = 0.015,
  l2 = 0.03,
  featureKeys = MLB_EXPECTED_RUNS_FEATURE_KEYS,
} = {}) {
  if (!examples?.length || examples.length < 200) {
    throw new Error('mlb_expected_runs_examples_insufficient');
  }
  const { means, scales } = vectorStats(examples, featureKeys);
  const targetMean = examples.reduce((sum, row) => sum + row.targetRuns, 0) /
    examples.length;
  const model = {
    modelVersion: MLB_EXPECTED_RUNS_MODEL_VERSION,
    featureKeys,
    means,
    scales,
    intercept: Math.log(Math.max(0.5, targetMean)),
    weights: Object.fromEntries(featureKeys.map((key) => [key, 0])),
    dispersion: 8,
  };
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let interceptGradient = 0;
    const gradients = Object.fromEntries(
      featureKeys.map((key) => [key, 0])
    );
    for (const row of examples) {
      const mean = predictMlbExpectedRunsMean(model, row.vector);
      const error = mean - row.targetRuns;
      interceptGradient += error;
      for (const key of featureKeys) {
        gradients[key] += error * standardizedValue(model, row.vector, key);
      }
    }
    model.intercept -= learningRate * interceptGradient / examples.length;
    for (const key of featureKeys) {
      model.weights[key] -= learningRate * (
        gradients[key] / examples.length + l2 * model.weights[key]
      );
    }
  }
  model.dispersion = estimateDispersion(examples, model);
  model.trainSamples = examples.length;
  return model;
}

function logGamma(value) {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) -
      logGamma(1 - value);
  }
  let x = 0.9999999999998099;
  const z = value - 1;
  coefficients.forEach((coefficient, index) => {
    x += coefficient / (z + index + 1);
  });
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

export function negativeBinomialPmf(runs, mean, dispersion) {
  if (!Number.isInteger(runs) || runs < 0 || mean <= 0 || dispersion <= 0) return 0;
  const size = dispersion;
  const logProbability =
    logGamma(runs + size) - logGamma(size) - logGamma(runs + 1) +
    size * Math.log(size / (size + mean)) +
    runs * Math.log(mean / (size + mean));
  return Math.exp(logProbability);
}

export function buildMlbScoreDistribution({
  homeMean,
  awayMean,
  homeDispersion,
  awayDispersion,
  maxRuns = MAX_RUNS,
}) {
  const cells = [];
  let mass = 0;
  for (let home = 0; home <= maxRuns; home += 1) {
    for (let away = 0; away <= maxRuns; away += 1) {
      const probability =
        negativeBinomialPmf(home, homeMean, homeDispersion) *
        negativeBinomialPmf(away, awayMean, awayDispersion);
      cells.push({ home, away, probability });
      mass += probability;
    }
  }
  return cells.map((cell) => ({ ...cell, probability: cell.probability / mass }));
}

export function deriveMlbScoreMarkets(distribution, {
  totalLine = 8.5,
  homeSpread = -1.5,
  extraInningsHomeProbability = 0.5,
} = {}) {
  let homeWin = 0;
  let awayWin = 0;
  let tie = 0;
  let over = 0;
  let under = 0;
  let totalPush = 0;
  let homeCover = 0;
  let homeSpreadLoss = 0;
  let spreadPush = 0;
  for (const cell of distribution) {
    if (cell.home > cell.away) homeWin += cell.probability;
    else if (cell.away > cell.home) awayWin += cell.probability;
    else tie += cell.probability;
    const total = cell.home + cell.away;
    if (total > totalLine) over += cell.probability;
    else if (total < totalLine) under += cell.probability;
    else totalPush += cell.probability;
    const adjustedMargin = cell.home - cell.away + homeSpread;
    if (adjustedMargin > 0) homeCover += cell.probability;
    else if (adjustedMargin < 0) homeSpreadLoss += cell.probability;
    else spreadPush += cell.probability;
  }
  return {
    homeWinProbability: homeWin + tie * extraInningsHomeProbability,
    awayWinProbability: awayWin + tie * (1 - extraInningsHomeProbability),
    regulationTieProbability: tie,
    total: {
      line: totalLine,
      overProbability: over,
      underProbability: under,
      pushProbability: totalPush,
    },
    homeSpread: {
      line: homeSpread,
      coverProbability: homeCover,
      lossProbability: homeSpreadLoss,
      pushProbability: spreadPush,
    },
  };
}

export function predictMlbGameRuns(model, features, marketOptions = {}) {
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
    dispersion: model.dispersion,
    markets: deriveMlbScoreMarkets(distribution, marketOptions),
  };
}

function loadRows() {
  return db.prepare(`
    SELECT f.game_id, f.commence_time, f.features_json,
           g.home_team, g.away_team, g.home_score, g.away_score
    FROM mlb_historical_feature_rows f
    JOIN games g ON g.id = f.game_id
    WHERE f.feature_version = ?
      AND g.completed = 1
      AND g.home_score IS NOT NULL
      AND g.away_score IS NOT NULL
    ORDER BY datetime(f.commence_time), f.game_id
  `).all(MLB_BASELINE_FEATURE_VERSION).flatMap((row) => {
    try {
      return [{
        gameId: row.game_id,
        commenceTime: row.commence_time,
        homeTeam: row.home_team,
        awayTeam: row.away_team,
        homeScore: Number(row.home_score),
        awayScore: Number(row.away_score),
        features: JSON.parse(row.features_json),
      }];
    } catch {
      return [];
    }
  });
}

function probabilityMetrics(points) {
  if (!points.length) return { samples: 0, brier: null, logLoss: null, accuracy: null };
  let brier = 0;
  let logLoss = 0;
  let correct = 0;
  for (const point of points) {
    const p = clamp(point.p, 0.001, 0.999);
    brier += (p - point.y) ** 2;
    logLoss -= point.y * Math.log(p) + (1 - point.y) * Math.log(1 - p);
    if ((p >= 0.5 ? 1 : 0) === point.y) correct += 1;
  }
  return {
    samples: points.length,
    brier: brier / points.length,
    logLoss: logLoss / points.length,
    accuracy: correct / points.length,
  };
}

function confidenceMetrics(points) {
  return Object.fromEntries([0.5, 0.55, 0.6, 0.65, 0.7].map((threshold) => {
    const selected = points.filter((point) =>
      Math.max(point.p, 1 - point.p) >= threshold
    );
    const wins = selected.filter((point) =>
      (point.p >= 0.5 ? 1 : 0) === point.y
    ).length;
    return [`${Math.round(threshold * 100)}%+`, {
      samples: selected.length,
      wins,
      accuracy: selected.length ? wins / selected.length : null,
    }];
  }));
}

function marketProbability(row, key) {
  const pit = resolvePitOdds(row.gameId, row.commenceTime);
  if (!pit.ok) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((entry) => entry.key === key);
    if (!market) continue;
    if (key === 'h2h') {
      const home = market.outcomes?.find((outcome) => outcome.name === row.homeTeam);
      const away = market.outcomes?.find((outcome) => outcome.name === row.awayTeam);
      if (!home?.price || !away?.price) continue;
      const fair = removeVig(
        decimalToImpliedProb(home.price),
        decimalToImpliedProb(away.price)
      );
      const vig = 1 / home.price + 1 / away.price;
      if (!best || vig < best.vig) {
        best = {
          probability: fair.fairA,
          homeOdds: Number(home.price),
          awayOdds: Number(away.price),
          vig,
        };
      }
    } else if (key === 'totals') {
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
  }
  return best;
}

function summarizeMoneylineBets(bets) {
  if (!bets.length) {
    return {
      samples: 0,
      wins: 0,
      winRate: null,
      profitUnits: null,
      roi: null,
      roi95: null,
      averageOdds: null,
      averageEdge: null,
      averageModelProbability: null,
    };
  }
  const wins = bets.filter((bet) => bet.won).length;
  const profits = bets.map((bet) => (bet.won ? bet.odds - 1 : -1));
  const profitUnits = profits.reduce((sum, profit) => sum + profit, 0);
  const roi = profitUnits / bets.length;
  const variance = profits.reduce(
    (sum, profit) => sum + (profit - roi) ** 2,
    0
  ) / Math.max(1, bets.length - 1);
  const margin95 = 1.96 * Math.sqrt(variance / bets.length);
  return {
    samples: bets.length,
    wins,
    winRate: wins / bets.length,
    profitUnits,
    roi,
    roi95: [roi - margin95, roi + margin95],
    averageOdds: bets.reduce((sum, bet) => sum + bet.odds, 0) / bets.length,
    averageEdge: bets.reduce((sum, bet) => sum + bet.edge, 0) / bets.length,
    averageModelProbability:
      bets.reduce((sum, bet) => sum + bet.modelProbability, 0) / bets.length,
  };
}

function moneylineBetDiagnostics(bets) {
  const positiveEv = bets.filter((bet) => bet.expectedValue > 0);
  const edgeThresholds = [0, 0.02, 0.03, 0.05, 0.08];
  const confidenceThresholds = [0.55, 0.6, 0.65];
  const oddsBands = [
    { key: '1.30-1.60', min: 1.3, max: 1.6 },
    { key: '1.60-1.80', min: 1.6, max: 1.8 },
    { key: '1.80-2.00', min: 1.8, max: 2 },
    { key: '2.00-2.30', min: 2, max: 2.3 },
    { key: '2.30+', min: 2.3, max: Infinity },
  ];
  const months = [...new Set(positiveEv.map((bet) => bet.month))].sort();
  return {
    compared: bets.length,
    positiveEv: summarizeMoneylineBets(positiveEv),
    byEdge: Object.fromEntries(edgeThresholds.map((threshold) => [
      `${Math.round(threshold * 100)}%+`,
      summarizeMoneylineBets(
        positiveEv.filter((bet) => bet.edge >= threshold)
      ),
    ])),
    byConfidence: Object.fromEntries(confidenceThresholds.map((threshold) => [
      `${Math.round(threshold * 100)}%+`,
      summarizeMoneylineBets(
        positiveEv.filter((bet) => bet.modelProbability >= threshold)
      ),
    ])),
    byOdds: Object.fromEntries(oddsBands.map((band) => [
      band.key,
      summarizeMoneylineBets(
        positiveEv.filter((bet) => bet.odds >= band.min && bet.odds < band.max)
      ),
    ])),
    byMonth: Object.fromEntries(months.map((month) => {
      const monthly = positiveEv.filter((bet) => bet.month === month);
      return [month, {
        all: summarizeMoneylineBets(monthly),
        '55%+': summarizeMoneylineBets(
          monthly.filter((bet) => bet.modelProbability >= 0.55)
        ),
        '60%+': summarizeMoneylineBets(
          monthly.filter((bet) => bet.modelProbability >= 0.6)
        ),
      }];
    })),
  };
}

function scoreMetrics(rows, model, { modelForRow = null } = {}) {
  let homeAbsolute = 0;
  let awayAbsolute = 0;
  let totalAbsolute = 0;
  let squared = 0;
  const winPoints = [];
  const pitModelWinPoints = [];
  const marketWinPoints = [];
  const moneylineBets = [];
  const totalPoints = [];
  const marketTotalPoints = [];
  for (const row of rows) {
    const activeModel = modelForRow?.(row) || model;
    const prediction = predictMlbGameRuns(activeModel, row.features);
    homeAbsolute += Math.abs(prediction.homeExpectedRuns - row.homeScore);
    awayAbsolute += Math.abs(prediction.awayExpectedRuns - row.awayScore);
    totalAbsolute += Math.abs(prediction.expectedTotal - row.homeScore - row.awayScore);
    squared += (prediction.homeExpectedRuns - row.homeScore) ** 2 +
      (prediction.awayExpectedRuns - row.awayScore) ** 2;
    const homeWon = row.homeScore > row.awayScore ? 1 : 0;
    winPoints.push({ p: prediction.markets.homeWinProbability, y: homeWon });
    const h2h = marketProbability(row, 'h2h');
    if (h2h) {
      pitModelWinPoints.push({
        p: prediction.markets.homeWinProbability,
        y: homeWon,
      });
      marketWinPoints.push({ p: h2h.probability, y: homeWon });
      const homeEdge = prediction.markets.homeWinProbability - h2h.probability;
      const pickHome = homeEdge >= 0;
      const modelProbability = pickHome
        ? prediction.markets.homeWinProbability
        : prediction.markets.awayWinProbability;
      const marketFairProbability = pickHome
        ? h2h.probability
        : 1 - h2h.probability;
      const odds = pickHome ? h2h.homeOdds : h2h.awayOdds;
      moneylineBets.push({
        side: pickHome ? 'home' : 'away',
        won: pickHome ? homeWon === 1 : homeWon === 0,
        odds,
        modelProbability,
        marketFairProbability,
        edge: modelProbability - marketFairProbability,
        expectedValue: modelProbability * odds - 1,
        month: String(row.commenceTime).slice(0, 7),
      });
    }
    const totals = marketProbability(row, 'totals');
    if (totals && row.homeScore + row.awayScore !== totals.line) {
      const markets = predictMlbGameRuns(activeModel, row.features, {
        totalLine: totals.line,
      }).markets;
      const decisive = 1 - markets.total.pushProbability;
      totalPoints.push({
        p: markets.total.overProbability / Math.max(1e-9, decisive),
        y: row.homeScore + row.awayScore > totals.line ? 1 : 0,
      });
      marketTotalPoints.push({
        p: totals.probability,
        y: row.homeScore + row.awayScore > totals.line ? 1 : 0,
      });
    }
  }
  return {
    samples: rows.length,
    homeRunsMae: homeAbsolute / rows.length,
    awayRunsMae: awayAbsolute / rows.length,
    totalRunsMae: totalAbsolute / rows.length,
    sideRunsRmse: Math.sqrt(squared / (rows.length * 2)),
    moneyline: probabilityMetrics(winPoints),
    moneylineConfidence: confidenceMetrics(winPoints),
    pitModelMoneyline: probabilityMetrics(pitModelWinPoints),
    pitMarketMoneyline: probabilityMetrics(marketWinPoints),
    moneylineBetDiagnostics: moneylineBetDiagnostics(moneylineBets),
    totals: probabilityMetrics(totalPoints),
    pitMarketTotals: probabilityMetrics(marketTotalPoints),
  };
}

function range(rows) {
  return {
    from: rows[0]?.commenceTime ?? null,
    to: rows.at(-1)?.commenceTime ?? null,
  };
}

function probableStarterIdentityCoverage(rows) {
  const covered = completeProbableStarterGameIds();
  const games = rows.length;
  const complete = rows.filter((row) => covered.has(row.gameId)).length;
  return {
    games,
    complete,
    rate: games ? complete / games : 0,
  };
}

function completeProbableStarterGameIds() {
  return new Set(db.prepare(`
    SELECT DISTINCT game_id
    FROM mlb_probable_starter_snapshots
    WHERE status = 'complete'
      AND datetime(captured_at) < datetime(commence_time)
  `).all().map((row) => row.game_id));
}

export function runMlbExpectedRunsValidation({ persist = true } = {}) {
  const rows = loadRows();
  const bySeason = (season) => rows.filter((row) =>
    String(row.commenceTime).startsWith(String(season))
  );
  const train2024 = bySeason(2024);
  const validation2025 = bySeason(2025);
  const final2026 = bySeason(2026);
  if (train2024.length < 1000 || validation2025.length < 1000 || final2026.length < 300) {
    throw new Error('mlb_expected_runs_cross_season_rows_insufficient');
  }
  const selectionModel = fitMlbExpectedRunsModel(
    buildMlbExpectedRunsExamples(train2024)
  );
  const validation = scoreMetrics(validation2025, selectionModel);
  const selectionFallbackModel = fitMlbExpectedRunsModel(
    buildMlbExpectedRunsExamples(train2024),
    { featureKeys: MLB_EXPECTED_RUNS_FALLBACK_FEATURE_KEYS }
  );
  const fallbackValidation = scoreMetrics(
    validation2025,
    selectionFallbackModel
  );
  const developmentRows = [...train2024, ...validation2025];
  const finalModel = fitMlbExpectedRunsModel(
    buildMlbExpectedRunsExamples(developmentRows)
  );
  const fallbackModel = fitMlbExpectedRunsModel(
    buildMlbExpectedRunsExamples(developmentRows),
    { featureKeys: MLB_EXPECTED_RUNS_FALLBACK_FEATURE_KEYS }
  );
  finalModel.fallbackModel = fallbackModel;
  const finalTest = scoreMetrics(final2026, finalModel);
  const fallbackFinalObserved = scoreMetrics(final2026, fallbackModel);
  const strictStarterGames = completeProbableStarterGameIds();
  const routedFinalObserved = scoreMetrics(final2026, fallbackModel, {
    modelForRow: (row) =>
      strictStarterGames.has(row.gameId) ? finalModel : fallbackModel,
  });
  const starterIdentityCoverage = {
    development: probableStarterIdentityCoverage(developmentRows),
    finalObserved: probableStarterIdentityCoverage(final2026),
  };
  const beatsMoneylineMarket =
    finalTest.pitModelMoneyline.samples >= 500 &&
    finalTest.pitModelMoneyline.samples === finalTest.pitMarketMoneyline.samples &&
    finalTest.pitModelMoneyline.brier < finalTest.pitMarketMoneyline.brier &&
    finalTest.pitModelMoneyline.logLoss < finalTest.pitMarketMoneyline.logLoss;
  const beatsTotalsMarket =
    finalTest.totals.samples >= 300 &&
    finalTest.totals.samples === finalTest.pitMarketTotals.samples &&
    finalTest.totals.brier < finalTest.pitMarketTotals.brier &&
    finalTest.totals.logLoss < finalTest.pitMarketTotals.logLoss;
  const historicalStarterIdentityPitVerified =
    starterIdentityCoverage.development.rate >= 0.95;
  const finalTestPristine = false;
  const summary = {
    warning:
      '研究模式：v2 使用已觀察的 2026 異常值修復小樣本特徵，2026 不再是全新 final test；歷史先發身份亦尚未具備賽前快照。',
    split: {
      train2024: { samples: train2024.length, ...range(train2024) },
      validation2025: { samples: validation2025.length, ...range(validation2025) },
      final2026: { samples: final2026.length, ...range(final2026) },
    },
    featureKeys: MLB_EXPECTED_RUNS_FEATURE_KEYS,
    fallbackFeatureKeys: MLB_EXPECTED_RUNS_FALLBACK_FEATURE_KEYS,
    starterIdentityCoverage,
    validation,
    fallbackValidation,
    finalTest,
    fallbackFinalObserved,
    routedFinalObserved,
    deploymentDecision: {
      eligible:
        finalTestPristine &&
        historicalStarterIdentityPitVerified &&
        beatsMoneylineMarket &&
        beatsTotalsMarket,
      finalTestPristine,
      historicalStarterIdentityPitVerified,
      beatsMoneylineMarket,
      beatsTotalsMarket,
      blockReasons: [
        'final_test_reused_for_feature_repair',
        'historical_starter_identity_not_pit_replayable',
        ...(beatsMoneylineMarket ? [] : ['score_model_does_not_beat_moneyline_market']),
        ...(beatsTotalsMarket ? [] : ['score_model_does_not_beat_totals_market']),
      ],
    },
  };
  const run = {
    runId: `mlb-xruns-${randomUUID()}`,
    modelVersion: MLB_EXPECTED_RUNS_MODEL_VERSION,
    featureVersion: MLB_BASELINE_FEATURE_VERSION,
    model: finalModel,
    summary,
  };
  if (persist) {
    db.prepare(`
      INSERT INTO mlb_expected_runs_models
        (run_id, model_version, feature_version, training_from, training_to,
         train_samples, model_json, summary_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.runId,
      run.modelVersion,
      run.featureVersion,
      developmentRows[0].commenceTime,
      developmentRows.at(-1).commenceTime,
      developmentRows.length,
      JSON.stringify(finalModel),
      JSON.stringify(summary)
    );
  }
  return run;
}

export function getLatestMlbExpectedRunsValidation() {
  const row = db.prepare(`
    SELECT * FROM mlb_expected_runs_models
    ORDER BY datetime(created_at) DESC, rowid DESC
    LIMIT 1
  `).get();
  if (!row) return null;
  return {
    runId: row.run_id,
    modelVersion: row.model_version,
    featureVersion: row.feature_version,
    createdAt: row.created_at,
    model: JSON.parse(row.model_json),
    summary: JSON.parse(row.summary_json),
  };
}
