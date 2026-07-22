/**
 * MLB 模型驗證框架。
 *
 * 固定順序：train → feature selection → calibration → final test。
 * final test 只評估已選定模型，不得用來挑特徵。
 */
import { randomUUID } from 'crypto';
import db from '../db/database.js';
import { decimalToImpliedProb, removeVig } from '../utils/odds.js';
import {
  buildMlbHistoricalFeatureRows,
  fitMlbBaseline,
  MLB_BASELINE_FEATURE_VERSION,
  MLB_BULLPEN_QUALITY_FEATURE_KEYS,
  MLB_FOUNDATION_FEATURE_KEYS,
  MLB_FOUNDATION_TEAM_FEATURE_KEYS,
  MLB_RECENT_BATTING_FEATURE_KEYS,
  MLB_TEAM_FEATURE_KEYS,
  predictMlbBaseline,
} from './MlbHistoricalBaseline.js';
import { resolvePitOdds } from './PitOddsService.js';

export const MLB_MODEL_EVAL_VERSION = 'mlb-model-eval-v4';
export const MLB_FOUNDATION_EVAL_VERSION = 'mlb-foundation-eval-v1';
const SEASON_PITCHER_KEYS = [
  'pitcherEraDiff',
  'pitcherWhipDiff',
  'pitcherK9Diff',
  'pitcherBb9Diff',
];
const RECENT_PITCHER_KEYS = [
  'pitcherRestDaysDiff',
  'pitcherRecentEraDiff',
  'pitcherRecentK9Diff',
  'pitcherRecentBb9Diff',
  'pitcherRecentPitchesDiff',
];
const BULLPEN_KEYS = [
  'bullpenPitchesLast3Diff',
  'bullpenAppearancesLast3Diff',
];

function clamp(value, min = 0.001, max = 0.999) {
  return Math.max(min, Math.min(max, Number(value)));
}

function logit(probability) {
  const p = clamp(probability);
  return Math.log(p / (1 - p));
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
}

function rawPoints(rows, model) {
  return rows.map((row) => ({
    p: predictMlbBaseline(model, row.features.vector),
    y: Number(row.homeWin),
    row,
  }));
}

/**
 * Platt calibration：只在獨立 calibration 段估計 slope/intercept。
 * L2 與 slope=1 的弱先驗避免小樣本產生極端概率。
 */
export function fitPlattCalibration(points, {
  epochs = 700,
  learningRate = 0.04,
  l2 = 0.02,
} = {}) {
  if (!points?.length || points.length < 30) {
    return {
      method: 'identity',
      samples: points?.length || 0,
      intercept: 0,
      slope: 1,
      reason: 'calibration_rows_insufficient',
    };
  }
  let intercept = 0;
  let slope = 1;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let interceptGradient = 0;
    let slopeGradient = 0;
    for (const point of points) {
      const x = logit(point.p);
      const error = sigmoid(intercept + slope * x) - point.y;
      interceptGradient += error;
      slopeGradient += error * x;
    }
    intercept -= learningRate * (interceptGradient / points.length + l2 * intercept);
    slope -= learningRate * (slopeGradient / points.length + l2 * (slope - 1));
  }
  if (![intercept, slope].every(Number.isFinite) || slope <= 0) {
    return {
      method: 'identity',
      samples: points.length,
      intercept: 0,
      slope: 1,
      reason: 'invalid_platt_fit',
    };
  }
  return {
    method: 'platt',
    samples: points.length,
    intercept,
    slope,
  };
}

export function applyMlbCalibration(probability, calibration) {
  if (!calibration || calibration.method !== 'platt') return clamp(probability);
  return clamp(sigmoid(calibration.intercept + calibration.slope * logit(probability)));
}

export function probabilityMetrics(points, { bins = 10 } = {}) {
  if (!points?.length) {
    return {
      samples: 0,
      brier: null,
      logLoss: null,
      accuracy: null,
      ece: null,
      calibrationBins: [],
    };
  }
  let brier = 0;
  let loss = 0;
  let correct = 0;
  const buckets = Array.from({ length: bins }, (_, index) => ({
    lo: index / bins,
    hi: (index + 1) / bins,
    n: 0,
    sumP: 0,
    sumY: 0,
  }));
  for (const point of points) {
    const p = clamp(point.p);
    const y = Number(point.y);
    brier += (p - y) ** 2;
    loss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    if ((p >= 0.5 ? 1 : 0) === y) correct += 1;
    const bucket = buckets[Math.min(bins - 1, Math.floor(p * bins))];
    bucket.n += 1;
    bucket.sumP += p;
    bucket.sumY += y;
  }
  const calibrationBins = buckets
    .filter((bucket) => bucket.n)
    .map((bucket) => ({
      lo: bucket.lo,
      hi: bucket.hi,
      n: bucket.n,
      avgProb: bucket.sumP / bucket.n,
      hitRate: bucket.sumY / bucket.n,
    }));
  const ece = calibrationBins.reduce(
    (sum, bucket) =>
      sum + (bucket.n / points.length) * Math.abs(bucket.avgProb - bucket.hitRate),
    0
  );
  return {
    samples: points.length,
    brier: brier / points.length,
    logLoss: loss / points.length,
    accuracy: correct / points.length,
    ece,
    calibrationBins,
  };
}

