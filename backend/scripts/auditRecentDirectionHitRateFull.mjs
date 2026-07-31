/**
 * 近 N 個月勝方方向命中率（不強制 boxscore，覆蓋完整 2026 特徵列）。
 */
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  predictMlbGameRunsWithRegime,
} from '../src/services/MlbExpectedRunsModel.js';
import { labelGameRegimeFromScores } from '../src/services/MlbGameRegimeService.js';

const months = Number(process.argv[2] || 3);
const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) throw new Error('mlb_expected_runs_model_missing');

const since = new Date();
since.setUTCMonth(since.getUTCMonth() - months);
const sinceIso = since.toISOString().slice(0, 10);

const rows = db.prepare(`
  SELECT f.game_id AS gameId,
         f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
         g.home_team AS homeTeam,
         g.away_team AS awayTeam,
         g.home_score AS homeScore,
         g.away_score AS awayScore
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  WHERE f.feature_version = ?
    AND g.completed = 1
    AND g.home_score IS NOT NULL
    AND g.away_score IS NOT NULL
    AND date(f.commence_time) >= date(?)
  ORDER BY f.commence_time
`).all(MLB_BASELINE_FEATURE_VERSION, sinceIso);

function empty() {
  return { n: 0, hitsBase: 0, hitsRegime: 0, ties: 0 };
}

const overall = empty();
const byMonth = new Map();
const byScoreRegime = {
  duel: empty(),
  normal: empty(),
  blowup: empty(),
};

let sideAbsBase = 0;
let sideAbsRegime = 0;
let sideN = 0;

for (const row of rows) {
  let features;
  try {
    features = JSON.parse(row.featuresJson);
  } catch {
    continue;
  }
  const homeScore = Number(row.homeScore);
  const awayScore = Number(row.awayScore);
  const monthKey = String(row.commenceTime).slice(0, 7);
  if (!byMonth.has(monthKey)) byMonth.set(monthKey, empty());

  const scoreRegime = labelGameRegimeFromScores(homeScore, awayScore).regime || 'normal';
  const base = predictMlbGameRuns(model, features);
  const regime = predictMlbGameRunsWithRegime(model, features);

  sideAbsBase += Math.abs(base.homeExpectedRuns - homeScore) +
    Math.abs(base.awayExpectedRuns - awayScore);
  sideAbsRegime += Math.abs(regime.homeExpectedRuns - homeScore) +
    Math.abs(regime.awayExpectedRuns - awayScore);
  sideN += 2;

  const tie = homeScore === awayScore;
  const actHome = homeScore > awayScore;
  const touch = (bucket) => {
    if (tie) {
      bucket.ties += 1;
      return;
    }
    bucket.n += 1;
    if ((base.homeExpectedRuns >= base.awayExpectedRuns) === actHome) bucket.hitsBase += 1;
    if ((regime.homeExpectedRuns >= regime.awayExpectedRuns) === actHome) {
      bucket.hitsRegime += 1;
    }
  };

  touch(overall);
  touch(byMonth.get(monthKey));
  touch(byScoreRegime[scoreRegime]);
}

function fmt(b) {
  return {
    decidedGames: b.n,
    tiesExcluded: b.ties,
    baselineHitRate: b.n ? Number((b.hitsBase / b.n).toFixed(4)) : null,
    regimeHitRate: b.n ? Number((b.hitsRegime / b.n).toFixed(4)) : null,
    baselineWins: b.hitsBase,
    baselineLosses: b.n - b.hitsBase,
    regimeWins: b.hitsRegime,
    regimeLosses: b.n - b.hitsRegime,
  };
}

const first = rows[0]?.commenceTime || null;
const last = rows.at(-1)?.commenceTime || null;

console.log(JSON.stringify({
  ok: true,
  modelVersion: validation.modelVersion,
  windowMonths: months,
  since: sinceIso,
  sample: {
    games: rows.length,
    firstCommence: first,
    lastCommence: last,
  },
  clarify: {
    previous559: '先前 55.9% 來自約 4884 場（多為 2024-2025 official 列）混合樣本',
    thisReport: '本報告僅用近 N 個月、全部有特徵的完賽列（含 2026 hash id）',
    metric: '勝方方向命中（預期得分較高邊是否贏），不是投注 ROI',
  },
  overall: fmt(overall),
  sideMae: {
    baseline: sideN ? Number((sideAbsBase / sideN).toFixed(3)) : null,
    regime: sideN ? Number((sideAbsRegime / sideN).toFixed(3)) : null,
  },
  byMonth: Object.fromEntries(
    [...byMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => [k, fmt(v)])
  ),
  byScoreOnlyRegime: {
    lowTotal_le5: fmt(byScoreRegime.duel),
    midTotal: fmt(byScoreRegime.normal),
    highTotal_ge14: fmt(byScoreRegime.blowup),
  },
}, null, 2));
