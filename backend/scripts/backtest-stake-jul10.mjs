/**
 * 7/10 Stake 實戰單場結果 vs 系統推薦邏輯
 */
import { getMlbStandings } from '../src/services/MlbStatsService.js';
import { analyzeMatchup } from '../src/services/TeamAnalyzer.js';
import { pickGameRecommendations } from '../src/services/RecommendationRules.js';
import { classifyBetStrategy, qualifiesFlatBet } from '../src/services/BetStrategy.js';
import { extractMarkets } from '../src/utils/odds.js';
import db from '../src/db/database.js';

/** 用戶 7/10 實戰（客隊 @ 主隊 比分） */
const STAKE_JUL10 = [
  { pick: '小 10', market: 'totals', odds: 1.8, away: 'Atlanta Braves', home: 'Pittsburgh Pirates', as: 10, hs: 5, hit: false },
  { pick: 'Kansas City Royals +1.5', market: 'spreads', odds: 1.61, away: 'Kansas City Royals', home: 'New York Mets', as: 3, hs: 7, hit: false },
  { pick: '大 7.5', market: 'totals', odds: 1.91, away: 'New York Yankees', home: 'Tampa Bay Rays', as: 12, hs: 4, hit: true },
  { pick: 'Chicago Cubs', market: 'h2h', odds: 2.07, away: 'Chicago Cubs', home: 'Baltimore Orioles', as: 2, hs: 3, hit: false },
  { pick: 'Minnesota Twins +1.5', market: 'spreads', odds: 1.6, away: 'Cleveland Guardians', home: 'Minnesota Twins', as: 5, hs: 2, hit: false },
  { pick: 'Chicago White Sox +1.5', market: 'spreads', odds: 1.53, away: 'Boston Red Sox', home: 'Chicago White Sox', as: 2, hs: 1, hit: true },
  { pick: 'Miami Marlins +1.5', market: 'spreads', odds: 1.64, away: 'Seattle Mariners', home: 'Miami Marlins', as: 4, hs: 8, hit: true },
  { pick: 'Detroit Tigers', market: 'h2h', odds: 1.75, away: 'Oakland Athletics', home: 'Detroit Tigers', as: 1, hs: 4, hit: true },
  { pick: 'Cincinnati Reds +1.5', market: 'spreads', odds: 1.83, away: 'Philadelphia Phillies', home: 'Cincinnati Reds', as: 1, hs: 0, hit: true },
  { pick: 'Milwaukee Brewers', market: 'h2h', odds: 1.74, away: 'Milwaukee Brewers', home: 'St. Louis Cardinals', as: 8, hs: 4, hit: true },
  { pick: '大 7.5', market: 'totals', odds: 2.13, away: 'Los Angeles Angels', home: 'Texas Rangers', as: 6, hs: 7, hit: true },
  { pick: 'Arizona Diamondbacks +1.5', market: 'spreads', odds: 1.54, away: 'San Diego Padres', home: 'Arizona Diamondbacks', as: 1, hs: 3, hit: true },
  { pick: 'Colorado Rockies +1.5', market: 'spreads', odds: 1.55, away: 'San Francisco Giants', home: 'Colorado Rockies', as: 8, hs: 2, hit: false },
];

function teamKey(n) {
  return (n || '').toLowerCase().replace(/[^a-z]/g, '');
}

function matchGame(row, game) {
  const s = new Set([teamKey(row.home), teamKey(row.away)]);
  const g = new Set([teamKey(game.home_team), teamKey(game.away_team)]);
  return [...s].every((t) => g.has(t));
}

async function main() {
  const standings = await getMlbStandings();
  const games = db.prepare(`SELECT * FROM games WHERE league='MLB'`).all();

  let flatWould = 0;
  let flatHits = 0;
  let anchorWould = 0;
  let anchorHits = 0;
  let userFlatOdds = [];

  console.log('=== 7/10 Stake 實戰 vs 系統分類 ===\n');

  for (const row of STAKE_JUL10) {
    const game = games.find((g) => matchGame(row, g));
    const bookmakers = game ? JSON.parse(game.raw_odds || '[]') : [];
    let sysFlat = '-';
    let sysAnchor = '-';
    let primary = '-';

    if (game && bookmakers.length) {
      const analysis = await analyzeMatchup('MLB', game.home_team, game.away_team, bookmakers, {
        mlbStandings: standings,
      });
      const picks = pickGameRecommendations(game, extractMarkets(bookmakers), analysis, '', {
        bookmakers,
      });
      const p = picks.find((x) => x.isPrimary) || picks[0];
      if (p) primary = `${p.market} ${p.pick} @${p.oddsDecimal?.toFixed(2)}`;

      const flatPicks = picks.filter((x) => qualifiesFlatBet({ ...x, tier: x.tier, market: x.market, league: 'MLB' }));
      const anchorPicks = picks.filter((x) => classifyBetStrategy({ ...x, tier: x.tier, market: x.market, league: 'MLB', ev: x.ev, edge_prob: x.edgeProb, model_prob: x.modelProb, odds_decimal: x.oddsDecimal }) === 'parlay_anchor');

      if (flatPicks.length) sysFlat = flatPicks.map((f) => `${f.market} ${f.pick}`).join('; ');
      if (anchorPicks.length) sysAnchor = anchorPicks.map((a) => `${a.market} ${a.pick}`).join('; ');

      const userMatchesFlat = flatPicks.some((f) => row.pick.includes(f.pick) || f.pick.includes(row.pick.split(' ')[0]));
      const userMatchesAnchor = anchorPicks.some((a) => row.pick.includes(a.pick.split(' ')[0]));

      if (row.odds >= 1.8 && row.market !== 'totals') {
        userFlatOdds.push(row);
        flatWould++;
        if (row.hit) flatHits++;
      } else if (row.odds < 1.8) {
        anchorWould++;
        if (row.hit) anchorHits++;
      }
    }

    console.log(
      `${row.away} @ ${row.home} | 你: ${row.pick} @${row.odds} ${row.hit ? '中' : '錯'} | 主推: ${primary} | 均注: ${sysFlat} | 錨腿: ${sysAnchor}`
    );
  }

  const mlb = STAKE_JUL10;
  const wins = mlb.filter((r) => r.hit).length;
  const totals = mlb.filter((r) => r.market === 'totals');
  const lowWater = mlb.filter((r) => r.odds < 1.75);
  const h2h = mlb.filter((r) => r.market === 'h2h');

  console.log('\n========== 匯總 ==========');
  console.log(`MLB 單場命中率: ${wins}/${mlb.length} (${((wins / mlb.length) * 100).toFixed(1)}%)`);
  console.log(`大小盤: ${totals.filter((t) => t.hit).length}/${totals.length}`);
  console.log(`低水(<1.75): ${lowWater.filter((t) => t.hit).length}/${lowWater.length} — 應走錨腿/串關，非均注`);
  console.log(`獨贏(≥1.74): ${h2h.filter((t) => t.hit).length}/${h2h.length}`);
  console.log(`若僅下賠率≥1.80且非大小: ${flatHits}/${flatWould}`);
  console.log(`低水讓分錨腿區: ${anchorHits}/${anchorWould}`);
  console.log('\n問題: 大小「小10」慘敗(15分)；低水讓分混進$2均注；多場串成24.96倍一單全滅');
}

main().catch(console.error);