function evaluateRows(rows, model, calibration = null) {
  const raw = rawPoints(rows, model);
  const calibrated = raw.map((point) => ({
    ...point,
    p: applyMlbCalibration(point.p, calibration),
  }));
  return {
    raw: probabilityMetrics(raw),
    calibrated: probabilityMetrics(calibrated),
  };
}

function marketHomeProbability(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit.ok) return null;
  let selected = null;
  for (const book of pit.bookmakers) {
    const h2h = (book.markets || []).find((market) => market.key === 'h2h');
    const home = h2h?.outcomes?.find((outcome) => outcome.name === homeTeam);
    const away = h2h?.outcomes?.find((outcome) => outcome.name === awayTeam);
    if (!home?.price || !away?.price) continue;
    const homeImplied = decimalToImpliedProb(home.price);
    const awayImplied = decimalToImpliedProb(away.price);
    const fair = removeVig(homeImplied, awayImplied);
    const vig = homeImplied + awayImplied;
    if (!selected || vig < selected.vig) {
      selected = {
        p: fair.fairA,
        vig,
        bookmaker: book.title || book.key || null,
        homeOdds: Number(home.price),
        awayOdds: Number(away.price),
        snapshotId: pit.snapshotId,
        capturedAt: pit.capturedAt,
      };
    }
  }
  return selected;
}

function marketAlignedMetrics(rows, model, calibration) {
  const marketPoints = [];
  const rawModelPoints = [];
  const calibratedModelPoints = [];
  let missing = 0;
  for (const row of rows) {
    const market = marketHomeProbability(
      row.gameId,
      row.commenceTime,
      row.homeTeam,
      row.awayTeam
    );
    if (!market) {
      missing += 1;
      continue;
    }
    const rawProbability = predictMlbBaseline(model, row.features.vector);
    marketPoints.push({ p: market.p, y: row.homeWin });
    rawModelPoints.push({ p: rawProbability, y: row.homeWin });
    calibratedModelPoints.push({
      p: applyMlbCalibration(rawProbability, calibration),
      y: row.homeWin,
    });
  }
  return {
    samples: marketPoints.length,
    missingPitOdds: missing,
    market: probabilityMetrics(marketPoints),
    modelRaw: probabilityMetrics(rawModelPoints),
    modelCalibrated: probabilityMetrics(calibratedModelPoints),
  };
}

function summarizeFlatBets(bets) {
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
      homePicks: 0,
      awayPicks: 0,
    };
  }
  const wins = bets.filter((bet) => bet.won).length;
  const profits = bets.map((bet) => (bet.won ? bet.odds - 1 : -1));
  const profitUnits = profits.reduce((sum, profit) => sum + profit, 0);
  const roi = profitUnits / bets.length;
  const profitVariance = bets.length > 1
    ? profits.reduce((sum, profit) => sum + (profit - roi) ** 2, 0) /
      (bets.length - 1)
    : 0;
  const roiMargin95 = 1.96 * Math.sqrt(profitVariance / bets.length);
  return {
    samples: bets.length,
    wins,
    winRate: wins / bets.length,
    profitUnits,
    roi,
    roi95: [roi - roiMargin95, roi + roiMargin95],
    averageOdds: bets.reduce((sum, bet) => sum + bet.odds, 0) / bets.length,
    averageEdge: bets.reduce((sum, bet) => sum + bet.edge, 0) / bets.length,
    homePicks: bets.filter((bet) => bet.side === 'home').length,
    awayPicks: bets.filter((bet) => bet.side === 'away').length,
  };
}

