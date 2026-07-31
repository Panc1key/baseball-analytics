/**
 * 優先級 1：回補 2025-04～09 MLB 開賽前 PIT 獨贏（h2h only）。
 *
 * 注意：2025 場次 id 多為 mlb-official-*，與 Odds API event id 不同，
 * 必須用主客隊名 + 開賽時間對齊。
 *
 * 成本約：10 × markets(1) × regions(1) = 10 credits / 每個開賽日快照。
 *
 * 用法：
 *   node scripts/backfillMlb2025H2hPitOdds.mjs --dry-run
 *   node scripts/backfillMlb2025H2hPitOdds.mjs --reserve=500
 */
import 'dotenv/config';
import fs from 'fs';
import db from '../src/db/database.js';
import { LEAGUES } from '../src/config.js';
import {
  OddsApiClient,
  isOddsQuotaExhaustedError,
  remainingQuota,
} from '../src/services/OddsApiClient.js';
import { recordOddsSnapshot } from '../src/services/PitOddsService.js';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const dryRun = process.argv.includes('--dry-run');
const fromDate = argValue('from', '2025-04-01');
const toDate = argValue('to', '2025-09-30');
const reserve = Number(argValue('reserve', '500'));
const markets = argValue('markets', 'h2h');
const region = argValue('region', LEAGUES.MLB.region || 'us');
const sleepMs = Number(argValue('sleepMs', '250'));

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function namesMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = na.split(' ');
  const tb = nb.split(' ');
  const lastA = ta[ta.length - 1];
  const lastB = tb[tb.length - 1];
  return lastA.length >= 4 && lastA === lastB;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const games = db
  .prepare(
    `
  SELECT id, commence_time, home_team, away_team
  FROM games
  WHERE league = 'MLB'
    AND completed = 1
    AND home_score IS NOT NULL
    AND away_score IS NOT NULL
    AND date(commence_time) >= date(?)
    AND date(commence_time) <= date(?)
  ORDER BY commence_time, id
`
  )
  .all(fromDate, toDate);

const alreadyPit = db
  .prepare(
    `
  SELECT DISTINCT game_id
  FROM odds_snapshots
  WHERE source NOT LIKE '%_post_start%'
`
  )
  .all()
  .map((r) => r.game_id);

const alreadySet = new Set(alreadyPit);
const needGames = games.filter((g) => !alreadySet.has(g.id));

const byDay = new Map();
for (const g of needGames) {
  const day = String(g.commence_time).slice(0, 10);
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day).push(g);
}

const days = [...byDay.keys()].sort();
const estimatedCredits = days.length * 10 * markets.split(',').filter(Boolean).length;

console.log(
  JSON.stringify(
    {
      window: { fromDate, toDate },
      markets,
      region,
      reserve,
      dryRun,
      totalGamesInWindow: games.length,
      alreadyHavePit: games.length - needGames.length,
      needGames: needGames.length,
      snapshotDays: days.length,
      estimatedCreditsIfAllDays: estimatedCredits,
      note: 'historical cost ≈ 10 × #markets × #regions per day snapshot',
    },
    null,
    2
  )
);

if (dryRun) {
  console.log('\n[dry-run] 不呼叫 Odds API。前 5 個快照日：');
  for (const day of days.slice(0, 5)) {
    const list = byDay.get(day);
    const earliest = list.reduce((a, g) =>
      new Date(g.commence_time) < new Date(a.commence_time) ? g : a
    );
    const snapAt = new Date(new Date(earliest.commence_time).getTime() - 2 * 3600 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    console.log(`  ${day} games=${list.length} snapAt=${snapAt}`);
  }
  process.exit(0);
}

const client = new OddsApiClient();
let filled = 0;
let matchedDays = 0;
let unmatchedGames = 0;
let skippedReserve = 0;
let errors = 0;
let stoppedForReserve = false;
let lastRemaining = null;
const unmatchedSamples = [];

for (const day of days) {
  const list = byDay.get(day);
  const earliest = list.reduce((a, g) =>
    new Date(g.commence_time) < new Date(a.commence_time) ? g : a
  );
  const snapAt = new Date(new Date(earliest.commence_time).getTime() - 2 * 3600 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  if (lastRemaining != null && lastRemaining <= reserve) {
    stoppedForReserve = true;
    skippedReserve += days.length - days.indexOf(day);
    console.log(`停止：剩餘額度 ${lastRemaining} ≤ 保留 ${reserve}`);
    break;
  }

  try {
    const resp = await client.getHistoricalOdds(LEAGUES.MLB.key, snapAt, {
      regions: region,
      markets,
    });
    lastRemaining = remainingQuota(client.getQuota());
    const events = Array.isArray(resp?.data) ? resp.data : [];

    let dayFilled = 0;
    for (const g of list) {
      const gTime = Date.parse(g.commence_time);
      let best = null;
      let bestDt = Infinity;
      for (const ev of events) {
        if (!ev?.bookmakers?.length) continue;
        const homeOk = namesMatch(ev.home_team, g.home_team);
        const awayOk = namesMatch(ev.away_team, g.away_team);
        if (!homeOk || !awayOk) continue;
        const evTime = Date.parse(ev.commence_time || '');
        const dt = Number.isFinite(evTime) && Number.isFinite(gTime)
          ? Math.abs(evTime - gTime)
          : 0;
        if (dt < bestDt) {
          bestDt = dt;
          best = ev;
        }
      }
      if (!best) {
        unmatchedGames += 1;
        if (unmatchedSamples.length < 12) {
          unmatchedSamples.push({
            day,
            game: `${g.away_team} @ ${g.home_team}`,
            commence_time: g.commence_time,
          });
        }
        continue;
      }
      const capturedAt = resp.timestamp || snapAt;
      recordOddsSnapshot({
        gameId: g.id,
        league: 'MLB',
        commenceTime: g.commence_time,
        capturedAt,
        bookmakers: best.bookmakers,
        source: 'historical_api_h2h_2025',
      });
      db.prepare(
        `UPDATE games SET raw_odds = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(JSON.stringify(best.bookmakers), g.id);
      filled += 1;
      dayFilled += 1;
    }

    matchedDays += 1;
    console.log(
      `✓ ${day} events=${events.length} filled=${dayFilled}/${list.length} remaining=${lastRemaining}`
    );

    if (lastRemaining != null && lastRemaining <= reserve) {
      stoppedForReserve = true;
      console.log(`停止：剩餘額度 ${lastRemaining} ≤ 保留 ${reserve}`);
      break;
    }
    if (sleepMs > 0) await sleep(sleepMs);
  } catch (err) {
    errors += 1;
    console.error(`✗ ${day}:`, err.message);
    lastRemaining = remainingQuota(client.getQuota()) ?? lastRemaining;
    if (isOddsQuotaExhaustedError(err)) {
      stoppedForReserve = true;
      break;
    }
  }
}

const out = {
  ok: true,
  fromDate,
  toDate,
  markets,
  reserve,
  filled,
  matchedDays,
  unmatchedGames,
  errors,
  stoppedForReserve,
  lastRemaining,
  unmatchedSamples,
};
fs.writeFileSync('tmp-backfill-2025-h2h-result.json', JSON.stringify(out, null, 2));
console.log('\n' + JSON.stringify(out, null, 2));
