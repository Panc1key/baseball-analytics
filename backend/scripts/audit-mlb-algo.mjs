/**
 * MLB 初盤算法健檢：推薦分佈、邏輯一致性、雙軌分類
 */
import db from '../src/db/database.js';
import { config } from '../src/config.js';
import { buildParlaysFromDb } from '../src/services/ParlayBuilder.js';

const recs = db
  .prepare(`
    SELECT r.*, g.home_team, g.away_team, g.commence_time
    FROM recommendations r
    JOIN games g ON g.id = r.game_id
    WHERE g.league = 'MLB'
      AND g.completed = 0
      AND datetime(g.commence_time) > datetime('now')
    ORDER BY g.commence_time, r.score DESC
  `)
  .all();

const games = db
  .prepare(`
    SELECT COUNT(*) c FROM games
    WHERE league='MLB' AND completed=0 AND datetime(commence_time)>datetime('now')
  `)
  .get().c;

console.log('=== MLB 初盤健檢 ===');
console.log('未開賽場次:', games);
console.log('推薦條數:', recs.length);
console.log('門檻: EV>=' + config.minEvThreshold * 100 + '%', 'flat>=' + config.flatBetMinOdds, 'anchor', config.parlayAnchorMinOdds + '-' + config.parlayAnchorMaxOdds);

const byMarket = {};
const byStrategy = {};
const byTier = {};
for (const r of recs) {
  byMarket[r.market] = (byMarket[r.market] || 0) + 1;
  byStrategy[r.bet_strategy || 'none'] = (byStrategy[r.bet_strategy || 'none'] || 0) + 1;
  byTier[r.tier] = (byTier[r.tier] || 0) + 1;
}
console.log('\n盤口分佈:', byMarket);
console.log('策略分佈:', byStrategy);
console.log('評級分佈:', byTier);

const issues = [];

console.log('\n=== 各場推薦明細 ===');
const byGame = new Map();
for (const r of recs) {
  if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
  byGame.get(r.game_id).push(r);
}

for (const [, picks] of byGame) {
  const g = picks[0];
  console.log(`\n${g.away_team} @ ${g.home_team} (${g.commence_time})`);
  for (const p of picks.sort((a, b) => b.score - a.score)) {
    const strat = p.bet_strategy || '-';
    const primary = p.tier === 'primary' ? '*' : '';
    console.log(
      `  ${primary}[${p.tier}] ${p.market} ${p.pick} @${p.odds_decimal} | prob ${(p.model_prob * 100).toFixed(1)}% ev ${(p.ev * 100).toFixed(1)}% edge ${(p.edge_prob || 0).toFixed(1)}% score ${(p.score || 0).toFixed(0)} | ${strat}`
    );

    // 邏輯檢查
    if (p.ev < config.minEvThreshold && p.tier === 'primary') {
      issues.push(`${g.away_team}@${g.home_team}: primary 但 EV 不足`);
    }
    if (p.bet_strategy === 'flat_bet' && p.odds_decimal < config.flatBetMinOdds) {
      issues.push(`${g.away_team}@${g.home_team}: flat_bet 賠率過低`);
    }
    if (p.bet_strategy === 'parlay_anchor') {
      if (p.odds_decimal < config.parlayAnchorMinOdds || p.odds_decimal > config.parlayAnchorMaxOdds) {
        issues.push(`${g.away_team}@${g.home_team}: anchor 賠率區間異常`);
      }
      if (p.model_prob < config.parlayAnchorMinProb) {
        issues.push(`${g.away_team}@${g.home_team}: anchor 勝率不足`);
      }
    }
    if (p.market === 'totals' && p.tier === 'primary') {
      // 大小盤主推需有合理 edge
      if ((p.edge_prob || 0) < 2) {
        issues.push(`${g.away_team}@${g.home_team}: 大小盤主推 edge 偏低`);
      }
    }
  }

  // 同場獨贏 vs 讓分方向
  const h2h = picks.find((p) => p.market === 'h2h');
  const spread = picks.find((p) => p.market === 'spreads');
  if (h2h && spread) {
    const h2hHome = h2h.pick === g.home_team;
    const spreadHome = spread.pick.startsWith(g.home_team);
    if (h2hHome !== spreadHome) {
      issues.push(`${g.away_team}@${g.home_team}: 獨贏與讓分方向不一致`);
    }
  }
}

// 投注紀錄
const bets = db
  .prepare(`
    SELECT result, market, COUNT(*) c,
      SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) won,
      SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) lost
    FROM bet_log WHERE league='MLB'
    GROUP BY result, market
  `)
  .all();

const settled = db
  .prepare(`
    SELECT market, bet_strategy,
      SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) won,
      SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) lost,
      SUM(profit) profit
    FROM bet_log
    WHERE league='MLB' AND result IN ('win','loss')
    GROUP BY market, bet_strategy
  `)
  .all();

console.log('\n=== 投注紀錄（若有）===');
if (!settled.length) {
  console.log('尚無已結算 MLB 投注');
} else {
  for (const s of settled) {
    const total = s.won + s.lost;
    console.log(
      `${s.market} ${s.bet_strategy || '-'}: ${s.won}/${total} (${((s.won / total) * 100).toFixed(1)}%) profit $${(s.profit || 0).toFixed(2)}`
    );
  }
}

const parlay = buildParlaysFromDb({ limit: 1 })[0];
if (parlay) {
  const mlbLegs = parlay.legs.filter((l) => l.league === 'MLB');
  console.log('\n=== 大串 MLB 腿 ===');
  console.log(parlay.parlay_label, '| MLB腿', mlbLegs.length, '/', parlay.leg_count);
  console.log('腿均勝率', (parlay.avg_leg_prob * 100).toFixed(1) + '%', '| 錨腿', parlay.anchor_leg_count);
}

console.log('\n=== 邏輯問題 ===');
if (!issues.length) console.log('未發現明顯矛盾');
else issues.forEach((i) => console.log('-', i));

// 勝率區間統計
const probs = recs.map((r) => r.model_prob);
if (probs.length) {
  const avg = probs.reduce((a, b) => a + b, 0) / probs.length;
  const flat = recs.filter((r) => r.bet_strategy === 'flat_bet');
  const anchor = recs.filter((r) => r.bet_strategy === 'parlay_anchor');
  console.log('\n=== 勝率摘要 ===');
  console.log('全部推薦均 prob:', (avg * 100).toFixed(1) + '%');
  if (flat.length) {
    const fp = flat.reduce((a, r) => a + r.model_prob, 0) / flat.length;
    const fo = flat.reduce((a, r) => a + r.odds_decimal, 0) / flat.length;
    console.log(`均注精選 ${flat.length} 條: 均prob ${(fp * 100).toFixed(1)}% 均賠 ${fo.toFixed(2)}`);
  }
  if (anchor.length) {
    const ap = anchor.reduce((a, r) => a + r.model_prob, 0) / anchor.length;
    const ao = anchor.reduce((a, r) => a + r.odds_decimal, 0) / anchor.length;
    console.log(`串關錨腿 ${anchor.length} 條: 均prob ${(ap * 100).toFixed(1)}% 均賠 ${ao.toFixed(2)}`);
  }
}
