/**
 * MLB 官方 Stats API (免費、無需 key)
 * https://statsapi.mlb.com/api/v1/
 */

import db from '../db/database.js';

const MLB_BASE = 'https://statsapi.mlb.com/api/v1';
const teamStatsCache = new Map();
const teamRecordCache = new Map();
const pitcherGameLogCache = new Map();
const personHandCache = new Map();
const pitcherPlatoonCache = new Map();
const teamHittingPlatoonCache = new Map();
let mlbTeamsCache = null;

async function mlbFetch(path, params = {}) {
  const url = new URL(`${MLB_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`MLB API ${res.status}: ${path}`);
  return res.json();
}

/** 取得今日/日期範圍賽程，含先發投手 */
export async function getMlbSchedule(date) {
  const d = date || new Date().toISOString().slice(0, 10);
  const data = await mlbFetch('/schedule', {
    sportId: 1,
    date: d,
    hydrate: 'team,probablePitcher,linescore',
  });
  return data.dates?.[0]?.games || [];
}

/** 取得官方日期區間賽程，供跨季歷史資料回填。 */
export async function getMlbScheduleDateRange(startDate, endDate) {
  if (!startDate || !endDate) return [];
  const data = await mlbFetch('/schedule', {
    sportId: 1,
    startDate,
    endDate,
    hydrate: 'team',
  });
  return data.dates?.flatMap((date) => date.games || []) || [];
}

/** UTC 開賽時間可能與 MLB officialDate 相差一天；查詢前後三個日曆日。 */
export async function getMlbScheduleAround(commenceTime) {
  const commence = new Date(commenceTime);
  if (!Number.isFinite(commence.getTime())) return [];
  const dates = [-1, 0, 1].map((offset) => {
    const date = new Date(commence);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  });
  const schedules = await Promise.all(dates.map((date) => getMlbSchedule(date)));
  const unique = new Map();
  for (const game of schedules.flat()) {
    const key = game.gamePk || `${game.gameDate}:${game.teams?.away?.team?.id}:${game.teams?.home?.team?.id}`;
    unique.set(key, game);
  }
  return [...unique.values()];
}

/**
 * 以雙方隊伍 + 最接近開賽時間配對官方場次，避免雙重賽只靠隊名誤配。
 */
export function matchMlbOfficialGame(oddsGame, schedule, { maxHours = 18 } = {}) {
  const commenceMs = Date.parse(oddsGame?.commence_time || oddsGame?.commenceTime || '');
  if (!Number.isFinite(commenceMs)) return null;
  const candidates = (schedule || [])
    .filter((candidate) => {
      const home = candidate.teams?.home?.team;
      const away = candidate.teams?.away?.team;
      return home && away &&
        matchMlbTeam(oddsGame.home_team || oddsGame.homeTeam, [home]) &&
        matchMlbTeam(oddsGame.away_team || oddsGame.awayTeam, [away]);
    })
    .map((candidate) => ({
      candidate,
      differenceMs: Math.abs(Date.parse(candidate.gameDate) - commenceMs),
    }))
    .filter((entry) => Number.isFinite(entry.differenceMs))
    .sort((a, b) => a.differenceMs - b.differenceMs);
  if (!candidates.length || candidates[0].differenceMs > maxHours * 3600000) return null;
  return candidates[0].candidate;
}

/** 取得分區戰績 */
export async function getMlbStandings(season) {
  const year = season || new Date().getFullYear();
  const data = await mlbFetch('/standings', {
    leagueId: '103,104',
    season: year,
    standingsTypes: 'regularSeason',
    hydrate: 'team',
  });
  const teams = [];
  for (const record of data.records || []) {
    for (const teamRec of record.teamRecords || []) {
      const t = teamRec.team;
      teams.push({
        teamId: t.id,
        name: t.name,
        abbreviation: t.abbreviation,
        wins: teamRec.wins,
        losses: teamRec.losses,
        winPct: parseFloat(teamRec.winningPercentage || '0'),
        runsScored: teamRec.runsScored,
        runsAllowed: teamRec.runsAllowed,
        runDiff: teamRec.runDifferential,
        streak: teamRec.streak?.streakCode || '',
        last10: `${teamRec.records?.splitRecords?.find((s) => s.type === 'lastTen')?.wins || 0}-${teamRec.records?.splitRecords?.find((s) => s.type === 'lastTen')?.losses || 0}`,
        divisionRank: teamRec.divisionRank,
      });
    }
  }
  return teams;
}

/** 取得多日賽程（從今天起往後） */
export async function getMlbScheduleRange(dayCount = 3) {
  const games = [];
  for (let i = 0; i < dayCount; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayGames = await getMlbSchedule(dateStr);
    games.push(...dayGames);
  }
  return games;
}

/**
 * 滾球用賽程窗口：昨天～明天（涵蓋跨日進行中場次 + linescore）
 */
export async function getMlbScheduleWindow({ daysBack = 1, daysForward = 1 } = {}) {
  const games = [];
  for (let i = -daysBack; i <= daysForward; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayGames = await getMlbSchedule(dateStr);
    games.push(...dayGames);
  }
  return games;
}

/**
 * 從 MLB schedule hydrate linescore 解析局數進度
 * @returns {null|{inningsPlayed,inningsRemaining,currentInning,inningState,outs,balls,strikes,homeScore,awayScore,label,source}}
 */
export function extractLinescoreState(mlbGame) {
  const ls = mlbGame?.linescore;
  if (!ls) return null;

  const currentInning = Number(ls.currentInning) || 0;
  if (!currentInning) return null;

  const inningState = String(ls.inningState || '').toLowerCase();
  const outs = Math.min(2, Math.max(0, Number(ls.outs) || 0));
  const halfProgress = outs / 3;

  let inningsPlayed;
  if (inningState === 'end') {
    inningsPlayed = currentInning;
  } else if (inningState === 'middle') {
    inningsPlayed = currentInning - 0.5;
  } else if (inningState === 'bottom') {
    inningsPlayed = currentInning - 1 + 0.5 + halfProgress * 0.5;
  } else if (inningState === 'top') {
    inningsPlayed = currentInning - 1 + halfProgress * 0.5;
  } else {
    inningsPlayed = Math.max(0.4, currentInning - 0.5);
  }

  const regulation = 9;
  let inningsRemaining;
  if (currentInning > regulation) {
    // 延長賽：至少再半局
    inningsRemaining = inningState === 'end' ? 0.5 : Math.max(0.35, 1 - halfProgress * 0.5);
  } else {
    inningsRemaining = Math.max(0.3, regulation - inningsPlayed);
  }

  const stateLabel =
    { top: '上', bottom: '下', middle: '中', end: '結束' }[inningState] || inningState || '';

  return {
    inningsPlayed: Math.round(inningsPlayed * 100) / 100,
    inningsRemaining: Math.round(inningsRemaining * 100) / 100,
    currentInning,
    inningState: ls.inningState || null,
    outs,
    balls: ls.balls != null ? Number(ls.balls) : null,
    strikes: ls.strikes != null ? Number(ls.strikes) : null,
    homeScore: ls.teams?.home?.runs != null ? Number(ls.teams.home.runs) : null,
    awayScore: ls.teams?.away?.runs != null ? Number(ls.teams.away.runs) : null,
    label: `第${currentInning}局${stateLabel}${outs != null ? ` · ${outs}出局` : ''}`,
    source: 'mlb_linescore',
  };
}

export function parseMlbInjuredRoster(roster = []) {
  return roster
    .filter((entry) =>
      String(entry.status?.description || '').toLowerCase().startsWith('injured')
    )
    .map((entry) => ({
      id: entry.person?.id ?? null,
      name: entry.person?.fullName ?? null,
      position: entry.position?.abbreviation ?? null,
      status: entry.status?.description ?? null,
      statusCode: entry.status?.code ?? null,
    }))
    .filter((entry) => entry.name);
}

/** 傷兵名單摘要；MLB API 沒有 injuryList rosterType，必須由 40-man 狀態過濾。 */
export async function getTeamInjurySummary(teamId) {
  if (!teamId) return { ok: false, count: null, names: [], error: 'team_id_missing' };
  try {
    const data = await mlbFetch(`/teams/${teamId}/roster`, { rosterType: '40Man' });
    const names = parseMlbInjuredRoster(data.roster).map((entry) => entry.name);
    return { ok: true, count: names.length, names };
  } catch (err) {
    return { ok: false, count: null, names: [], error: err.message };
  }
}

/** 可追溯的傷兵名單資料；呼叫失敗必須回報失敗，不能偽裝成零傷兵。 */
export async function getTeamInjuryList(teamId) {
  if (!teamId) {
    return { ok: false, roster: [], error: 'team_id_missing' };
  }
  try {
    const data = await mlbFetch(`/teams/${teamId}/roster`, { rosterType: '40Man' });
    if (!Array.isArray(data.roster)) {
      return { ok: false, roster: [], error: 'forty_man_roster_missing' };
    }
    return {
      ok: true,
      roster: parseMlbInjuredRoster(data.roster),
      sourceRosterType: '40Man',
    };
  } catch (err) {
    return { ok: false, roster: [], error: err.message };
  }
}

/** 當日 active roster；只代表名單可用，不能推論當晚後援一定可登板。 */
export async function getTeamActiveRoster(teamId) {
  if (!teamId) return { ok: false, roster: [], error: 'team_id_missing' };
  try {
    const data = await mlbFetch(`/teams/${teamId}/roster`, { rosterType: 'active' });
    return {
      ok: true,
      roster: (data.roster || []).map((entry) => ({
        id: entry.person?.id ?? null,
        name: entry.person?.fullName ?? null,
        position: entry.position?.abbreviation ?? null,
      })),
    };
  } catch (err) {
    return { ok: false, roster: [], error: err.message };
  }
}

/** MLB 官方場次 boxscore；未公布打線時回傳 null。 */
export async function getMlbGameBoxscore(gamePk) {
  if (!gamePk) return null;
  const cached = db.prepare(`
    SELECT payload_json
    FROM mlb_boxscore_cache
    WHERE game_pk = ?
  `).get(gamePk);
  if (cached?.payload_json) {
    try {
      return JSON.parse(cached.payload_json);
    } catch {
      // 損壞快取會重新向官方來源抓取。
    }
  }
  try {
    const payload = await mlbFetch(`/game/${gamePk}/boxscore`);
    db.prepare(`
      INSERT INTO mlb_boxscore_cache (game_pk, payload_json, fetched_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(game_pk) DO UPDATE SET
        payload_json = excluded.payload_json,
        fetched_at = excluded.fetched_at
    `).run(gamePk, JSON.stringify(payload));
    return payload;
  } catch {
    return null;
  }
}

/** 球場座標與可用的場地中繼資料。 */
export async function getMlbVenue(venueId) {
  if (!venueId) return null;
  try {
    const data = await mlbFetch(`/venues/${venueId}`, {
      hydrate: 'location,fieldInfo',
    });
    return data.venues?.[0] ?? data;
  } catch {
    return null;
  }
}

/**
 * 官方隊伍賽程，供休息、連戰及旅行資料推導。
 * 呼叫端必須用 as-of 時點過濾，不得拿未來完賽狀態做 PIT 特徵。
 */
export async function getMlbTeamSchedule(teamId, startDate, endDate) {
  if (!teamId || !startDate || !endDate) return [];
  try {
    const data = await mlbFetch('/schedule', {
      sportId: 1,
      teamId,
      startDate,
      endDate,
      hydrate: 'venue,linescore',
    });
    return data.dates?.flatMap((date) => date.games || []) || [];
  } catch {
    return [];
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function inningsToOuts(value) {
  const text = String(value ?? '');
  const match = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const innings = Number(match[1]);
  const partialOuts = Number(match[2] || 0);
  if (!Number.isInteger(innings) || partialOuts < 0 || partialOuts > 2) return null;
  return innings * 3 + partialOuts;
}

/**
 * 指定日期範圍內的官方 MLB 隊級打擊／投球統計。
 * key 包含 endDate，確保同一賽前截點只使用當時之前的完賽資料。
 */
export async function getMlbLeagueTeamStatsByDateRange(startDate, endDate, season) {
  const cacheKey = `${startDate}:${endDate}:${season}`;
  if (teamStatsCache.has(cacheKey)) return teamStatsCache.get(cacheKey);

  const request = Promise.all(['hitting', 'pitching'].map(async (group) => {
    const data = await mlbFetch('/teams/stats', {
      sportIds: 1,
      group,
      stats: 'byDateRange',
      season,
      startDate,
      endDate,
    });
    return [group, data.stats?.[0]?.splits || []];
  })).then((entries) => Object.fromEntries(entries));

  teamStatsCache.set(cacheKey, request);
  try {
    return await request;
  } catch (error) {
    teamStatsCache.delete(cacheKey);
    throw error;
  }
}

function summarizeOfficialRecord(games, teamId, endDate) {
  const completed = (games || [])
    .filter((game) => game.gameType === 'R')
    .filter((game) => game.status?.abstractGameState === 'Final')
    .filter((game) => String(game.gameDate || '').slice(0, 10) <= endDate)
    .sort((a, b) => Date.parse(a.gameDate) - Date.parse(b.gameDate));
  const summary = {
    wins: 0,
    losses: 0,
    homeWins: 0,
    homeLosses: 0,
    awayWins: 0,
    awayLosses: 0,
    last10Wins: 0,
    last10Losses: 0,
    gamesObserved: completed.length,
  };

  completed.forEach((game, index) => {
    const isHome = game.teams?.home?.team?.id === teamId;
    const own = isHome ? numberOrNull(game.teams?.home?.score) : numberOrNull(game.teams?.away?.score);
    const opponent = isHome ? numberOrNull(game.teams?.away?.score) : numberOrNull(game.teams?.home?.score);
    if (own == null || opponent == null || own === opponent) return;
    const won = own > opponent;
    if (won) summary.wins += 1;
    else summary.losses += 1;
    if (isHome) {
      if (won) summary.homeWins += 1;
      else summary.homeLosses += 1;
    } else if (won) summary.awayWins += 1;
    else summary.awayLosses += 1;
    if (index >= completed.length - 10) {
      if (won) summary.last10Wins += 1;
      else summary.last10Losses += 1;
    }
  });
  return summary;
}

/** 指定賽前截點的官方戰績，包含主／客與近十場拆分。 */
export async function getMlbTeamRecordThroughDate(teamId, endDate, season) {
  const cacheKey = `${teamId}:${endDate}:${season}`;
  if (teamRecordCache.has(cacheKey)) return teamRecordCache.get(cacheKey);

  const startDate = `${season}-03-01`;
  const request = getMlbTeamSchedule(teamId, startDate, endDate)
    .then((games) => summarizeOfficialRecord(games, teamId, endDate));
  teamRecordCache.set(cacheKey, request);
  try {
    return await request;
  } catch (error) {
    teamRecordCache.delete(cacheKey);
    throw error;
  }
}

function statForTeam(splits, teamId) {
  return (splits || []).find((split) => split.team?.id === teamId)?.stat ?? null;
}

/**
 * 完全由官方 MLB Stats API 構成的賽前歷史特徵。
 * endDate 必須小於比賽日，避免同日或賽後統計回灌。
 */
export async function getMlbOfficialPregameTeamFeatures(
  teamId,
  commenceTime,
  windowDays = 30,
  { cutoffDate = null } = {}
) {
  if (!teamId || !commenceTime) return null;
  const commence = new Date(commenceTime);
  if (Number.isNaN(commence.getTime())) return null;
  const gameLocalDate = cutoffDate || commence.toISOString().slice(0, 10);
  const end = new Date(`${gameLocalDate}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(1, windowDays - 1));
  const formatDate = (date) => date.toISOString().slice(0, 10);
  const endDate = formatDate(end);
  const startDate = formatDate(start);
  const season = commence.getUTCFullYear();

  try {
    const [stats, record] = await Promise.all([
      getMlbLeagueTeamStatsByDateRange(startDate, endDate, season),
      getMlbTeamRecordThroughDate(teamId, endDate, season),
    ]);
    const hitting = statForTeam(stats.hitting, teamId);
    const pitching = statForTeam(stats.pitching, teamId);
    if (!hitting || !pitching) return null;

    const hittingGames = numberOrNull(hitting.gamesPlayed);
    const pitchingGames = numberOrNull(pitching.gamesPlayed);
    const outs = inningsToOuts(pitching.inningsPitched);
    const innings = outs == null ? null : outs / 3;
    const walks = numberOrNull(pitching.baseOnBalls);
    const strikeouts = numberOrNull(pitching.strikeOuts);
    const totalBases = numberOrNull(hitting.totalBases);
    const stolenBases = numberOrNull(hitting.stolenBases);

    return {
      asOfDate: endDate,
      window: { startDate, endDate, days: windowDays },
      record,
      offense: {
        games: hittingGames,
        runsPerGame: hittingGames ? numberOrNull(hitting.runs) / hittingGames : null,
        avg: numberOrNull(hitting.avg),
        obp: numberOrNull(hitting.obp),
        slg: numberOrNull(hitting.slg),
        ops: numberOrNull(hitting.ops),
        totalBases,
        totalBasesPerGame: hittingGames && totalBases != null ? totalBases / hittingGames : null,
        stolenBases,
        stolenBasesPerGame: hittingGames && stolenBases != null ? stolenBases / hittingGames : null,
      },
      pitching: {
        games: pitchingGames,
        era: numberOrNull(pitching.era),
        whip: numberOrNull(pitching.whip),
        runsAllowedPerGame:
          pitchingGames && numberOrNull(pitching.runs) != null
            ? numberOrNull(pitching.runs) / pitchingGames
            : null,
        inningsPitched: innings,
        walks,
        walksPer9: innings && walks != null ? walks * 9 / innings : null,
        strikeouts,
        strikeoutsPer9: innings && strikeouts != null ? strikeouts * 9 / innings : null,
        strikeoutWalkRatio: walks && strikeouts != null ? strikeouts / walks : null,
      },
    };
  } catch {
    return null;
  }
}

/**
 * 指定比賽日前已完賽的官方投手累積數據。
 * 不可改用 stats=season，因為該端點在回放歷史場次時會混入賽後資料。
 */
export async function getMlbPitcherPregameFeatures(
  pitcherId,
  commenceTime,
  { cutoffDate = null } = {}
) {
  if (!pitcherId || !commenceTime) return null;
  const commence = new Date(commenceTime);
  if (Number.isNaN(commence.getTime())) return null;
  const gameLocalDate = cutoffDate || commence.toISOString().slice(0, 10);
  const end = new Date(`${gameLocalDate}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const season = commence.getUTCFullYear();
  const endDate = end.toISOString().slice(0, 10);
  const startDate = `${season}-03-01`;

  try {
    const data = await mlbFetch(`/people/${pitcherId}/stats`, {
      stats: 'byDateRange',
      group: 'pitching',
      season,
      startDate,
      endDate,
    });
    const stat = data.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) return null;
    const outs = inningsToOuts(stat.inningsPitched);
    const inningsPitched = outs == null ? null : outs / 3;
    const walks = numberOrNull(stat.baseOnBalls);
    const strikeouts = numberOrNull(stat.strikeOuts);
    return {
      asOfDate: endDate,
      window: { startDate, endDate },
      games: numberOrNull(stat.gamesPlayed),
      gamesStarted: numberOrNull(stat.gamesStarted),
      inningsPitched,
      era: numberOrNull(stat.era),
      whip: numberOrNull(stat.whip),
      walks,
      walksPer9: inningsPitched && walks != null ? walks * 9 / inningsPitched : null,
      strikeouts,
      strikeoutsPer9: inningsPitched && strikeouts != null ? strikeouts * 9 / inningsPitched : null,
      strikeoutWalkRatio: walks && strikeouts != null ? strikeouts / walks : null,
      homeRuns: numberOrNull(stat.homeRuns),
      hits: numberOrNull(stat.hits),
    };
  } catch {
    return null;
  }
}

/**
 * 本季官方投手逐場紀錄；同一投手／球季只請求一次，供歷史回放與即時快照共用。
 */
async function getMlbPitcherGameLog(pitcherId, season) {
  const cacheKey = `${pitcherId}:${season}`;
  if (pitcherGameLogCache.has(cacheKey)) return pitcherGameLogCache.get(cacheKey);
  const request = mlbFetch(`/people/${pitcherId}/stats`, {
    stats: 'gameLog',
    group: 'pitching',
    season,
  }).then((data) => data.stats?.[0]?.splits || []);
  pitcherGameLogCache.set(cacheKey, request);
  try {
    return await request;
  } catch (error) {
    pitcherGameLogCache.delete(cacheKey);
    throw error;
  }
}

/** 歷史批次重建用：由同一份 gameLog 聚合賽前球季數據，避免每場重複請求。 */
export async function getMlbPitcherPregameFeaturesFromGameLog(
  pitcherId,
  commenceTime,
  { cutoffDate = null, excludeGamePk = null } = {}
) {
  if (!pitcherId || !commenceTime) return null;
  const commence = new Date(commenceTime);
  if (Number.isNaN(commence.getTime())) return null;
  try {
    const season = commence.getUTCFullYear();
    const gameLocalDate = cutoffDate || commence.toISOString().slice(0, 10);
    const logs = (await getMlbPitcherGameLog(pitcherId, season))
      .filter((entry) => String(entry.date || '') < gameLocalDate)
      .filter((entry) => entry.game?.gamePk !== excludeGamePk);
    if (!logs.length) return null;
    const total = (field) => logs.reduce(
      (sum, entry) => sum + (numberOrNull(entry.stat?.[field]) ?? 0),
      0
    );
    const outs = logs.reduce(
      (sum, entry) => sum + (inningsToOuts(entry.stat?.inningsPitched) ?? 0),
      0
    );
    const inningsPitched = outs / 3;
    if (inningsPitched <= 0) return null;
    const walks = total('baseOnBalls');
    const strikeouts = total('strikeOuts');
    const hits = total('hits');
    const earnedRuns = total('earnedRuns');
    const end = new Date(`${gameLocalDate}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() - 1);
    return {
      asOfDate: end.toISOString().slice(0, 10),
      window: { startDate: `${season}-03-01`, endDate: end.toISOString().slice(0, 10) },
      games: logs.length,
      gamesStarted: total('gamesStarted'),
      inningsPitched,
      era: earnedRuns * 9 / inningsPitched,
      whip: (walks + hits) / inningsPitched,
      walks,
      walksPer9: walks * 9 / inningsPitched,
      strikeouts,
      strikeoutsPer9: strikeouts * 9 / inningsPitched,
      strikeoutWalkRatio: walks ? strikeouts / walks : null,
      homeRuns: total('homeRuns'),
      hits,
    };
  } catch {
    return null;
  }
}

