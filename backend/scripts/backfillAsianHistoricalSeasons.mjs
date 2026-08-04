/**
 * 亞聯（NPB/KBO）歷史初盤回填 — 研究用
 *
 * 成本：historical odds ≈ 10 × markets × regions
 * 預設 markets=h2h → 約 10 credits／聯盟／日
 * 預算預設 9000，保留 remaining≥3000 即停
 *
 * 用法:
 *   node scripts/backfillAsianHistoricalSeasons.mjs --dry-run
 *   node scripts/backfillAsianHistoricalSeasons.mjs
 *   node scripts/backfillAsianHistoricalSeasons.mjs --budget=9000 --min-remaining=3000
 */
import 'dotenv/config';
import db from '../src/db/database.js';
import { LEAGUES } from '../src/config.js';
import {
  OddsApiClient,
  isOddsQuotaExhaustedError,
  remainingQuota,
} from '../src/services/OddsApiClient.js';
import { recordOddsSnapshot } from '../src/services/PitOddsService.js';
import {
  fetchNpbOfficialSeasonScores,
  matchOfficialScoreToGame,
} from '../src/services/NpbOfficialScores.js';
import {
  fetchNaverKboScores,
  matchKboScoreToGame,
} from '../src/services/KboNaverScores.js';

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const dryRun = process.argv.includes('--dry-run');
const scoresOnly = process.argv.includes('--scores-only');
const budget = Number(argValue('budget') || 9000);
const minRemaining = Number(argValue('min-remaining') || 3000);
const markets = argValue('markets') || 'h2h';
const creditPerReq = 10 * markets.split(',').filter(Boolean).length * 1; // regions=1

const RANGES = [
  ['2024-03-29', '2024-10-31'],
  ['2025-03-20', '2025-10-31'],
];
const LEAGUE_CODES = ['NPB', 'KBO'];

function eachUtcDayRange(fromYmd, toYmd) {
  const out = [];
  let t = Date.parse(`${fromYmd}T00:00:00Z`);
  const end = Date.parse(`${toYmd}T00:00:00Z`);
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86400000;
  }
  return out;
}

