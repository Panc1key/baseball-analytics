import db from '../src/db/database.js';

const now = db.prepare("SELECT datetime('now') as n").get().n;
console.log('DB now (UTC):', now);

const recs = db
  .prepare(`
  SELECT r.market, r.pick, r.odds_decimal, r.model_prob, r.ev, r.tier, r.score,
    g.home_team, g.away_team, g.commence_time, g.league, g.completed, g.id
  FROM recommendations r JOIN games g ON g.id = r.game_id
  WHERE r.tier IN ('primary','watch')
  ORDER BY g.commence_time
`)
  .all();

console.log('\n=== 當前推薦', recs.length, '條 ===\n');
for (const r of recs) {
  const past = r.commence_time < now ? '【已開賽/過期】' : '';
  console.log(
    `${past}[${r.league}] ${r.away_team} @ ${r.home_team} | ${r.commence_time}\n` +
      `  ${r.market} ${r.pick} @${r.odds_decimal} prob${(r.model_prob * 100).toFixed(1)}% EV${(r.ev * 100).toFixed(1)}% [${r.tier}]`
  );
}

const parlays = db
  .prepare('SELECT * FROM parlay_recommendations ORDER BY combined_ev DESC LIMIT 5')
  .all();

console.log('\n=== 串關', parlays.length, '組 ===');
for (const p of parlays.slice(0, 2)) {
  const meta = JSON.parse(p.legs);
  const legs = meta.legs || meta;
  console.log(`\n${meta.parlay_label || '?'} | ${legs.length}腿 | 賠率${p.combined_odds?.toFixed(2)}`);
  for (const leg of legs) {
    console.log(`  ${leg.league} ${leg.market} ${leg.pick} @${leg.odds} ${leg.commenceTime}`);
  }
}