function foundationOddsDiagnostics(rows, model) {
  const bets = [];
  const marketFavorites = [];
  let missingPitOdds = 0;
  for (const row of rows) {
    const market = marketHomeProbability(
      row.gameId,
      row.commenceTime,
      row.homeTeam,
      row.awayTeam
    );
    if (!market?.homeOdds || !market?.awayOdds) {
      missingPitOdds += 1;
      continue;
    }
    const modelHome = predictMlbBaseline(model, row.features.vector);
    const homeEdge = modelHome - market.p;
    const side = homeEdge >= 0 ? 'home' : 'away';
    bets.push({
      side,
      won: side === 'home' ? row.homeWin === 1 : row.homeWin === 0,
      edge: Math.abs(homeEdge),
      odds: side === 'home' ? market.homeOdds : market.awayOdds,
      month: String(row.commenceTime).slice(0, 7),
    });

    const favoriteSide = market.p >= 0.5 ? 'home' : 'away';
    marketFavorites.push({
      side: favoriteSide,
      won: favoriteSide === 'home' ? row.homeWin === 1 : row.homeWin === 0,
      edge: Math.abs(market.p - 0.5),
      odds: favoriteSide === 'home' ? market.homeOdds : market.awayOdds,
    });
  }
  const thresholds = [0.01, 0.02, 0.03, 0.05, 0.08];
  const buckets = [
    { key: '0-2%', min: 0, max: 0.02 },
    { key: '2-3%', min: 0.02, max: 0.03 },
    { key: '3-5%', min: 0.03, max: 0.05 },
    { key: '5-8%', min: 0.05, max: 0.08 },
    { key: '8%+', min: 0.08, max: Infinity },
  ];
  const months = [...new Set(bets.map((bet) => bet.month))].sort();
  return {
    samples: bets.length,
    missingPitOdds,
    allModelLeans: summarizeFlatBets(bets),
    thresholds: Object.fromEntries(thresholds.map((threshold) => [
      `${Math.round(threshold * 100)}%+`,
      summarizeFlatBets(bets.filter((bet) => bet.edge >= threshold)),
    ])),
    buckets: Object.fromEntries(buckets.map((bucket) => [
      bucket.key,
      summarizeFlatBets(
        bets.filter((bet) => bet.edge >= bucket.min && bet.edge < bucket.max)
      ),
    ])),
    bySide: {
      home: summarizeFlatBets(bets.filter((bet) => bet.side === 'home')),
      away: summarizeFlatBets(bets.filter((bet) => bet.side === 'away')),
    },
    byMonth: Object.fromEntries(months.map((month) => {
      const monthly = bets.filter((bet) => bet.month === month);
      return [month, {
        all: summarizeFlatBets(monthly),
        '3%+': summarizeFlatBets(monthly.filter((bet) => bet.edge >= 0.03)),
        '5%+': summarizeFlatBets(monthly.filter((bet) => bet.edge >= 0.05)),
        '8%+': summarizeFlatBets(monthly.filter((bet) => bet.edge >= 0.08)),
      }];
    })),
    marketFavorite: summarizeFlatBets(marketFavorites),
  };
}

function splitDevelopmentRows(rows) {
  const n = rows.length;
  const afterTies = (target) => {
    let index = Math.max(1, Math.min(n - 1, target));
    while (
      index < n &&
      rows[index - 1]?.commenceTime === rows[index]?.commenceTime
    ) {
      index += 1;
    }
    return index;
  };
  const trainEnd = afterTies(Math.floor(n * 0.55));
  const selectionEnd = afterTies(Math.max(trainEnd + 1, Math.floor(n * 0.7)));
  const calibrationEnd = afterTies(Math.max(selectionEnd + 1, Math.floor(n * 0.85)));
  return {
    train: rows.slice(0, trainEnd),
    selection: rows.slice(trainEnd, selectionEnd),
    calibration: rows.slice(selectionEnd, calibrationEnd),
    finalTest: rows.slice(calibrationEnd),
  };
}

