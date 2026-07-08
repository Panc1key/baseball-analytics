import db from '../db/database.js';
import {
  matchMlbTeam,
  getProbablePitchers,
  getPitcherSeasonStats,
  getTeamInjurySummary,
  getVenueName,
} from './MlbStatsService.js';
import { decimalToImpliedProb, removeVig } from '../utils/odds.js';

function parseL10Rate(last10) {
  if (!last10 || last10 === 'N/A') return null;
  const [w, l] = last10.split('-').map((n) => parseInt(n, 10));
  if (Number.isNaN(w) || Number.isNaN(l) || w + l === 0) return null;
  return w / (w + l);
}

/**
 * 從比分歷史更新 NPB/KBO 隊伍近期狀態 (無免費統計 API 時的 fallback)
 */
export function updateTeamStatsFromScores(league, scores) {
  const upsert = db.prepare(`
    INSERT INTO team_stats (league, team_name, wins, losses, last_10_wins, last_10_losses, rating, updated_at)
    VALUES (@league, @team_name, @wins, @losses, @l10w, @l10l, @rating, datetime('now'))
    ON CONFLICT(league, team_name) DO UPDATE SET
      wins = @wins, losses = @losses,
      last_10_wins = @l10w, last_10_losses = @l10l,
      rating = @rating, updated_at = datetime('now')
  `);

  const teamGames = {};

  for (const game of scores || []) {
    if (!game.completed) continue;
    const home = game.home_team;
    const away = game.away_team;
    const hs = game.scores?.find((s) => s.name === home)?.score;
    const as = game.scores?.find((s) => s.name === away)?.score;
    if (hs === undefined || as === undefined) continue;

    const homeWon = parseInt(hs, 10) > parseInt(as, 10);
    for (const [team, won] of [
      [home, homeWon],
      [away, !homeWon],
    ]) {
      if (!teamGames[team]) teamGames[team] = [];
      teamGames[team].push({ won, date: game.commence_time });
    }
  }

  const tx = db.transaction(() => {
    for (const [team, games] of Object.entries(teamGames)) {
      games.sort((a, b) => new Date(b.date) - new Date(a.date));
      const wins = games.filter((g) => g.won).length;
      const losses = games.length - wins;
      const last10 = games.slice(0, 10);
      const l10w = last10.filter((g) => g.won).length;
      const l10l = last10.length - l10w;
      const rating = games.length > 0 ? wins / games.length : 0.5;

      upsert.run({
        league,
        team_name: team,
        wins,
        losses,
        l10w,
        l10l,
        rating,
      });
    }
  });
  tx();
}

export function getTeamStats(league, teamName) {
  return db
    .prepare('SELECT * FROM team_stats WHERE league = ? AND team_name = ?')
    .get(league, teamName);
}

/**
 * 綜合模型：戰績 / 近10場 / 得失分差 / 先發投手 / 主場 / 傷兵 / 市場機率
 */
