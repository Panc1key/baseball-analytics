import { getMlbPrematchTruthSlate } from '../src/services/MlbPrematchTruthPipeline.js';
import {
  classifyMlbMoneylineCandidate,
  MLB_EXPECTED_RUNS_MODEL_VERSION,
} from '../src/services/MlbExpectedRunsModel.js';

const limit = Math.max(1, Number(process.argv[2]) || 8);
const slate = getMlbPrematchTruthSlate({ from: new Date().toISOString() });
const recommendations = [];
const valueWatch = [];

for (const game of slate.games || []) {
  const prediction = game.expectedRuns?.prediction;
  const oddsEvidence = game.evidence?.find((item) => item.key === 'odds');
  const market = oddsEvidence?.values;
  if (
    game.expectedRuns?.status !== 'research_scored' ||
    game.expectedRuns?.modelVersion !== MLB_EXPECTED_RUNS_MODEL_VERSION ||
    !prediction ||
    !market?.homeOdds ||
    !market?.awayOdds
  ) continue;

  const classification = classifyMlbMoneylineCandidate({
    prediction,
    market,
    modelStatus: game.expectedRuns.status,
  });
  if (!['recommendation', 'value_watch'].includes(classification.tier)) continue;
  const candidate = {
    gameId: game.gameId,
    commenceTime: game.commenceTime,
    matchup: `${game.awayTeam} @ ${game.homeTeam}`,
    modelStatus: game.expectedRuns.status,
    modelVersion: game.expectedRuns.modelVersion,
    expectedScore: {
      away: prediction.awayExpectedRuns,
      home: prediction.homeExpectedRuns,
    },
    bookmaker: market.bookmaker,
    pick: classification.side === 'home' ? game.homeTeam : game.awayTeam,
    ...classification,
  };
  if (classification.tier === 'recommendation') recommendations.push(candidate);
  else valueWatch.push(candidate);
}

const ranking = (a, b) =>
  b.modelProbability - a.modelProbability ||
  b.expectedRunMargin - a.expectedRunMargin ||
  b.expectedValue - a.expectedValue ||
  String(a.commenceTime).localeCompare(String(b.commenceTime))
;
recommendations.sort(ranking);
valueWatch.sort(ranking);

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: 'research_only',
  ranking: 'calibrated win probability, expected run margin, then EV',
  availableRecommendations: recommendations.length,
  returnedRecommendations: Math.min(limit, recommendations.length),
  recommendations: recommendations.slice(0, limit),
  valueWatch,
}, null, 2));
