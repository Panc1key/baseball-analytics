import db from '../src/db/database.js';
import { extractMarkets } from '../src/utils/odds.js';
import { analyzeMatchup } from '../src/services/TeamAnalyzer.js';
import { pickGameRecommendations } from '../src/services/RecommendationRules.js';
import { buildParlaysFromDb } from '../src/services/ParlayBuilder.js';
import { getMlbStandings } from '../src/services/MlbStatsService.js';
import { config } from '../src/config.js';

/** 7/8 實戰 14 場實際比分（Stake 截圖） */
const ACTUAL_RESULTS = [
  { away: 'San Francisco Giants', home: 'Toronto Blue Jays', total: 10, userBet: '大 7.5', hit: true },
  { away: 'Baltimore Orioles', home: 'Chicago Cubs', total: 16, userBet: '小 10.5', hit: false },
  { away: 'Detroit Tigers', home: 'Oakland Athletics', total: 7, userBet: '小 9.5', hit: true },
  { away: 'Pittsburgh Pirates', home: 'Atlanta Braves', total: 3, userBet: '小 9.5', hit: true },
  { away: 'Tampa Bay Rays', home: 'New York Yankees', total: 3, userBet: '大 6.5', hit: false },
  { away: 'Miami Marlins', home: 'Seattle Mariners', total: 2, userBet: '大 7.5', hit: false },
  { away: 'Washington Nationals', home: 'Houston Astros', total: 10, userBet: '小 9.5', hit: false },
  { away: 'Cincinnati Reds', home: 'Philadelphia Phillies', total: 16, userBet: '小 9.5', hit: false },
  { away: 'New York Mets', home: 'Kansas City Royals', total: 8, userBet: '小 9.5', hit: true },
  { away: 'Chicago White Sox', home: 'Boston Red Sox', total: 5, userBet: '大 7.5', hit: false },
  { away: 'St. Louis Cardinals', home: 'Milwaukee Brewers', total: 6, userBet: '大 7.5', hit: false },
  { away: 'Texas Rangers', home: 'Los Angeles Angels', total: 14, userBet: '大 7.5', hit: true },
  { away: 'Los Angeles Dodgers', home: 'Colorado Rockies', total: 7, userBet: '小 10.5', hit: true },
  { away: 'San Diego Padres', home: 'Arizona Diamondbacks', total: 14, userBet: '大 7.5', hit: true },
];

function normalizeTeam(name) {
  return (name || '').toLowerCase().replace(/[^a-z]/g, '');
}

function teamKey(name) {
  const n = normalizeTeam(name);
  if (n.includes('athletic')) return 'athletics';
  if (n.includes('diamondback')) return 'arizonadiamondbacks';
  if (n.includes('dodger')) return 'losangelesdodgers';
  if (n.includes('angel')) return 'losangelesangels';
  return n;
}

function matchGame(actual, game) {
  const actualSet = new Set([teamKey(actual.home), teamKey(actual.away)]);
  const gameSet = new Set([teamKey(game.home_team), teamKey(game.away_team)]);
  if (actualSet.size !== gameSet.size) return false;
  for (const t of actualSet) {
    if (!gameSet.has(t)) return false;
  }
  return true;
}

/** 7/8 當日所有場次（含西岸早場） */
function isJul8Slate(commenceTime) {
  return String(commenceTime).startsWith('2026-07-08');
}

function checkPickHit(pick, line, actualTotal) {
  const isOver = pick.startsWith('大');
  const isUnder = pick.startsWith('小');
  if (isOver) return actualTotal > line;
  if (isUnder) return actualTotal < line;
  return null;
}

function checkH2hHit(pick, home, away, homeScore, awayScore) {
  if (pick === home) return homeScore > awayScore;
  if (pick === away) return awayScore > homeScore;
  return null;
}

