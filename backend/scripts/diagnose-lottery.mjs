import db from '../src/db/database.js';
import { config } from '../src/config.js';
import { buildParlaysFromDb } from '../src/services/ParlayBuilder.js';
import { qualifiesParlayAnchor } from '../src/services/BetStrategy.js';
import { calibrateModelProb, decimalToImpliedProb, calcEV, decimalToNetOdds } from '../src/utils/odds.js';

const games = db
  .prepare(`
  SELECT g.id, g.home_team, g.away_team, g.commence_time, g.league, g.raw_odds
  FROM games g
  WHERE g.completed = 0
    AND datetime(g.commence_time) > datetime('now')
    AND datetime(g.commence_time) < datetime('now', '+2 day')
  ORDER BY g.commence_time
`)
  .all();

const recs = db
  .prepare(`
  SELECT r.*, g.home_team, g.away_team, g.commence_time, g.league
  FROM recommendations r
  JOIN games g ON g.id = r.game_id
  WHERE g.completed = 0
    AND datetime(g.commence_time) > datetime('now')
    AND datetime(g.commence_time) < datetime('now', '+2 day')
`)
  .all();

const byGame = new Map();
for (const r of recs) {
  if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
  byGame.get(r.game_id).push(r);
}

console.log('=== 概況 ===');
console.log('當日未開賽場次:', games.length);
console.log('有推薦的場次:', byGame.size);
console.log('大串設定:', {
  parlayLotteryMaxLegs: config.parlayLotteryMaxLegs,
  parlayLotteryMinProb: config.parlayLotteryMinProb,
  parlayMinLegEv: config.parlayMinLegEv,
  parlayAnchorMinOdds: config.parlayAnchorMinOdds,
});

const parlays = buildParlaysFromDb({ limit: 5 });
const full = parlays.find((p) => p.category === 'lottery_full_slate');
console.log('\n=== 大串 ===');
if (full) {
  console.log(full.parlay_label, '腿數', full.leg_count, '賠率', full.combined_odds.toFixed(2));
} else {
  console.log('無大串');
}

console.log('\n=== 未入大串場次分析 ===');
const included = new Set(full?.legs?.map((l) => l.gameId) || []);

for (const g of games) {
  if (included.has(g.id)) continue;
  const rs = byGame.get(g.id) || [];
  const main = rs.filter((r) => ['h2h', 'spreads', 'totals'].includes(r.market));

  let reason = '無推薦';
  if (!main.length) {
    reason = rs.length ? '僅有球員盤/其他盤' : '無推薦';
  } else {
    const best = main
      .map((r) => {
        const odds = r.odds_decimal;
        const implied = r.implied_prob ?? decimalToImpliedProb(odds);
        const modelProb = calibrateModelProb(r.model_prob, implied, config.maxModelEdgePct);
        const ev = calcEV(modelProb, decimalToNetOdds(odds));
        const anchor = qualifiesParlayAnchor({ ...r, model_prob: modelProb });
        return { r, odds, modelProb, ev, anchor, tier: r.tier };
      })
      .sort((a, b) => b.modelProb - a.modelProb)[0];

    const reasons = [];
    if (!['primary', 'watch'].includes(best.tier)) reasons.push(`tier=${best.tier}`);
    if (best.odds < config.parlayAnchorMinOdds) reasons.push(`賠率${best.odds}<${config.parlayAnchorMinOdds}`);
    if (best.ev < config.parlayMinLegEv) reasons.push(`EV${(best.ev * 100).toFixed(1)}%`);
    if (best.modelProb <= (best.r.implied_prob ?? decimalToImpliedProb(best.odds)))
      reasons.push('模型≤市場');
    if (!best.anchor && best.modelProb < config.parlayLotteryMinProb)
      reasons.push(`非錨腿且勝率${(best.modelProb * 100).toFixed(1)}%<${config.parlayLotteryMinProb * 100}%`);
    if (!best.anchor && best.odds > config.parlayAnchorMaxOdds + 0.06)
      reasons.push(`非錨腿賠率>${config.parlayAnchorMaxOdds + 0.06}`);
    reason = reasons.join('; ') || '應可入串（檢查邏輯）';
  }

  console.log(`- ${g.away_team} @ ${g.home_team} | ${reason}`);
}

// 未入串場次：列出所有主盤推薦
console.log('\n=== 未入串場次全部主盤推薦 ===');
for (const g of games) {
  if (included.has(g.id)) continue;
  const rs = (byGame.get(g.id) || []).filter((r) => ['h2h', 'spreads', 'totals'].includes(r.market));
  console.log(`\n${g.away_team} @ ${g.home_team} (${rs.length} 條)`);
  for (const r of rs) {
    const odds = r.odds_decimal;
    const implied = r.implied_prob ?? decimalToImpliedProb(odds);
    const modelProb = calibrateModelProb(r.model_prob, implied, config.maxModelEdgePct);
    console.log(
      `  ${r.market} ${r.pick} @${odds} tier=${r.tier} prob=${(modelProb * 100).toFixed(1)}% ev=${(r.ev * 100).toFixed(1)}%`
    );
  }
}
