/**
 * MLB 官方 Stats API (免費、無需 key)
 * https://statsapi.mlb.com/api/v1/
 */

const MLB_BASE = 'https://statsapi.mlb.com/api/v1';

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

/** 傷兵名單摘要 */
export async function getTeamInjurySummary(teamId) {
  if (!teamId) return { count: 0, names: [] };
  try {
    const data = await mlbFetch(`/teams/${teamId}/roster`, { rosterType: 'injuryList' });
    const names = (data.roster || [])
      .map((r) => r.person?.fullName)
      .filter(Boolean)
      .slice(0, 5);
    return { count: names.length, names };
  } catch {
    return { count: 0, names: [] };
  }
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
