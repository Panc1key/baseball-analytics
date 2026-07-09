/**
 * 7/9 實戰回測：使用用戶提供的 Stake 賠率與比分
 * 對比舊模型 vs 新 TotalsModel
 */

import { getMlbStandings } from '../src/services/MlbStatsService.js';
import { matchMlbTeam } from '../src/services/MlbStatsService.js';
import {
  estimateProjectedTotal,
  probTotalOver,
  decimalToImpliedProb,
  decimalToNetOdds,
  calcEV,
  calibrateModelProb,
} from '../src/utils/odds.js';
import {
  computeTotalsProjection,
  buildTotalCandidates,
  probOverAtLine,
} from '../src/services/TotalsModel.js';
import { pickGameRecommendations } from '../src/services/RecommendationRules.js';
import { analyzeMatchup } from '../src/services/TeamAnalyzer.js';
import { extractMarkets } from '../src/utils/odds.js';
import { config } from '../src/config.js';

/** 用戶 Stake 實戰 14 場（賠率、盤口、實際總分） */
const STAKE_GAMES = [
  { label: '巨人@藍鳥', home: 'Toronto Blue Jays', away: 'San Francisco Giants', line: 7.5, side: 'over', odds: 2.2, total: 10 },
  { label: '金鶯@小熊', home: 'Chicago Cubs', away: 'Baltimore Orioles', line: 10.5, side: 'under', odds: 1.77, total: 16 },
  { label: '老虎@運動家', home: 'Oakland Athletics', away: 'Detroit Tigers', line: 9.5, side: 'under', odds: 1.79, total: 7 },
  { label: '海盜@勇士', home: 'Atlanta Braves', away: 'Pittsburgh Pirates', line: 6.5, side: 'over', odds: 1.65, total: 3 },
  { label: '洋基@光芒', home: 'Tampa Bay Rays', away: 'New York Yankees', line: 7.5, side: 'over', odds: 1.65, total: 3 },
  { label: '水手@馬林魚', home: 'Miami Marlins', away: 'Seattle Mariners', line: 9.5, side: 'under', odds: 1.92, total: 2 },
  { label: '太空人@國民', home: 'Washington Nationals', away: 'Houston Astros', line: 9.5, side: 'under', odds: 1.79, total: 10 },
  { label: '費城人@紅人', home: 'Cincinnati Reds', away: 'Philadelphia Phillies', line: 9.5, side: 'under', odds: 1.75, total: 16 },
  { label: '皇家@大都會', home: 'New York Mets', away: 'Kansas City Royals', line: 7.5, side: 'over', odds: 1.78, total: 8 },
  { label: '紅襪@白襪', home: 'Chicago White Sox', away: 'Boston Red Sox', line: 7.5, side: 'over', odds: 1.73, total: 5 },
  { label: '釀酒人@紅雀', home: 'St. Louis Cardinals', away: 'Milwaukee Brewers', line: 7.5, side: 'over', odds: 1.89, total: 6 },
  { label: '天使@遊騎兵', home: 'Los Angeles Angels', away: 'Texas Rangers', line: 10.5, side: 'under', odds: 1.72, total: 14 },
  { label: '道奇@洛磯', home: 'Colorado Rockies', away: 'Los Angeles Dodgers', line: 10.5, side: 'under', odds: 1.72, total: 7 },
  { label: '教士@響尾蛇', home: 'Arizona Diamondbacks', away: 'San Diego Padres', line: 7.5, side: 'over', odds: 1.7, total: 14 },
];

function buildStakeBookmakers({ line, side, odds }) {
  const userImplied = decimalToImpliedProb(odds);
  const hold = 0.045;
  const otherImplied = Math.max(0.35, 1 - userImplied + hold / 2);
  const otherOdds = 1 / otherImplied;

  const over = side === 'over'
    ? { name: 'Over', point: line, price: odds }
    : { name: 'Over', point: line, price: otherOdds };
  const under = side === 'under'
    ? { name: 'Under', point: line, price: odds }
    : { name: 'Under', point: line, price: otherOdds };

  return [
    {
      title: 'Stake',
      markets: [
        {
          key: 'totals',
          outcomes: [over, under],
        },
      ],
    },
  ];
}

function checkHit(side, line, total) {
  if (side === 'over') return total > line;
  return total < line;
}

function oldModelPick(homeEra, awayEra, line, side, odds) {
  const projected = estimateProjectedTotal('MLB', homeEra, awayEra);
  const isOver = side === 'over';
  const modelProb = isOver
    ? probTotalOver(projected, line)
    : 1 - probTotalOver(projected, line);
  const implied = decimalToImpliedProb(odds);
  const calibrated = calibrateModelProb(modelProb, implied, config.maxModelEdgePct);
  const ev = calcEV(calibrated, decimalToNetOdds(odds));
  return { projected, modelProb: calibrated, ev, pick: `${isOver ? '大' : '小'} ${line}` };
}

