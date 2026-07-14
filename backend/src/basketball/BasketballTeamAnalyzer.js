import db from '../db/database.js';
import { BASKETBALL_LEAGUE_AVG_TOTAL } from './config.js';
import { computeBasketballH2h, projectBasketballScore } from './models/BasketballH2hModel.js';
import { projectMatchPoints } from './models/BasketballTotalsModel.js';

/** 用歷史比分更新隊史勝率 / 得分節奏 */
export function updateBasketballTeamStatsFromScores(league, scores) {
  const upsert = db.prepare(`
    INSERT INTO team_stats (league, team_name, wins, losses, last_10_wins, last_10_losses, rating, goals_for, goals_against, draws, updated_at)
    VALUES (@league, @team_name, @wins, @losses, @l10w, @l10l, @rating, @gf, @ga, 0, datetime('now'))
    ON CONFLICT(league, team_name) DO UPDATE SET
      wins = @wins, losses = @losses, draws = 0,
      last_10_wins = @l10w, last_10_losses = @l10l,
      goals_for = @gf, goals_against = @ga,
      rating = @rating, updated_at = datetime('now')
  `);

  const teamGames = {};

  for (const game of scores || []) {
    if (!game.completed) continue;
    const home = game.home_team;
    const away = game.away_team;
    const hs = parseInt(game.scores?.find((s) => s.name === home)?.score, 10);
    const as = parseInt(game.scores?.find((s) => s.name === away)?.score, 10);
    if (Number.isNaN(hs) || Number.isNaN(as)) continue;

    const record = (team, pts, opp) => {
      if (!teamGames[team]) teamGames[team] = [];
      teamGames[team].push({ won: pts > opp, pts, opp, date: game.commence_time });
    };
    record(home, hs, as);
    record(away, as, hs);
  }

  const tx = db.transaction(() => {
    for (const [team, games] of Object.entries(teamGames)) {
      games.sort((a, b) => new Date(b.date) - new Date(a.date));
      const wins = games.filter((g) => g.won).length;
      const losses = games.length - wins;
      const gf = games.reduce((s, g) => s + g.pts, 0);
      const ga = games.reduce((s, g) => s + g.opp, 0);
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
        gf,
        ga,
        rating,
      });
    }
  });
  tx();
}

function getTeamStats(league, teamName) {
  return db
    .prepare('SELECT * FROM team_stats WHERE league = ? AND team_name = ?')
    .get(league, teamName);
}

function profileFromDbStats(stats, teamName, league) {
  if (!stats) return null;
  const games = (stats.wins || 0) + (stats.losses || 0);
  const avgTotal = BASKETBALL_LEAGUE_AVG_TOTAL[league] ?? BASKETBALL_LEAGUE_AVG_TOTAL.DEFAULT;
  const half = avgTotal / 2;
  const ppg = games > 0 ? (stats.goals_for || 0) / games : half;
  const oppg = games > 0 ? (stats.goals_against || 0) / games : half;

  return {
    teamName,
    gamesPlayed: games,
    hasIntel: games >= 3,
    formRating: stats.rating ?? 0.5,
    offenseRating: Math.min(0.9, ppg / (half * 1.15)),
    defenseRating: Math.min(0.9, 1 - oppg / (half * 1.15)),
    ppg,
    oppg,
    formSummary: games
      ? `近況 ${stats.wins}勝${stats.losses}負 · 均得 ${ppg.toFixed(1)} 失 ${oppg.toFixed(1)}`
      : null,
  };
}

export async function analyzeBasketballMatchup(leagueCode, homeTeam, awayTeam, bookmakers) {
  const homeProfile = profileFromDbStats(getTeamStats(leagueCode, homeTeam), homeTeam, leagueCode);
  const awayProfile = profileFromDbStats(getTeamStats(leagueCode, awayTeam), awayTeam, leagueCode);

  const scoreProjection = projectBasketballScore({
    league: leagueCode,
    homeProfile,
    awayProfile,
  });

  const h2h = computeBasketballH2h({
    homeTeam,
    awayTeam,
    bookmakers,
    homeProfile,
    awayProfile,
    league: leagueCode,
    scoreProjection,
  });

  const totalsProjection = projectMatchPoints({
    league: leagueCode,
    homeProfile,
    awayProfile,
    bookmakers,
    scoreProjection: h2h.scoreProjection || scoreProjection,
  });

  return {
    homeTeam,
    awayTeam,
    homeWinProb: h2h.homeWinProb,
    awayWinProb: h2h.awayWinProb,
    expectedMargin: h2h.expectedMargin,
    confidence: h2h.confidence,
    factors: [...h2h.factors, ...totalsProjection.factors],
    marketHomeProb: h2h.market?.homeProb ?? null,
    marketAwayProb: h2h.market?.awayProb ?? null,
    totalsProjection,
    projectedTotal: totalsProjection.finalTotal,
    homeProfile,
    awayProfile,
    h2hComponents: h2h.components,
    scoreProjection,
  };
}
