import db from '../src/db/database.js';
import { extractFairH2h3, extractSoccerMarkets } from '../src/football/utils/footballOdds.js';
import { analyzeFootballMatchup } from '../src/football/FootballTeamAnalyzer.js';

const game = db
  .prepare(
    `SELECT * FROM games WHERE home_team='France' AND away_team='Morocco' ORDER BY commence_time DESC LIMIT 1`
  )
  .get();

if (!game) {
  console.log(JSON.stringify({ error: 'no game found' }));
  process.exit(0);
}

const bookmakers = JSON.parse(game.raw_odds || '[]');
const fair = extractFairH2h3(bookmakers, 'France', 'Morocco');
const markets = extractSoccerMarkets(bookmakers);
const analysis = await analyzeFootballMatchup(
  'WC',
  'France',
  'Morocco',
  bookmakers,
  game.commence_time
);

function pois(k, l) {
  const facts = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880];
  return (Math.exp(-l) * Math.pow(l, k)) / facts[k];
}

const total = analysis.totalsProjection.modelTotal;
const share = analysis.homeWinProb / (analysis.homeWinProb + analysis.awayWinProb + 0.001);
const lambdaF = total * share * 1.08;
const lambdaM = total * (1 - share) * 0.85;
const scores = [];
for (let h = 0; h <= 4; h++) {
  for (let a = 0; a <= 4; a++) {
    const p = pois(h, lambdaF) * pois(a, lambdaM);
    if (p >= 0.025) scores.push({ score: `${h}-${a}`, p });
  }
}
scores.sort((a, b) => b.p - a.p);

const pinnacle = bookmakers.find((b) => /pinnacle/i.test(b.title));
const pinH2h = pinnacle?.markets?.find((m) => m.key === 'h2h')?.outcomes;
const pinTotals = pinnacle?.markets?.find((m) => m.key === 'totals')?.outcomes;

const franceStats = db
  .prepare(`SELECT * FROM team_stats WHERE league='WC' AND team_name='France'`)
  .get();
const moroccoStats = db
  .prepare(`SELECT * FROM team_stats WHERE league='WC' AND team_name='Morocco'`)
  .get();

const wcGames = db
  .prepare(
    `SELECT home_team, away_team, home_score, away_score FROM games WHERE league='WC' AND completed=1`
  )
  .all();

console.log(
  JSON.stringify(
    {
      commence: game.commence_time,
      fairMarket: fair,
      model: {
        france: analysis.homeWinProb,
        draw: analysis.drawProb,
        morocco: analysis.awayWinProb,
      },
      totals: {
        modelTotal: analysis.totalsProjection.modelTotal,
        marketLine: analysis.totalsProjection.marketLine,
        marketOverProb: analysis.totalsProjection.marketOverProb,
      },
      pinnacle: { h2h: pinH2h, totals: pinTotals },
      bestMarkets: { h2h: markets.h2h, totals: markets.totals },
      topCorrectScores: scores.slice(0, 10),
      poissonLambdas: { france: lambdaF, morocco: lambdaM },
      factors: analysis.factors,
      franceStats,
      moroccoStats,
      wcCompletedGames: wcGames.length,
    },
    null,
    2
  )
);
