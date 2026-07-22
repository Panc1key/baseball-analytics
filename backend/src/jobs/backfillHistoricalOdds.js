/**
 * 用 Odds API 歷史盤口補齊庫內「有比分但無 raw_odds」的場次
 * 付費方案：GET /v4/historical/sports/{sport}/odds?date=...
 * 成本約 10 × markets(3) × regions(1) = 30 credits / 每次快照
 */
import 'dotenv/config';
import db from '../db/database.js';
import { LEAGUES } from '../config.js';
import { OddsApiClient, isOddsQuotaExhaustedError } from '../services/OddsApiClient.js';
import { recordOddsSnapshot } from '../services/PitOddsService.js';

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const days = Number(argValue('days') || 30);
const dryRun = process.argv.includes('--dry-run');

const since = new Date();
since.setUTCDate(since.getUTCDate() - days);
const sinceIso = since.toISOString();

const missing = db
  .prepare(
    `
    SELECT * FROM games
    WHERE league IN ('MLB','NPB','KBO')
      AND datetime(commence_time) >= datetime(?)
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND (raw_odds IS NULL OR raw_odds = '[]' OR length(raw_odds) <= 2)
    ORDER BY commence_time
  `
  )
  .all(sinceIso);

if (!missing.length) {
  console.log('無需補齊的場次');
  process.exit(0);
}

/** 按聯盟+開賽日分組，每組一次歷史快照（開賽前 2h） */
const groups = new Map();
for (const g of missing) {
  const day = String(g.commence_time).slice(0, 10);
  const key = `${g.league}|${day}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(g);
}

console.log(
  `待補 ${missing.length} 場 · ${groups.size} 次歷史快照請求` +
    (dryRun ? ' [dry-run]' : '')
);

const client = new OddsApiClient();
let filled = 0;
let notFound = 0;
let errors = 0;

for (const [key, games] of groups) {
  const [leagueCode, day] = key.split('|');
  const league = LEAGUES[leagueCode];
  if (!league) continue;

  const earliest = games.reduce((a, g) =>
    new Date(g.commence_time) < new Date(a.commence_time) ? g : a
  );
  const snapAt = new Date(new Date(earliest.commence_time).getTime() - 2 * 3600000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  if (dryRun) {
    console.log(`[dry-run] ${leagueCode} ${day} snap=${snapAt} games=${games.length}`);
    continue;
  }

  try {
    const resp = await client.getHistoricalOdds(league.key, snapAt, {
      regions: league.region,
    });
    const events = resp.data || [];
    const byId = new Map(events.map((e) => [e.id, e]));

    for (const g of games) {
      const ev = byId.get(g.id);
      if (!ev?.bookmakers?.length) {
        notFound += 1;
        console.warn(`  未找到 ${g.commence_time} ${g.away_team} @ ${g.home_team}`);
        continue;
      }
      const json = JSON.stringify(ev.bookmakers);
      db.prepare(
        `UPDATE games SET raw_odds = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(json, g.id);
      recordOddsSnapshot({
        gameId: g.id,
        league: g.league,
        commenceTime: g.commence_time,
        capturedAt: resp.timestamp || snapAt,
        bookmakers: ev.bookmakers,
        source: 'historical_api',
      });
      filled += 1;
    }

    const left = client.getQuota()?.remaining;
    console.log(
      `✓ ${leagueCode} ${day} 快照@${resp.timestamp || snapAt} 命中 ${games.length - notFound}/${games.length} · 剩餘額度 ${left}`
    );
  } catch (err) {
    errors += 1;
    console.error(`✗ ${key}:`, err.message);
    if (isOddsQuotaExhaustedError(err)) break;
  }
}

console.log(`\n完成: 補齊 ${filled} 場 · 未找到 ${notFound} · 錯誤 ${errors}`);
