import db from '../src/db/database.js';

const kbo = db
  .prepare(`
    SELECT id, home_team, away_team, commence_time, completed,
      CASE WHEN datetime(commence_time) <= datetime('now') THEN 1 ELSE 0 END as started
    FROM games WHERE league = 'KBO'
    ORDER BY commence_time DESC LIMIT 20
  `)
  .all();

console.log('KBO in DB:', kbo.length);
for (const g of kbo) {
  const flag = g.completed ? '完賽' : g.started ? '已開賽(滾球區)' : '未開賽';
  console.log(`[${flag}] ${g.away_team} @ ${g.home_team} | ${g.commence_time}`);
}

const rec = db
  .prepare(`SELECT COUNT(*) c FROM recommendations r JOIN games g ON g.id = r.game_id WHERE g.league = 'KBO'`)
  .get();
console.log('\nKBO 推薦數:', rec.c);

const liveStarted = kbo.filter((g) => g.started && !g.completed);
console.log('已開賽未完成 KBO:', liveStarted.length);

const rows = db
  .prepare(`
    SELECT g.away_team, g.home_team, r.market, r.pick, r.odds_decimal, r.model_prob, r.ev, r.tier, r.bet_strategy
    FROM recommendations r
    JOIN games g ON g.id = r.game_id
    WHERE g.league = 'KBO'
    ORDER BY g.commence_time, r.ev DESC
  `)
  .all();

console.log('\n=== 現有 KBO 推薦（皆為開賽前快照，非滾球）===');
for (const r of rows) {
  console.log(
    `${r.away_team} @ ${r.home_team} | ${r.market} ${r.pick} @${r.odds_decimal} prob ${(r.model_prob * 100).toFixed(1)}% ev ${(r.ev * 100).toFixed(1)}% [${r.tier}] ${r.bet_strategy || ''}`
  );
}
