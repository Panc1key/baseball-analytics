/**
 * KBO 先發身份回填 → asian_probable_starter_snapshots（研究）
 * 用法:
 *   node scripts/backfillAsianKboStarters.mjs
 *   node scripts/backfillAsianKboStarters.mjs --with-stats
 */
import db from '../src/db/database.js';
import {
  clearKboPitcherCaches,
  fetchKboSchedulePitchers,
  getKboPitcherSeasonStats,
  kstDateYmd,
  matchKboPitchersToGame,
} from '../src/services/KboPitcherService.js';
import { recordAsianStarterSnapshot } from '../src/services/AsianStarterSnapshots.js';

const withStats = process.argv.includes('--with-stats');
const delayMs = withStats ? 350 : 120;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const games = db
  .prepare(
    `SELECT id, commence_time, home_team, away_team
     FROM games WHERE league = 'KBO'
     ORDER BY datetime(commence_time) ASC`
  )
  .all();

const byDate = new Map();
for (const g of games) {
  const ymd = kstDateYmd(g.commence_time);
  if (!ymd) continue;
  if (!byDate.has(ymd)) byDate.set(ymd, []);
  byDate.get(ymd).push(g);
}

clearKboPitcherCaches();
let inserted = 0;
let matched = 0;
let skipped = 0;
let errors = 0;
const dates = [...byDate.keys()].sort();

console.log(`KBO games=${games.length} dates=${dates.length} withStats=${withStats}`);

for (const ymd of dates) {
  let rows;
  try {
    rows = await fetchKboSchedulePitchers(ymd);
  } catch (err) {
    console.warn('schedule fail', ymd, err.message);
    errors += 1;
    await sleep(delayMs);
    continue;
  }

  for (const g of byDate.get(ymd)) {
    const m = matchKboPitchersToGame(g.home_team, g.away_team, rows);
    if (!m || (!m.home && !m.away)) {
      skipped += 1;
      continue;
    }
    matched += 1;

    let homeStats = null;
    let awayStats = null;
    if (withStats) {
      try {
        if (m.home?.id != null) homeStats = await getKboPitcherSeasonStats(m.home.id);
        if (m.away?.id != null) awayStats = await getKboPitcherSeasonStats(m.away.id);
      } catch (err) {
        console.warn('stats fail', g.id, err.message);
      }
    }

    // 歷史回填：captured_at 設為開賽前 6h，允許寫入（schedule_historical）
    const commenceMs = Date.parse(g.commence_time);
    const capturedAt = new Date(commenceMs - 6 * 3600 * 1000).toISOString();

    const res = recordAsianStarterSnapshot({
      league: 'KBO',
      gameId: g.id,
      commenceTime: g.commence_time,
      capturedAt,
      source: 'kbo_official_GetKboGameList',
      captureKind: 'schedule_historical',
      home: m.home ? { id: m.home.id, name: m.home.nameKo } : null,
      away: m.away ? { id: m.away.id, name: m.away.nameKo } : null,
      homeStats,
      awayStats,
      statsAsofKind: withStats ? 'season_page_at_backfill' : null,
      allowPostStart: false,
    });
    if (res.ok && res.inserted) inserted += 1;
  }

  process.stdout.write(`\r${ymd} matched=${matched} inserted=${inserted} skip=${skipped}`);
  await sleep(delayMs);
}

console.log('\n', JSON.stringify({ dates: dates.length, matched, inserted, skipped, errors }, null, 2));
