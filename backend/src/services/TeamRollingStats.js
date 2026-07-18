/**
 * 近窗隊力形態：完賽累積後的 OBP/SLG/OPS/WHIP（MLB）與 RPG/RAPG（全聯盟）
 * 用於調整初盤 λ，類似足球用近期 xG 而非單場箱分。
 */

import db from '../db/database.js';
import { config } from '../config.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function mlbDate(d) {
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/^\./, '0.'));
  return Number.isFinite(n) ? n : null;
}

async function mlbTeamsStats(group, startDate, endDate, season) {
  const url = new URL('https://statsapi.mlb.com/api/v1/teams/stats');
  url.searchParams.set('sportIds', '1');
  url.searchParams.set('group', group);
  url.searchParams.set('stats', 'byDateRange');
  url.searchParams.set('season', String(season));
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`MLB teams/stats ${group} HTTP ${res.status}`);
  const data = await res.json();
  return data.stats?.[0]?.splits || [];
}

export function ensureRollingColumns() {
  const cols = [
    'ALTER TABLE team_stats ADD COLUMN avg_30 REAL',
    'ALTER TABLE team_stats ADD COLUMN obp_30 REAL',
    'ALTER TABLE team_stats ADD COLUMN slg_30 REAL',
    'ALTER TABLE team_stats ADD COLUMN ops_30 REAL',
    'ALTER TABLE team_stats ADD COLUMN era_30 REAL',
    'ALTER TABLE team_stats ADD COLUMN whip_30 REAL',
    'ALTER TABLE team_stats ADD COLUMN rpg_30 REAL',
    'ALTER TABLE team_stats ADD COLUMN rapg_30 REAL',
    'ALTER TABLE team_stats ADD COLUMN games_30 INTEGER DEFAULT 0',
    'ALTER TABLE team_stats ADD COLUMN rolling_window_days INTEGER DEFAULT 30',
    'ALTER TABLE team_stats ADD COLUMN rolling_updated_at TEXT',
  ];
  for (const sql of cols) {
    try {
      db.exec(sql);
    } catch {
      /* already exists */
    }
  }
}

/** COALESCE：null 不覆蓋既有欄位（RPG 與 baseball-data OPS 可分次寫入） */
export function upsertRolling() {
  return db.prepare(`
    INSERT INTO team_stats (
      league, team_name, avg_30, obp_30, slg_30, ops_30, era_30, whip_30,
      rpg_30, rapg_30, games_30, rolling_window_days, rolling_updated_at, updated_at
    ) VALUES (
      @league, @team_name, @avg_30, @obp_30, @slg_30, @ops_30, @era_30, @whip_30,
      @rpg_30, @rapg_30, @games_30, @window_days, datetime('now'), datetime('now')
    )
    ON CONFLICT(league, team_name) DO UPDATE SET
      avg_30 = COALESCE(@avg_30, team_stats.avg_30),
      obp_30 = COALESCE(@obp_30, team_stats.obp_30),
      slg_30 = COALESCE(@slg_30, team_stats.slg_30),
      ops_30 = COALESCE(@ops_30, team_stats.ops_30),
      era_30 = COALESCE(@era_30, team_stats.era_30),
      whip_30 = COALESCE(@whip_30, team_stats.whip_30),
      rpg_30 = COALESCE(@rpg_30, team_stats.rpg_30),
      rapg_30 = COALESCE(@rapg_30, team_stats.rapg_30),
      games_30 = COALESCE(@games_30, team_stats.games_30),
      rolling_window_days = COALESCE(@window_days, team_stats.rolling_window_days),
      rolling_updated_at = datetime('now'),
      updated_at = datetime('now')
  `);
}

/**
 * MLB：Stats API 近 N 日球隊打擊／投球（完賽累積）
 */