async function main() {
  const standings = await getMlbStandings();
  console.log('=== 7/9 Stake 實戰回測：舊模型 vs 新 TotalsModel ===\n');

  let oldHits = 0;
  let newHits = 0;
  let newSkips = 0;
  let userHits = 0;
  let newPrimaryHits = 0;
  let newPrimaryTotal = 0;

  for (const g of STAKE_GAMES) {
    const bookmakers = buildStakeBookmakers(g);
    const markets = extractMarkets(bookmakers);

    const homeMlb = matchMlbTeam(g.home, standings);
    const awayMlb = matchMlbTeam(g.away, standings);

    const analysis = await analyzeMatchup('MLB', g.home, g.away, bookmakers, {
      mlbStandings: standings,
    });

    const projection = computeTotalsProjection({
      league: 'MLB',
      homeMlb,
      awayMlb,
      venueName: g.label.includes('洛磯') ? 'Coors Field' : null,
      bookmakers,
    });

    const candidates = buildTotalCandidates(markets, projection, 'MLB');
    const qualified = candidates.filter((c) => c.structuralOk && c.ev >= config.totalsMinEv);
    const bestNew = qualified.sort((a, b) => b.ev - a.ev)[0] || null;

    const old = oldModelPick(analysis.homePitcherEra, analysis.awayPitcherEra, g.line, g.side, g.odds);
    const userHit = checkHit(g.side, g.line, g.total);
    if (userHit) userHits++;

    const oldWouldBet = old.ev >= config.minEvThreshold && old.modelProb > decimalToImpliedProb(g.odds);
    const oldHit = oldWouldBet ? userHit : null;
    if (oldHit === true) oldHits++;
    if (oldHit === false) {
      /* counted in total below */
    }

    let newRec = '跳過';
    let newHit = null;
    if (bestNew) {
      const newSide = bestNew.side;
      newHit = checkHit(newSide, bestNew.line, g.total);
      newRec = `${bestNew.pick} @${bestNew.oddsDecimal.toFixed(2)} EV${(bestNew.ev * 100).toFixed(1)}%`;
      if (newHit) newHits++;
    } else {
      newSkips++;
    }

    const fullPicks = pickGameRecommendations(
      { id: g.label, league: 'MLB', home_team: g.home, away_team: g.away },
      markets,
      analysis,
      '回測',
      { bookmakers }
    );
    const primary = fullPicks.find((p) => p.isPrimary) || fullPicks[0];
    let primaryStr = '無推薦';
    if (primary) {
      primaryStr = `${primary.market} ${primary.pick}`;
      if (primary.market === 'totals') {
        const ph = checkHit(primary.pick.startsWith('大') ? 'over' : 'under', primary.line, g.total);
        newPrimaryTotal++;
        if (ph) newPrimaryHits++;
        primaryStr += ph ? ' 中' : ' 錯';
      }
    }

    console.log(`${g.label} | 實際${g.total} | 你: ${g.side === 'over' ? '大' : '小'}${g.line}@${g.odds} ${userHit ? '中' : '錯'}`);
    console.log(`  市場反推: 主盤${projection.marketLine} 最終預估${projection.finalTotal.toFixed(1)} (模型${projection.modelTotal.toFixed(1)})`);
    console.log(`  舊模型: 預估${old.projected.toFixed(1)} → ${old.pick} EV${(old.ev * 100).toFixed(1)}% ${oldWouldBet ? (userHit ? '若跟→中' : '若跟→錯') : '不推'}`);
    console.log(`  新模型: ${newRec}${newHit != null ? (newHit ? ' 中' : ' 錯') : ''}`);
    console.log(`  新主推: ${primaryStr}`);
    console.log('');
  }

  const oldWouldBetTotal = STAKE_GAMES.filter((g) => {
    const old = oldModelPick(null, null, g.line, g.side, g.odds);
    return old.ev >= config.minEvThreshold;
  }).length;

  console.log('========== 匯總 ==========');
  console.log(`你實戰 Stake:     ${userHits}/14 (${((userHits / 14) * 100).toFixed(1)}%)`);
  console.log(`舊模型若全跟:     ${oldHits}/14 (幾乎每場都推大小)`);
  console.log(`新模型合格推薦:   ${14 - newSkips} 場推薦，${newHits} 中 / ${14 - newSkips} 推 (${newSkips} 場跳過)`);
  console.log(`新邏輯主推:       ${newPrimaryHits}/${newPrimaryTotal} (大小主推場次)`);
}

main().catch(console.error);
