/**
 * MLB 明星打者缺陣加權（可開關 A/B）
 * - 直播/初盤：傷兵名單姓名匹配
 * - 回測：用當日 boxscore 是否出場（近似開賽前可用資訊，避免用「當前 IL」污染歷史）
 */

import { config } from '../config.js';
import { getMlbSchedule, matchMlbTeam } from './MlbStatsService.js';

const MLB_BASE = 'https://statsapi.mlb.com/api/v1';

/** 高影響力打者（保守 impact；總懲罰另有封頂） */
export const MLB_STAR_BATTERS = [
  { key: 'ohtani', name: 'Shohei Ohtani', aliases: ['ohtani'], teams: ['Los Angeles Dodgers'], impact: 0.03 },
  { key: 'judge', name: 'Aaron Judge', aliases: ['judge'], teams: ['New York Yankees'], impact: 0.026 },
  { key: 'soto', name: 'Juan Soto', aliases: ['soto'], teams: ['New York Mets'], impact: 0.024 },
  { key: 'betts', name: 'Mookie Betts', aliases: ['betts'], teams: ['Los Angeles Dodgers'], impact: 0.022 },
  { key: 'witt', name: 'Bobby Witt Jr.', aliases: ['witt'], teams: ['Kansas City Royals'], impact: 0.02 },
  { key: 'henderson', name: 'Gunnar Henderson', aliases: ['henderson'], teams: ['Baltimore Orioles'], impact: 0.018 },
  { key: 'harper', name: 'Bryce Harper', aliases: ['harper'], teams: ['Philadelphia Phillies'], impact: 0.018 },
  { key: 'trout', name: 'Mike Trout', aliases: ['trout'], teams: ['Los Angeles Angels'], impact: 0.02 },
  { key: 'acuna', name: 'Ronald Acuna Jr.', aliases: ['acuna', 'acuña'], teams: ['Atlanta Braves'], impact: 0.022 },
  { key: 'tatis', name: 'Fernando Tatis Jr.', aliases: ['tatis'], teams: ['San Diego Padres'], impact: 0.02 },
];

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function nameMatchesStar(personName, star) {
  const n = norm(personName);
  if (!n) return false;
  if (n.includes(norm(star.name))) return true;
  return (star.aliases || []).some((a) => n.includes(norm(a)));
}

function teamMatchesStar(teamName, star) {
  const t = norm(teamName);
  return (star.teams || []).some((x) => t === norm(x) || t.includes(norm(x)) || norm(x).includes(t));
}

function starsForTeam(teamName) {
  return MLB_STAR_BATTERS.filter((s) => teamMatchesStar(teamName, s));
}

/**
 * 由傷兵姓名估算明星缺陣懲罰（初盤即時）
 * @returns {{ penalty: number, hits: Array<{ name: string, impact: number }> }}
 */
export function starPenaltyFromInjuryNames(teamName, injuryNames = []) {
  if (!config.enableStarImpact) return { penalty: 0, hits: [] };
  const stars = starsForTeam(teamName);
  if (!stars.length || !injuryNames?.length) return { penalty: 0, hits: [] };

  const hits = [];
  for (const star of stars) {
    const hit = injuryNames.some((n) => nameMatchesStar(n, star));
    if (hit) hits.push({ name: star.name, impact: star.impact, source: 'injury_list' });
  }
  return finalizePenalty(hits);
}

/**
 * 由「該隊明星是否出現在當日打席」估算缺陣（回測用）
 * appearedNames: boxscore 有 PA/AB 的打者名
 */
export function starPenaltyFromLineupAbsence(teamName, appearedBatterNames = []) {
  if (!config.enableStarImpact) return { penalty: 0, hits: [] };
  const stars = starsForTeam(teamName);
  if (!stars.length) return { penalty: 0, hits: [] };

  const appeared = appearedBatterNames || [];
  // 若該隊完全沒打者名單（API 失敗），不懲罰
  if (!appeared.length) return { penalty: 0, hits: [] };

  const hits = [];
  for (const star of stars) {
    const played = appeared.some((n) => nameMatchesStar(n, star));
    if (!played) hits.push({ name: star.name, impact: star.impact, source: 'boxscore_absent' });
  }
  return finalizePenalty(hits);
}

