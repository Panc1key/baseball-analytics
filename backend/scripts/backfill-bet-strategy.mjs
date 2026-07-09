import db from '../src/db/database.js';
import { classifyBetStrategy } from '../src/services/BetStrategy.js';
import { buildParlaysFromDb } from '../src/services/ParlayBuilder.js';

const rows = db.prepare('SELECT * FROM recommendations').all();
const update = db.prepare('UPDATE recommendations SET bet_strategy = ? WHERE id = ?');

for (const r of rows) {
  const s = classifyBetStrategy(r);
  update.run(s, r.id);
}

const flat = db.prepare("SELECT COUNT(*) c FROM recommendations WHERE bet_strategy='flat_bet'").get().c;
const anchor = db.prepare("SELECT COUNT(*) c FROM recommendations WHERE bet_strategy='parlay_anchor'").get().c;
console.log('flat_bet:', flat, 'parlay_anchor:', anchor);

console.log('\n--- 均注精選 ---');
db.prepare(`
  SELECT pick, odds_decimal, model_prob, ev, league, market
  FROM recommendations WHERE bet_strategy='flat_bet' ORDER BY ev DESC
`).all().forEach((r) => {
  console.log(`  ${r.league} ${r.market} ${r.pick} @${r.odds_decimal} prob${(r.model_prob*100).toFixed(1)}% EV${(r.ev*100).toFixed(1)}%`);
});

console.log('\n--- 串關錨腿 ---');
db.prepare(`
  SELECT pick, odds_decimal, model_prob, ev, league, market
  FROM recommendations WHERE bet_strategy='parlay_anchor' ORDER BY model_prob DESC
`).all().forEach((r) => {
  console.log(`  ${r.league} ${r.market} ${r.pick} @${r.odds_decimal} prob${(r.model_prob*100).toFixed(1)}%`);
});

const parlays = buildParlaysFromDb({ limit: 3 });
console.log('\n--- 串關組合 ---', parlays.length);
if (parlays[0]) {
  console.log(parlays[0].parlay_label, '腿均勝率', (parlays[0].avg_leg_prob*100).toFixed(1)+'%', '賠率', parlays[0].combined_odds.toFixed(2));
}