function featureSetCandidates({
  bullpenAvailable = false,
  seasonPitcherAvailable = false,
  recentPitcherAvailable = false,
  recentBoxscoreAvailable = false,
} = {}) {
  return [
    {
      key: 'team_all',
      featureKeys: [...MLB_TEAM_FEATURE_KEYS],
    },
    ...(bullpenAvailable
      ? [{
          key: 'team_plus_bullpen',
          featureKeys: [...MLB_TEAM_FEATURE_KEYS, ...BULLPEN_KEYS],
        }]
      : []),
    ...(seasonPitcherAvailable
      ? [{
          key: 'team_plus_season_pitcher',
          featureKeys: [...MLB_TEAM_FEATURE_KEYS, ...SEASON_PITCHER_KEYS],
        }]
      : []),
    ...(recentPitcherAvailable
      ? [
          {
            key: 'team_plus_recent_pitcher',
            featureKeys: [
              ...MLB_TEAM_FEATURE_KEYS,
              ...SEASON_PITCHER_KEYS,
              ...RECENT_PITCHER_KEYS,
            ],
          },
          ...(bullpenAvailable
            ? [{
                key: 'team_plus_recent_pitcher_bullpen',
                featureKeys: [
                  ...MLB_TEAM_FEATURE_KEYS,
                  ...SEASON_PITCHER_KEYS,
                  ...RECENT_PITCHER_KEYS,
                  ...BULLPEN_KEYS,
                ],
              }]
            : []),
        ]
      : []),
    ...(recentBoxscoreAvailable
      ? [
          {
            key: 'team_plus_recent_batting',
            featureKeys: [...MLB_TEAM_FEATURE_KEYS, ...MLB_RECENT_BATTING_FEATURE_KEYS],
          },
          {
            key: 'team_plus_bullpen_quality',
            featureKeys: [...MLB_TEAM_FEATURE_KEYS, ...MLB_BULLPEN_QUALITY_FEATURE_KEYS],
          },
          {
            key: 'team_plus_recent_boxscore',
            featureKeys: [
              ...MLB_TEAM_FEATURE_KEYS,
              ...MLB_RECENT_BATTING_FEATURE_KEYS,
              ...MLB_BULLPEN_QUALITY_FEATURE_KEYS,
            ],
          },
          ...(recentPitcherAvailable
            ? [{
                key: 'team_plus_pitcher_recent_boxscore',
                featureKeys: [
                  ...MLB_TEAM_FEATURE_KEYS,
                  ...SEASON_PITCHER_KEYS,
                  ...RECENT_PITCHER_KEYS,
                  ...MLB_RECENT_BATTING_FEATURE_KEYS,
                  ...MLB_BULLPEN_QUALITY_FEATURE_KEYS,
                ],
              }]
            : []),
        ]
      : []),
    {
      key: 'season_venue_only',
      featureKeys: ['seasonWinPctDiff', 'venueRecordDiff'],
    },
    ...MLB_TEAM_FEATURE_KEYS.map((removed) => ({
      key: `without_${removed}`,
      featureKeys: MLB_TEAM_FEATURE_KEYS.filter((key) => key !== removed),
    })),
  ];
}

function dateRange(rows) {
  return {
    from: rows[0]?.commenceTime || null,
    to: rows.at(-1)?.commenceTime || null,
  };
}

function evaluateAblations(train, selection, options = {}) {
  return featureSetCandidates(options).map((candidate) => {
    const fit = fitMlbBaseline(train, {
      featureKeys: candidate.featureKeys,
      holdout: false,
    });
    return {
      ...candidate,
      selection: evaluateRows(selection, fit.model).raw,
    };
  }).sort((a, b) =>
    a.selection.brier - b.selection.brier ||
    a.selection.logLoss - b.selection.logLoss
  );
}

function loadPersistedValidationRows() {
  return db.prepare(`
    SELECT f.game_id, f.commence_time, f.features_json, f.home_win,
           g.home_team, g.away_team
    FROM mlb_historical_feature_rows f
    JOIN games g ON g.id = f.game_id
    WHERE f.feature_version = ?
    ORDER BY datetime(f.commence_time) ASC, f.game_id ASC
  `).all(MLB_BASELINE_FEATURE_VERSION).map((row) => ({
    gameId: row.game_id,
    commenceTime: row.commence_time,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    features: JSON.parse(row.features_json),
    homeWin: row.home_win,
  }));
}

function selectCalibration(calibrationRows, model) {
  const fitEnd = Math.max(30, Math.floor(calibrationRows.length * 0.65));
  const fitRows = calibrationRows.slice(0, fitEnd);
  const checkRows = calibrationRows.slice(fitEnd);
  const candidate = fitPlattCalibration(rawPoints(fitRows, model));
  const check = evaluateRows(checkRows, model, candidate);
  const accepted = candidate.method === 'platt' &&
    check.calibrated.brier < check.raw.brier &&
    check.calibrated.logLoss < check.raw.logLoss;
  const calibration = accepted
    ? fitPlattCalibration(rawPoints(calibrationRows, model))
    : {
        method: 'identity',
        samples: calibrationRows.length,
        intercept: 0,
        slope: 1,
        reason: 'platt_did_not_improve_calibration_check',
      };
  return {
    calibration,
    selection: {
      fitSamples: fitRows.length,
      checkSamples: checkRows.length,
      candidate,
      check,
      accepted,
    },
  };
}

