import { getMlbPrematchTruthSlate } from '../src/services/MlbPrematchTruthPipeline.js';

const limit = Math.max(1, Number(process.argv[2]) || 8);
const slate = getMlbPrematchTruthSlate({ from: new Date().toISOString() });
const candidates = [];

for (const game of slate.games || []) {
  const prediction = game.expectedRuns?.prediction;
  const oddsEvidence = game.evidence?.find((item) => item.key === 'odds');
  const market = oddsEvidence?.values;
  if (
    game.expectedRuns?.status !== 'research_scored' ||
    !prediction ||
    !market?.homeOdds ||
    !market?.awayOdds
  ) continue;

  const sides = [
    {
      side: 'home',
      pick: game.homeTeam,
      modelProbability: prediction.markets?.homeWinProbability,
      marketProbability: market.homeProb,
      odds: market.homeOdds,
    },
    {
      side: 'away',
      pick: game.awayTeam,
      modelProbability: prediction.markets?.awayWinProbability,
      marketProbability: market.awayProb,
      odds: market.awayOdds,
    },
  ].map((row) => ({
    ...row,
    edge: row.modelProbability - row.marketProbability,
    expectedValue: row.modelProbability * row.odds - 1,
  }));
  const best = sides.sort((a, b) =>
    b.edge - a.edge || b.expectedValue - a.expectedValue
  )[0];
  if (!(best.edge > 0 && best.expectedValue > 0)) continue;
  candidates.push({
    gameId: game.gameId,
    commenceTime: game.commenceTime,
    matchup: `${game.awayTeam} @ ${game.homeTeam}`,
    modelStatus: game.expectedRuns.status,
    expectedScore: {
      away: prediction.awayExpectedRuns,
      home: prediction.homeExpectedRuns,
    },
    bookmaker: market.bookmaker,
    ...best,
  });
}

candidates.sort((a, b) =>
  b.edge - a.edge ||
  b.expectedValue - a.expectedValue ||
  String(a.commenceTime).localeCompare(String(b.commenceTime))
);

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: 'research_only',
  ranking: 'model probability minus no-vig market probability',
  available: candidates.length,
  returned: Math.min(limit, candidates.length),
  candidates: candidates.slice(0, limit),
}, null, 2));
