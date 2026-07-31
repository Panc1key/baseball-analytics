import db from '../src/db/database.js';
import {
  classifyMlbMoneylineCandidate,
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';

const from = process.argv[2] || new Date().toISOString().slice(0, 10);
const to = process.argv[3] || null;
const rows = db.prepare(`
  WITH latest AS (
    SELECT *,
           ROW_NUMBER() OVER (
             PARTITION BY game_id
             ORDER BY datetime(captured_at) DESC, id DESC
           ) AS rn
    FROM mlb_prematch_truth_snapshots
    WHERE datetime(commence_time) >= datetime(?)
      AND (? IS NULL OR datetime(commence_time) < datetime(?))
  )
  SELECT *
  FROM latest
  WHERE rn = 1
  ORDER BY datetime(commence_time), game_id
`).all(from, to, to);
const validation = getLatestMlbExpectedRunsValidation();
if (!validation?.model) throw new Error('mlb_expected_runs_model_missing');

const games = rows.flatMap((row) => {
  const evidence = JSON.parse(row.evidence_json || '[]');
  const modelInput = JSON.parse(row.model_input_json || '{}');
  const item = (key) => evidence.find((entry) => entry.key === key)?.values;
  const history = item('model_history');
  const starters = item('starting_pitchers');
  const market = item('odds');
  if (!history?.home || !history?.away || !starters?.home || !starters?.away) return [];
  const features = {
    home: history.home,
    away: history.away,
    pitchers: {
      home: starters.home.pregameStats,
      away: starters.away.pregameStats,
      homeRecent: starters.home.recentStartStats,
      awayRecent: starters.away.recentStartStats,
    },
  };
  const prediction = predictMlbGameRuns(validation.model, features);
  const classification = classifyMlbMoneylineCandidate({
    prediction,
    market,
    modelStatus:
      starters.identitySnapshot?.status === 'complete' && !(starters.conflicts || []).length
        ? 'research_scored'
        : 'research_scored_fallback',
  });
  const previous = modelInput.expectedRuns?.prediction;
  return [{
    gameId: row.game_id,
    commenceTime: row.commence_time,
    matchup: `${row.away_team} @ ${row.home_team}`,
    previousModelVersion: modelInput.expectedRuns?.modelVersion || null,
    previousExpectedTotal: previous?.expectedTotal ?? null,
    expectedTotal: prediction.expectedTotal,
    expectedScore: {
      away: prediction.awayExpectedRuns,
      home: prediction.homeExpectedRuns,
    },
    maximumAbsoluteZScore: prediction.dataQuality.maximumAbsoluteZScore,
    tier: classification.tier,
    side: classification.side,
    modelProbability: classification.modelProbability,
    expectedRunMargin: classification.expectedRunMargin,
    expectedValue: classification.expectedValue,
    reasons: classification.reasons,
  }];
});

const average = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;
const previousTotals = games
  .map((game) => Number(game.previousExpectedTotal))
  .filter(Number.isFinite);

console.log(JSON.stringify({
  from,
  to,
  modelVersion: validation.modelVersion,
  games: games.length,
  previousAverageExpectedTotal: average(previousTotals),
  averageExpectedTotal: average(games.map((game) => game.expectedTotal)),
  outOfDistributionGames: games.filter((game) => game.maximumAbsoluteZScore > 3.5).length,
  recommendations: games.filter((game) => game.tier === 'recommendation'),
  valueWatch: games.filter((game) => game.tier === 'value_watch'),
  blocked: games.filter((game) => game.tier === 'blocked'),
  replay: games,
}, null, 2));
