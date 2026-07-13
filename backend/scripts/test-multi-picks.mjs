import { getMlbStandings } from '../src/services/MlbStatsService.js';
import { analyzeMatchup } from '../src/services/TeamAnalyzer.js';
import { pickGameRecommendations } from '../src/services/RecommendationRules.js';
import { extractMarkets } from '../src/utils/odds.js';
import db from '../src/db/database.js';

const standings = await getMlbStandings();
const games = db.prepare("SELECT * FROM games WHERE league='MLB'").all();
let multi = 0;

for (const game of games) {
  const bookmakers = JSON.parse(game.raw_odds || '[]');
  if (!bookmakers.length) continue;
  const analysis = await analyzeMatchup('MLB', game.home_team, game.away_team, bookmakers, {
    mlbStandings: standings,
  });
  const picks = pickGameRecommendations(game, extractMarkets(bookmakers), analysis, 'test', {
    bookmakers,
  });
  if (picks.length >= 2) {
    multi += 1;
    console.log(`${game.away_team} @ ${game.home_team}`);
    for (const p of picks) {
      console.log(
        `  #${p.pickRank} ${p.rankLabel} | ${p.market} ${p.pick} @${p.oddsDecimal?.toFixed(2)} | 建議${p.suggestedStake}元 (×${p.stakeMultiplier}) | flat:${p.bet_strategy || '-'}`
      );
    }
    console.log('');
  }
}

console.log(`共 ${multi} 場有 2+ 條推薦`);
