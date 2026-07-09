import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const key = process.env.ODDS_API_KEY;
if (!key) {
  console.log('NO_KEY');
  process.exit(1);
}

const now = new Date();

async function probe() {
  const oddsUrl = new URL('https://api.the-odds-api.com/v4/sports/baseball_kbo/odds');
  oddsUrl.searchParams.set('apiKey', key);
  oddsUrl.searchParams.set('regions', 'us');
  oddsUrl.searchParams.set('markets', 'h2h,spreads,totals');
  oddsUrl.searchParams.set('oddsFormat', 'decimal');

  const scoresUrl = new URL('https://api.the-odds-api.com/v4/sports/baseball_kbo/scores');
  scoresUrl.searchParams.set('apiKey', key);
  scoresUrl.searchParams.set('daysFrom', '1');

  const [oddsRes, scoresRes] = await Promise.all([fetch(oddsUrl), fetch(scoresUrl)]);

  console.log('quota remaining:', oddsRes.headers.get('x-requests-remaining'));
  console.log('odds status:', oddsRes.status);
  console.log('scores status:', scoresRes.status);

  if (!oddsRes.ok) {
    console.log('odds error:', await oddsRes.text());
    return;
  }
  if (!scoresRes.ok) {
    console.log('scores error:', await scoresRes.text());
    return;
  }

  const odds = await oddsRes.json();
  const scores = await scoresRes.json();

  console.log('\n=== KBO odds endpoint ===');
  console.log('events returned:', odds.length);

  for (const g of odds) {
    const started = new Date(g.commence_time) <= now;
    const books = g.bookmakers?.length || 0;
    const h2h = g.bookmakers?.[0]?.markets?.find((m) => m.key === 'h2h');
    const prices = h2h?.outcomes?.map((o) => `${o.name}:${o.price}`).join(' | ') || 'no h2h';
    console.log(
      `[${started ? 'LIVE/started' : 'pre'}] ${g.away_team} @ ${g.home_team} | books:${books} | ${prices}`
    );
  }

  console.log('\n=== KBO scores endpoint ===');
  console.log('events returned:', scores.length);
  for (const g of scores) {
    const hs = g.scores?.find((s) => s.name === g.home_team)?.score ?? '?';
    const as = g.scores?.find((s) => s.name === g.away_team)?.score ?? '?';
    const scoreDetail = g.scores?.length ? JSON.stringify(g.scores) : 'no scores array';
    console.log(
      `[completed=${g.completed}] ${g.away_team} @ ${g.home_team} | ${as}-${hs} | commence ${g.commence_time}`
    );
    if (as === '?' && hs === '?') console.log('  scores raw:', scoreDetail);
  }

  // 檢查讓分/大小是否有的場次
  console.log('\n=== 各場盤口覆蓋 ===');
  for (const g of odds) {
    const markets = new Set();
    for (const b of g.bookmakers || []) {
      for (const m of b.markets || []) markets.add(m.key);
    }
    console.log(`${g.away_team} @ ${g.home_team}:`, [...markets].join(', ') || 'none');
  }
}

probe().catch((e) => console.error(e.message));