function seasonForwardFolds(rows, featureKeys) {
  const seasons = [...new Set(rows.map((row) => String(row.commenceTime).slice(0, 4)))].sort();
  const folds = [];
  for (const season of seasons.slice(1)) {
    const seasonRows = rows.filter((row) => String(row.commenceTime).startsWith(season));
    const train = rows.filter((row) => String(row.commenceTime).slice(0, 4) < season);
    if (train.length < 120 || seasonRows.length < 60) continue;
    const calibrationEnd = Math.max(30, Math.floor(seasonRows.length * 0.2));
    const calibrationRows = seasonRows.slice(0, calibrationEnd);
    const testRows = seasonRows.slice(calibrationEnd);
    if (testRows.length < 30) continue;
    const fit = fitMlbBaseline(train, { featureKeys, holdout: false });
    const calibrationChoice = selectCalibration(calibrationRows, fit.model);
    const calibration = calibrationChoice.calibration;
    folds.push({
      foldKey: `season_${season}`,
      featureSet: featureKeys.join(','),
      train: dateRange(train),
      calibration: dateRange(calibrationRows),
      test: dateRange(testRows),
      metrics: {
        calibration,
        calibrationSelection: calibrationChoice.selection,
        test: evaluateRows(testRows, fit.model, calibration),
        pitComparison: marketAlignedMetrics(testRows, fit.model, calibration),
      },
    });
  }
  return folds;
}

function rollingBlockedFolds(rows, featureKeys, {
  minTrain = 360,
  blockSize = 180,
  calibrationSize = 60,
} = {}) {
  const folds = [];
  let foldNumber = 1;
  for (
    let blockStart = minTrain;
    blockStart + blockSize <= rows.length;
    blockStart += blockSize
  ) {
    const train = rows.slice(0, blockStart);
    const block = rows.slice(blockStart, blockStart + blockSize);
    const calibrationRows = block.slice(0, calibrationSize);
    const testRows = block.slice(calibrationSize);
    const fit = fitMlbBaseline(train, { featureKeys, holdout: false });
    const calibrationChoice = selectCalibration(calibrationRows, fit.model);
    const calibration = calibrationChoice.calibration;
    folds.push({
      foldKey: `rolling_${String(foldNumber).padStart(2, '0')}`,
      featureSet: featureKeys.join(','),
      train: dateRange(train),
      calibration: dateRange(calibrationRows),
      test: dateRange(testRows),
      metrics: {
        calibration,
        calibrationSelection: calibrationChoice.selection,
        test: evaluateRows(testRows, fit.model, calibration),
        pitComparison: marketAlignedMetrics(testRows, fit.model, calibration),
      },
    });
    foldNumber += 1;
  }
  return folds;
}

function persistEvaluation(run, folds) {
  const insertRun = db.prepare(`
    INSERT INTO mlb_model_eval_runs
      (run_id, feature_version, eval_version, evaluation_from, evaluation_to,
       config_json, summary_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFold = db.prepare(`
    INSERT INTO mlb_model_eval_folds
      (run_id, fold_key, feature_set, train_from, train_to, calibration_from,
       calibration_to, test_from, test_to, metrics_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    insertRun.run(
      run.runId,
      run.featureVersion,
      run.evalVersion,
      run.evaluation.from,
      run.evaluation.to,
      JSON.stringify(run.config),
      JSON.stringify(run.summary)
    );
    for (const fold of folds) {
      insertFold.run(
        run.runId,
        fold.foldKey,
        fold.featureSet,
        fold.train.from,
        fold.train.to,
        fold.calibration.from,
        fold.calibration.to,
        fold.test.from,
        fold.test.to,
        JSON.stringify(fold.metrics)
      );
    }
  })();
}