/**
 * 先發投手的近期負荷與休息日。
 * 僅計入比賽開始前的官方 gameLog，並只取先發登板，避免用後援紀錄污染。
 */
export async function getMlbPitcherRecentStartFeatures(
  pitcherId,
  commenceTime,
  { cutoffDate = null, excludeGamePk = null } = {}
) {
  if (!pitcherId || !commenceTime) return null;
  const commence = new Date(commenceTime);
  if (Number.isNaN(commence.getTime())) return null;
  try {
    const logs = await getMlbPitcherGameLog(pitcherId, commence.getUTCFullYear());
    const gameLocalDate = cutoffDate || commence.toISOString().slice(0, 10);
    const starts = logs
      // gameLog 的 date 是當地官方比賽日，不是 UTC 開賽時間；同日一律排除以防前視。
      .filter((entry) => String(entry.date || '') < gameLocalDate)
      .filter((entry) => entry.game?.gamePk !== excludeGamePk)
      .filter((entry) => Number(entry.stat?.gamesStarted) > 0)
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
      .slice(0, 3);
    if (!starts.length) return null;
    const total = (field) => starts.reduce((sum, entry) => sum + (numberOrNull(entry.stat?.[field]) ?? 0), 0);
    const outs = starts.reduce((sum, entry) => sum + (inningsToOuts(entry.stat?.inningsPitched) ?? 0), 0);
    const innings = outs / 3;
    const strikeouts = total('strikeOuts');
    const walks = total('baseOnBalls');
    const earnedRuns = total('earnedRuns');
    const pitches = total('numberOfPitches');
    const latestStart = new Date(starts[0].date);
    const asOf = new Date(`${gameLocalDate}T00:00:00.000Z`);
    asOf.setUTCDate(asOf.getUTCDate() - 1);
    const volatility = summarizeRecentStartLines(starts);
    return {
      asOfDate: asOf.toISOString().slice(0, 10),
      startsObserved: starts.length,
      lastStartDate: starts[0].date,
      restDays: Math.max(0, Math.floor((commence.getTime() - latestStart.getTime()) / 86400000) - 1),
      recent3Innings: innings,
      recent3Pitches: pitches,
      recent3PitchesPerStart: pitches / starts.length,
      recent3Era: innings > 0 ? earnedRuns * 9 / innings : null,
      recent3Whip: innings > 0 ? (walks + total('hits')) / innings : null,
      recent3Hr9: innings > 0 ? total('homeRuns') * 9 / innings : null,
      recent3K9: innings > 0 ? strikeouts * 9 / innings : null,
      recent3BB9: innings > 0 ? walks * 9 / innings : null,
      earlyExitsLast3: volatility.earlyExitsLast3,
      blowupStartsLast3: volatility.blowupStartsLast3,
      minIpLast3: volatility.minIpLast3,
      maxErLast3: volatility.maxErLast3,
    };
  } catch {
    return null;
  }
}

