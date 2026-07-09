import db from '../db/database.js';
import {
  matchMlbTeam,
  getProbablePitchers,
  getPitcherSeasonStats,
  getTeamInjurySummary,
  getVenueName,
} from './MlbStatsService.js';
import { computeH2hProbabilities } from './H2hModel.js';
import { computeTotalsProjection } from './TotalsModel.js';

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
 * 綜合分析（獨贏模型為核心，其他盤口沿用同一 homeWinProb）
 */
export async function analyzeMatchup(league, homeTeam, awayTeam, bookmakers, options = {}) {
  const { mlbStandings = [], mlbScheduleGame = null } = options;

  let homeMlb = null;
  let awayMlb = null;
  let homePitcherStats = null;
  let awayPitcherStats = null;
  let homeInjuryCount = 0;
  let awayInjuryCount = 0;
  let homeFallbackRating = 0.5;
  let awayFallbackRating = 0.5;
  let homeL10 = 'N/A';
  let awayL10 = 'N/A';
  let homePitcherEra = null;
  let awayPitcherEra = null;

  if (league === 'MLB' && mlbStandings.length > 0) {
    homeMlb = matchMlbTeam(homeTeam, mlbStandings);
    awayMlb = matchMlbTeam(awayTeam, mlbStandings);
    homeL10 = homeMlb?.last10 || 'N/A';
    awayL10 = awayMlb?.last10 || 'N/A';

    const [homeInj, awayInj] = await Promise.all([
      getTeamInjurySummary(homeMlb?.teamId),
      getTeamInjurySummary(awayMlb?.teamId),
    ]);
    homeInjuryCount = homeInj.count;
    awayInjuryCount = awayInj.count;

    if (mlbScheduleGame) {
      const pitchers = getProbablePitchers(mlbScheduleGame);
      const [homeStats, awayStats] = await Promise.all([
        getPitcherSeasonStats(pitchers.home?.id),
        getPitcherSeasonStats(pitchers.away?.id),
      ]);
      homePitcherStats = homeStats;
      awayPitcherStats = awayStats;
      homePitcherEra = homeStats?.era ?? null;
      awayPitcherEra = awayStats?.era ?? null;
    }
  } else {
    const homeStats = getTeamStats(league, homeTeam);
    const awayStats = getTeamStats(league, awayTeam);
    if (homeStats) {
      homeFallbackRating = homeStats.rating;
      homeL10 = `${homeStats.last_10_wins}-${homeStats.last_10_losses}`;
    }
    if (awayStats) {
      awayFallbackRating = awayStats.rating;
      awayL10 = `${awayStats.last_10_wins}-${awayStats.last_10_losses}`;
    }
  }

  const h2h = computeH2hProbabilities({
    league,
    homeTeam,
    awayTeam,
    bookmakers,
    homeMlb,
    awayMlb,
    homePitcherStats,
    awayPitcherStats,
    homeInjuryCount,
    awayInjuryCount,
    homeFallbackRating,
    awayFallbackRating,
    venueName: getVenueName(mlbScheduleGame),
  });

  const totalsProjection = computeTotalsProjection({
    league,
    homeMlb,
    awayMlb,
    homePitcherStats,
    awayPitcherStats,
    venueName: getVenueName(mlbScheduleGame),
    bookmakers,
  });

  return {
    homeTeam,
    awayTeam,
    homeWinProb: h2h.homeWinProb,
    awayWinProb: h2h.awayWinProb,
    confidence: h2h.confidence,
    homeL10,
    awayL10,
    factors: [...h2h.factors, ...totalsProjection.factors],
    marketHomeProb: h2h.marketHomeProb,
    marketAwayProb: h2h.marketAwayProb,
    homePitcherEra,
    awayPitcherEra,
    h2hComponents: h2h.components,
    homeMlb,
    awayMlb,
    homePitcherStats,
    awayPitcherStats,
    venueName: getVenueName(mlbScheduleGame),
    totalsProjection,
    projectedTotal: totalsProjection.finalTotal,
  };
}