function finalizePenalty(hits) {
  if (!hits.length) return { penalty: 0, hits: [] };
  const raw = hits.reduce((s, h) => s + h.impact, 0);
  const cap = config.starImpactMaxPenalty ?? 0.04;
  const penalty = Math.min(cap, raw);
  return { penalty, hits };
}

async function mlbFetch(path, params = {}) {
  const url = new URL(`${MLB_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`MLB API ${res.status}: ${path}`);
  return res.json();
}

function batterNamesFromBoxside(side) {
  const players = side?.players || {};
  const names = [];
  for (const p of Object.values(players)) {
    const name = p?.person?.fullName;
    const pa = Number(p?.stats?.batting?.plateAppearances);
    const ab = Number(p?.stats?.batting?.atBats);
    if (name && ((Number.isFinite(pa) && pa > 0) || (Number.isFinite(ab) && ab > 0))) {
      names.push(name);
    }
  }
  return names;
}

const scheduleCache = new Map();
const boxCache = new Map();

async function scheduleForDay(day) {
  if (scheduleCache.has(day)) return scheduleCache.get(day);
  const games = await getMlbSchedule(day);
  scheduleCache.set(day, games);
  return games;
}

async function boxscore(gamePk) {
  if (boxCache.has(gamePk)) return boxCache.get(gamePk);
  const data = await mlbFetch(`/game/${gamePk}/boxscore`);
  boxCache.set(gamePk, data);
  return data;
}

/**
 * 回測：依開賽日 boxscore 判斷主客明星是否缺席
 */
function teamHasTrackedStar(teamName) {
  return starsForTeam(teamName).length > 0;
}

export async function resolveStarAbsenceForGame(homeTeam, awayTeam, commenceTime) {
  if (!config.enableStarImpact) {
    return { home: { penalty: 0, hits: [] }, away: { penalty: 0, hits: [] } };
  }
  // 兩隊都無追蹤明星 → 不打 API
  if (!teamHasTrackedStar(homeTeam) && !teamHasTrackedStar(awayTeam)) {
    return { home: { penalty: 0, hits: [] }, away: { penalty: 0, hits: [] } };
  }
  const day = String(commenceTime || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { home: { penalty: 0, hits: [] }, away: { penalty: 0, hits: [] } };
  }

  try {
    const games = await scheduleForDay(day);
    const stubTeams = games.flatMap((g) => [
      { name: g.teams?.home?.team?.name, abbreviation: g.teams?.home?.team?.abbreviation },
      { name: g.teams?.away?.team?.name, abbreviation: g.teams?.away?.team?.abbreviation },
    ]);
    const homeHit = matchMlbTeam(homeTeam, stubTeams);
    const awayHit = matchMlbTeam(awayTeam, stubTeams);
    const sg = games.find((g) => {
      const hn = g.teams?.home?.team?.name;
      const an = g.teams?.away?.team?.name;
      const homeOk =
        homeHit?.name === hn ||
        matchMlbTeam(homeTeam, [{ name: hn, abbreviation: g.teams?.home?.team?.abbreviation }]);
      const awayOk =
        awayHit?.name === an ||
        matchMlbTeam(awayTeam, [{ name: an, abbreviation: g.teams?.away?.team?.abbreviation }]);
      return homeOk && awayOk;
    });
    if (!sg?.gamePk) {
      return { home: { penalty: 0, hits: [] }, away: { penalty: 0, hits: [] } };
    }

    const box = await boxscore(sg.gamePk);
    const homeBatters = batterNamesFromBoxside(box?.teams?.home);
    const awayBatters = batterNamesFromBoxside(box?.teams?.away);

    return {
      home: starPenaltyFromLineupAbsence(homeTeam, homeBatters),
      away: starPenaltyFromLineupAbsence(awayTeam, awayBatters),
      gamePk: sg.gamePk,
    };
  } catch {
    return { home: { penalty: 0, hits: [] }, away: { penalty: 0, hits: [] } };
  }
}
