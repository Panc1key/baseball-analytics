/**
 * NPB/KBO 滾動 Elo
 *
 * - 完賽場次按時間序更新
 * - 主場加成、可選分差加權
 * - Elo → 獨贏期望勝率；Elo 差 → 調整泊松 λ
 * - 回測必須用 createWalkForwardElo（開賽前狀態），禁止用期末 Elo 前視
 */

import db from '../db/database.js';
import { config } from '../config.js';

export const ELO_DEFAULT = 1500;
export const ELO_HOME_ADV = 35;
export const ELO_K = 22;
export const ELO_SCALE = 400;

const FAMILY = new Set(['NPB', 'KBO']);

export function expectedScore(eloA, eloB) {
  return 1 / (1 + 10 ** ((eloB - eloA) / ELO_SCALE));
}

/** Elo → 相對聯盟均值的實力（0~1），供 Log5 / 展示 */
export function eloToStrength(elo) {
  const e = Number(elo);
  if (!Number.isFinite(e)) return 0.5;
  return Math.max(0.22, Math.min(0.78, expectedScore(e, ELO_DEFAULT)));
}

/**
 * 主場視角獨贏期望（含主場加成）
 */
export function eloHomeWinProb(homeElo, awayElo, homeAdv = ELO_HOME_ADV) {
  return expectedScore(Number(homeElo) + homeAdv, Number(awayElo));
}

/**
 * 分差加權 K（大勝多更新一點，封頂）
 */
export function marginMultiplier(homeScore, awayScore, eloDiff) {
  const mov = Math.abs(Number(homeScore) - Number(awayScore));
  if (!Number.isFinite(mov) || mov <= 0) return 1;
  const logPart = Math.log(mov + 1);
  const diffAbs = Math.abs(eloDiff) / ELO_SCALE;
  const damp = 2.2 / (diffAbs + 2.2);
  return Math.min(1.75, Math.max(0.85, logPart * damp));
}

export function updatePairElo(homeElo, awayElo, homeScore, awayScore, opts = {}) {
  const k = opts.k ?? config.baseballEloK ?? ELO_K;
  const homeAdv = opts.homeAdv ?? config.baseballEloHomeAdv ?? ELO_HOME_ADV;
  const hs = Number(homeScore);
  const as = Number(awayScore);
  let actualHome = 0.5;
  if (hs > as) actualHome = 1;
  else if (hs < as) actualHome = 0;

  const expectedHome = expectedScore(homeElo + homeAdv, awayElo);
  const eloDiff = homeElo + homeAdv - awayElo;
  const mult = opts.useMargin !== false ? marginMultiplier(hs, as, eloDiff) : 1;
  const delta = k * mult * (actualHome - expectedHome);

  return {
    homeElo: homeElo + delta,
    awayElo: awayElo - delta,
    expectedHome,
    actualHome,
    delta,
  };
}

/**
 * 用 Elo 差調整泊松 λ
 */
export function applyEloToLambdas(homeRuns, awayRuns, homeElo, awayElo, opts = {}) {
  const homeAdv = opts.homeAdv ?? config.baseballEloHomeAdv ?? ELO_HOME_ADV;
  const h = Number(homeRuns);
  const a = Number(awayRuns);
  if (!Number.isFinite(h) || !Number.isFinite(a)) {
    return { homeRuns, awayRuns, modelTotal: (h || 0) + (a || 0), eloMargin: 0 };
  }

  const margin = (Number(homeElo) + homeAdv - Number(awayElo)) / ELO_SCALE;
  const t = Math.tanh(margin);
  let homeAdj = h * (1 + 0.08 * t);
  let awayAdj = a * (1 - 0.08 * t);
  const shrink = Math.min(0.1, Math.abs(t) * 0.07);
  const total = (homeAdj + awayAdj) * (1 - shrink);
  const scale = homeAdj + awayAdj > 0 ? total / (homeAdj + awayAdj) : 1;
  homeAdj *= scale;
  awayAdj *= scale;

  return {
    homeRuns: Math.max(1.4, Math.min(8.5, homeAdj)),
    awayRuns: Math.max(1.4, Math.min(8.5, awayAdj)),
    modelTotal: Math.max(2.8, Math.min(17, homeAdj + awayAdj)),
    eloMargin: margin,
    shrink,
  };
}

function ensureEloColumn() {
  try {
    db.exec('ALTER TABLE team_stats ADD COLUMN elo REAL DEFAULT 1500');
  } catch {
    /* exists */
  }
}

export function seedEloMap(league) {
  const seeds = db
    .prepare('SELECT team_name, rating FROM team_stats WHERE league = ?')
    .all(league);
  const ratings = new Map();
  for (const s of seeds) {
    const fromRating =
      s.rating != null ? ELO_DEFAULT + (Number(s.rating) - 0.5) * 800 : ELO_DEFAULT;
    ratings.set(s.team_name, fromRating);
  }
  return ratings;
}