/**
 * 從近 3 場先發逐場線計算波動（提早退場／爆分）。
 * 提早退場：IP < 4；爆分：ER≥5，或 IP<5 且 ER≥4。
 */
export function summarizeRecentStartLines(starts) {
  const lines = Array.isArray(starts) ? starts : [];
  let earlyExitsLast3 = 0;
  let blowupStartsLast3 = 0;
  let minIpLast3 = null;
  let maxErLast3 = null;
  for (const entry of lines) {
    const outs = inningsToOuts(entry?.stat?.inningsPitched ?? entry?.inningsPitched);
    const ip = outs == null ? null : outs / 3;
    const er = numberOrNull(entry?.stat?.earnedRuns ?? entry?.earnedRuns) ?? 0;
    if (ip != null && Number.isFinite(ip)) {
      if (minIpLast3 == null || ip < minIpLast3) minIpLast3 = ip;
      if (ip > 0 && ip < 4) earlyExitsLast3 += 1;
      if (er >= 5 || (ip < 5 && er >= 4)) blowupStartsLast3 += 1;
    } else if (er >= 5) {
      blowupStartsLast3 += 1;
    }
    if (maxErLast3 == null || er > maxErLast3) maxErLast3 = er;
  }
  return {
    earlyExitsLast3,
    blowupStartsLast3,
    minIpLast3: minIpLast3 == null ? null : Number(minIpLast3.toFixed(3)),
    maxErLast3,
  };
}

