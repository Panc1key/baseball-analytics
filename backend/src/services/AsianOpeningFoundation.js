/**
 * 亞聯初盤 foundation 特徵（PIT）
 * 只從開賽前已完賽的庫內比分 + walk-forward Elo 推導。
 * 不讀 team_stats.ops/whip（避免季中快照前視）、不載 MLB 權重、不碰 Locked B。
 */
import db from '../db/database.js';
import { ELO_DEFAULT, eloToStrength } from './BaseballElo.js';

export const ASIAN_FOUNDATION_FEATURE_VERSION = 'asian-foundation-pit-v3';
export const ASIAN_FOUNDATION_FEATURE_KEYS = Object.freeze([
  'isHome',
  'seasonWinPct',
  'opponentSeasonWinPct',
  'pythWinPct',
  'opponentPythWinPct',
  'last10WinPct',
  'opponentLast10WinPct',
  'last5WinPct',
  'formWinAccel',
  'seasonRpg',
  'opponentSeasonRpg',
  'seasonRaRpg',
  'opponentSeasonRaRpg',
  'runDiffPerGame',
  'opponentRunDiffPerGame',
  'recentRpg',
  'opponentRecentRpg',
  'recentRaRpg',
  'opponentRecentRaRpg',
  'rpgAccel',
  'restDays',
  'opponentRestDays',
  'restDiff',
  'gamesPlayed',
  'opponentGamesPlayed',
  'elo',
  'opponentElo',
  'eloDiff',
  'eloStrength',
  // 先發滾動（PIT；無先發時 known=0）
  'pitcherKnown',
  'opponentPitcherKnown',
  'pitcherStarts',
  'opponentPitcherStarts',
  'pitcherRestDays',
  'opponentPitcherRestDays',
  'pitcherRaRpg',
  'opponentPitcherRaRpg',
  'pitcherRaDiff',
]);

