/**
 * 投手優先 vs 打擊優先：用歷史賽果檢驗方向一致性。
 * 只做診斷／對照，不自動改正式模型。
 */
import db from '../src/db/database.js';
import {
  MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS,
  MLB_EXPECTED_RUNS_BATTING_FEATURE_KEYS,
  MLB_EXPECTED_RUNS_BULLPEN_FEATURE_KEYS,
  MLB_EXPECTED_RUNS_STARTER_STRENGTH_FEATURE_KEYS,
  MLB_EXPECTED_RUNS_BULLPEN_STRENGTH_FEATURE_KEYS,
  MLB_EXPECTED_RUNS_PLATOON_FEATURE_KEYS,
  MLB_EXPECTED_RUNS_PARK_FEATURE_KEYS,
  buildMlbExpectedRunsExamples,
  fitMlbExpectedRunsModel,
  predictMlbGameRuns,
  getLatestMlbExpectedRunsValidation,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import { getCachedMlbGameWeather } from '../src/services/MlbGameWeatherService.js';

function loadRows() {
  return db.prepare(`
    SELECT f.game_id AS gameId, f.commence_time AS commenceTime,
           f.features_json AS featuresJson,
           g.home_team AS homeTeam, g.away_team AS awayTeam,
           g.home_score AS homeScore, g.away_score AS awayScore
    FROM mlb_historical_feature_rows f
    JOIN games g ON g.id = f.game_id
    WHERE f.feature_version = 'mlb-foundation-pit-v1'
      AND g.completed = 1
      AND g.home_score IS NOT NULL
      AND g.away_score IS NOT NULL
      AND datetime(f.commence_time) >= datetime('2025-05-01')
    ORDER BY datetime(f.commence_time), f.game_id
  `).all().map((row) => {
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
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      homeScore: Number(row.homeScore),
      awayScore: Number(row.awayScore),
      features,
    };
  });
}

function evaluate(rows, model) {
  let directionHits = 0;
  let decisive = 0;
  let totalAbs = 0;
  let marginCorrNum = 0;
  let marginCorrDenPred = 0;
  let marginCorrDenAct = 0;
  let predMargins = [];
  let actMargins = [];
  let brier = 0;
  const buckets = {
    'all': { n: 0, hits: 0 },
    'margin>=0.5': { n: 0, hits: 0 },
    'margin>=1.0': { n: 0, hits: 0 },
    'prob>=55%': { n: 0, hits: 0 },
    'prob>=60%': { n: 0, hits: 0 },
  };

  for (const row of rows) {
    const pred = predictMlbGameRuns(model, row.features);
    const actMargin = row.homeScore - row.awayScore;
    const predMargin = pred.homeExpectedRuns - pred.awayExpectedRuns;
    const homeWon = row.homeScore > row.awayScore ? 1 : 0;
    totalAbs += Math.abs(pred.expectedTotal - row.homeScore - row.awayScore);
    brier += (pred.markets.homeWinProbability - homeWon) ** 2;
    predMargins.push(predMargin);
    actMargins.push(actMargin);

    if (actMargin !== 0) {
      decisive += 1;
      const hit = (predMargin >= 0 && homeWon === 1) || (predMargin < 0 && homeWon === 0);
      if (hit) directionHits += 1;
      const pHome = pred.markets.homeWinProbability;
      const conf = Math.max(pHome, 1 - pHome);
      const absMargin = Math.abs(predMargin);
      const mark = (key, ok) => {
        buckets[key].n += 1;
        if (ok) buckets[key].hits += 1;
      };
      mark('all', hit);
      if (absMargin >= 0.5) mark('margin>=0.5', hit);
      if (absMargin >= 1.0) mark('margin>=1.0', hit);
      if (conf >= 0.55) mark('prob>=55%', hit);
      if (conf >= 0.60) mark('prob>=60%', hit);
    }
  }

  const mean = (arr) => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
  const mp = mean(predMargins);
  const ma = mean(actMargins);
  for (let i = 0; i < predMargins.length; i += 1) {
    marginCorrNum += (predMargins[i] - mp) * (actMargins[i] - ma);
    marginCorrDenPred += (predMargins[i] - mp) ** 2;
    marginCorrDenAct += (actMargins[i] - ma) ** 2;
  }

  return {
    samples: rows.length,
    decisiveGames: decisive,
    directionHitRate: decisive ? directionHits / decisive : null,
    predMarginVsActualMarginCorr:
      marginCorrNum / Math.sqrt(Math.max(1e-12, marginCorrDenPred * marginCorrDenAct)),
    totalRunsMae: totalAbs / rows.length,
    moneylineBrier: brier / rows.length,
    buckets: Object.fromEntries(
      Object.entries(buckets).map(([key, value]) => [
        key,
        {
          samples: value.n,
          hits: value.hits,
          hitRate: value.n ? value.hits / value.n : null,
        },
      ])
    ),
  };
}

