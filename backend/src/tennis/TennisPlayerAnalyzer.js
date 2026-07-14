import db from '../db/database.js';
import { computeTennisH2h } from './models/TennisH2hModel.js';
import { projectMatchGames } from './models/TennisTotalsModel.js';

/**
 * 網球比分：Odds API 常以盤分為主分（2-0 / 2-1），總局數較少有完整字串
 * 用於更新選手勝率與「均盤數」粗估
 */
export function updateTennisPlayerStatsFromScores(league, scores) {
  const upsert = db.prepare(`
    INSERT INTO team_stats (league, team_name, wins, losses, last_10_wins, last_10_losses, rating, goals_for, goals_against, draws, updated_at)
    VALUES (@league, @team_name, @wins, @losses, @l10w, @l10l, @rating, @gf, @ga, 0, datetime('now'))
    ON CONFLICT(league, team_name) DO UPDATE SET
      wins = @wins, losses = @losses, draws = 0,
      last_10_wins = @l10w, last_10_losses = @l10l,
      goals_for = @gf, goals_against = @ga,
      rating = @rating, updated_at = datetime('now')
  `);

  const playerMatches = {};

  for (const game of scores || []) {
    if (!game.completed) continue;
    const home = game.home_team;
    const away = game.away_team;
    const hs = parseInt(game.scores?.find((s) => s.name === home)?.score, 10);
    const as = parseInt(game.scores?.find((s) => s.name === away)?.score, 10);
    if (Number.isNaN(hs) || Number.isNaN(as)) continue;

    /** goals_for 存「贏得盤數」，goals_against 存「丟掉盤數」 */
    const record = (player, setsWon, setsLost) => {
      if (!playerMatches[player]) playerMatches[player] = [];
      const totalSets = setsWon + setsLost;
      const approxGames = totalSets * 9.2;
      playerMatches[player].push({
        won: setsWon > setsLost,
        setsWon,
        setsLost,
        approxGames,
        date: game.commence_time,
      });
    };
    record(home, hs, as);
    record(away, as, hs);
  }

  const tx = db.transaction(() => {
    for (const [player, matches] of Object.entries(playerMatches)) {
      matches.sort((a, b) => new Date(b.date) - new Date(a.date));
      const wins = matches.filter((m) => m.won).length;
      const losses = matches.length - wins;
      const gf = matches.reduce((s, m) => s + m.setsWon, 0);
      const ga = matches.reduce((s, m) => s + m.setsLost, 0);
      const last10 = matches.slice(0, 10);
      const l10w = last10.filter((m) => m.won).length;
      const l10l = last10.length - l10w;
      const rating = matches.length > 0 ? wins / matches.length : 0.5;

      upsert.run({
        league,
        team_name: player,
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

function getPlayerStats(league, name) {
  return db.prepare('SELECT * FROM team_stats WHERE league = ? AND team_name = ?').get(league, name);
}

function profileFromDb(stats, name) {
  if (!stats) return null;
  const games = (stats.wins || 0) + (stats.losses || 0);
  const setsWon = stats.goals_for || 0;
  const setsLost = stats.goals_against || 0;
  const setShare = setsWon + setsLost > 0 ? setsWon / (setsWon + setsLost) : 0.5;
  const avgGames =
    games > 0 ? ((setsWon + setsLost) / games) * 9.2 : null;

  return {
    playerName: name,
    gamesPlayed: games,
    hasIntel: games >= 2,
    formRating: stats.rating ?? 0.5,
    serveRating: Math.min(0.9, setShare),
    avgGamesPlayed: avgGames,
    formSummary: games
      ? `近況 ${stats.wins}勝${stats.losses}負 · 盤分 ${setsWon}-${setsLost}`
      : null,
  };
}

export async function analyzeTennisMatchup(leagueCode, homeTeam, awayTeam, bookmakers) {
  const homeProfile = profileFromDb(getPlayerStats(leagueCode, homeTeam), homeTeam);
  const awayProfile = profileFromDb(getPlayerStats(leagueCode, awayTeam), awayTeam);

  const h2h = computeTennisH2h({
    homeTeam,
    awayTeam,
    bookmakers,
    homeProfile,
    awayProfile,
  });

  const totalsProjection = projectMatchGames({
    leagueCode,
    homeWinProb: h2h.homeWinProb,
    homeProfile,
    awayProfile,
    bookmakers,
  });

  return {
    homeTeam,
    awayTeam,
    homeWinProb: h2h.homeWinProb,
    awayWinProb: h2h.awayWinProb,
    expectedGameMargin: h2h.expectedGameMargin,
    confidence: h2h.confidence,
    factors: [...h2h.factors, ...totalsProjection.factors],
    marketHomeProb: h2h.market?.homeProb ?? null,
    marketAwayProb: h2h.market?.awayProb ?? null,
    totalsProjection,
    projectedTotal: totalsProjection.finalTotal,
    homeProfile,
    awayProfile,
    h2hComponents: h2h.components,
  };
}
