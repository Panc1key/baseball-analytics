import db from '../db/database.js';
import {
  matchMlbTeam,
  getProbablePitchers,
  getPitcherSeasonStats,
  getTeamInjurySummary,
  getVenueName,
} from './MlbStatsService.js';
import { computeH2hProbabilities, pythagoreanWinPct } from './H2hModel.js';
import { buildMatchupAnalysis, applyCalibratedProbabilities } from './MatchupCore.js';
import { computeTotalsProjection } from './TotalsModel.js';
import { fetchYahooNpbStandings } from './NpbYahooScores.js';
import { resolveNpbTeamStrength } from './NpbStrength.js';

function teamStatsUpsertStmt() {
  return db.prepare(`
    INSERT INTO team_stats (
      league, team_name, wins, losses, last_10_wins, last_10_losses,
      rating, runs_scored, runs_allowed, updated_at
    )
    VALUES (
      @league, @team_name, @wins, @losses, @l10w, @l10l,
      @rating, @rs, @ra, datetime('now')
    )
    ON CONFLICT(league, team_name) DO UPDATE SET
      wins = @wins, losses = @losses,
      last_10_wins = @l10w, last_10_losses = @l10l,
      rating = @rating,
      runs_scored = COALESCE(@rs, team_stats.runs_scored),
      runs_allowed = COALESCE(@ra, team_stats.runs_allowed),
      updated_at = datetime('now')
  `);
}

/**
 * 從比分歷史更新 NPB/KBO 隊伍近期狀態 (Odds API scores fallback)
 */
export function updateTeamStatsFromScores(league, scores) {
  const upsert = teamStatsUpsertStmt();
  const teamGames = {};

  for (const game of scores || []) {
    if (!game.completed) continue;
    const home = game.home_team;
    const away = game.away_team;
    const hs = game.scores?.find((s) => s.name === home)?.score;
    const as = game.scores?.find((s) => s.name === away)?.score;
    if (hs === undefined || as === undefined) continue;

    const homeScore = parseInt(hs, 10);
    const awayScore = parseInt(as, 10);
    if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) continue;
    const homeWon = homeScore > awayScore;

    for (const [team, won, gf, ga] of [
      [home, homeWon, homeScore, awayScore],
      [away, !homeWon, awayScore, homeScore],
    ]) {
      if (!teamGames[team]) teamGames[team] = [];
      teamGames[team].push({ won, gf, ga, date: game.commence_time });
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
      const rs = games.reduce((s, g) => s + (g.gf || 0), 0);
      const ra = games.reduce((s, g) => s + (g.ga || 0), 0);
      const rating = games.length > 0 ? wins / games.length : 0.5;

      upsert.run({
        league,
        team_name: team,
        wins,
        losses,
        l10w,
        l10l,
        rating,
        rs,
        ra,
      });
    }
  });
  tx();
}

/**
 * Yahoo 順位表寫入 NPB team_stats（主力數據源）
 * rating = 0.4×勝率 + 0.6×Pythagorean（與 MLB 思路一致）
 */
export function updateNpbTeamStatsFromStandings(standings) {
  if (!standings?.length) return 0;
  const upsert = teamStatsUpsertStmt();

  const tx = db.transaction(() => {
    for (const row of standings) {
      const winPct = row.winPct ?? (row.wins + row.losses > 0 ? row.wins / (row.wins + row.losses) : 0.5);
      const pyth =
        row.runsScored != null && row.runsAllowed != null
          ? pythagoreanWinPct(row.runsScored, row.runsAllowed)
          : null;
      const rating =
        pyth != null ? Math.max(0.28, Math.min(0.72, winPct * 0.4 + pyth * 0.6)) : winPct;

      upsert.run({
        league: 'NPB',
        team_name: row.teamName,
        wins: row.wins,
        losses: row.losses,
        l10w: 0,
        l10l: 0,
        rating,
        rs: row.runsScored,
        ra: row.runsAllowed,
      });
    }
  });
  tx();
  return standings.length;
}

/** sync 時拉 Yahoo 順位並寫入（失敗不阻斷） */
export async function syncNpbStandingsFromYahoo() {
  const standings = await fetchYahooNpbStandings();
  const n = updateNpbTeamStatsFromStandings(standings);
  return { count: n, standings };
}

export function getTeamStats(league, teamName) {
  return db
    .prepare('SELECT * FROM team_stats WHERE league = ? AND team_name = ?')
    .get(league, teamName);
}

/**
 * 綜合分析：MLB 用 MatchupCore（情境/EV）+ H2hModel/Poisson（校準勝率）
 */