const rows = loadRows();
const development = rows.filter((row) => row.commenceTime < '2026-01-01');
const observed2026 = rows.filter((row) => row.commenceTime >= '2026-01-01');
const split = Math.floor(development.length * 0.7);
const train = development.slice(0, split);
const validation = development.slice(split);

const candidates = [
  {
    key: 'pitcher_core',
    featureKeys: [...MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS],
  },
  {
    key: 'v43_core_plus_batting',
    featureKeys: [
      ...MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_BATTING_FEATURE_KEYS,
    ],
  },
  {
    key: 'v45_platoon',
    featureKeys: [
      ...MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_PLATOON_FEATURE_KEYS,
    ],
  },
  {
    key: 'v45_batting_platoon',
    featureKeys: [
      ...MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_BATTING_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_PLATOON_FEATURE_KEYS,
    ],
  },
  {
    key: 'v44_starter_strength',
    featureKeys: [
      ...MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_STARTER_STRENGTH_FEATURE_KEYS,
    ],
  },
  {
    key: 'v44_pitching_stack',
    featureKeys: [
      ...MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_STARTER_STRENGTH_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_BULLPEN_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_BULLPEN_STRENGTH_FEATURE_KEYS,
    ],
  },
  {
    key: 'v45_batting_platoon_pitching',
    featureKeys: [
      ...MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_BATTING_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_PLATOON_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_STARTER_STRENGTH_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_BULLPEN_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_BULLPEN_STRENGTH_FEATURE_KEYS,
    ],
  },
  {
    key: 'batting_park',
    featureKeys: [
      ...MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_BATTING_FEATURE_KEYS,
      ...MLB_EXPECTED_RUNS_PARK_FEATURE_KEYS,
    ],
  },
];

const trainExamples = buildMlbExpectedRunsExamples(train);
const report = candidates.map((candidate) => {
  const model = fitMlbExpectedRunsModel(trainExamples, {
    featureKeys: candidate.featureKeys,
  });
  const starterKeys = candidate.featureKeys.filter((key) =>
    /Starter|Bullpen|parkFactor/.test(key)
  );
  const battingKeys = candidate.featureKeys.filter((key) =>
    /offenseObp|offenseSlg|offenseKMinusBb|offenseRecentRpg/.test(key)
  );
  return {
    key: candidate.key,
    featureCount: candidate.featureKeys.length,
    starterishKeys: starterKeys,
    battingKeys,
    validation: evaluate(validation, model),
    observed2026: evaluate(observed2026, model),
  };
});

report.sort((a, b) =>
  b.validation.directionHitRate - a.validation.directionHitRate ||
  a.validation.moneylineBrier - b.validation.moneylineBrier
);

const latest = getLatestMlbExpectedRunsValidation();
const dataCheck = {
  hasHistoricalResults: true,
  developmentGames: development.length,
  validationGames: validation.length,
  observed2026Games: observed2026.length,
  sample: development[0] && {
    gameId: development[0].gameId,
    commenceTime: development[0].commenceTime,
    homeTeam: development[0].homeTeam,
    awayTeam: development[0].awayTeam,
    actualScore: `${development[0].homeScore}-${development[0].awayScore}`,
  },
  currentPersistedModel: latest?.modelVersion ?? null,
  currentSelectedKeys: latest?.model?.featureKeys ?? null,
};

console.log(JSON.stringify({
  dataCheck,
  rankingNote:
    'directionHitRate = 預測分差方向是否與實際勝負一致；這最直接檢驗「投手優先改權重」有沒有對。',
  rankedByValidationDirection: report,
}, null, 2));