export function runMlbModelValidation({ persist = true } = {}) {
  const persistedRows = loadPersistedValidationRows();
  const hasKeys = (row, keys) =>
    keys.every((key) => Number.isFinite(row.features?.vector?.[key]));
  const bullpenRows = persistedRows.filter((row) => hasKeys(row, BULLPEN_KEYS));
  const seasonPitcherRows = persistedRows.filter((row) => hasKeys(row, SEASON_PITCHER_KEYS));
  const recentPitcherRows = persistedRows.filter((row) =>
    hasKeys(row, [...SEASON_PITCHER_KEYS, ...RECENT_PITCHER_KEYS, ...BULLPEN_KEYS])
  );
  const recentBoxscoreKeys = [
    ...MLB_RECENT_BATTING_FEATURE_KEYS,
    ...MLB_BULLPEN_QUALITY_FEATURE_KEYS,
  ];
  const recentBoxscoreRows = persistedRows.filter((row) =>
    hasKeys(row, recentBoxscoreKeys)
  );
  const fullAdvancedRows = persistedRows.filter((row) =>
    hasKeys(row, [
      ...SEASON_PITCHER_KEYS,
      ...RECENT_PITCHER_KEYS,
      ...BULLPEN_KEYS,
      ...recentBoxscoreKeys,
    ])
  );
  const bullpenAvailable = bullpenRows.length >= 300;
  const seasonPitcherAvailable = seasonPitcherRows.length >= 300;
  const recentPitcherAvailable = recentPitcherRows.length >= 300;
  const recentBoxscoreAvailable = recentBoxscoreRows.length >= 300;
  const rows = fullAdvancedRows.length >= 300
    ? fullAdvancedRows
    : recentPitcherAvailable
      ? recentPitcherRows
    : seasonPitcherAvailable
      ? seasonPitcherRows.filter((row) => hasKeys(row, BULLPEN_KEYS))
      : bullpenAvailable
        ? bullpenRows
        : persistedRows.length >= 300
          ? persistedRows
          : buildMlbHistoricalFeatureRows({});
  if (rows.length < 300) throw new Error('mlb_validation_rows_insufficient');
  const split = splitDevelopmentRows(rows);
  const ablations = evaluateAblations(split.train, split.selection, {
    bullpenAvailable,
    seasonPitcherAvailable,
    recentPitcherAvailable,
    recentBoxscoreAvailable,
  });
  const selected = ablations[0];

  // 特徵選定後，train + selection 可合併重訓；calibration/final test 仍完全隔離。
  const developmentRows = [...split.train, ...split.selection];
  const fit = fitMlbBaseline(developmentRows, {
    featureKeys: selected.featureKeys,
    holdout: false,
  });
  const calibrationChoice = selectCalibration(split.calibration, fit.model);
  const calibration = calibrationChoice.calibration;
  const finalTest = evaluateRows(split.finalTest, fit.model, calibration);
  const pitComparison = marketAlignedMetrics(split.finalTest, fit.model, calibration);
  // 特徵只由 selection 段決定；後續 folds 固定使用該組特徵，不再重新挑選。
  const seasonFolds = seasonForwardFolds(rows, selected.featureKeys);
  const rollingFolds = rollingBlockedFolds(rows, selected.featureKeys);
  const folds = [...seasonFolds, ...rollingFolds];
  const pitMarketSufficient = pitComparison.samples >= 100;
  const rawBeatsMarket = pitMarketSufficient &&
    pitComparison.modelRaw.brier < pitComparison.market.brier &&
    pitComparison.modelRaw.logLoss < pitComparison.market.logLoss;
  const calibratedBeatsMarket = pitMarketSufficient &&
    pitComparison.modelCalibrated.brier < pitComparison.market.brier &&
    pitComparison.modelCalibrated.logLoss < pitComparison.market.logLoss;
  const calibrationGeneralized =
    finalTest.calibrated.brier < finalTest.raw.brier &&
    finalTest.calibrated.logLoss < finalTest.raw.logLoss;
  const stableRollingFolds = rollingFolds.filter((fold) => {
    const comparison = fold.metrics.pitComparison;
    return comparison.modelRaw.brier < comparison.market.brier &&
      comparison.modelRaw.logLoss < comparison.market.logLoss;
  }).length;
  const deploymentBlockReasons = [
    ...(!pitMarketSufficient
      ? ['pit_market_sample_insufficient']
      : rawBeatsMarket
        ? []
        : ['raw_model_does_not_beat_pit_market']),
    ...(calibrationGeneralized ? [] : ['calibration_did_not_generalize']),
    ...(rollingFolds.length >= 3 && stableRollingFolds >= Math.ceil(rollingFolds.length * 0.75)
      ? []
      : ['rolling_fold_stability_insufficient']),
    ...(seasonFolds.length ? [] : ['cross_season_validation_unavailable']),
  ];
  const runId = `mlb-eval-${randomUUID()}`;
  const summary = {
    warning:
      'final test 僅評估已由 selection 段選定的特徵；不得以此報告直接宣稱盈利。',
    rows: rows.length,
    split: {
      train: { samples: split.train.length, ...dateRange(split.train) },
      selection: { samples: split.selection.length, ...dateRange(split.selection) },
      calibration: { samples: split.calibration.length, ...dateRange(split.calibration) },
      finalTest: { samples: split.finalTest.length, ...dateRange(split.finalTest) },
    },
    selectedFeatureSet: selected.key,
    selectedFeatureKeys: selected.featureKeys,
    selectionMetrics: selected.selection,
    calibration,
    calibrationSelection: calibrationChoice.selection,
    finalTest,
    pitComparison,
    deltaVsMarket: {
      rawBrier: pitComparison.modelRaw.brier != null && pitComparison.market.brier != null
        ? pitComparison.modelRaw.brier - pitComparison.market.brier
        : null,
      calibratedBrier:
        pitComparison.modelCalibrated.brier != null && pitComparison.market.brier != null
        ? pitComparison.modelCalibrated.brier - pitComparison.market.brier
        : null,
      rawLogLoss: pitComparison.modelRaw.logLoss != null && pitComparison.market.logLoss != null
        ? pitComparison.modelRaw.logLoss - pitComparison.market.logLoss
        : null,
      calibratedLogLoss:
        pitComparison.modelCalibrated.logLoss != null && pitComparison.market.logLoss != null
        ? pitComparison.modelCalibrated.logLoss - pitComparison.market.logLoss
        : null,
    },
    deploymentDecision: {
      eligible: deploymentBlockReasons.length === 0,
      blockReasons: deploymentBlockReasons,
      rawBeatsMarket,
      calibratedBeatsMarket,
      pitMarketSufficient,
      calibrationGeneralized,
      rollingFoldsBeatingMarket: stableRollingFolds,
      rollingFoldsTotal: rollingFolds.length,
    },
    ablations,
    seasonFolds: seasonFolds.map((fold) => ({
      foldKey: fold.foldKey,
      train: fold.train,
      calibration: fold.calibration,
      test: fold.test,
      metrics: fold.metrics,
    })),
    rollingFolds: rollingFolds.map((fold) => ({
      foldKey: fold.foldKey,
      train: fold.train,
      calibration: fold.calibration,
      test: fold.test,
      metrics: fold.metrics,
    })),
  };
  const run = {
    runId,
    featureVersion: MLB_BASELINE_FEATURE_VERSION,
    evalVersion: MLB_MODEL_EVAL_VERSION,
    evaluation: dateRange(rows),
    config: {
      split: '55% train / 15% selection / 15% calibration / 15% final test',
      calibration: 'platt',
      seasonFoldCalibration: 'first 20% of held-forward season',
    },
    summary,
  };
  if (persist) persistEvaluation(run, folds);
  return run;
}

