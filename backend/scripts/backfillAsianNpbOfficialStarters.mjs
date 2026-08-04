/**
 * NPB 歷史先發回填（npb.jp box；研究）
 * 只補尚無快照的場次。
 *
 * 用法:
 *   node scripts/backfillAsianNpbOfficialStarters.mjs
 *   node scripts/backfillAsianNpbOfficialStarters.mjs --years=2024,2025
 *   node scripts/backfillAsianNpbOfficialStarters.mjs --limit=50
 */
import db from '../src/db/database.js';
import {
  fetchNpbOfficialBoxStarters,
  fetchNpbOfficialMonthGameLinks,
} from '../src/services/NpbOfficialStarters.js';
import { recordAsianStarterSnapshot } from '../src/services/AsianStarterSnapshots.js';

const yearsArg = process.argv.find((a) => a.startsWith('--years='));
const years = (yearsArg ? yearsArg.split('=')[1] : '2024,2025')
  .split(',')
  .map((y) => Number(y.trim()))
  .filter(Boolean);
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
const delayMs = 220;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function teamsMatch(a, b) {
  const ak = normalizeKey(a);
  const bk = normalizeKey(b);
  if (!ak || !bk) return false;
  return ak === bk || ak.includes(bk) || bk.includes(ak);
}

function matchDbGame(gamesOnDate, homeEn, awayEn) {
  return (
    gamesOnDate.find(
      (g) =>
        teamsMatch(g.home_team, homeEn) && teamsMatch(g.away_team, awayEn)
    ) || null
  );
}

const existing = new Set(
  db
    .prepare(`SELECT game_id FROM asian_probable_starter_snapshots WHERE league='NPB'`)
    .all()
    .map((r) => r.game_id)
);

const games = db
  .prepare(
    `SELECT id, commence_time, home_team, away_team
     FROM games WHERE league='NPB'
       AND substr(commence_time,1,4) IN (${years.map(() => '?').join(',')})
     ORDER BY datetime(commence_time)`
  )
  .all(...years.map(String));

const byDate = new Map();
for (const g of games) {
  const ymd = String(g.commence_time).slice(0, 10);
  if (!byDate.has(ymd)) byDate.set(ymd, []);
  byDate.get(ymd).push(g);
}

let inserted = 0;
let matched = 0;
let skipped = 0;
let already = 0;
let errors = 0;
let fetched = 0;

console.log(
  JSON.stringify(
    {
      years,
      games: games.length,
      existingSnapshots: existing.size,
      missingApprox: games.filter((g) => !existing.has(g.id)).length,
      limit,
    },
    null,
    2
  )
);

outer: for (const year of years) {
  for (const month of [3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    let links;
    try {
      links = await fetchNpbOfficialMonthGameLinks(year, month);
    } catch (err) {
      console.warn(`sched ${year}-${month}`, err.message);
      errors += 1;
      continue;
    }
    for (const link of links) {
      if (fetched >= limit) break outer;
      const dayGames = (byDate.get(link.dateIso) || []).filter((g) => !existing.has(g.id));
      if (!dayGames.length) {
        already += 1;
        continue;
      }
      const g = matchDbGame(dayGames, link.homeTeam, link.awayTeam);
      if (!g) {
        skipped += 1;
        continue;
      }
      if (existing.has(g.id)) {
        already += 1;
        continue;
      }

      try {
        const starters = await fetchNpbOfficialBoxStarters(link.gameUrl);
        fetched += 1;
        if (!starters.home && !starters.away) {
          skipped += 1;
          await sleep(delayMs);
          continue;
        }
        matched += 1;
        const commenceMs = Date.parse(g.commence_time);
        const capturedAt = new Date(commenceMs - 6 * 3600 * 1000).toISOString();
        const res = recordAsianStarterSnapshot({
          league: 'NPB',
          gameId: g.id,
          commenceTime: g.commence_time,
          capturedAt,
          source: 'npb_official_box',
          captureKind: 'boxscore_historical',
          home: starters.home,
          away: starters.away,
          homeStats: null,
          awayStats: null,
          statsAsofKind: null,
          allowPostStart: false,
        });
        if (res.ok && res.inserted) {
          inserted += 1;
          existing.add(g.id);
        } else if (!res.ok && inserted + errors < 5) {
          console.warn('\ninsert fail', g.id, res);
        }
        process.stdout.write(
          `\r${link.dateIso} fetched=${fetched} inserted=${inserted} matched=${matched} skip=${skipped} err=${errors}   `
        );
      } catch (err) {
        errors += 1;
        if (errors <= 8) console.warn('\nbox fail', link.gameUrl, err.message);
      }
      await sleep(delayMs);
    }
  }
}

console.log(
  '\n',
  JSON.stringify({ fetched, matched, inserted, skipped, already, errors }, null, 2)
);
