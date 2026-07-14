import db from '../db/database.js';
import { FOOTBALL_LEAGUES } from './config.js';
import { computeFootballH2h } from './models/FootballH2hModel.js';
import { projectMatchGoals } from './models/FootballTotalsModel.js';
import { fetchMatchIntel } from './FootballStatsService.js';

/** 從比分歷史更新足球隊伍近期狀態 */
export function updateFootballTeamStatsFromScores(league, scores) {
  const upsert = db.prepare(`
    INSERT INTO team_stats (league, team_name, wins, losses, last_10_wins, last_10_losses, rating, goals_for, goals_against, draws, updated_at)
    VALUES (@league, @team_name, @wins, @losses, @l10w, @l10l, @rating, @gf, @ga, @draws, datetime('now'))
    ON CONFLICT(league, team_name) DO UPDATE SET
      wins = @wins, losses = @losses, draws = @draws,
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

    const record = (team, gf, ga) => {
      if (!teamGames[team]) teamGames[team] = [];
      const won = gf > ga;
      const draw = gf === ga;
      teamGames[team].push({ won, draw, gf, ga, date: game.commence_time });
    };
    record(home, hs, as);
    record(away, as, hs);
  }

  const tx = db.transaction(() => {
    for (const [team, games] of Object.entries(teamGames)) {
      games.sort((a, b) => new Date(b.date) - new Date(a.date));
      const wins = games.filter((g) => g.won).length;
      const draws = games.filter((g) => g.draw).length;
      const losses = games.length - wins - draws;
      const gf = games.reduce((s, g) => s + g.gf, 0);
      const ga = games.reduce((s, g) => s + g.ga, 0);
      const last10 = games.slice(0, 10);
      const l10w = last10.filter((g) => g.won).length;
      const l10l = last10.filter((g) => !g.won && !g.draw).length;
      const rating =
        games.length > 0
          ? (wins + draws * 0.35) / games.length
          : 0.5;

      upsert.run({
        league,
        team_name: team,
        wins,
        losses,
        draws,
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

function profileFromDbStats(stats, teamName) {
  if (!stats) return null;
  const games = (stats.wins || 0) + (stats.losses || 0) + (stats.draws || 0);
  const gf = games > 0 ? (stats.goals_for || 0) / games : 1.3;
  const ga = games > 0 ? (stats.goals_against || 0) / games : 1.3;

  return {
    teamName,
    gamesPlayed: games,
    hasIntel: games >= 2,
    formRating: stats.rating ?? 0.5,
    attackRating: Math.min(0.9, gf / 2.2),
    defenseRating: Math.min(0.9, 1 - ga / 2.2),
    goalsPerGame: gf,
    goalsAgainstPerGame: ga,
    tacticalStyle: gf >= 1.9 ? 'attacking' : ga <= 0.85 ? 'defensive' : 'balanced',
    formSummary: games
      ? `本屆 ${stats.wins}勝${stats.draws || 0}和${stats.losses}負 · 進失 ${stats.goals_for || 0}-${stats.goals_against || 0}（均進 ${gf.toFixed(1)}）`
      : null,
    lineupPenalty: 0,
    lineupNote: null,
    coachNote: null,
  };
}

function mergeProfiles(apiProfile, dbProfile) {
  if (!apiProfile && !dbProfile) return null;
  if (!apiProfile) return dbProfile;
  if (!dbProfile) return apiProfile;

  return {
    ...apiProfile,
    formRating: apiProfile.hasIntel
      ? apiProfile.formRating * 0.65 + dbProfile.formRating * 0.35
      : dbProfile.formRating,
    goalsPerGame: apiProfile.goalsPerGame ?? dbProfile.goalsPerGame,
    goalsAgainstPerGame: apiProfile.goalsAgainstPerGame ?? dbProfile.goalsAgainstPerGame,
    formSummary: [apiProfile.formSummary, dbProfile.formSummary].filter(Boolean).join(' · '),
    hasIntel: apiProfile.hasIntel || dbProfile.hasIntel,
  };
}

export async function analyzeFootballMatchup(leagueCode, homeTeam, awayTeam, bookmakers, commenceTime) {
  const leagueMeta = FOOTBALL_LEAGUES[leagueCode];
  const intel = await fetchMatchIntel(leagueCode, homeTeam, awayTeam, commenceTime);

  const homeDb = profileFromDbStats(getTeamStats(leagueCode, homeTeam), homeTeam);
  const awayDb = profileFromDbStats(getTeamStats(leagueCode, awayTeam), awayTeam);
  const homeProfile = mergeProfiles(intel.homeProfile, homeDb);
  const awayProfile = mergeProfiles(intel.awayProfile, awayDb);

  const h2h = computeFootballH2h({
    homeTeam,
    awayTeam,
    bookmakers,
    homeProfile,
    awayProfile,
    neutralVenue: leagueMeta?.neutralVenue ?? false,
    tacticalEdge: intel.tacticalEdge ?? 0,
    league: leagueCode,
  });

  const totalsProjection = projectMatchGoals({
    homeLambda: h2h.homeLambda,
    awayLambda: h2h.awayLambda,
    scoreGrid: h2h.scoreGrid,
    bookmakers,
    xgFactors: [],
  });

  return {
    homeTeam,
    awayTeam,
    homeWinProb: h2h.homeWinProb,
    drawProb: h2h.drawProb,
    awayWinProb: h2h.awayWinProb,
    confidence: h2h.confidence,
    factors: [...h2h.factors, ...totalsProjection.factors],
    marketHomeProb: h2h.market?.homeProb ?? null,
    marketDrawProb: h2h.market?.drawProb ?? null,
    marketAwayProb: h2h.market?.awayProb ?? null,
    scoreGrid: h2h.scoreGrid,
    homeLambda: h2h.homeLambda,
    awayLambda: h2h.awayLambda,
    totalsProjection,
    projectedTotal: totalsProjection.finalTotal,
    homeProfile,
    awayProfile,
    intel,
    h2hComponents: h2h.components,
  };
}
