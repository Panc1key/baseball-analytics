import { OddsApiClient } from '../src/services/OddsApiClient.js';
import { LEAGUES } from '../src/config.js';

const client = new OddsApiClient();
const scores = await client.getScores(LEAGUES.NPB.key, 1);
const liveish = (scores || []).filter((g) => !g.completed);
console.log('NPB scores total', scores?.length, 'not completed', liveish.length);
for (const g of liveish.slice(0, 10)) {
  console.log({
    id: g.id,
    commence: g.commence_time,
    home: g.home_team,
    away: g.away_team,
    completed: g.completed,
    scores: g.scores,
    last_update: g.last_update,
  });
}

// also try daysFrom=3
const scores3 = await client.getScores(LEAGUES.NPB.key, 3);
const match = (scores3 || []).find((g) => /Hanshin|Tigers/i.test(g.away_team || '') || /Hanshin|Tigers/i.test(g.home_team || ''));
console.log('\nHanshin sample daysFrom=3:', match ? {
  completed: match.completed,
  scores: match.scores,
  commence: match.commence_time,
  home: match.home_team,
  away: match.away_team,
} : 'not found');
