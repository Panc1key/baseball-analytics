/**
 * MLB 獨贏/讓分 初盤邏輯回測（7/9 實戰場次）
 * 使用實際比分驗證當前模型推薦方向
 */
import db from '../src/db/database.js';
import { extractMarkets, estimateCoverProb } from '../src/utils/odds.js';
import { analyzeMatchup } from '../src/services/TeamAnalyzer.js';
import { pickGameRecommendations } from '../src/services/RecommendationRules.js';
import { getMlbStandings } from '../src/services/MlbStatsService.js';
import { classifyBetStrategy } from '../src/services/BetStrategy.js';
import { config } from '../src/config.js';

/** 7/9 完賽比分（與 Stake 同日 slate） */
const JUL9_SCORES = [
  { away: 'Atlanta Braves', home: 'Pittsburgh Pirates', awayScore: 4, homeScore: 2 },
  { away: 'New York Yankees', home: 'Tampa Bay Rays', awayScore: 1, homeScore: 2 },
  { away: 'Chicago Cubs', home: 'Baltimore Orioles', awayScore: 6, homeScore: 3 },
  { away: 'Cleveland Guardians', home: 'Minnesota Twins', awayScore: 2, homeScore: 5 },
  { away: 'Boston Red Sox', home: 'Chicago White Sox', awayScore: 4, homeScore: 1 },
  { away: 'Oakland Athletics', home: 'Detroit Tigers', awayScore: 1, homeScore: 5 },
  { away: 'Seattle Mariners', home: 'Miami Marlins', awayScore: 0, homeScore: 2 },
  { away: 'Philadelphia Phillies', home: 'Cincinnati Reds', awayScore: 8, homeScore: 5 },
  { away: 'Kansas City Royals', home: 'New York Mets', awayScore: 3, homeScore: 4 },
  { away: 'Milwaukee Brewers', home: 'St. Louis Cardinals', awayScore: 5, homeScore: 2 },
  { away: 'Los Angeles Angels', home: 'Texas Rangers', awayScore: 6, homeScore: 7 },
];

function teamKey(name) {
  return (name || '').toLowerCase().replace(/[^a-z]/g, '');
}

function matchGame(actual, game) {
  const a = new Set([teamKey(actual.home), teamKey(actual.away)]);
  const g = new Set([teamKey(game.home_team), teamKey(game.away_team)]);
  return [...a].every((t) => g.has(t));
}

function parseSpread(pick, home, away) {
  const m = pick.match(/^(.+?)\s+([+-]?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const team = m[1].trim();
  const line = parseFloat(m[2]);
  const isHome = teamKey(team) === teamKey(home);
  const teamScore = isHome ? 'home' : 'away';
  return { team, line, teamScore };
}

function checkSpreadHit(pick, home, away, homeScore, awayScore) {
  const s = parseSpread(pick, home, away);
  if (!s) return null;
  const diff = homeScore - awayScore;
  const adj = s.teamScore === 'home' ? diff + s.line : -diff + s.line;
  return adj > 0;
}

function checkH2hHit(pick, home, away, homeScore, awayScore) {
  if (teamKey(pick) === teamKey(home)) return homeScore > awayScore;
  if (teamKey(pick) === teamKey(away)) return awayScore > homeScore;
  return null;
}

async function main() {
  const games = db.prepare(`SELECT * FROM games WHERE league='MLB'`).all();
  const standings = await getMlbStandings();

  console.log('=== MLB 獨贏/讓分 初盤回測（7/9）===\n');

  let anchorHits = 0;
  let anchorTotal = 0;
  let flatHits = 0;
  let flatTotal = 0;
  let allMainHits = 0;
  let allMainTotal = 0;

  for (const actual of JUL9_SCORES) {
    const game = games.find((g) => matchGame(actual, g));
    if (!game) {
      console.log(`${actual.away} @ ${actual.home} | DB 無場次`);
      continue;
    }

    const bookmakers = JSON.parse(game.raw_odds || '[]');
    if (!bookmakers.length) {
      console.log(`${actual.away} @ ${actual.home} | 無初盤賠率`);
      continue;
    }

    const analysis = await analyzeMatchup('MLB', game.home_team, game.away_team, bookmakers, {
      mlbStandings: standings,
    });
    const markets = extractMarkets(bookmakers);
    const picks = pickGameRecommendations(game, markets, analysis, '回測', { bookmakers });

    const scoreStr = `${actual.awayScore}-${actual.homeScore}`;
    console.log(`${actual.away} @ ${actual.home} | 實際 ${scoreStr}`);

    for (const p of picks.filter((x) => ['h2h', 'spreads'].includes(x.market))) {
      const hit =
        p.market === 'h2h'
          ? checkH2hHit(p.pick, actual.home, actual.away, actual.homeScore, actual.awayScore)
          : checkSpreadHit(p.pick, actual.home, actual.away, actual.homeScore, actual.awayScore);

      const strat = classifyBetStrategy({
        tier: p.tier,
        market: p.market,
        league: 'MLB',
        ev: p.ev,
        edge_prob: p.edgeProb,
        model_prob: p.modelProb,
        odds_decimal: p.oddsDecimal,
        data_quality: p.dataQuality,
      });

      const mark = hit ? '中' : '錯';
      console.log(
        `  ${p.isPrimary ? '*' : ' '}${p.market} ${p.pick} @${p.oddsDecimal?.toFixed(2)} prob${(p.modelProb * 100).toFixed(0)}% ev${(p.ev * 100).toFixed(1)}% [${strat || '-'}] ${mark}`
      );

      allMainTotal++;
      if (hit) allMainHits++;

      if (strat === 'parlay_anchor') {
        anchorTotal++;
        if (hit) anchorHits++;
      }
      if (strat === 'flat_bet') {
        flatTotal++;
        if (hit) flatHits++;
      }
    }
    console.log('');
  }

  console.log('========== 匯總 ==========');
  console.log(`主盤獨贏/讓分全部推薦: ${allMainHits}/${allMainTotal} (${pct(allMainHits, allMainTotal)})`);
  console.log(`串關錨腿策略:         ${anchorHits}/${anchorTotal} (${pct(anchorHits, anchorTotal)})`);
  console.log(`均注精選策略:         ${flatHits}/${flatTotal} (${pct(flatHits, flatTotal)})`);
  console.log('\n門檻參考: 錨腿需 prob≥58% 賠率1.55-1.79 | 均注需賠率≥1.80 正EV');
}

function pct(w, t) {
  if (!t) return 'N/A';
  return ((w / t) * 100).toFixed(1) + '%';
}

main().catch(console.error);