export async function analyzeMatchup(league, homeTeam, awayTeam, bookmakers, options = {}) {
  const { mlbStandings = [], mlbScheduleGame = null } = options;

  let homeRating = 0.5;
  let awayRating = 0.5;
  let homeL10 = 'N/A';
  let awayL10 = 'N/A';
  let pitcherEdge = 0;
  let homePitcherEra = null;
  let awayPitcherEra = null;
  const factors = [];

  if (league === 'MLB' && mlbStandings.length > 0) {
    const homeMlb = matchMlbTeam(homeTeam, mlbStandings);
    const awayMlb = matchMlbTeam(awayTeam, mlbStandings);

    if (homeMlb) {
      homeRating = homeMlb.winPct || 0.5;
      homeL10 = homeMlb.last10;
      const l10r = parseL10Rate(homeL10);
      if (l10r != null) homeRating = homeRating * 0.8 + l10r * 0.2;
      if (homeMlb.runDiff != null) {
        homeRating += homeMlb.runDiff * 0.0008;
        factors.push(`${homeTeam} 得失分差 ${homeMlb.runDiff > 0 ? '+' : ''}${homeMlb.runDiff}`);
      }
      factors.push(`${homeTeam} 戰績 ${homeMlb.wins}-${homeMlb.losses} (${(homeMlb.winPct * 100).toFixed(1)}%) 近10 ${homeL10}`);
    }
    if (awayMlb) {
      awayRating = awayMlb.winPct || 0.5;
      awayL10 = awayMlb.last10;
      const l10r = parseL10Rate(awayL10);
      if (l10r != null) awayRating = awayRating * 0.8 + l10r * 0.2;
      if (awayMlb.runDiff != null) {
        awayRating += awayMlb.runDiff * 0.0008;
        factors.push(`${awayTeam} 得失分差 ${awayMlb.runDiff > 0 ? '+' : ''}${awayMlb.runDiff}`);
      }
      factors.push(`${awayTeam} 戰績 ${awayMlb.wins}-${awayMlb.losses} (${(awayMlb.winPct * 100).toFixed(1)}%) 近10 ${awayL10}`);
    }

    const venue = getVenueName(mlbScheduleGame);
    if (venue) factors.push(`主場球場 ${venue}`);

    const [homeInj, awayInj] = await Promise.all([
      getTeamInjurySummary(homeMlb?.teamId),
      getTeamInjurySummary(awayMlb?.teamId),
    ]);
    if (homeInj.count > 0) {
      homeRating -= Math.min(0.04, homeInj.count * 0.008);
      factors.push(`${homeTeam} 傷兵 ${homeInj.count} 人${homeInj.names.length ? ` (${homeInj.names.slice(0, 2).join(', ')})` : ''}`);
    }
    if (awayInj.count > 0) {
      awayRating -= Math.min(0.04, awayInj.count * 0.008);
      factors.push(`${awayTeam} 傷兵 ${awayInj.count} 人${awayInj.names.length ? ` (${awayInj.names.slice(0, 2).join(', ')})` : ''}`);
    }

    if (mlbScheduleGame) {
      const pitchers = getProbablePitchers(mlbScheduleGame);
      const [homePitcherStats, awayPitcherStats] = await Promise.all([
        getPitcherSeasonStats(pitchers.home?.id),
        getPitcherSeasonStats(pitchers.away?.id),
      ]);

      if (homePitcherStats && awayPitcherStats) {
        const homeEra = homePitcherStats.era || 4.5;
        const awayEra = awayPitcherStats.era || 4.5;
        homePitcherEra = homeEra;
        awayPitcherEra = awayEra;
        pitcherEdge = (awayEra - homeEra) * 0.025;
        factors.push(
          `先發: ${pitchers.home?.name || '?'} ERA ${homeEra.toFixed(2)} vs ${pitchers.away?.name || '?'} ERA ${awayEra.toFixed(2)}`
        );
      } else if (pitchers.home || pitchers.away) {
        factors.push(`先發: ${pitchers.home?.name || 'TBD'} vs ${pitchers.away?.name || 'TBD'}`);
      }
    }
  } else {
    const homeStats = getTeamStats(league, homeTeam);
    const awayStats = getTeamStats(league, awayTeam);

    if (homeStats) {
      homeRating = homeStats.rating;
      homeL10 = `${homeStats.last_10_wins}-${homeStats.last_10_losses}`;
      factors.push(`${homeTeam} 近 ${homeStats.wins + homeStats.losses} 場勝率 ${(homeStats.rating * 100).toFixed(1)}%`);
    }
    if (awayStats) {
      awayRating = awayStats.rating;
      awayL10 = `${awayStats.last_10_wins}-${awayStats.last_10_losses}`;
      factors.push(`${awayTeam} 近 ${awayStats.wins + awayStats.losses} 場勝率 ${(awayStats.rating * 100).toFixed(1)}%`);
    }
  }

  const homeAdv = 0.035;
  let modelHomeProb =
    homeRating / (homeRating + awayRating + 0.001) + homeAdv + pitcherEdge;
  modelHomeProb = Math.max(0.15, Math.min(0.85, modelHomeProb));

  let marketHomeProb = null;
  const pinnacle = bookmakers?.find((b) => /pinnacle/i.test(b.title));
  const refBooks = pinnacle ? [pinnacle] : bookmakers?.slice(0, 3) || [];

  for (const book of refBooks) {
    const h2h = book.markets?.find((m) => m.key === 'h2h');
    if (!h2h) continue;
    const homeOutcome = h2h.outcomes?.find((o) => o.name === homeTeam);
    const awayOutcome = h2h.outcomes?.find((o) => o.name === awayTeam);
    if (homeOutcome && awayOutcome) {
      const hp = decimalToImpliedProb(homeOutcome.price);
      const ap = decimalToImpliedProb(awayOutcome.price);
      const fair = removeVig(hp, ap);
      marketHomeProb = fair.fairA;
      factors.push(`市場公平機率主隊 ${(marketHomeProb * 100).toFixed(1)}%`);
      break;
    }
  }

  if (marketHomeProb !== null) {
    modelHomeProb = modelHomeProb * 0.65 + marketHomeProb * 0.35;
  }

  const modelAwayProb = 1 - modelHomeProb;
  const confidence = Math.abs(modelHomeProb - 0.5) * 2;

  return {
    homeTeam,
    awayTeam,
    homeWinProb: modelHomeProb,
    awayWinProb: modelAwayProb,
    confidence,
    homeL10,
    awayL10,
    factors,
    marketHomeProb,
    marketAwayProb: marketHomeProb != null ? 1 - marketHomeProb : null,
    homePitcherEra,
    awayPitcherEra,
  };
}