export function runMlbFoundationValidation({ persist = true } = {}) {
  const rows = loadPersistedValidationRows().filter((row) =>
    MLB_FOUNDATION_FEATURE_KEYS.every((key) =>
      Number.isFinite(row.features?.vector?.[key])
    )
  );
  const bySeason = (season) => rows.filter((row) =>
    String(row.commenceTime).startsWith(String(season))
  );
  const train = bySeason(2024);
  const season2025 = bySeason(2025);
  const finalTestRows = bySeason(2026);
  if (train.length < 1000 || season2025.length < 1000 || finalTestRows.length < 300) {
    throw new Error('mlb_foundation_cross_season_rows_insufficient');
  }

  const selectionEnd = Math.floor(season2025.length * 0.65);
  const selection = season2025.slice(0, selectionEnd);
  const calibrationRows = season2025.slice(selectionEnd);
  const selectionFit = fitMlbBaseline(train, {
    featureKeys: MLB_FOUNDATION_FEATURE_KEYS,
    holdout: false,
  });
  const selectionMetrics = evaluateRows(selection, selectionFit.model).raw;
  const teamSelectionFit = fitMlbBaseline(train, {
    featureKeys: MLB_FOUNDATION_TEAM_FEATURE_KEYS,
    holdout: false,
  });
  const teamSelectionMetrics = evaluateRows(selection, teamSelectionFit.model).raw;
  const developmentRows = [...train, ...selection];
  const developmentFit = fitMlbBaseline(developmentRows, {
    featureKeys: MLB_FOUNDATION_FEATURE_KEYS,
    holdout: false,
  });
  const calibrationChoice = selectCalibration(calibrationRows, developmentFit.model);
  const calibration = calibrationChoice.calibration;
  const finalTest = evaluateRows(finalTestRows, developmentFit.model, calibration);
  const teamDevelopmentFit = fitMlbBaseline(developmentRows, {
    featureKeys: MLB_FOUNDATION_TEAM_FEATURE_KEYS,
    holdout: false,
  });
  const teamFinalTest = evaluateRows(finalTestRows, teamDevelopmentFit.model);
  const teamPitComparison = marketAlignedMetrics(
    finalTestRows,
    teamDevelopmentFit.model,
    { method: 'identity', intercept: 0, slope: 1 }
  );
  const pitComparison = marketAlignedMetrics(
    finalTestRows,
    developmentFit.model,
    calibration
  );
  const oddsDiagnostics = foundationOddsDiagnostics(
    finalTestRows,
    developmentFit.model
  );
  const pitMarketSufficient = pitComparison.samples >= 500;
  const rawBeatsMarket = pitMarketSufficient &&
    pitComparison.modelRaw.brier < pitComparison.market.brier &&
    pitComparison.modelRaw.logLoss < pitComparison.market.logLoss;
  const calibrationGeneralized =
    finalTest.calibrated.brier <= finalTest.raw.brier &&
    finalTest.calibrated.logLoss <= finalTest.raw.logLoss;
  const crossSeasonUseful =
    selectionMetrics.brier < 0.25 &&
    selectionMetrics.logLoss < Math.log(2);
  const foundationImprovesTeamBaseline =
    selectionMetrics.brier < teamSelectionMetrics.brier &&
    selectionMetrics.logLoss < teamSelectionMetrics.logLoss;
  const foundationImprovesTeamFinal =
    finalTest.raw.brier <= teamFinalTest.raw.brier &&
    finalTest.raw.logLoss <= teamFinalTest.raw.logLoss;
  const blockReasons = [
    ...(crossSeasonUseful ? [] : ['does_not_generalize_to_2025']),
    ...(foundationImprovesTeamBaseline ? [] : ['does_not_improve_team_baseline']),
    ...(foundationImprovesTeamFinal ? [] : ['does_not_improve_team_baseline_final']),
    ...(!pitMarketSufficient
      ? ['pit_market_sample_insufficient']
      : rawBeatsMarket
        ? []
        : ['raw_model_does_not_beat_2026_pit_market']),
    ...(calibrationGeneralized ? [] : ['calibration_did_not_generalize']),
  ];
  const delta = (modelValue, marketValue) =>
    modelValue != null && marketValue != null ? modelValue - marketValue : null;
  const summary = {
    warning: '固定 10 特徵地基模型；2024 訓練、2025 選擇與校準、2026 市場測試。',
    rows: rows.length,
    split: {
      train: { samples: train.length, ...dateRange(train) },
      selection: { samples: selection.length, ...dateRange(selection) },
      calibration: { samples: calibrationRows.length, ...dateRange(calibrationRows) },
      finalTest: { samples: finalTestRows.length, ...dateRange(finalTestRows) },
    },
    selectedFeatureSet: 'foundation_fixed_10',
    selectedFeatureKeys: MLB_FOUNDATION_FEATURE_KEYS,
    selectionMetrics,
    teamBaseline: {
      featureKeys: MLB_FOUNDATION_TEAM_FEATURE_KEYS,
      selectionMetrics: teamSelectionMetrics,
      finalTest: teamFinalTest,
      pitComparison: teamPitComparison,
    },
    calibration,
    calibrationSelection: calibrationChoice.selection,
    finalTest,
    pitComparison,
    oddsDiagnostics,
    deltaVsMarket: {
      rawBrier: delta(pitComparison.modelRaw.brier, pitComparison.market.brier),
      calibratedBrier: delta(
        pitComparison.modelCalibrated.brier,
        pitComparison.market.brier
      ),
      rawLogLoss: delta(
        pitComparison.modelRaw.logLoss,
        pitComparison.market.logLoss
      ),
      calibratedLogLoss: delta(
        pitComparison.modelCalibrated.logLoss,
        pitComparison.market.logLoss
      ),
    },
    deploymentDecision: {
      eligible: blockReasons.length === 0,
      blockReasons,
      crossSeasonUseful,
      foundationImprovesTeamBaseline,
      foundationImprovesTeamFinal,
      pitMarketSufficient,
      rawBeatsMarket,
      calibrationGeneralized,
    },
  };
  const run = {
    runId: `mlb-foundation-${randomUUID()}`,
    featureVersion: MLB_BASELINE_FEATURE_VERSION,
    evalVersion: MLB_FOUNDATION_EVAL_VERSION,
    evaluation: dateRange(rows),
    config: {
      split: '2024 train / first 65% of 2025 selection / last 35% calibration / 2026 final',
      featureContract: 'fixed_10',
      calibration: 'platt_if_generalized',
    },
    summary,
  };
  if (persist) {
    persistEvaluation(run, [{
      foldKey: '2024_to_2025',
      featureSet: 'foundation_fixed_10',
      train: dateRange(train),
      calibration: dateRange(calibrationRows),
      test: dateRange(selection),
      metrics: { selection: selectionMetrics },
    }]);
  }
  return run;
}

export function getLatestMlbModelValidation() {
  const row = db.prepare(`
    SELECT run_id, feature_version, eval_version, evaluation_from, evaluation_to,
           config_json, summary_json, created_at
    FROM mlb_model_eval_runs
    ORDER BY datetime(created_at) DESC, rowid DESC
    LIMIT 1
  `).get();
  if (!row) return null;
  return {
    runId: row.run_id,
    featureVersion: row.feature_version,
    evalVersion: row.eval_version,
    evaluation: { from: row.evaluation_from, to: row.evaluation_to },
    config: JSON.parse(row.config_json),
    summary: JSON.parse(row.summary_json),
    createdAt: row.created_at,
  };
}