function dayOddsCount(league, day) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM games
       WHERE league = ?
         AND date(commence_time) = date(?)
         AND raw_odds IS NOT NULL AND length(raw_odds) > 10`
    )
    .get(league, day);
  return row?.n || 0;
}

function dayAlreadyCovered(league, day) {
  return dayOddsCount(league, day) >= 2;
}

function upsertOddsGame(league, event, snapshotAt) {
  if (!event?.id || !event.bookmakers?.length) return false;
  const json = JSON.stringify(event.bookmakers);
  const existing = db.prepare('SELECT id, raw_odds FROM games WHERE id = ?').get(event.id);
  if (!existing) {
    db.prepare(
      `INSERT INTO games (id, league, commence_time, home_team, away_team, raw_odds, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(event.id, league, event.commence_time, event.home_team, event.away_team, json);
  } else if (!existing.raw_odds || existing.raw_odds.length <= 10) {
    db.prepare(
      `UPDATE games SET raw_odds = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(json, event.id);
  }
  recordOddsSnapshot({
    gameId: event.id,
    league,
    commenceTime: event.commence_time,
    capturedAt: snapshotAt || new Date().toISOString(),
    bookmakers: event.bookmakers,
    source: 'historical_api_asian_h2h',
  });
  return true;
}

const dayList = RANGES.flatMap(([a, b]) => eachUtcDayRange(a, b));
const jobs = [];
for (const day of dayList) {
  for (const code of LEAGUE_CODES) {
    jobs.push({ day, code });
  }
}

const todo = jobs.filter((j) => !dayAlreadyCovered(j.code, j.day));
const skippedCovered = jobs.length - todo.length;

console.log(
  JSON.stringify(
    {
      ranges: RANGES,
      leagues: LEAGUE_CODES,
      markets,
      creditPerReq,
      budget,
      minRemaining,
      totalDayLeagueSlots: jobs.length,
      alreadyCovered: skippedCovered,
      pending: todo.length,
      estCreditsIfAll: todo.length * creditPerReq,
      dryRun,
      scoresOnly,
    },
    null,
    2
  )
);

if (dryRun) {
  console.log('\n[dry-run] 未呼叫 API。確認後去掉 --dry-run 執行。');
  process.exit(0);
}

const client = new OddsApiClient();
let requests = 0;
let estUsed = 0;
let gamesUpserted = 0;
let emptyDays = 0;
let errors = 0;
const touchedDays = new Set();

if (!scoresOnly) {
  console.log('\n=== 歷史盤口回填（NPB/KBO · h2h）===');
  for (const { day, code } of todo) {
    const rem = remainingQuota(client.getQuota());
    if (requests > 0 && rem != null && rem < minRemaining) {
      console.log(`\n停止：remaining=${rem} < minRemaining=${minRemaining}`);
      break;
    }
    if (estUsed + creditPerReq > budget) {
      console.log(`\n停止：預算用盡 estUsed=${estUsed} budget=${budget}`);
      break;
    }

    const league = LEAGUES[code];
    const date = `${day}T02:00:00Z`;
    try {
      const resp = await client.getHistoricalOdds(league.key, date, {
        regions: league.region,
        markets,
      });
      requests += 1;
      estUsed += creditPerReq;
      const events = resp.data || [];
      let hit = 0;
      for (const ev of events) {
        if (upsertOddsGame(code, ev, resp.timestamp || date)) {
          hit += 1;
          gamesUpserted += 1;
        }
      }
      if (!events.length) emptyDays += 1;
      else touchedDays.add(`${code}|${day}`);
      if (requests % 25 === 0 || hit > 0) {
        const q = client.getQuota();
        process.stdout.write(
          `\r${day} ${code} hit=${hit} req=${requests} estUsed=${estUsed} remaining=${q?.remaining ?? '?'}   `
        );
      }
      await new Promise((r) => setTimeout(r, 120));
    } catch (err) {
      errors += 1;
      console.warn(`\n${day} ${code} 失敗:`, err.message);
      if (isOddsQuotaExhaustedError(err)) break;
    }
  }
  console.log(
    '\n',
    JSON.stringify(
      {
        requests,
        estUsed,
        gamesUpserted,
        emptyDays,
        errors,
        remaining: client.getQuota()?.remaining ?? null,
      },
      null,
      2
    )
  );
}

// 免費補比分：NPB 用官網月表（Yahoo 對歷史球季會 fallback）；KBO 用 Naver 日表
console.log('\n=== 免費補比分（NPB official / Naver KBO）===');

let npbScored = 0;
let kboScored = 0;

console.log('NPB: npb.jp schedule_XX_detail …');
for (const year of [2024, 2025]) {
  try {
    const official = await fetchNpbOfficialSeasonScores(year);
    const byDay = new Map();
    for (const s of official) {
      if (!byDay.has(s.dateIso)) byDay.set(s.dateIso, []);
      byDay.get(s.dateIso).push(s);
    }
    const games = db
      .prepare(
        `SELECT * FROM games
         WHERE league='NPB'
           AND substr(commence_time,1,4)=?
           AND (home_score IS NULL OR away_score IS NULL OR completed=0)`
      )
      .all(String(year));
    for (const g of games) {
      const day = String(g.commence_time).slice(0, 10);
      const pool = byDay.get(day) || official;
      const hit = matchOfficialScoreToGame(g, pool);
      if (!hit || !Number.isFinite(hit.homeScore) || !Number.isFinite(hit.awayScore)) continue;
      if (hit.status !== 'completed') continue;
      db.prepare(
        `UPDATE games SET home_score=?, away_score=?, completed=1, status='completed', updated_at=datetime('now')
         WHERE id=?`
      ).run(hit.homeScore, hit.awayScore, g.id);
      npbScored += 1;
    }
    console.log(`NPB ${year}: officialRows=${official.length}`);
  } catch (err) {
    console.warn(`NPB ${year}`, err.message);
  }
}

const kboDays = db
  .prepare(
    `SELECT DISTINCT date(commence_time) AS d
     FROM games
     WHERE league='KBO'
       AND date(commence_time) >= date('2024-03-01')
       AND date(commence_time) <= date('2025-11-30')
       AND (home_score IS NULL OR away_score IS NULL)
     ORDER BY d`
  )
  .all();

for (const row of kboDays) {
  const day = row.d;
  try {
    const scores = await fetchNaverKboScores(day);
    const games = db
      .prepare(
        `SELECT * FROM games WHERE league='KBO' AND date(commence_time)=date(?)
         AND (home_score IS NULL OR away_score IS NULL)`
      )
      .all(day);
    for (const g of games) {
      const hit = matchKboScoreToGame(g, scores);
      if (!hit || !Number.isFinite(hit.homeScore) || !Number.isFinite(hit.awayScore)) continue;
      db.prepare(
        `UPDATE games SET home_score=?, away_score=?, completed=1, status='completed', updated_at=datetime('now')
         WHERE id=?`
      ).run(hit.homeScore, hit.awayScore, g.id);
      kboScored += 1;
    }
  } catch (err) {
    console.warn(`KBO ${day}`, err.message);
  }
  await new Promise((r) => setTimeout(r, 80));
}

const coverage = db
  .prepare(
    `SELECT league,
       substr(commence_time,1,4) AS y,
       COUNT(*) AS total,
       SUM(CASE WHEN home_score IS NOT NULL AND away_score IS NOT NULL THEN 1 ELSE 0 END) AS scored,
       SUM(CASE WHEN raw_odds IS NOT NULL AND length(raw_odds)>10 THEN 1 ELSE 0 END) AS with_odds,
       SUM(CASE WHEN home_score IS NOT NULL AND away_score IS NOT NULL
                 AND raw_odds IS NOT NULL AND length(raw_odds)>10 THEN 1 ELSE 0 END) AS gradable
     FROM games
     WHERE league IN ('NPB','KBO')
     GROUP BY league, y
     ORDER BY league, y`
  )
  .all();

console.log(
  JSON.stringify(
    {
      npbScored,
      kboScored,
      coverage,
      finalQuota: client.getQuota(),
    },
    null,
    2
  )
);