export async function refreshMlbRollingOffenseDefense(days = null) {
  ensureRollingColumns();
  const windowDays = days ?? config.rollingFormDays ?? 30;
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - windowDays);
  const season = end.getFullYear();
  const startDate = mlbDate(start);
  const endDate = mlbDate(end);

  const [hitting, pitching] = await Promise.all([
    mlbTeamsStats('hitting', startDate, endDate, season),
    mlbTeamsStats('pitching', startDate, endDate, season),
  ]);

  const byTeam = new Map();
  for (const s of hitting) {
    const name = s.team?.name;
    if (!name) continue;
    const games = Number(s.stat?.gamesPlayed) || 0;
    const runs = toNum(s.stat?.runs);
    byTeam.set(name, {
      league: 'MLB',
      team_name: name,
      avg_30: toNum(s.stat?.avg),
      obp_30: toNum(s.stat?.obp),
      slg_30: toNum(s.stat?.slg),
      ops_30: toNum(s.stat?.ops),
      era_30: null,
      whip_30: null,
      rpg_30: games > 0 && runs != null ? runs / games : null,
      rapg_30: null,
      games_30: games,
      window_days: windowDays,
    });
  }
  for (const s of pitching) {
    const name = s.team?.name;
    if (!name) continue;
    const prev = byTeam.get(name) || {
      league: 'MLB',
      team_name: name,
      avg_30: null,
      obp_30: null,
      slg_30: null,
      ops_30: null,
      rpg_30: null,
      games_30: Number(s.stat?.gamesPlayed) || 0,
      window_days: windowDays,
    };
    const games = Number(s.stat?.gamesPlayed) || prev.games_30 || 0;
    const runsAllowed = toNum(s.stat?.runs);
    prev.era_30 = toNum(s.stat?.era);
    prev.whip_30 = toNum(s.stat?.whip);
    prev.rapg_30 = games > 0 && runsAllowed != null ? runsAllowed / games : prev.rapg_30;
    prev.games_30 = Math.max(prev.games_30 || 0, games);
    byTeam.set(name, prev);
  }

  const stmt = upsertRolling();
  db.transaction(() => {
    for (const row of byTeam.values()) stmt.run(row);
  })();
  return { league: 'MLB', teams: byTeam.size, windowDays, startDate, endDate };
}

/**
 * NPB/KBO：用庫內完賽比分重建近 N 日 RPG/RAPG（無箱分時的得分形態）
 */
export function refreshLeagueRollingRunForm(league, days = null) {
  if (league !== 'NPB' && league !== 'KBO' && league !== 'MLB') {
    return { league, teams: 0 };
  }
  ensureRollingColumns();
  const windowDays = days ?? config.rollingFormDays ?? 30;
  const since = new Date();
  since.setDate(since.getDate() - windowDays);
  const sinceIso = since.toISOString();

  const rows = db
    .prepare(
      `
    SELECT home_team, away_team, home_score, away_score, commence_time
    FROM games
    WHERE league = ?
      AND completed = 1
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND NOT (home_score = 0 AND away_score = 0)
      AND datetime(commence_time) >= datetime(?)
    ORDER BY datetime(commence_time) ASC
  `
    )
    .all(league, sinceIso);

  const bag = {};
  for (const g of rows) {
    const hs = Number(g.home_score);
    const as = Number(g.away_score);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    for (const [team, rs, ra] of [
      [g.home_team, hs, as],
      [g.away_team, as, hs],
    ]) {
      if (!bag[team]) bag[team] = { rs: 0, ra: 0, n: 0 };
      bag[team].rs += rs;
      bag[team].ra += ra;
      bag[team].n += 1;
    }
  }

  const stmt = upsertRolling();
  db.transaction(() => {
    for (const [team, v] of Object.entries(bag)) {
      if (v.n < 1) continue;
      stmt.run({
        league,
        team_name: team,
        avg_30: null,
        obp_30: null,
        slg_30: null,
        ops_30: null,
        era_30: null,
        whip_30: null,
        rpg_30: v.rs / v.n,
        rapg_30: v.ra / v.n,
        games_30: v.n,
        window_days: windowDays,
      });
    }
  })();
  return { league, teams: Object.keys(bag).length, games: rows.length, windowDays };
}

export async function refreshAllRollingTeamForm(days = null) {
  ensureRollingColumns();
  const windowDays = days ?? config.rollingFormDays ?? 30;
  const out = {
    NPB: refreshLeagueRollingRunForm('NPB', windowDays),
    KBO: refreshLeagueRollingRunForm('KBO', windowDays),
    MLB_runs: refreshLeagueRollingRunForm('MLB', windowDays),
    MLB_ops: null,
    NPB_ops: null,
    KBO_ops: null,
  };
  try {
    out.MLB_ops = await refreshMlbRollingOffenseDefense(windowDays);
  } catch (err) {
    console.warn('[rolling] MLB OBP/SLG/WHIP 同步失敗:', err.message);
  }
  // NPB：baseball-data.com 隊級 OPS/WHIP（在 RPG 之後寫入，COALESCE 不覆蓋 RPG）
  if (config.enableNpbBaseballDataForm !== false) {
    try {
      const { refreshNpbBaseballDataTeamForm } = await import('./NpbBaseballDataStats.js');
      out.NPB_ops = await refreshNpbBaseballDataTeamForm();
    } catch (err) {
      console.warn('[rolling] NPB baseball-data OPS/WHIP 同步失敗:', err.message);
    }
  }
  // KBO：官網 TeamStats OPS/ERA/WHIP
  if (config.enableKboOfficialForm !== false) {
    try {
      const { refreshKboOfficialTeamForm } = await import('./KboOfficialStats.js');
      out.KBO_ops = await refreshKboOfficialTeamForm();
    } catch (err) {
      console.warn('[rolling] KBO 官網 OPS/WHIP 同步失敗:', err.message);
    }
  }
  return out;
}

