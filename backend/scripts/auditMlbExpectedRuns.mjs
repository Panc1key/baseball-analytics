import db from '../src/db/database.js';
import {
  buildMlbExpectedRunsExamples,
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';

const raw = db.prepare(`
  SELECT f.game_id AS gameId, f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
         g.home_score AS homeScore, g.away_score AS awayScore
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  WHERE f.feature_version = ?
  ORDER BY f.commence_time
`).all('mlb-foundation-pit-v1');
const rows = raw.map((row) => ({
  ...row,
  features: JSON.parse(row.featuresJson),
}));
const model = getLatestMlbExpectedRunsValidation()?.model;
if (!model) throw new Error('mlb_expected_runs_model_missing');

const report = {};
const highConfidenceRows = [];
for (const year of ['2024', '2025', '2026']) {
  const seasonRows = rows.filter((row) => row.commenceTime.startsWith(year));
  const examples = buildMlbExpectedRunsExamples(seasonRows);
  const averageFeature = (key) =>
    examples.reduce((sum, row) => sum + row.vector[key], 0) / examples.length;
  let predictedHome = 0;
  let actualHome = 0;
  let predictedAway = 0;
  let actualAway = 0;
  let highConfidence = 0;
  let highConfidenceBothStartersKnown = 0;
  for (const row of seasonRows) {
    const prediction = predictMlbGameRuns(model, row.features);
    predictedHome += prediction.homeExpectedRuns;
    actualHome += Number(row.homeScore);
    predictedAway += prediction.awayExpectedRuns;
    actualAway += Number(row.awayScore);
    if (
      Math.max(
        prediction.markets.homeWinProbability,
        prediction.markets.awayWinProbability
      ) >= 0.6
    ) {
      highConfidence += 1;
      const gameExamples = buildMlbExpectedRunsExamples([row]);
      if (year === '2026') {
        highConfidenceRows.push({
          gameId: row.gameId,
          commenceTime: row.commenceTime,
          probability: Math.max(
            prediction.markets.homeWinProbability,
            prediction.markets.awayWinProbability
          ),
          homeExpectedRuns: prediction.homeExpectedRuns,
          awayExpectedRuns: prediction.awayExpectedRuns,
          actual: `${row.homeScore}-${row.awayScore}`,
          home: gameExamples[0].vector,
          away: gameExamples[1].vector,
        });
      }
      if (gameExamples.every((entry) => entry.vector.starterKnown)) {
        highConfidenceBothStartersKnown += 1;
      }
    }
  }
  report[year] = {
    games: seasonRows.length,
    actualHomeRuns: actualHome / seasonRows.length,
    predictedHomeRuns: predictedHome / seasonRows.length,
    actualAwayRuns: actualAway / seasonRows.length,
    predictedAwayRuns: predictedAway / seasonRows.length,
    starterCoverage: averageFeature('starterKnown'),
    bullpenCoverage: averageFeature('bullpenKnown'),
    highConfidence,
    highConfidenceBothStartersKnown,
  };
}

console.log(JSON.stringify({
  modelVersion: model.modelVersion,
  dispersion: model.dispersion,
  weights: model.weights,
  seasons: report,
  highConfidence2026: highConfidenceRows
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 10),
}, null, 2));
