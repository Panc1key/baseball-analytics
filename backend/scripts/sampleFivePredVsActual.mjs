import db from '../src/db/database.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';

const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) throw new Error('mlb_expected_runs_model_missing');

const limit = Number(process.argv[2] || 20);
const pool = Math.max(limit * 4, 80);

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
    AND g.commence_time >= '2026-01-01'
  ORDER BY f.commence_time DESC
  LIMIT ?
`).all(MLB_BASELINE_FEATURE_VERSION, pool);

const picked = [];
const step = Math.max(1, Math.floor(rows.length / limit));
for (let i = 0; i < rows.length && picked.length < limit; i += step) {
  picked.push(rows[i]);
}

const games = picked.map((row) => {
  const features = JSON.parse(row.featuresJson);
  const p = predictMlbGameRuns(model, features);
  const predHome = Number(p.homeExpectedRuns.toFixed(2));
  const predAway = Number(p.awayExpectedRuns.toFixed(2));
  const actHome = Number(row.homeScore);
  const actAway = Number(row.awayScore);
  const predWinner = predHome >= predAway ? 'home' : 'away';
  const actWinner = actHome === actAway ? 'tie' : (actHome > actAway ? 'home' : 'away');
  return {
    date: String(row.commenceTime).slice(0, 10),
    matchup: `${row.awayTeam} @ ${row.homeTeam}`,
    predictedAwayHome: `${predAway} - ${predHome}`,
    actualAwayHome: `${actAway} - ${actHome}`,
    predTotal: Number((predHome + predAway).toFixed(2)),
    actualTotal: actHome + actAway,
    homeErr: Number((predHome - actHome).toFixed(2)),
    awayErr: Number((predAway - actAway).toFixed(2)),
    totalErr: Number(((predHome + predAway) - (actHome + actAway)).toFixed(2)),
    marginPredHomeMinusAway: Number((predHome - predAway).toFixed(2)),
    marginActHomeMinusAway: actHome - actAway,
    winnerHit: actWinner === 'tie' ? null : predWinner === actWinner,
  };
});

const abs = (v) => Math.abs(v);
const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
const winnerKnown = games.filter((g) => g.winnerHit != null);

console.log(JSON.stringify({
  modelVersion: validation.modelVersion,
  note: 'predictedAwayHome / actualAwayHome 皆為 客 - 主；err = 預測 - 實際',
  summary: {
    n: games.length,
    sideMae: Number(mean(games.flatMap((g) => [abs(g.homeErr), abs(g.awayErr)])).toFixed(2)),
    totalMae: Number(mean(games.map((g) => abs(g.totalErr))).toFixed(2)),
    winnerHitRate: winnerKnown.length
      ? Number((winnerKnown.filter((g) => g.winnerHit).length / winnerKnown.length).toFixed(3))
      : null,
  },
  games,
}, null, 2));
