/**
 * API-Football 數據服務（陣容、傷病、戰績、戰術）
 * https://www.api-football.com/documentation-v3
 * 無 key 時優雅降級，僅用 Odds API 比分推算
 */
import { footballConfig, FOOTBALL_LEAGUES } from './config.js';

const BASE_URL = 'https://v3.football.api-sports.io';

function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function fuzzyTeamMatch(oddsName, apiName) {
  const a = normalizeName(oddsName);
  const b = normalizeName(apiName);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const aParts = a.split(/\s+/).filter((p) => p.length > 3);
  const bParts = b.split(/\s+/).filter((p) => p.length > 3);
  return aParts.some((p) => b.includes(p)) || bParts.some((p) => a.includes(p));
}

async function apiRequest(path, params = {}, { soft = false } = {}) {
  if (!footballConfig.apiFootballKey) return null;

  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { 'x-apisports-key': footballConfig.apiFootballKey },
    });

    if (!res.ok) {
      const body = await res.text();
      if (soft) return null;
      throw new Error(`API-Football ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json();
    if (json.errors && Object.keys(json.errors).length) {
      if (soft) return null;
      throw new Error(`API-Football: ${JSON.stringify(json.errors)}`);
    }
    return json.response ?? json;
  } catch (err) {
    if (soft) return null;
    throw err;
  }
}

export async function fetchFixturesByDate(commenceTime) {
  const date = new Date(commenceTime).toISOString().slice(0, 10);
  return (await apiRequest('/fixtures', { date, timezone: 'UTC' }, { soft: true })) || [];
}

export async function fetchLeagueFixtures(leagueCode) {
  const league = FOOTBALL_LEAGUES[leagueCode];
  if (!league?.apiFootballLeagueId) return [];

  const data = await apiRequest(
    '/fixtures',
    {
      league: league.apiFootballLeagueId,
      season: league.season,
      timezone: 'UTC',
    },
    { soft: true }
  );
  return data || [];
}

export function matchFixtureToGame(fixtures, homeTeam, awayTeam, commenceTime) {
  const target = new Date(commenceTime).getTime();
  let best = null;
  let bestDiff = Infinity;

  for (const fx of fixtures || []) {
    const home = fx.teams?.home?.name;
    const away = fx.teams?.away?.name;
    if (!fuzzyTeamMatch(homeTeam, home) || !fuzzyTeamMatch(awayTeam, away)) continue;

    const diff = Math.abs(new Date(fx.fixture?.date).getTime() - target);
    if (diff < bestDiff && diff < 48 * 3600000) {
      bestDiff = diff;
      best = fx;
    }
  }
  return best;
}

async function fetchTeamStatistics(teamId, leagueCode) {
  const league = FOOTBALL_LEAGUES[leagueCode];
  if (!teamId || !league) return null;

  const data = await apiRequest(
    '/teams/statistics',
    {
      league: league.apiFootballLeagueId,
      season: league.season,
      team: teamId,
    },
    { soft: true }
  );
  return data || null;
}

async function fetchLineups(fixtureId) {
  if (!fixtureId) return null;
  const data = await apiRequest('/fixtures/lineups', { fixture: fixtureId });
  return data || [];
}

async function fetchInjuries(fixtureId) {
  if (!fixtureId) return null;
  const data = await apiRequest('/fixtures/injuries', { fixture: fixtureId });
  return data || [];
}

async function fetchH2H(homeId, awayId) {
  if (!homeId || !awayId) return [];
  const data = await apiRequest('/fixtures/headtohead', { h2h: `${homeId}-${awayId}` });
  return (data || []).slice(0, 8);
}

function parseFormString(form) {
  if (!form) return { wins: 0, draws: 0, losses: 0, rating: 0.5 };
  const chars = form.split('');
  const wins = chars.filter((c) => c === 'W').length;
  const draws = chars.filter((c) => c === 'D').length;
  const losses = chars.filter((c) => c === 'L').length;
  const total = wins + draws + losses || 1;
  return {
    wins,
    draws,
    losses,
    rating: (wins * 1 + draws * 0.35) / total,
    summary: `近況 ${form} (${wins}勝${draws}和${losses}負)`,
  };
}

function inferTacticalStyle(stats) {
  const played = stats?.fixtures?.played?.total || 0;
  if (!played) return 'balanced';
  const gf = stats?.goals?.for?.average?.total ?? 1.3;
  const ga = stats?.goals?.against?.average?.total ?? 1.3;
  if (gf >= 1.8 && ga >= 1.5) return 'open';
  if (gf >= 1.6) return 'attacking';
  if (ga <= 0.9) return 'defensive';
  return 'balanced';
}

function buildCoachNote(stats) {
  const formation = stats?.lineups?.[0]?.formation;
  const played = stats?.lineups?.[0]?.played;
  if (!formation) return null;
  return `主戰術陣型 ${formation}${played ? `（本屆 ${played} 場）` : ''}`;
}

function lineupImpact(lineups, injuries, teamName) {
  const teamLineup = (lineups || []).find((l) => fuzzyTeamMatch(teamName, l.team?.name));
  const starters = teamLineup?.startXI?.length ?? 0;
  const injCount = (injuries || []).filter((i) =>
    fuzzyTeamMatch(teamName, i.team?.name)
  ).length;

  let penalty = 0;
  let note = null;

  if (starters > 0 && starters < 11) {
    penalty += (11 - starters) * 0.012;
    note = `${teamName} 陣容不完整（僅 ${starters} 人確認）`;
  }
  if (injCount > 0) {
    penalty += Math.min(0.06, injCount * 0.015);
    note = note
      ? `${note}；傷病 ${injCount} 人`
      : `${teamName} 傷病/停賽 ${injCount} 人`;
  }
  return { penalty: Math.min(0.08, penalty), note, starters, injCount };
}

export async function buildTeamProfile(teamName, leagueCode, fixture, side) {
  const teamId = side === 'home' ? fixture?.teams?.home?.id : fixture?.teams?.away?.id;
  const stats = teamId ? await fetchTeamStatistics(teamId, leagueCode) : null;

  const played = stats?.fixtures?.played?.total || 0;
  const form = parseFormString(stats?.form);
  const gf = parseFloat(stats?.goals?.for?.average?.total) || 1.3;
  const ga = parseFloat(stats?.goals?.against?.average?.total) || 1.3;
  const tacticalStyle = inferTacticalStyle(stats);

  const attackRating = Math.max(0.1, Math.min(0.9, gf / 2.2));
  const defenseRating = Math.max(0.1, Math.min(0.9, 1 - ga / 2.2));
  const formRating = form.rating;

  return {
    teamId,
    teamName,
    gamesPlayed: played,
    hasIntel: Boolean(stats && played >= 2),
    formRating,
    attackRating,
    defenseRating,
    goalsPerGame: gf,
    goalsAgainstPerGame: ga,
    tacticalStyle,
    formSummary: stats?.form ? form.summary : null,
    coachNote: stats ? buildCoachNote(stats) : null,
    wins: stats?.fixtures?.wins?.total ?? 0,
    draws: stats?.fixtures?.draws?.total ?? 0,
    losses: stats?.fixtures?.loses?.total ?? 0,
    lineupPenalty: 0,
    lineupNote: null,
  };
}

export async function fetchMatchIntel(leagueCode, homeTeam, awayTeam, commenceTime) {
  if (!footballConfig.apiFootballKey) {
    return { fixture: null, homeProfile: null, awayProfile: null, h2h: [], hasApi: false };
  }

  try {
    const fixturesByDate = await fetchFixturesByDate(commenceTime);
    let fixture = matchFixtureToGame(fixturesByDate, homeTeam, awayTeam, commenceTime);

    if (!fixture) {
      const fixtures = await fetchLeagueFixtures(leagueCode);
      fixture = matchFixtureToGame(fixtures, homeTeam, awayTeam, commenceTime);
    }

    if (!fixture) {
      return { fixture: null, homeProfile: null, awayProfile: null, h2h: [], hasApi: true };
    }

    const fixtureId = fixture.fixture?.id;
    const [lineups, injuries, homeProfile, awayProfile, h2h] = await Promise.all([
      fetchLineups(fixtureId),
      fetchInjuries(fixtureId),
      buildTeamProfile(homeTeam, leagueCode, fixture, 'home'),
      buildTeamProfile(awayTeam, leagueCode, fixture, 'away'),
      fetchH2H(fixture.teams?.home?.id, fixture.teams?.away?.id),
    ]);

    const homeLineup = lineupImpact(lineups, injuries, homeTeam);
    const awayLineup = lineupImpact(lineups, injuries, awayTeam);
    homeProfile.lineupPenalty = homeLineup.penalty;
    homeProfile.lineupNote = homeLineup.note;
    awayProfile.lineupPenalty = awayLineup.penalty;
    awayProfile.lineupNote = awayLineup.note;

    let tacticalEdge = 0;
    if (homeProfile.tacticalStyle === 'attacking' && awayProfile.tacticalStyle === 'defensive') {
      tacticalEdge = 0.02;
    } else if (homeProfile.tacticalStyle === 'defensive' && awayProfile.tacticalStyle === 'attacking') {
      tacticalEdge = -0.015;
    }

    const h2hSummary = summarizeH2h(h2h, homeTeam);
    if (h2hSummary) {
      homeProfile.formSummary = homeProfile.formSummary
        ? `${homeProfile.formSummary} · ${h2hSummary}`
        : h2hSummary;
    }

    return {
      fixture,
      fixtureId,
      homeProfile,
      awayProfile,
      lineups,
      injuries,
      h2h,
      tacticalEdge,
      hasApi: true,
    };
  } catch (err) {
    console.warn('[football-stats]', err.message);
    return { fixture: null, homeProfile: null, awayProfile: null, h2h: [], hasApi: true, error: err.message };
  }
}

function summarizeH2h(matches, homeTeam) {
  if (!matches?.length) return null;
  let hw = 0;
  let d = 0;
  let aw = 0;
  for (const m of matches) {
    const h = m.goals?.home;
    const a = m.goals?.away;
    if (h == null || a == null) continue;
    const homeIs = fuzzyTeamMatch(homeTeam, m.teams?.home?.name);
    const hg = homeIs ? h : a;
    const ag = homeIs ? a : h;
    if (hg > ag) hw++;
    else if (hg < ag) aw++;
    else d++;
  }
  return `交鋒 ${matches.length} 場 ${hw}勝${d}和${aw}負`;
}

export async function fetchPlayerSeasonStats(teamId, leagueCode) {
  if (!teamId || !footballConfig.apiFootballKey) return [];

  const league = FOOTBALL_LEAGUES[leagueCode];
  const data = await apiRequest(
    '/players',
    {
      team: teamId,
      league: league.apiFootballLeagueId,
      season: league.season,
    },
    { soft: true }
  );
  return data || [];
}

export function findPlayerStats(players, playerName) {
  const target = normalizeName(playerName);
  for (const entry of players || []) {
    const name = entry.player?.name;
    if (!name) continue;
    const n = normalizeName(name);
    if (n === target || n.includes(target) || target.includes(n)) {
      const stat = entry.statistics?.[0];
      return {
        name,
        goals: stat?.goals?.total ?? 0,
        assists: stat?.goals?.assists ?? 0,
        shots: stat?.shots?.total ?? 0,
        shotsOn: stat?.shots?.on ?? 0,
        appearances: stat?.games?.appearences ?? stat?.games?.appearence ?? 0,
        minutes: stat?.games?.minutes ?? 0,
        cards: (stat?.cards?.yellow ?? 0) + (stat?.cards?.red ?? 0) * 2,
      };
    }
  }
  return null;
}
