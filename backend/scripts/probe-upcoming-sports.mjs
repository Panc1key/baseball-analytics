/**
 * 探測各運動近期可投注賽事（Odds API + 本地 DB）
 */
import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const key = process.env.ODDS_API_KEY;
const now = new Date();

const sports = [
  ['MLB', 'baseball_mlb', '已接入·完整模型'],
  ['NPB', 'baseball_npb', '已接入·簡化模型'],
  ['KBO', 'baseball_kbo', '已接入·簡化模型'],
  ['世界盃', 'soccer_fifa_world_cup', '已接入·足球模組'],
  ['MLS', 'soccer_usa_mls', '可擴展'],
  ['英超', 'soccer_epl', '可擴展'],
  ['德甲', 'soccer_germany_bundesliga', '可擴展'],
  ['WNBA', 'basketball_wnba', '未接入'],
  ['NBA夏季聯賽', 'basketball_nba_summer_league', '未接入'],
  ['NFL季前', 'americanfootball_nfl_preseason', '未接入'],
  ['J聯', 'soccer_japan_j_league', '可擴展'],
  ['K聯', 'soccer_korea_kleague1', '可擴展'],
  ['墨超', 'soccer_mexico_ligamx', '可擴展'],
  ['墨超盃', 'soccer_concacaf_leagues_cup', '可擴展'],
];

async function fetchOdds(name, sportKey, status) {
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds`);
  url.searchParams.set('apiKey', key);
  url.searchParams.set('regions', 'us,eu');
  url.searchParams.set('markets', 'h2h');
  url.searchParams.set('oddsFormat', 'decimal');
  const res = await fetch(url);
  if (!res.ok) {
    return { name, sportKey, status, error: res.status, upcoming: 0, samples: [] };
  }
  const data = await res.json();
  const upcoming = data.filter((g) => new Date(g.commence_time) > now);
  return {
    name,
    sportKey,
    status,
    total: data.length,
    upcoming: upcoming.length,
    samples: upcoming.slice(0, 4).map((g) => ({
      time: g.commence_time,
      match: `${g.away_team} @ ${g.home_team}`,
    })),
    quota: res.headers.get('x-requests-remaining'),
  };
}

async function main() {
  if (!key) {
    console.log('未設定 ODDS_API_KEY');
    process.exit(1);
  }

  console.log('=== 近期可投注賽事探測 ===');
  console.log(`當前時間: ${now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })} (UTC+8)\n`);

  const results = [];
  for (const [name, sportKey, status] of sports) {
    try {
      results.push(await fetchOdds(name, sportKey, status));
    } catch (e) {
      results.push({ name, sportKey, status, error: e.message, upcoming: 0 });
    }
  }

  const withGames = results.filter((r) => r.upcoming > 0).sort((a, b) => b.upcoming - a.upcoming);
  const noGames = results.filter((r) => !r.upcoming && !r.error);

  console.log('【有初盤的聯盟】');
  for (const r of withGames) {
    console.log(`\n${r.name} (${r.sportKey})`);
    console.log(`  系統狀態: ${r.status}`);
    console.log(`  未開賽: ${r.upcoming} 場 (API 共 ${r.total} 場)`);
    for (const s of r.samples) {
      const t = new Date(s.time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      console.log(`    ${t} | ${s.match}`);
    }
  }

  if (noGames.length) {
    console.log('\n【目前無初盤】');
    for (const r of noGames) console.log(`  ${r.name}: 0 場`);
  }

  const errors = results.filter((r) => r.error);
  if (errors.length) {
    console.log('\n【API 錯誤】');
    for (const r of errors) console.log(`  ${r.name}: ${r.error}`);
  }

  const last = results.find((r) => r.quota);
  if (last?.quota) console.log(`\nAPI 剩餘額度: ${last.quota}`);

  const dbPath = path.join(__dirname, '../data/analytics.db');
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath);
    const games = db
      .prepare(
        `SELECT league, COUNT(1) as cnt, MIN(commence_time) as first, MAX(commence_time) as last
         FROM games WHERE datetime(commence_time) > datetime('now') GROUP BY league ORDER BY cnt DESC`
      )
      .all();
    const recs = db.prepare('SELECT league, COUNT(1) as cnt FROM recommendations GROUP BY league').all();
    const recMap = Object.fromEntries(recs.map((r) => [r.league, r.cnt]));

    console.log('\n=== 本地已同步（未開賽）===');
    if (!games.length) console.log('  無');
    for (const g of games) {
      console.log(`  ${g.league}: ${g.cnt} 場 | 推薦 ${recMap[g.league] ?? 0} 條 | ${g.first?.slice(0, 16)} ~ ${g.last?.slice(0, 16)}`);
    }
    db.close();
  }
}

main().catch(console.error);
