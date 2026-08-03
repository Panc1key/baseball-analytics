/**
 * 回補 2025-04～09 MLB 開賽前 PIT 大小分（totals），合併進既有 h2h 快照。
 *
 * 注意：resolvePitOdds 只取開賽前最後一張快照；不可另存 totals-only，
 * 否則會蓋掉 h2h。本腳本更新既有 bookmakers_json，把 totals market 併入。
 *
 * 用法：
 *   node scripts/backfillMlb2025TotalsPitOdds.mjs --dry-run
 *   node scripts/backfillMlb2025TotalsPitOdds.mjs --reserve=500
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

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const dryRun = process.argv.includes('--dry-run');
const fromDate = argValue('from', '2025-04-01');
const toDate = argValue('to', '2025-09-30');
const reserve = Number(argValue('reserve', '500'));
const markets = argValue('markets', 'totals');
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

function parseBooks(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function hasTotals(books) {
  return books.some((b) => (b.markets || []).some((m) => m.key === 'totals'));
}

function mergeTotals(existingBooks, incomingBooks) {
  const byKey = new Map(
    existingBooks.map((b) => [String(b.key || b.title || ''), { ...b, markets: [...(b.markets || [])] }])
  );
  for (const book of incomingBooks || []) {
    const key = String(book.key || book.title || '');
    const totalsMarket = (book.markets || []).find((m) => m.key === 'totals');
    if (!totalsMarket) continue;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key: book.key,
        title: book.title,
        markets: [totalsMarket],
      });
      continue;
    }
    const target = byKey.get(key);
    const without = (target.markets || []).filter((m) => m.key !== 'totals');
    target.markets = [...without, totalsMarket];
  }
  return [...byKey.values()];
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

const need = [];
for (const g of games) {
  const snap = db
    .prepare(
      `
    SELECT id, bookmakers_json, captured_at, source
    FROM odds_snapshots
    WHERE game_id = ?
      AND datetime(captured_at) < datetime(?)
      AND source NOT LIKE '%_post_start%'
    ORDER BY datetime(captured_at) DESC, id DESC
    LIMIT 1
  `
    )
    .get(g.id, g.commence_time);
  if (!snap) continue;
  const books = parseBooks(snap.bookmakers_json);
  if (hasTotals(books)) continue;
  need.push({ ...g, snapshotId: snap.id, books });
}

const byDay = new Map();
for (const g of need) {
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
      totalGames: games.length,
      needTotalsMerge: need.length,
      snapshotDays: days.length,
      estimatedCreditsIfAllDays: estimatedCredits,
      note: '合併 totals 進既有 PIT 快照；不另存 totals-only',
    },
    null,
    2
  )
);

if (dryRun) {
  console.log('\n[dry-run] 不呼叫 Odds API。前 5 日：');
  for (const day of days.slice(0, 5)) {
    console.log(`  ${day} games=${byDay.get(day).length}`);
  }
  process.exit(0);
}

const client = new OddsApiClient();
let filled = 0;
let unmatchedGames = 0;
let errors = 0;
let stoppedForReserve = false;
let lastRemaining = null;
const unmatchedSamples = [];

const upd = db.prepare(`
  UPDATE odds_snapshots
  SET bookmakers_json = ?, source = CASE
    WHEN source LIKE '%+totals%' THEN source
    ELSE source || '+totals'
  END
  WHERE id = ?
`);

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
        if (!namesMatch(ev.home_team, g.home_team) || !namesMatch(ev.away_team, g.away_team)) {
          continue;
        }
        const evTime = Date.parse(ev.commence_time || '');
        const dt =
          Number.isFinite(evTime) && Number.isFinite(gTime) ? Math.abs(evTime - gTime) : 0;
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
          });
        }
        continue;
      }
      const merged = mergeTotals(g.books, best.bookmakers);
      if (!hasTotals(merged)) {
        unmatchedGames += 1;
        continue;
      }
      upd.run(JSON.stringify(merged), g.snapshotId);
      filled += 1;
      dayFilled += 1;
    }

    console.log(
      `✓ ${day} events=${events.length} filled=${dayFilled}/${list.length} remaining=${lastRemaining}`
    );
    if (lastRemaining != null && lastRemaining <= reserve) {
      stoppedForReserve = true;
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
  filled,
  need: need.length,
  unmatchedGames,
  errors,
  stoppedForReserve,
  lastRemaining,
  unmatchedSamples,
};
fs.writeFileSync('tmp-backfill-2025-totals-result.json', JSON.stringify(out, null, 2));
console.log('\n' + JSON.stringify(out, null, 2));