export async function analyzeMatchup(league, homeTeam, awayTeam, bookmakers, options = {}) {
  const { mlbStandings = [], mlbScheduleGame = null } = options;

  let homeMlb = null;
  let awayMlb = null;
  let homePitcherStats = null;
  let awayPitcherStats = null;
  let homeInjurySummary = { count: 0, names: [] };
  let awayInjurySummary = { count: 0, names: [] };
  let homeFallbackRating = 0.5;
  let awayFallbackRating = 0.5;
  let homeL10 = 'N/A';
  let awayL10 = 'N/A';
  let homePitcherEra = null;
  let awayPitcherEra = null;
  const venueName = getVenueName(mlbScheduleGame);

  if (league === 'MLB' && mlbStandings.length > 0) {
    homeMlb = matchMlbTeam(homeTeam, mlbStandings);
    awayMlb = matchMlbTeam(awayTeam, mlbStandings);
    homeL10 = homeMlb?.last10 || 'N/A';
    awayL10 = awayMlb?.last10 || 'N/A';

    const [homeInj, awayInj] = await Promise.all([
      getTeamInjurySummary(homeMlb?.teamId),
      getTeamInjurySummary(awayMlb?.teamId),
    ]);
    homeInjurySummary = homeInj;
    awayInjurySummary = awayInj;

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
      // 顯示賽季戰績（Yahoo 順位無真實近10）
      homeL10 = `${homeStats.wins}-${homeStats.losses}`;
    }
    if (awayStats) {
      awayFallbackRating = awayStats.rating;
      awayL10 = `${awayStats.wins}-${awayStats.losses}`;
    }
  }

  const homeStatsRow = league !== 'MLB' ? getTeamStats(league, homeTeam) : null;
  const awayStatsRow = league !== 'MLB' ? getTeamStats(league, awayTeam) : null;
  const strength = resolveNpbTeamStrength(homeStatsRow, awayStatsRow, league);
  const hasNpbStrength = strength.hasStrength;

  const totalsProjection = computeTotalsProjection({
    league,
    homeMlb,
    awayMlb,
    homePitcherStats,
    awayPitcherStats,
    venueName,
    bookmakers,
    homeTeamStats: homeStatsRow,
    awayTeamStats: awayStatsRow,
  });

  let matchupCore = null;
  let h2h;

  if (league === 'MLB') {
    const situationCore = buildMatchupAnalysis({
      league,
      homeTeam,
      awayTeam,
      bookmakers,
      homeMlb,
      awayMlb,
      homePitcherStats,
      awayPitcherStats,
      homeInjurySummary,
      awayInjurySummary,
      homeFallbackRating,
      awayFallbackRating,
      venueName,
    });

    h2h = computeH2hProbabilities({
      league,
      homeTeam,
      awayTeam,
      bookmakers,
      homeMlb,
      awayMlb,
      homePitcherStats,
      awayPitcherStats,
      homeInjuryCount: homeInjurySummary.count,
      awayInjuryCount: awayInjurySummary.count,
      homeFallbackRating,
      awayFallbackRating,
      venueName,
      // 三盤口統一使用市場校準後的 scoring lambda。
      homeRuns: totalsProjection.probabilityHomeRuns,
      awayRuns: totalsProjection.probabilityAwayRuns,
    });

    matchupCore = applyCalibratedProbabilities(
      situationCore,
      h2h.homeWinProb,
      h2h.awayWinProb,
      bookmakers,
      homeTeam,
      awayTeam
    );
  } else {
    h2h = computeH2hProbabilities({
      league,
      homeTeam,
      awayTeam,
      bookmakers,
      homeMlb,
      awayMlb,
      homePitcherStats,
      awayPitcherStats,
      homeInjuryCount: homeInjurySummary.count,
      awayInjuryCount: awayInjurySummary.count,
      homeFallbackRating,
      awayFallbackRating,
      venueName,
      homeRuns: totalsProjection.probabilityHomeRuns,
      awayRuns: totalsProjection.probabilityAwayRuns,
      hasNpbStrength,
    });
  }

  const coreFactors = h2h.factors || [];
  const totalsFactors = totalsProjection.factors.filter((f) => !coreFactors.some((c) => c === f));

  let dataQuality = matchupCore?.dataQuality ?? totalsProjection.dataQuality ?? 0.35;
  if (league === 'NPB') {
    dataQuality = hasNpbStrength ? Math.max(dataQuality, 0.72) : Math.min(dataQuality, 0.4);
  }

  return {
    homeTeam,
    awayTeam,
    homeWinProb: h2h.homeWinProb,
    awayWinProb: h2h.awayWinProb,
    rawModelHomeProb: h2h.rawModelHomeProb ?? h2h.homeWinProb,
    rawModelAwayProb: h2h.rawModelAwayProb ?? h2h.awayWinProb,
    calibratedHomeProb: h2h.calibratedHomeProb ?? h2h.homeWinProb,
    calibratedAwayProb: h2h.calibratedAwayProb ?? h2h.awayWinProb,
    confidence: h2h.confidence,
    homeL10,
    awayL10,
    factors: [...coreFactors, ...totalsFactors],
    marketHomeProb: h2h.marketHomeProb,
    marketAwayProb: h2h.marketAwayProb,
    homePitcherEra,
    awayPitcherEra,
    pitcherEdge: h2h.pitcherEdge ?? h2h.components?.pitcherEdge ?? 0,
    homeRuns: totalsProjection.homeRuns,
    awayRuns: totalsProjection.awayRuns,
    scoringHomeRuns: totalsProjection.probabilityHomeRuns,
    scoringAwayRuns: totalsProjection.probabilityAwayRuns,
    h2hComponents: h2h.components,
    homeMlb,
    awayMlb,
    homePitcherStats,
    awayPitcherStats,
    homeInjurySummary,
    awayInjurySummary,
    venueName,
    totalsProjection,
    projectedTotal: totalsProjection.finalTotal,
    matchupCore,
    hasTeamStrength: hasNpbStrength || Boolean(homeMlb && awayMlb),
    dataQuality,
  };
}
