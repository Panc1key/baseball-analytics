/**
 * NPB 先發身份回填（研究）
 * 優先 /stats 投手表第一列；只補尚無快照的場次。
 *
 * 用法:
 *   node scripts/backfillAsianNpbStarters.mjs
 *   node scripts/backfillAsianNpbStarters.mjs --limit=30
 *   node scripts/backfillAsianNpbStarters.mjs --refill-all
 */
import db from '../src/db/database.js';
import {
  fetchYahooNpbGameStarters,
  fetchYahooNpbScheduleCards,
} from '../src/services/NpbYahooStarters.js';
import { recordAsianStarterSnapshot } from '../src/services/AsianStarterSnapshots.js';

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
const refillAll = process.argv.includes('--refill-all');
const delayMs = 280;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]/g, '');
}

function jstDateYmd(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
}

function teamsMatch(a, b) {
  const ak = normalizeKey(a);
  const bk = normalizeKey(b);
  if (!ak || !bk) return false;
  return ak.includes(bk.slice(0, 5)) || bk.includes(ak.slice(0, 5)) || ak === bk;
}

function matchDbGame(gamesOnDate, homeEn, awayEn) {
  if (!homeEn || !awayEn) return null;
  return (
    gamesOnDate.find(
      (g) =>
        (teamsMatch(g.home_team, homeEn) && teamsMatch(g.away_team, awayEn)) ||
        (teamsMatch(g.home_team, awayEn) && teamsMatch(g.away_team, homeEn))
    ) || null
  );
}

function resolveNameForTeam(teamName, byTeam) {
  if (!teamName || !byTeam?.size) return null;
  if (byTeam.has(teamName)) return byTeam.get(teamName);
  for (const [t, name] of byTeam.entries()) {
    if (teamsMatch(t, teamName)) return name;
  }
  return null;
}

const existing = new Set(
  db
    .prepare(
      `SELECT game_id FROM asian_probable_starter_snapshots WHERE league = 'NPB'`
    )
    .all()
    .map((r) => r.game_id)
);

const games = db
  .prepare(
    `SELECT id, commence_time, home_team, away_team
     FROM games WHERE league = 'NPB'
     ORDER BY datetime(commence_time) ASC`
  )
  .all();

const byDate = new Map();
for (const g of games) {
  const ymd = jstDateYmd(g.commence_time);
  if (!ymd) continue;
  if (!byDate.has(ymd)) byDate.set(ymd, []);
  byDate.get(ymd).push(g);
}

const dates = [...byDate.keys()].sort();
let inserted = 0;
let matched = 0;
let skipped = 0;
let already = 0;
let errors = 0;
let fetched = 0;
const usedGameIds = new Set();
const bySource = {};

console.log(
  `NPB games=${games.length} existingSnapshots=${existing.size} refillAll=${refillAll} limit=${limit}`
);

outer: for (const ymd of dates) {
  let cards;
  try {
    cards = await fetchYahooNpbScheduleCards(ymd);
  } catch (err) {
    console.warn('sched', ymd, err.message);
    errors += 1;
    await sleep(delayMs);
    continue;
  }

  for (const card of cards) {
    if (fetched >= limit) break outer;
    const dayGames = (byDate.get(ymd) || []).filter((g) => !usedGameIds.has(g.id));
    const g = matchDbGame(dayGames, card.homeTeam, card.awayTeam);
    if (!g) {
      skipped += 1;
      continue;
    }
    if (!refillAll && existing.has(g.id)) {
      already += 1;
      usedGameIds.add(g.id);
      continue;
    }

    fetched += 1;
    let info;
    try {
      info = await fetchYahooNpbGameStarters(card.yahooGameId, {
        homeTeam: card.homeTeam,
        awayTeam: card.awayTeam,
      });
    } catch (err) {
      errors += 1;
      await sleep(delayMs);
      continue;
    }

    const homeName = resolveNameForTeam(g.home_team, info.byTeam);
    const awayName = resolveNameForTeam(g.away_team, info.byTeam);
    if (!homeName && !awayName) {
      skipped += 1;
      await sleep(delayMs);
      continue;
    }

    matched += 1;
    usedGameIds.add(g.id);
    const src = info.parseSource || 'unknown';
    bySource[src] = (bySource[src] || 0) + 1;

    const commenceMs = Date.parse(g.commence_time);
    const capturedAt = new Date(commenceMs - 6 * 3600 * 1000).toISOString();
    // stats 回填用不同 source，避免與舊 top 快照 UNIQUE 衝突；prefer complete 時會選較新
    const source =
      src === 'stats_first_pitcher'
        ? 'yahoo_npb_stats_first_pitcher'
        : 'yahoo_npb_game_top_senpatsu';

    const homeStarter = info.raw.find((s) => s.teamEn && teamsMatch(s.teamEn, g.home_team));
    const awayStarter = info.raw.find((s) => s.teamEn && teamsMatch(s.teamEn, g.away_team));

    const res = recordAsianStarterSnapshot({
      league: 'NPB',
      gameId: g.id,
      commenceTime: g.commence_time,
      capturedAt,
      source,
      captureKind: 'boxscore_historical',
      home: homeName
        ? {
            name: homeName,
            era: homeStarter?.era ?? null,
          }
        : null,
      away: awayName
        ? {
            name: awayName,
            era: awayStarter?.era ?? null,
          }
        : null,
      homeStats: homeStarter?.era != null ? { era: homeStarter.era } : null,
      awayStats: awayStarter?.era != null ? { era: awayStarter.era } : null,
      statsAsofKind: homeStarter?.era != null ? 'boxscore_game_era' : null,
    });
    if (res.ok && res.inserted) inserted += 1;
    await sleep(delayMs);
  }
  process.stdout.write(
    `\r${ymd} cards=${cards.length} fetched=${fetched} matched=${matched} inserted=${inserted} already=${already} skip=${skipped}`
  );
}

const coverage = db
  .prepare(
    `SELECT COUNT(DISTINCT game_id) AS c FROM asian_probable_starter_snapshots WHERE league='NPB'`
  )
  .get().c;

console.log(
  '\n',
  JSON.stringify(
    {
      fetched,
      matched,
      inserted,
      already,
      skipped,
      errors,
      bySource,
      distinctGameCoverage: coverage,
      coverageRate: Number((coverage / games.length).toFixed(4)),
    },
    null,
    2
  )
);
