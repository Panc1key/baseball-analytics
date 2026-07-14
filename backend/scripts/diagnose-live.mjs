import db from '../src/db/database.js';
import { config } from '../src/config.js';
import { getLiveGames, runLiveAnalysis } from '../src/services/LiveAnalysisEngine.js';
import { analyzeMatchup } from '../src/services/TeamAnalyzer.js';
import { extractMarkets } from '../src/utils/odds.js';
import { projectLiveState } from '../src/models/LiveScoreModel.js';
import { enforceLiveDiscipline } from '../src/services/LiveDiscipline.js';
import { decimalToImpliedProb, decimalToNetOdds, calcEV, calibrateModelProb } from '../src/utils/odds.js';

const games = getLiveGames();
console.log('=== getLiveGames ===', games.length);
for (const g of games) {
  console.log(
    `${g.league} | ${g.away_team} @ ${g.home_team} | score ${g.away_score}-${g.home_score} | status=${g.status} | commence=${g.commence_time} | odds=${g.raw_odds ? 'Y' : 'N'}`
  );
}

const recs = db.prepare("SELECT COUNT(*) AS c FROM recommendations WHERE phase='live'").get();
console.log('live recs in DB:', recs.c);

const runs = db
  .prepare(
    `SELECT id, started_at, completed_at, recommendation_count, metadata_json
     FROM analysis_runs WHERE phase='live' ORDER BY started_at DESC LIMIT 3`
  )
  .all();
console.log('last runs:', runs);

console.log('\n=== diagnosing each live game ===');
for (const game of games) {
  let bookmakers = [];
  try {
    bookmakers = JSON.parse(game.raw_odds || '[]');
  } catch {
    console.log(game.id, 'bad raw_odds');
    continue;
  }
  const hasScore = game.home_score != null && game.away_score != null;
  const markets = extractMarkets(bookmakers);
  const h2hCount = Object.keys(markets.h2h || {}).length;
  const totalsCount = Object.keys(markets.totals || {}).length;

  const analysis = await analyzeMatchup(
    game.league,
    game.home_team,
    game.away_team,
    bookmakers,
    {}
  );

  const live = projectLiveState({
    commenceTime: game.commence_time,
    homeScore: Number(game.home_score) || 0,
    awayScore: Number(game.away_score) || 0,
    homeRunsPrior: analysis.homeRuns ?? 4.0,
    awayRunsPrior: analysis.awayRuns ?? 4.0,
    priorHomeWin: analysis.homeWinProb ?? 0.5,
  });

  console.log(`\n${game.league} ${game.away_team} @ ${game.home_team}`);
  console.log(
    `  hasScore=${hasScore} scores=${game.away_score}-${game.home_score} h2hMarkets=${h2hCount} totals=${totalsCount}`
  );
  console.log(
    `  priorWin home=${(analysis.homeWinProb * 100).toFixed(1)}% liveWin home=${(live.homeWinProb * 100).toFixed(1)}% innings=${live.inningsPlayed}/${live.inningsRemaining} source=${live.inningSource}`
  );

  if (!hasScore) {
    console.log('  REJECT: no score');
    continue;
  }

  // evaluate both h2h sides quickly
  for (const [team, side] of [
    [game.home_team, 'home'],
    [game.away_team, 'away'],
  ]) {
    const odds = markets.h2h?.[team];
    if (!odds?.price) {
      console.log(`  h2h ${side}: no odds`);
      continue;
    }
    const rawProb = side === 'home' ? live.homeWinProb : live.awayWinProb;
    const implied = decimalToImpliedProb(odds.price);
    const modelProb = calibrateModelProb(rawProb, implied, config.liveMaxModelEdgePct ?? 0.045);
    const ev = calcEV(modelProb, decimalToNetOdds(odds.price));
    const edge = (modelProb - implied) * 100;
    const disc = enforceLiveDiscipline(
      {
        market: 'h2h',
        modelProb,
        impliedProb: implied,
        ev,
        edgeProb: edge,
        dataQuality: hasScore ? 0.7 : 0.3,
        pick: team,
      },
      { hasScore, live }
    );
    console.log(
      `  h2h ${team} @${odds.price} raw=${(rawProb * 100).toFixed(1)}% cal=${(modelProb * 100).toFixed(1)}% imp=${(implied * 100).toFixed(1)}% ev=${(ev * 100).toFixed(1)}% edge=${edge.toFixed(1)}% ok=${disc.ok} reject=${disc.rejectReasons.join('; ') || '-'}`
    );
  }
}
