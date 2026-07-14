import { fullRefresh } from '../src/services/AnalysisEngine.js';
import { buildParlaysFromDb } from '../src/services/ParlayBuilder.js';
import db from '../src/db/database.js';

const r = await fullRefresh();
console.log('Refresh:', r);

const recs = db
  .prepare(`
    SELECT r.tier, r.market, r.pick, r.model_prob, r.ev, r.bet_strategy, g.away_team, g.home_team
    FROM recommendations r
    JOIN games g ON g.id = r.game_id
    WHERE g.league = 'MLB'
      AND g.completed = 0
      AND datetime(g.commence_time) > datetime('now')
    ORDER BY g.commence_time, r.tier
  `)
  .all();

console.log('\n=== MLB 推薦', recs.length, '條 ===');
const underTotals = recs.filter((x) => x.market === 'totals' && x.pick.startsWith('小'));
const plus15 = recs.filter((x) => x.market === 'spreads' && /\+1\.5/.test(x.pick));
console.log('小球推薦:', underTotals.length, '| +1.5 讓分:', plus15.length);

for (const x of recs) {
  console.log(
    `[${x.tier}] ${x.market} ${x.pick.slice(0, 36)} | prob ${(x.model_prob * 100).toFixed(1)}% ev ${(x.ev * 100).toFixed(1)}% | ${x.bet_strategy || '-'}`
  );
}

const parlays = buildParlaysFromDb({ limit: 5 });
console.log('\n=== 串關 ===');
for (const p of parlays) {
  console.log(
    p.parlay_label,
    '| legs',
    p.leg_count,
    '| avgProb',
    ((p.avg_leg_prob || 0) * 100).toFixed(1) + '%',
    '| totals',
    p.market_mix?.totals ?? 0,
    '| fill',
    p.fill_leg_count ?? 0
  );
}