function finite(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

/**
 * 某隊在 asOfCommence 之前的完賽紀錄（時間升序）
 */
export function loadTeamPriorGames(league, teamName, asOfCommence) {
  return db
    .prepare(
      `SELECT commence_time, home_team, away_team, home_score, away_score
       FROM games
       WHERE league = ?
         AND completed = 1
         AND home_score IS NOT NULL AND away_score IS NOT NULL
         AND NOT (home_score = 0 AND away_score = 0)
         AND (home_team = ? OR away_team = ?)
         AND datetime(commence_time) < datetime(?)
       ORDER BY datetime(commence_time) ASC`
    )
    .all(league, teamName, teamName, asOfCommence);
}

/**
 * 從 prior 列摘要（可重用於 in-memory 審計）
 */
export function summarizeTeamFromPriors(priors, teamName, recentN = 10) {
  let w = 0;
  let l = 0;
  let gf = 0;
  let ga = 0;
  const recent = [];
  for (const g of priors) {
    const home = g.home_team === teamName;
    const hs = Number(g.home_score);
    const as = Number(g.away_score);
    const scored = home ? hs : as;
    const allowed = home ? as : hs;
    const won = scored > allowed;
    const lost = scored < allowed;
    if (won) w += 1;
    if (lost) l += 1;
    gf += scored;
    ga += allowed;
    recent.push({
      commence_time: g.commence_time,
      scored,
      allowed,
      won,
      lost,
    });
  }
  const n = priors.length;
  const last10 = recent.slice(-recentN);
  const last5 = recent.slice(-5);
  const last10W = last10.filter((x) => x.won).length;
  const last10L = last10.filter((x) => x.lost).length;
  const last10Decided = last10W + last10L;
  const last5W = last5.filter((x) => x.won).length;
  const last5L = last5.filter((x) => x.lost).length;
  const last5Decided = last5W + last5L;
  const lastGf = last10.reduce((s, x) => s + x.scored, 0);
  const lastGa = last10.reduce((s, x) => s + x.allowed, 0);
  const seasonRpg = n ? gf / n : 4.2;
  const seasonRaRpg = n ? ga / n : 4.2;
  const recentRpg = last10.length ? lastGf / last10.length : seasonRpg;
  const recentRaRpg = last10.length ? lastGa / last10.length : seasonRaRpg;
  const seasonWinPct = w + l > 0 ? w / (w + l) : 0.5;
  const last10WinPct = last10Decided > 0 ? last10W / last10Decided : 0.5;
  const last5WinPct = last5Decided > 0 ? last5W / last5Decided : last10WinPct;
  const gf2 = gf * gf;
  const ga2 = ga * ga;
  const pythWinPct = n > 0 && gf2 + ga2 > 0 ? gf2 / (gf2 + ga2) : 0.5;
  const lastGame = recent.length ? recent[recent.length - 1] : null;
  return {
    gamesPlayed: n,
    seasonWinPct,
    pythWinPct,
    last10WinPct,
    last5WinPct,
    formWinAccel: last5WinPct - last10WinPct,
    seasonRpg,
    seasonRaRpg,
    runDiffPerGame: seasonRpg - seasonRaRpg,
    recentRpg,
    recentRaRpg,
    rpgAccel: recentRpg - seasonRpg,
    lastCommence: lastGame?.commence_time || null,
  };
}

function restDays(lastCommence, asOfCommence) {
  if (!lastCommence || !asOfCommence) return 3;
  const a = Date.parse(lastCommence);
  const b = Date.parse(asOfCommence);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 3;
  return Math.max(0, Math.min(10, (b - a) / (24 * 3600 * 1000)));
}

function resolveElo(teamName, eloLookup) {
  if (!eloLookup) return ELO_DEFAULT;
  if (typeof eloLookup.get === 'function') {
    const v = eloLookup.get(teamName);
    return Number.isFinite(Number(v)) ? Number(v) : ELO_DEFAULT;
  }
  if (typeof eloLookup === 'function') {
    const v = eloLookup(teamName);
    return Number.isFinite(Number(v)) ? Number(v) : ELO_DEFAULT;
  }
  return ELO_DEFAULT;
}

/**
 * 單邊特徵（priors 可外部注入，供審計避免 N+1）
 */
export function buildAsianSideFoundationFeatures({
  league,
  teamName,
  opponentName,
  commenceTime,
  isHome,
  teamPriors = null,
  oppPriors = null,
  eloLookup = null,
  myPitcherHist = null,
  oppPitcherHist = null,
}) {
  const teamRows =
    teamPriors ?? loadTeamPriorGames(league, teamName, commenceTime);
  const oppRows =
    oppPriors ?? loadTeamPriorGames(league, opponentName, commenceTime);
  const team = summarizeTeamFromPriors(teamRows, teamName);
  const opp = summarizeTeamFromPriors(oppRows, opponentName);
  const elo = resolveElo(teamName, eloLookup);
  const opponentElo = resolveElo(opponentName, eloLookup);
  const myRest = restDays(team.lastCommence, commenceTime);
  const oppRest = restDays(opp.lastCommence, commenceTime);
  const pMine = myPitcherHist || {
    starts: 0,
    restDays: 5,
    raRpg: 4.5,
    known: 0,
  };
  const pOpp = oppPitcherHist || {
    starts: 0,
    restDays: 5,
    raRpg: 4.5,
    known: 0,
  };
  return {
    isHome: isHome ? 1 : 0,
    seasonWinPct: team.seasonWinPct,
    opponentSeasonWinPct: opp.seasonWinPct,
    pythWinPct: team.pythWinPct,
    opponentPythWinPct: opp.pythWinPct,
    last10WinPct: team.last10WinPct,
    opponentLast10WinPct: opp.last10WinPct,
    last5WinPct: team.last5WinPct,
    formWinAccel: team.formWinAccel,
    seasonRpg: team.seasonRpg,
    opponentSeasonRpg: opp.seasonRpg,
    seasonRaRpg: team.seasonRaRpg,
    opponentSeasonRaRpg: opp.seasonRaRpg,
    runDiffPerGame: team.runDiffPerGame,
    opponentRunDiffPerGame: opp.runDiffPerGame,
    recentRpg: team.recentRpg,
    opponentRecentRpg: opp.recentRpg,
    recentRaRpg: team.recentRaRpg,
    opponentRecentRaRpg: opp.recentRaRpg,
    rpgAccel: team.rpgAccel,
    restDays: myRest,
    opponentRestDays: oppRest,
    restDiff: myRest - oppRest,
    gamesPlayed: team.gamesPlayed,
    opponentGamesPlayed: opp.gamesPlayed,
    elo,
    opponentElo,
    eloDiff: elo - opponentElo,
    eloStrength: eloToStrength(elo),
    pitcherKnown: pMine.known,
    opponentPitcherKnown: pOpp.known,
    pitcherStarts: pMine.starts,
    opponentPitcherStarts: pOpp.starts,
    pitcherRestDays: pMine.restDays,
    opponentPitcherRestDays: pOpp.restDays,
    pitcherRaRpg: pMine.raRpg,
    opponentPitcherRaRpg: pOpp.raRpg,
    pitcherRaDiff: pMine.raRpg - pOpp.raRpg,
  };
}

/**
 * 一場比賽主客兩側特徵
 * @param {object} game
 * @param {{ eloLookup?: Map|Function, priorIndex?: Map<string, object[]> }} [opts]
 */
export function buildAsianGameFoundationFeatures(game, opts = {}) {
  const priorIndex = opts.priorIndex || null;
  const eloLookup = opts.eloLookup || null;
  const teamPriors = priorIndex?.get(game.home_team) || null;
  const oppPriorsHome = priorIndex?.get(game.away_team) || null;
  const home = buildAsianSideFoundationFeatures({
    league: game.league,
    teamName: game.home_team,
    opponentName: game.away_team,
    commenceTime: game.commence_time,
    isHome: true,
    teamPriors,
    oppPriors: oppPriorsHome,
    eloLookup,
    myPitcherHist: opts.homePitcherHist || null,
    oppPitcherHist: opts.awayPitcherHist || null,
  });
  const away = buildAsianSideFoundationFeatures({
    league: game.league,
    teamName: game.away_team,
    opponentName: game.home_team,
    commenceTime: game.commence_time,
    isHome: false,
    teamPriors: oppPriorsHome,
    oppPriors: teamPriors,
    eloLookup,
    myPitcherHist: opts.awayPitcherHist || null,
    oppPitcherHist: opts.homePitcherHist || null,
  });
  return {
    featureVersion: ASIAN_FOUNDATION_FEATURE_VERSION,
    home,
    away,
    ready: home.gamesPlayed >= 8 && away.gamesPlayed >= 8,
  };
}

export function featuresToVector(features, keys = ASIAN_FOUNDATION_FEATURE_KEYS) {
  return keys.map((k) => finite(features[k], 0));
}

/**
 * 載入聯盟完賽場（審計用）
 */
export function loadAsianCompletedGames(league) {
  return db
    .prepare(
      `SELECT id, league, commence_time, home_team, away_team, home_score, away_score, raw_odds
       FROM games
       WHERE league = ? AND completed = 1
         AND home_score IS NOT NULL AND away_score IS NOT NULL
         AND NOT (home_score = 0 AND away_score = 0)
       ORDER BY datetime(commence_time) ASC`
    )
    .all(league);
}

/**
 * 依時間建立「開賽前」prior 索引（各隊歷史陣列的 shallow copy 指針）
 * 呼叫端應邊走邊 append；此函式給單場即時查詢用。
 */
export function buildPriorIndexAsOf(allGamesAsc, asOfCommence) {
  const idx = new Map();
  const cut = Date.parse(asOfCommence);
  for (const g of allGamesAsc) {
    if (Date.parse(g.commence_time) >= cut) break;
    for (const team of [g.home_team, g.away_team]) {
      if (!idx.has(team)) idx.set(team, []);
      idx.get(team).push(g);
    }
  }
  return idx;
}