function readPlatoonCache(cacheKey) {
  const row = db.prepare(`
    SELECT payload_json
    FROM mlb_platoon_splits_cache
    WHERE cache_key = ?
  `).get(cacheKey);
  if (!row?.payload_json) return null;
  try {
    return JSON.parse(row.payload_json);
  } catch {
    return null;
  }
}

function writePlatoonCache(cacheKey, entityType, entityId, season, payload) {
  db.prepare(`
    INSERT INTO mlb_platoon_splits_cache
      (cache_key, entity_type, entity_id, season, payload_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(cache_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      fetched_at = datetime('now')
  `).run(cacheKey, entityType, entityId, season, JSON.stringify(payload));
}

function parseOps(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function summarizePitcherSplit(stat) {
  if (!stat) return null;
  const outs = inningsToOuts(stat.inningsPitched);
  const inningsPitched = outs == null ? null : outs / 3;
  const battersFaced = numberOrNull(stat.battersFaced);
  const strikeouts = numberOrNull(stat.strikeOuts);
  const walks = numberOrNull(stat.baseOnBalls);
  return {
    ops: parseOps(stat.ops),
    avg: parseOps(stat.avg),
    battersFaced,
    strikeouts,
    walks,
    homeRuns: numberOrNull(stat.homeRuns),
    inningsPitched,
    strikeoutRate: battersFaced > 0 && strikeouts != null
      ? strikeouts / battersFaced
      : null,
    walkRate: battersFaced > 0 && walks != null ? walks / battersFaced : null,
  };
}

function summarizeHittingSplit(stat) {
  if (!stat) return null;
  const plateAppearances = numberOrNull(stat.plateAppearances);
  const gamesPlayed = numberOrNull(stat.gamesPlayed);
  const runs = numberOrNull(stat.runs);
  return {
    ops: parseOps(stat.ops),
    obp: parseOps(stat.obp),
    slg: parseOps(stat.slg),
    avg: parseOps(stat.avg),
    plateAppearances,
    gamesPlayed,
    runs,
    runsPerGame: gamesPlayed > 0 && runs != null ? runs / gamesPlayed : null,
  };
}

/** MLB 球隊清單（含 id／名稱），供隊名對 id。 */
export async function getMlbTeams(season = new Date().getUTCFullYear()) {
  if (mlbTeamsCache?.season === season) return mlbTeamsCache.teams;
  const data = await mlbFetch('/teams', { sportId: 1, season });
  const teams = data.teams || [];
  mlbTeamsCache = { season, teams };
  return teams;
}

export async function resolveMlbTeamId(teamName, season = new Date().getUTCFullYear()) {
  if (!teamName) return null;
  const teams = await getMlbTeams(season);
  return matchMlbTeam(teamName, teams)?.id ?? null;
}

/** 投手慣用手（L/R）；結果快取於記憶體與 SQLite。 */
export async function getMlbPitcherHand(pitcherId) {
  if (!pitcherId) return null;
  const cacheKey = `person:${pitcherId}:hand`;
  if (personHandCache.has(cacheKey)) return personHandCache.get(cacheKey);
  const cached = readPlatoonCache(cacheKey);
  if (cached) {
    personHandCache.set(cacheKey, cached);
    return cached;
  }
  try {
    const data = await mlbFetch(`/people/${pitcherId}`);
    const person = data.people?.[0];
    const payload = {
      id: Number(pitcherId),
      name: person?.fullName || null,
      pitchHand: person?.pitchHand?.code || null,
      batSide: person?.batSide?.code || null,
    };
    writePlatoonCache(cacheKey, 'person', Number(pitcherId), 0, payload);
    personHandCache.set(cacheKey, payload);
    return payload;
  } catch {
    return null;
  }
}

/**
 * 投手對左右打（vl/vr）statSplits。
 * 歷史回放請傳「前一完整球季」以避免同季前視；byDateRange+sitCodes 目前不可靠。
 */
export async function getMlbPitcherPlatoonSplits(pitcherId, season) {
  if (!pitcherId || !season) return null;
  const cacheKey = `pitcher:${pitcherId}:${season}:vlvr`;
  if (pitcherPlatoonCache.has(cacheKey)) return pitcherPlatoonCache.get(cacheKey);
  const cached = readPlatoonCache(cacheKey);
  if (cached) {
    pitcherPlatoonCache.set(cacheKey, cached);
    return cached;
  }
  try {
    const data = await mlbFetch(`/people/${pitcherId}/stats`, {
      stats: 'statSplits',
      group: 'pitching',
      season,
      sitCodes: 'vl,vr',
      sportId: 1,
    });
    const splits = data.stats?.[0]?.splits || [];
    const vsLhb = summarizePitcherSplit(
      splits.find((entry) => entry.split?.code === 'vl')?.stat
    );
    const vsRhb = summarizePitcherSplit(
      splits.find((entry) => entry.split?.code === 'vr')?.stat
    );
    if (!vsLhb && !vsRhb) return null;
    const payload = {
      pitcherId: Number(pitcherId),
      season: Number(season),
      source: 'MLB Stats API people stats=statSplits sitCodes=vl,vr',
      vsLhb,
      vsRhb,
    };
    writePlatoonCache(cacheKey, 'pitcher', Number(pitcherId), Number(season), payload);
    pitcherPlatoonCache.set(cacheKey, payload);
    return payload;
  } catch {
    return null;
  }
}

/** 球隊打擊對左右投（vl=對左投、vr=對右投）。 */
export async function getMlbTeamHittingPlatoonSplits(teamId, season) {
  if (!teamId || !season) return null;
  const cacheKey = `team_hitting:${teamId}:${season}:vlvr`;
  if (teamHittingPlatoonCache.has(cacheKey)) {
    return teamHittingPlatoonCache.get(cacheKey);
  }
  const cached = readPlatoonCache(cacheKey);
  if (cached) {
    teamHittingPlatoonCache.set(cacheKey, cached);
    return cached;
  }
  try {
    const data = await mlbFetch(`/teams/${teamId}/stats`, {
      stats: 'statSplits',
      group: 'hitting',
      season,
      sitCodes: 'vl,vr',
      sportId: 1,
    });
    const splits = data.stats?.[0]?.splits || [];
    const vsLhp = summarizeHittingSplit(
      splits.find((entry) => entry.split?.code === 'vl')?.stat
    );
    const vsRhp = summarizeHittingSplit(
      splits.find((entry) => entry.split?.code === 'vr')?.stat
    );
    if (!vsLhp && !vsRhp) return null;
    const payload = {
      teamId: Number(teamId),
      season: Number(season),
      source: 'MLB Stats API teams stats=statSplits hitting sitCodes=vl,vr',
      vsLhp,
      vsRhp,
    };
    writePlatoonCache(
      cacheKey,
      'team_hitting',
      Number(teamId),
      Number(season),
      payload
    );
    teamHittingPlatoonCache.set(cacheKey, payload);
    return payload;
  } catch {
    return null;
  }
}

/**
 * 組合賽前 platoon 區塊：一律用前一完整球季，避免同季前視。
 */
export async function buildMlbPregamePlatoonBlock({
  homePitcherId,
  awayPitcherId,
  homeTeamId,
  awayTeamId,
  commenceTime,
}) {
  const commence = new Date(commenceTime);
  if (Number.isNaN(commence.getTime())) return null;
  const season = commence.getUTCFullYear();
  const priorSeason = season - 1;
  const [
    homeHand,
    awayHand,
    homePitcherSplits,
    awayPitcherSplits,
    homeOffenseSplits,
    awayOffenseSplits,
  ] = await Promise.all([
    getMlbPitcherHand(homePitcherId),
    getMlbPitcherHand(awayPitcherId),
    getMlbPitcherPlatoonSplits(homePitcherId, priorSeason),
    getMlbPitcherPlatoonSplits(awayPitcherId, priorSeason),
    getMlbTeamHittingPlatoonSplits(homeTeamId, priorSeason),
    getMlbTeamHittingPlatoonSplits(awayTeamId, priorSeason),
  ]);
  return {
    source:
      'MLB Stats API prior-season platoon splits (pitcher vs LHB/RHB; offense vs LHP/RHP)',
    asOfSeason: priorSeason,
    gameSeason: season,
    home: {
      pitcherId: homePitcherId ? Number(homePitcherId) : null,
      pitchHand: homeHand?.pitchHand || null,
      pitcher: homePitcherSplits,
      offense: homeOffenseSplits,
    },
    away: {
      pitcherId: awayPitcherId ? Number(awayPitcherId) : null,
      pitchHand: awayHand?.pitchHand || null,
      pitcher: awayPitcherSplits,
      offense: awayOffenseSplits,
    },
  };
}

/** 從賽程取得場地 */
export function getVenueName(game) {
  return game?.venue?.name || null;
}
export function matchMlbTeam(oddsTeamName, mlbTeams) {
  if (!oddsTeamName) return null;

  const normalize = (s) =>
    (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .replace(/(the|city|club)$/g, '');

  const target = normalize(oddsTeamName);
  if (!target) return null;
  let best = null;
  let bestScore = 0;

  for (const team of mlbTeams) {
    if (!team?.name && !team?.abbreviation) continue;
    const candidates = [team.name, team.abbreviation].filter(Boolean).map(normalize);
    for (const c of candidates) {
      if (c === target) return team;
      if (c.includes(target) || target.includes(c)) {
        const score = Math.min(c.length, target.length) / Math.max(c.length, target.length);
        if (score > bestScore) {
          bestScore = score;
          best = team;
        }
      }
    }
  }
  return bestScore > 0.5 ? best : null;
}

/** 從賽程取得先發投手資訊 */
export function getProbablePitchers(game) {
  if (!game?.teams) {
    return { home: null, away: null };
  }
  const home = game.teams?.home?.probablePitcher;
  const away = game.teams?.away?.probablePitcher;
  return {
    home: home ? { id: home.id, name: home.fullName } : null,
    away: away ? { id: away.id, name: away.fullName } : null,
  };
}

/** 投手本季 ERA (簡化) */
export async function getPitcherSeasonStats(pitcherId, season) {
  if (!pitcherId) return null;
  const year = season || new Date().getFullYear();
  try {
    const data = await mlbFetch(`/people/${pitcherId}/stats`, {
      stats: 'season',
      group: 'pitching',
      season: year,
    });
    const split = data.stats?.[0]?.splits?.[0]?.stat;
    if (!split) return null;
    return {
      era: parseFloat(split.era || 0),
      whip: parseFloat(split.whip || 0),
      inningsPitched: parseFloat(split.inningsPitched || 0),
      strikeOuts: split.strikeOuts,
      walks: split.baseOnBalls,
      hits: split.hits,
      gamesStarted: split.gamesStarted,
      wins: split.wins,
      losses: split.losses,
    };
  } catch {
    return null;
  }
}
