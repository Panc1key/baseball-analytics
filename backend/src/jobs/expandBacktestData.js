/**
 * 擴大回測樣本：補比分 + 歷史盤口（MLB / NPB / KBO）
 *
 * 1. Odds API scores（近 3 天完賽）
 * 2. 歷史盤口：近 N 天每日一快照，寫入/補齊 raw_odds
 * 3. MLB Stats API 補更早比分（免費）
 * 4. Yahoo NPB 補日職比分（免費）
 * 5. 仍缺盤口的完賽場：多時間點重試
 */
import 'dotenv/config';
import db from '../db/database.js';
import { LEAGUES } from '../config.js';
import {
  OddsApiClient,
  isOddsQuotaExhaustedError,
  remainingQuota,
} from '../services/OddsApiClient.js';
import { getMlbSchedule, matchMlbTeam } from '../services/MlbStatsService.js';
import {
  fetchYahooNpbLiveScores,
  matchYahooScoreToGame,
} from '../services/NpbYahooScores.js';
import {
  fetchNaverKboScores,
  matchKboScoreToGame,
} from '../services/KboNaverScores.js';

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function isoNoMs(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function eachUtcDay(days) {
  const out = [];
  const now = new Date();
  for (let i = days; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** 含首尾的 UTC 日期清單 YYYY-MM-DD */
function eachUtcDayRange(fromYmd, toYmd) {
  const out = [];
  let t = Date.parse(`${fromYmd}T00:00:00Z`);
  const end = Date.parse(`${toYmd}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(end) || t > end) {
    throw new Error(`無效日期區間 from=${fromYmd} to=${toYmd}`);
  }
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86400000;
  }
  return out;
}

function dayOddsCount(league, day) {
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS n FROM games
      WHERE league = ?
        AND date(commence_time) = date(?)
        AND raw_odds IS NOT NULL
        AND length(raw_odds) > 10
    `
    )
    .get(league, day);
  return row?.n || 0;
}

/** 已有足夠盤口的聯盟日略過，避免重複燒 credit */
function dayAlreadyCovered(league, day) {
  const min = league === 'MLB' ? 5 : 2;
  return dayOddsCount(league, day) >= min;
}

function upsertOddsGame(league, event, snapshotAt) {
  if (!event?.id || !event.bookmakers?.length) return false;
  const json = JSON.stringify(event.bookmakers);
  const existing = db.prepare('SELECT id, raw_odds, home_score FROM games WHERE id = ?').get(event.id);

  if (!existing) {
    db.prepare(
      `
      INSERT INTO games (id, league, commence_time, home_team, away_team, raw_odds, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `
    ).run(event.id, league, event.commence_time, event.home_team, event.away_team, json);
  } else {
    const hasOdds = existing.raw_odds && existing.raw_odds.length > 10;
    if (!hasOdds) {
      db.prepare(`UPDATE games SET raw_odds = ?, updated_at = datetime('now') WHERE id = ?`).run(
        json,
        event.id
      );
    }
  }

  db.prepare(
    `
    INSERT OR IGNORE INTO odds_snapshots (game_id, league, captured_at, bookmakers_json, source)
    VALUES (?, ?, ?, ?, 'historical_api')
  `
  ).run(event.id, league, snapshotAt || new Date().toISOString(), json);
  return true;
}

function applyScoreRow(gameId, league, commence, home, away, hs, as, completed) {
  const done = completed ? 1 : 0;
  const status = completed ? 'completed' : 'in_progress';
  db.prepare(
    `
    INSERT INTO games (id, league, commence_time, home_team, away_team, completed, home_score, away_score, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      completed = CASE WHEN excluded.completed = 1 THEN 1 ELSE games.completed END,
      home_score = COALESCE(excluded.home_score, games.home_score),
      away_score = COALESCE(excluded.away_score, games.away_score),
      status = CASE WHEN excluded.completed = 1 THEN 'completed' ELSE games.status END,
      updated_at = datetime('now')
  `
  ).run(gameId, league, commence, home, away, done, hs, as, status);
}

async function syncRecentScores(client) {
  console.log('\n=== 1) Odds API 近 3 日比分 ===');
  let n = 0;
  for (const [code, league] of Object.entries(LEAGUES)) {
    try {
      const scores = await client.getScores(league.key, 3);
      for (const g of scores) {
        const hsRaw = g.scores?.find((s) => s.name === g.home_team)?.score;
        const asRaw = g.scores?.find((s) => s.name === g.away_team)?.score;
        const hs = hsRaw != null && hsRaw !== '' ? parseInt(hsRaw, 10) : null;
        const as = asRaw != null && asRaw !== '' ? parseInt(asRaw, 10) : null;
        if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
        applyScoreRow(g.id, code, g.commence_time, g.home_team, g.away_team, hs, as, Boolean(g.completed));
        n += 1;
      }
      console.log(`  ${code}: 寫入/更新 ${scores.filter((g) => g.scores?.length).length} 場有比分`);
    } catch (err) {
      console.warn(`  ${code} 失敗:`, err.message);
      if (isOddsQuotaExhaustedError(err)) throw err;
    }
  }
  console.log(`  合計處理 ${n} 筆有比分紀錄 · 剩餘額度 ${remainingQuota(client.getQuota())}`);
}

async function backfillHistoricalOddsByDay(client, dayList, { skipCovered = true, dryRun = false } = {}) {
  console.log(
    `\n=== 2) 歷史盤口（${dayList[0]} ~ ${dayList[dayList.length - 1]} · ${dayList.length} 日 · MLB/NPB/KBO）===` +
      (skipCovered ? ' · 跳過已覆蓋' : '') +
      (dryRun ? ' [dry-run]' : '')
  );
  let filled = 0;
  let requests = 0;
  let skipped = 0;
  const creditPerReq = 30; // 10 × markets(3) × regions(1)

  for (const day of dayList) {
    // 亞洲聯盟用當日 02:00Z（約上午 10–11 台北），美職用當日 16:00Z（約開賽前）
    const snapByLeague = {
      NPB: `${day}T02:00:00Z`,
      KBO: `${day}T02:00:00Z`,
      MLB: `${day}T16:00:00Z`,
    };

    for (const [code, league] of Object.entries(LEAGUES)) {
      if (skipCovered && dayAlreadyCovered(code, day)) {
        skipped += 1;
        continue;
      }

      const date = snapByLeague[code];
      if (dryRun) {
        requests += 1;
        console.log(`  [dry-run] ${code} ${day} @${date} (現有盤口場 ${dayOddsCount(code, day)})`);
        continue;
      }

      try {
        const resp = await client.getHistoricalOdds(league.key, date, {
          regions: league.region,
        });
        requests += 1;
        const events = resp.data || [];
        let dayHit = 0;
        for (const ev of events) {
          if (upsertOddsGame(code, ev, resp.timestamp || date)) {
            dayHit += 1;
            filled += 1;
          }
        }
        console.log(
          `  ${code} ${day} @${resp.timestamp || date} → ${dayHit} 場 · 剩餘 ${remainingQuota(client.getQuota())}`
        );
      } catch (err) {
        console.warn(`  ${code} ${day} 失敗:`, err.message.slice(0, 120));
        if (isOddsQuotaExhaustedError(err)) throw err;
      }
    }
  }
  console.log(
    `  請求 ${requests} 次（估 ${requests * creditPerReq} credits）· 略過 ${skipped} · upsert/補盤約 ${filled} 次`
  );
  return { requests, skipped, filled, estimatedCredits: requests * creditPerReq };
}

async function hydrateMlbScoresFromStats(dayList) {
  console.log('\n=== 3) MLB Stats API 補比分（免費）===');
  let matched = 0;
  for (const day of dayList) {
    let schedule;
    try {
      schedule = await getMlbSchedule(day);
    } catch (err) {
      console.warn(`  ${day} 賽程失敗:`, err.message);
      continue;
    }
    const finals = (schedule || []).filter(
      (g) => g.status?.detailedState === 'Final' || g.status?.abstractGameState === 'Final'
    );
    if (!finals.length) continue;

    const candidates = db
      .prepare(
        `
        SELECT * FROM games
        WHERE league = 'MLB'
          AND date(commence_time) = date(?)
          AND (home_score IS NULL OR away_score IS NULL)
      `
      )
      .all(day);

    if (!candidates.length) continue;

    const teamList = finals.flatMap((g) => [
      { name: g.teams?.home?.team?.name, abbreviation: g.teams?.home?.team?.abbreviation },
      { name: g.teams?.away?.team?.name, abbreviation: g.teams?.away?.team?.abbreviation },
    ]);

    for (const game of candidates) {
      const homeHit = matchMlbTeam(game.home_team, teamList);
      const awayHit = matchMlbTeam(game.away_team, teamList);
      const sg = finals.find((g) => {
        const hn = g.teams?.home?.team?.name;
        const an = g.teams?.away?.team?.name;
        const homeOk =
          homeHit?.name === hn ||
          matchMlbTeam(game.home_team, [{ name: hn, abbreviation: g.teams?.home?.team?.abbreviation }]);
        const awayOk =
          awayHit?.name === an ||
          matchMlbTeam(game.away_team, [{ name: an, abbreviation: g.teams?.away?.team?.abbreviation }]);
        return homeOk && awayOk;
      });
      if (!sg) continue;
      const hs = sg.teams?.home?.score;
      const as = sg.teams?.away?.score;
      if (!Number.isFinite(Number(hs)) || !Number.isFinite(Number(as))) continue;
      db.prepare(
        `
        UPDATE games SET home_score = ?, away_score = ?, completed = 1, status = 'completed', updated_at = datetime('now')
        WHERE id = ?
      `
      ).run(Number(hs), Number(as), game.id);
      matched += 1;
    }
  }
  console.log(`  補上 ${matched} 場 MLB 比分`);
}

async function hydrateNpbFromYahoo(dayList) {
  console.log('\n=== 4) Yahoo NPB 補比分（按日 · 免費）===');
  let n = 0;
  for (const day of dayList) {
    let yahoo;
    try {
      yahoo = await fetchYahooNpbLiveScores(day);
    } catch (err) {
      console.warn(`  ${day} Yahoo 失敗:`, err.message);
      continue;
    }
    if (!yahoo.length) continue;

    const games = db
      .prepare(
        `
        SELECT * FROM games
        WHERE league = 'NPB'
          AND date(commence_time) = date(?)
          AND (home_score IS NULL OR away_score IS NULL OR completed = 0
               OR (home_score = 0 AND away_score = 0 AND completed = 0))
      `
      )
      .all(day);

    for (const g of games) {
      const hit = matchYahooScoreToGame(g, yahoo);
      if (!hit || !Number.isFinite(hit.homeScore) || !Number.isFinite(hit.awayScore)) continue;
      const done = hit.status === 'completed' || hit.linescore?.completed;
      if (!done && hit.homeScore === 0 && hit.awayScore === 0) continue;
      db.prepare(
        `
        UPDATE games SET home_score = ?, away_score = ?,
          completed = CASE WHEN ? THEN 1 ELSE completed END,
          status = CASE WHEN ? THEN 'completed' ELSE status END,
          updated_at = datetime('now')
        WHERE id = ?
      `
      ).run(hit.homeScore, hit.awayScore, done ? 1 : 0, done ? 1 : 0, g.id);
      n += 1;
    }
  }
  console.log(`  補上 ${n} 場 NPB 比分`);
}

async function hydrateKboFromNaver(dayList) {
  console.log('\n=== 4b) Naver KBO 補比分（免費）===');
  let n = 0;
  for (const day of dayList) {
    let scores;
    try {
      scores = await fetchNaverKboScores(day);
    } catch (err) {
      console.warn(`  ${day} Naver 失敗:`, err.message);
      continue;
    }
    if (!scores.length) continue;

    const games = db
      .prepare(
        `
        SELECT * FROM games
        WHERE league = 'KBO'
          AND date(commence_time) = date(?)
          AND (home_score IS NULL OR away_score IS NULL)
      `
      )
      .all(day);

    for (const g of games) {
      const hit = matchKboScoreToGame(g, scores);
      if (!hit) continue;
      db.prepare(
        `
        UPDATE games SET home_score = ?, away_score = ?,
          completed = CASE WHEN ? THEN 1 ELSE 1 END,
          status = 'completed',
          updated_at = datetime('now')
        WHERE id = ?
      `
      ).run(hit.homeScore, hit.awayScore, hit.completed ? 1 : 1, g.id);
      n += 1;
    }
  }
  console.log(`  補上 ${n} 場 KBO 比分`);
}

async function retryMissingOdds(client, dayList = null) {
  console.log('\n=== 5) 完賽缺盤口：多時間點重試 ===');
  const from = dayList?.[0];
  const to = dayList?.[dayList.length - 1];
  const missing = from && to
    ? db
        .prepare(
          `
          SELECT * FROM games
          WHERE league IN ('MLB','NPB','KBO')
            AND date(commence_time) >= date(?)
            AND date(commence_time) <= date(?)
            AND home_score IS NOT NULL AND away_score IS NOT NULL
            AND (raw_odds IS NULL OR length(raw_odds) <= 2)
          ORDER BY commence_time
        `
        )
        .all(from, to)
    : db
        .prepare(
          `
          SELECT * FROM games
          WHERE league IN ('MLB','NPB','KBO')
            AND home_score IS NOT NULL AND away_score IS NOT NULL
            AND (raw_odds IS NULL OR length(raw_odds) <= 2)
          ORDER BY commence_time
        `
        )
        .all();

  if (!missing.length) {
    console.log('  無需重試');
    return;
  }

  let filled = 0;
  for (const g of missing) {
    const league = LEAGUES[g.league];
    if (!league) continue;
    const t = new Date(g.commence_time).getTime();
    const candidates = [
      isoNoMs(t - 6 * 3600000),
      isoNoMs(t - 2 * 3600000),
      isoNoMs(t - 30 * 60000),
      `${String(g.commence_time).slice(0, 10)}T12:00:00Z`,
    ];

    let ok = false;
    for (const date of candidates) {
      try {
        const resp = await client.getHistoricalOdds(league.key, date, {
          regions: league.region,
        });
        const ev = (resp.data || []).find((e) => e.id === g.id);
        if (ev?.bookmakers?.length) {
          upsertOddsGame(g.league, ev, resp.timestamp || date);
          filled += 1;
          ok = true;
          console.log(`  ✓ ${g.league} ${g.away_team} @ ${g.home_team} @${date}`);
          break;
        }
      } catch (err) {
        if (isOddsQuotaExhaustedError(err)) throw err;
      }
    }
    if (!ok) console.warn(`  ✗ 仍無盤口 ${g.league} ${g.commence_time} ${g.away_team} @ ${g.home_team}`);
  }
  console.log(`  補齊 ${filled}/${missing.length}`);
}

function printCoverage() {
  const rows = db
    .prepare(
      `
    SELECT league,
      COUNT(*) total,
      SUM(CASE WHEN home_score IS NOT NULL AND away_score IS NOT NULL THEN 1 ELSE 0 END) scored,
      SUM(CASE WHEN raw_odds IS NOT NULL AND length(raw_odds)>10 THEN 1 ELSE 0 END) with_odds,
      SUM(CASE WHEN home_score IS NOT NULL AND away_score IS NOT NULL
                AND raw_odds IS NOT NULL AND length(raw_odds)>10 THEN 1 ELSE 0 END) gradable
    FROM games
    WHERE league IN ('MLB','NPB','KBO')
    GROUP BY league
  `
    )
    .all();
  console.log('\n=== 覆蓋率 ===');
  console.table(rows);
}

const daysArg = argValue('days');
const fromArg = argValue('from');
const toArg = argValue('to');
const skipHist = process.argv.includes('--scores-only');
const dryRun = process.argv.includes('--dry-run');
const forceAll = process.argv.includes('--force'); // 不跳過已覆蓋
const skipRecentScores = process.argv.includes('--no-recent-scores');

const dayList =
  fromArg && toArg
    ? eachUtcDayRange(fromArg, toArg)
    : eachUtcDay(Number(daysArg || 30));

console.log(
  `擴大回測樣本 · 日期 ${dayList[0]} ~ ${dayList[dayList.length - 1]}（${dayList.length} 日）` +
    (dryRun ? ' [dry-run]' : '')
);

const client = new OddsApiClient();
if (!dryRun && !skipRecentScores) {
  await syncRecentScores(client);
}
if (!skipHist) {
  await backfillHistoricalOddsByDay(client, dayList, {
    skipCovered: !forceAll,
    dryRun,
  });
}
if (!dryRun) {
  await hydrateMlbScoresFromStats(dayList);
  await hydrateNpbFromYahoo(dayList);
  await hydrateKboFromNaver(dayList);
  await retryMissingOdds(client, dayList);
  printCoverage();
  const spanDays = Math.ceil(
    (Date.now() - Date.parse(`${dayList[0]}T00:00:00Z`)) / 86400000
  );
  console.log(`\n完成。接著執行: node tmp-daily-pnl.js --days=${Math.max(spanDays, dayList.length)}`);
} else {
  console.log('\ndry-run 結束，未呼叫付費 API / 未寫入比分。');
}
console.log(
  '用法: node src/jobs/expandBacktestData.js [--days=30 | --from=YYYY-MM-DD --to=YYYY-MM-DD] [--dry-run] [--force] [--scores-only] [--no-recent-scores]'
);
