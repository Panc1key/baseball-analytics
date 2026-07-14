import db from '../src/db/database.js';
import { buildParlaysFromDb } from '../src/services/ParlayBuilder.js';
import { BASEBALL_LEAGUE_SQL } from '../src/config.js';

const games = db
  .prepare(
    `SELECT id, home_team, away_team, commence_time,
      CASE WHEN raw_odds IS NOT NULL AND raw_odds != '[]' THEN 1 ELSE 0 END as has_odds
     FROM games
     WHERE league IN (${BASEBALL_LEAGUE_SQL}) AND completed = 0
       AND datetime(commence_time) > datetime('now')
       AND datetime(commence_time) < datetime('now', '+2 day')
     ORDER BY commence_time`
  )
  .all();

console.log('Upcoming baseball games:', games.length);
for (const g of games) {
  const recs = db
    .prepare(
      `SELECT market, pick, tier, bet_strategy, model_prob, odds_decimal, score
       FROM recommendations WHERE game_id = ? ORDER BY tier, score DESC`
    )
    .all(g.id);
  console.log(
    g.commence_time,
    '|',
    g.away_team,
    '@',
    g.home_team,
    '| odds:',
    g.has_odds,
    '| recs:',
    recs.length,
    recs[0] ? `top: ${recs[0].market} ${recs[0].pick} tier=${recs[0].tier}` : 'NONE'
  );
}

const parlays = buildParlaysFromDb({ limit: 40 });
console.log('\nParlays built:', parlays.length);
for (const p of parlays) {
  console.log(`- ${p.parlay_label} | ${p.leg_count} legs | ${p.category}`);
}

const full = parlays.find((p) => p.category === 'lottery_full_slate');
if (full) {
  const covered = new Set(full.legs.map((l) => l.gameId));
  const missing = games.filter((g) => !covered.has(g.id));
  console.log('\nFull slate missing games:', missing.length);
  for (const g of missing) {
    console.log(' MISSING:', g.away_team, '@', g.home_team, g.commence_time);
  }
}