/**
 * Walk-forward Elo：分析前讀取、完賽後更新，消除前視偏差
 * @param {{ seedFromRating?: boolean }} opts
 *   seedFromRating=false：從 1500 起純賽果推進（回測用，避免 Yahoo 期末種子前視）
 */
export function createWalkForwardElo(league, opts = {}) {
  if (!FAMILY.has(league)) {
    return {
      league,
      get() {
        return ELO_DEFAULT;
      },
      applyGame() {
        return null;
      },
      asMap() {
        return new Map();
      },
    };
  }
  const ratings = opts.seedFromRating === false ? new Map() : seedEloMap(league);
  return {
    league,
    get(team) {
      if (!ratings.has(team)) ratings.set(team, ELO_DEFAULT);
      return ratings.get(team);
    },
    applyGame(homeTeam, awayTeam, homeScore, awayScore) {
      const h = this.get(homeTeam);
      const a = this.get(awayTeam);
      const next = updatePairElo(h, a, homeScore, awayScore);
      ratings.set(homeTeam, next.homeElo);
      ratings.set(awayTeam, next.awayElo);
      return next;
    },
    asMap() {
      return new Map(ratings);
    },
  };
}

/**
 * @param {string} league
 * @param {string} teamName
 * @param {Map<string, number>|null} eloOverride 若提供則優先（回測 as-of）
 */
export function getTeamElo(league, teamName, eloOverride = null) {
  if (eloOverride instanceof Map && eloOverride.has(teamName)) {
    return eloOverride.get(teamName);
  }
  if (eloOverride && typeof eloOverride.get === 'function') {
    const v = eloOverride.get(teamName);
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  }
  ensureEloColumn();
  const row = db
    .prepare('SELECT elo, rating FROM team_stats WHERE league = ? AND team_name = ?')
    .get(league, teamName);
  if (row?.elo != null && Number.isFinite(Number(row.elo))) return Number(row.elo);
  if (row?.rating != null) return ELO_DEFAULT + (Number(row.rating) - 0.5) * 800;
  return ELO_DEFAULT;
}

export function setTeamElo(league, teamName, elo) {
  ensureEloColumn();
  db.prepare(
    `
    INSERT INTO team_stats (league, team_name, elo, rating, updated_at)
    VALUES (?, ?, ?, 0.5, datetime('now'))
    ON CONFLICT(league, team_name) DO UPDATE SET
      elo = excluded.elo,
      updated_at = datetime('now')
  `
  ).run(league, teamName, elo);
}

/**
 * 從 DB 完賽場次重建聯盟 Elo，並寫回 team_stats.elo（供即時分析）
 */
export function rebuildLeagueElo(league) {
  if (!FAMILY.has(league)) return { league, games: 0, teams: 0 };

  ensureEloColumn();
  const games = db
    .prepare(
      `
    SELECT home_team, away_team, home_score, away_score, commence_time
    FROM games
    WHERE league = ?
      AND completed = 1
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND NOT (home_score = 0 AND away_score = 0)
    ORDER BY datetime(commence_time) ASC
  `
    )
    .all(league);

  const walker = createWalkForwardElo(league);
  for (const g of games) {
    walker.applyGame(g.home_team, g.away_team, g.home_score, g.away_score);
  }

  const ratings = walker.asMap();
  const upsert = db.prepare(
    `
    INSERT INTO team_stats (league, team_name, elo, rating, updated_at)
    VALUES (?, ?, ?, COALESCE((SELECT rating FROM team_stats WHERE league = ? AND team_name = ?), 0.5), datetime('now'))
    ON CONFLICT(league, team_name) DO UPDATE SET
      elo = excluded.elo,
      updated_at = datetime('now')
  `
  );

  const tx = db.transaction(() => {
    for (const [team, elo] of ratings) {
      upsert.run(league, team, elo, league, team);
    }
  });
  tx();

  return { league, games: games.length, teams: ratings.size };
}

export function rebuildAllBaseballElo() {
  return {
    NPB: rebuildLeagueElo('NPB'),
    KBO: rebuildLeagueElo('KBO'),
  };
}

/** 單場完賽後增量更新 */
export function applyGameToElo(league, homeTeam, awayTeam, homeScore, awayScore) {
  if (!FAMILY.has(league)) return null;
  const homeElo = getTeamElo(league, homeTeam);
  const awayElo = getTeamElo(league, awayTeam);
  const next = updatePairElo(homeElo, awayElo, homeScore, awayScore);
  setTeamElo(league, homeTeam, next.homeElo);
  setTeamElo(league, awayTeam, next.awayElo);
  return next;
}