async function main() {
  const games = db
    .prepare(`SELECT * FROM games WHERE league = 'MLB' ORDER BY commence_time`)
    .all()
    .filter((g) => isJul8Slate(g.commence_time));

  console.log('DB 內 MLB 場次:', games.length);
  console.log('分析日期範圍:', games[0]?.commence_time, '~', games[games.length - 1]?.commence_time);

  let mlbStandings = [];
  try {
    mlbStandings = await getMlbStandings();
  } catch (e) {
    console.warn('MLB standings 拉取失敗，使用 DB 快取');
  }

  const simulations = [];
  const allRecs = [];

  for (const actual of ACTUAL_RESULTS) {
    const candidates = games.filter((g) => matchGame(actual, g));
    const game = candidates.sort((a, b) => b.commence_time.localeCompare(a.commence_time))[0];
    if (!game) {
      simulations.push({ actual, error: 'DB 無此場' });
      continue;
    }

    let bookmakers = [];
    try {
      bookmakers = JSON.parse(game.raw_odds || '[]');
    } catch {
      bookmakers = [];
    }

    if (!bookmakers.length) {
      simulations.push({ actual, game, error: '無賠率快照' });
      continue;
    }

    const markets = extractMarkets(bookmakers);
    const analysis = await analyzeMatchup(
      'MLB',
      game.home_team,
      game.away_team,
      bookmakers,
      { mlbStandings }
    );

    const picks = pickGameRecommendations(
      { ...game, league: 'MLB' },
      markets,
      analysis,
      analysis.summary || '分析'
    );

    const primary = picks.find((p) => p.tier === 'primary') || picks.sort((a, b) => b.score - a.score)[0] || null;
    const mainPicks = picks.filter((p) => ['h2h', 'spreads', 'totals'].includes(p.market));

    for (const p of mainPicks) {
      allRecs.push({ game, pick: p, actual });
    }

    let primaryHit = null;
    if (primary) {
      if (primary.market === 'totals') {
        primaryHit = checkPickHit(primary.pick, primary.line, actual.total);
      } else if (primary.market === 'h2h') {
        const hs = game.home_score ?? Math.floor(actual.total / 2);
        const as = game.away_score ?? actual.total - hs;
        primaryHit = checkH2hHit(primary.pick, game.home_team, game.away_team, hs, as);
      }
    }

    simulations.push({
      matchup: `${game.away_team} @ ${game.home_team}`,
      actualTotal: actual.total,
      userBet: actual.userBet,
      userHit: actual.hit,
      modelPrimary: primary
        ? {
            market: primary.market,
            pick: primary.pick,
            line: primary.line,
            odds: primary.oddsDecimal,
            ev: primary.ev,
            score: primary.score,
            tier: primary.tier,
            modelProb: primary.modelProb,
          }
        : null,
      allMainPicks: mainPicks.map((p) => ({
        market: p.market,
        pick: p.pick,
        odds: p.oddsDecimal,
        ev: +(p.ev * 100).toFixed(1) + '%',
        tier: p.tier,
        score: p.score,
      })),
      homeWinProb: analysis.homeWinProb?.toFixed(3),
      projectedTotal: analysis.projectedTotal,
      primaryHit,
    });
  }

  console.log('\n========== 單場模擬（現行邏輯）==========\n');

  let primaryHits = 0;
  let primaryTotal = 0;
  let totalsHits = 0;
  let totalsTotal = 0;

  for (const s of simulations) {
    if (s.error) {
      console.log(`[跳過] ${s.actual.away} @ ${s.actual.home} — ${s.error}`);
      continue;
    }

    const p = s.modelPrimary;
    const pStr = p ? `${p.market} · ${p.pick} @${p.odds?.toFixed(2)} [${p.tier}] EV${(p.ev * 100).toFixed(1)}%` : '無推薦';
    const hitStr =
      s.primaryHit === true ? '中' : s.primaryHit === false ? '錯' : '—';

    console.log(`${s.matchup}`);
    console.log(`  實際總分: ${s.actualTotal} | 你下注: ${s.userBet} (${s.userHit ? '中' : '錯'})`);
    console.log(`  主推: ${pStr} → ${hitStr}`);
    if (s.allMainPicks?.length > 1) {
      console.log(`  其他主盤: ${s.allMainPicks.map((x) => `${x.market}:${x.pick}`).join(' | ')}`);
    }
    console.log('');

    if (p?.market === 'totals' && s.primaryHit != null) {
      primaryTotal++;
      if (s.primaryHit) primaryHits++;
    }
    if (p) {
      if (p.market === 'totals') {
        totalsTotal++;
        if (s.primaryHit) totalsHits++;
      }
    }
  }

  // 統計所有 totals 主推
  const totalsPrimary = simulations.filter(
    (s) => s.modelPrimary?.market === 'totals' && s.primaryHit != null
  );
  const tHits = totalsPrimary.filter((s) => s.primaryHit).length;

  console.log('========== 統計 ==========');
  console.log(`有資料場次: ${simulations.filter((s) => !s.error).length} / ${ACTUAL_RESULTS.length}`);
  console.log(`主推為大小盤: ${totalsPrimary.length} 場，命中 ${tHits}/${totalsPrimary.length}`);
  console.log(`你實戰大小: 7/14 (50%)`);

  // 若主推改為每場最高 EV 主盤
  console.log('\n========== 每場所有主盤候選（現行邏輯產出）==========\n');
  let bestEvTotalsHits = 0;
  let bestEvTotalsTotal = 0;
  for (const s of simulations) {
    if (s.error || !s.allMainPicks?.length) continue;

    console.log(`${s.matchup} | 實際總分 ${s.actualTotal}`);
    for (const p of s.allMainPicks) {
      const full = allRecs.find(
        (r) =>
          r.actual.total === s.actualTotal &&
          r.pick.market === p.market &&
          r.pick.pick === p.pick
      )?.pick;
      let hit = '—';
      if (full?.market === 'totals') {
        const h = checkPickHit(full.pick, full.line, s.actualTotal);
        hit = h ? '中' : '錯';
      }
      console.log(`  ${p.market.padEnd(7)} ${p.pick.padEnd(22)} @${p.odds?.toFixed(2)} EV${p.ev} [${p.tier}] ${hit}`);
    }

    const totalsPicks = s.allMainPicks.filter((p) => p.market === 'totals');
    if (totalsPicks.length) {
      const bestTotal = totalsPicks.sort((a, b) => parseFloat(b.ev) - parseFloat(a.ev))[0];
      const full = allRecs.find(
        (r) =>
          r.actual.total === s.actualTotal &&
          r.pick.market === 'totals' &&
          r.pick.pick === bestTotal.pick
      )?.pick;
      if (full) {
        bestEvTotalsTotal++;
        if (checkPickHit(full.pick, full.line, s.actualTotal)) bestEvTotalsHits++;
      }
    }
    console.log('');
  }
  console.log(`大小盤最高EV候選累計: ${bestEvTotalsHits}/${bestEvTotalsTotal}`);

  // 串關模擬：臨時寫入 recommendations 再 build
  console.log('\n========== 串關模擬（需 DB 有未來場次，昨日場次已過期）==========');
  console.log('昨日場次已完賽，現行 ParlayBuilder 會過濾已開賽場次。');
  console.log('以下為「若昨日分析當下」每場合格主盤腿（賠率≥1.4、正EV）:\n');

  const parlayLegs = [];
  for (const s of simulations) {
    if (s.error || !s.allMainPicks?.length) continue;
    const qualified = s.allMainPicks.filter((p) => p.odds >= config.minParlayLegOdds);
    if (!qualified.length) continue;

    // balanced: prefer h2h/spread
    const nonTotals = qualified.filter((p) => p.market !== 'totals');
    const leg = (nonTotals.length ? nonTotals : qualified).sort(
      (a, b) => parseFloat(b.ev) - parseFloat(a.ev)
    )[0];

    const full = allRecs.find(
      (r) =>
        r.actual === s.actual &&
        r.pick.market === leg.market &&
        r.pick.pick === leg.pick
    )?.pick;

    let hit = null;
    if (full?.market === 'totals') {
      hit = checkPickHit(full.pick, full.line, s.actualTotal);
    }

    parlayLegs.push({ ...s, leg, full, hit });
    console.log(
      `  ${s.matchup} → ${leg.market} ${leg.pick} @${leg.odds?.toFixed(2)} ${hit != null ? (hit ? '中' : '錯') : '(獨贏/讓分需比分)'}`
    );
  }

  const parlayHits = parlayLegs.filter((l) => l.hit === true).length;
  const parlayWithResult = parlayLegs.filter((l) => l.hit != null).length;
  console.log(`\n串關策略「獨贏讓分優先」若全串: ${parlayHits}/${parlayWithResult} 腿命中`);
  if (parlayLegs.length >= 2) {
    const combinedOdds = parlayLegs.reduce((a, l) => a * l.leg.odds, 1);
    console.log(`  ${parlayLegs.length}串1 合計賠率約 ${combinedOdds.toFixed(2)}（全中機率極低，僅供參考）`);
  }
}

main().catch(console.error);