/** 形態乘數：OPS 高於聯盟 → 進攻加分；對手 WHIP 高 → 對手易失分 */
export function offenseFormMultiplier(ops30, leagueOps = 0.72) {
  if (ops30 == null || !Number.isFinite(ops30) || leagueOps <= 0) return 1;
  const raw = 1 + 0.55 * (ops30 / leagueOps - 1);
  return Math.max(0.88, Math.min(1.14, raw));
}

export function staffWhipMultiplier(whip30, leagueWhip = 1.28) {
  if (whip30 == null || !Number.isFinite(whip30) || leagueWhip <= 0) return 1;
  // 對手投手群 WHIP 高 → 我方得分期望上調
  const raw = 1 + 0.4 * (whip30 / leagueWhip - 1);
  return Math.max(0.88, Math.min(1.14, raw));
}

/** 開賽前一日（UTC）當 as-of，避免含當日進行中場 */
function asOfDateKey(commenceTime) {
  const t = new Date(commenceTime);
  if (!Number.isFinite(t.getTime())) return null;
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

function windowBounds(asOfYmd, windowDays) {
  const end = new Date(`${asOfYmd}T12:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - windowDays + 1);
  return {
    startDate: mlbDate(start),
    endDate: mlbDate(end),
    startIso: start.toISOString(),
    endIso: new Date(`${asOfYmd}T23:59:59Z`).toISOString(),
    season: end.getUTCFullYear(),
  };
}

/** 記憶體快取：同一 as-of 日只打 2 次免費 Stats API（hitting+pitching），不耗 Odds 額度 */
const mlbPitCache = new Map();
let mlbPitApiCalls = 0;

export function getMlbPitApiCallCount() {
  return mlbPitApiCalls;
}

export function resetMlbPitApiCallCount() {
  mlbPitApiCalls = 0;
  mlbPitCache.clear();
}

/**
 * MLB：開賽前 point-in-time 近窗（不含開賽當日）
 * @returns {Map<string, object>} teamName -> rolling fields
 */
export async function fetchMlbRollingFormAsOf(commenceTime, days = null) {
  const windowDays = days ?? config.rollingFormDays ?? 30;
  const asOf = asOfDateKey(commenceTime);
  if (!asOf) return new Map();
  const cacheKey = `${asOf}|${windowDays}`;
  if (mlbPitCache.has(cacheKey)) return mlbPitCache.get(cacheKey);

  const { startDate, endDate, season } = windowBounds(asOf, windowDays);
  const [hitting, pitching] = await Promise.all([
    mlbTeamsStats('hitting', startDate, endDate, season),
    mlbTeamsStats('pitching', startDate, endDate, season),
  ]);
  mlbPitApiCalls += 2;

  const byTeam = new Map();
  for (const s of hitting) {
    const name = s.team?.name;
    if (!name) continue;
    const games = Number(s.stat?.gamesPlayed) || 0;
    const runs = toNum(s.stat?.runs);
    byTeam.set(name, {
      league: 'MLB',
      team_name: name,
      avg_30: toNum(s.stat?.avg),
      obp_30: toNum(s.stat?.obp),
      slg_30: toNum(s.stat?.slg),
      ops_30: toNum(s.stat?.ops),
      era_30: null,
      whip_30: null,
      rpg_30: games > 0 && runs != null ? runs / games : null,
      rapg_30: null,
      games_30: games,
      rolling_window_days: windowDays,
      pit_as_of: asOf,
    });
  }
  for (const s of pitching) {
    const name = s.team?.name;
    if (!name) continue;
    const prev = byTeam.get(name) || {
      league: 'MLB',
      team_name: name,
      avg_30: null,
      obp_30: null,
      slg_30: null,
      ops_30: null,
      rpg_30: null,
      games_30: Number(s.stat?.gamesPlayed) || 0,
      rolling_window_days: windowDays,
      pit_as_of: asOf,
    };
    const games = Number(s.stat?.gamesPlayed) || prev.games_30 || 0;
    const runsAllowed = toNum(s.stat?.runs);
    prev.era_30 = toNum(s.stat?.era);
    prev.whip_30 = toNum(s.stat?.whip);
    prev.rapg_30 = games > 0 && runsAllowed != null ? runsAllowed / games : prev.rapg_30;
    prev.games_30 = Math.max(prev.games_30 || 0, games);
    byTeam.set(name, prev);
  }

  mlbPitCache.set(cacheKey, byTeam);
  return byTeam;
}

/**
 * NPB/KBO/MLB：用庫內完賽比分算開賽前近窗 RPG/RAPG（零 API）
 */
export function computeRunFormAsOf(league, commenceTime, days = null) {
  const windowDays = days ?? config.rollingFormDays ?? 30;
  const asOf = asOfDateKey(commenceTime);
  if (!asOf) return new Map();
  const { startIso, endIso } = windowBounds(asOf, windowDays);

  const rows = db
    .prepare(
      `
    SELECT home_team, away_team, home_score, away_score
    FROM games
    WHERE league = ?
      AND completed = 1
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND NOT (home_score = 0 AND away_score = 0)
      AND datetime(commence_time) >= datetime(?)
      AND datetime(commence_time) <= datetime(?)
  `
    )
    .all(league, startIso, endIso);

  const bag = {};
  for (const g of rows) {
    const hs = Number(g.home_score);
    const as = Number(g.away_score);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    for (const [team, rs, ra] of [
      [g.home_team, hs, as],
      [g.away_team, as, hs],
    ]) {
      if (!bag[team]) bag[team] = { rs: 0, ra: 0, n: 0 };
      bag[team].rs += rs;
      bag[team].ra += ra;
      bag[team].n += 1;
    }
  }

  const byTeam = new Map();
  for (const [team, v] of Object.entries(bag)) {
    byTeam.set(team, {
      league,
      team_name: team,
      rpg_30: v.rs / v.n,
      rapg_30: v.ra / v.n,
      games_30: v.n,
      rolling_window_days: windowDays,
      pit_as_of: asOf,
    });
  }
  return byTeam;
}

/**
 * 組合開賽前隊力覆寫（回測用，防洩漏）
 * MLB：Stats API OPS/WHIP + DB RPG 補強；NPB/KBO：僅 DB RPG
 */
export async function buildPointInTimeTeamStatsOverride(
  league,
  commenceTime,
  homeTeam,
  awayTeam,
  days = null
) {
  const baseHome = db
    .prepare(`SELECT * FROM team_stats WHERE league = ? AND team_name = ?`)
    .get(league, homeTeam);
  const baseAway = db
    .prepare(`SELECT * FROM team_stats WHERE league = ? AND team_name = ?`)
    .get(league, awayTeam);

  const runForm = computeRunFormAsOf(league, commenceTime, days);
  let mlbForm = null;
  if (league === 'MLB') {
    try {
      mlbForm = await fetchMlbRollingFormAsOf(commenceTime, days);
    } catch (err) {
      console.warn('[pit-rolling] MLB Stats API 失敗:', err.message);
    }
  }

  const merge = (team, base) => {
    const fromRuns = runForm.get(team) || {};
    const fromMlb = mlbForm?.get(team) || {};
    return {
      ...(base || { league, team_name: team }),
      ...fromRuns,
      ...fromMlb,
      // RPG：優先 API（含 runs），否則 DB 完賽窗
      rpg_30: fromMlb.rpg_30 ?? fromRuns.rpg_30 ?? base?.rpg_30 ?? null,
      rapg_30: fromMlb.rapg_30 ?? fromRuns.rapg_30 ?? base?.rapg_30 ?? null,
      games_30: Math.max(
        Number(fromMlb.games_30) || 0,
        Number(fromRuns.games_30) || 0,
        Number(base?.games_30) || 0
      ),
      rolling_window_days:
        fromMlb.rolling_window_days ||
        fromRuns.rolling_window_days ||
        days ||
        config.rollingFormDays ||
        30,
    };
  };

  return {
    [homeTeam]: merge(homeTeam, baseHome),
    [awayTeam]: merge(awayTeam, baseAway),
  };
}
