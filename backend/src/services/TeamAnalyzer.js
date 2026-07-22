import db from '../db/database.js';
import {
  matchMlbTeam,
  getProbablePitchers,
  getMlbPitcherPregameFeatures,
  getTeamInjurySummary,
  getVenueName,
} from './MlbStatsService.js';
import { starPenaltyFromInjuryNames } from './StarPlayerImpact.js';
import { config } from '../config.js';
import { computeH2hProbabilities, pythagoreanWinPct } from './H2hModel.js';
import { buildMatchupAnalysis, applyCalibratedProbabilities } from './MatchupCore.js';
import { computeTotalsProjection } from './TotalsModel.js';
import { fetchYahooNpbStandings } from './NpbYahooScores.js';
import { resolveNpbTeamStrength } from './NpbStrength.js';
import { resolveKboPitchersForGame } from './KboPitcherService.js';

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
 * 從 DB 完賽場次重建 NPB/KBO 戰績與得失分（不依賴 Odds API 近期窗口）
 * Elo 重建只寫 elo，不會補 wins/runs；此函式補上隊力判定所需欄位。
 */
export function updateTeamStatsFromDbGames(league) {
  if (league !== 'NPB' && league !== 'KBO') return { league, teams: 0, games: 0 };

  const rows = db
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

  const teamGames = {};
  for (const g of rows) {
    const homeScore = Number(g.home_score);
    const awayScore = Number(g.away_score);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
    const homeWon = homeScore > awayScore;
    for (const [team, won, gf, ga] of [
      [g.home_team, homeWon, homeScore, awayScore],
      [g.away_team, !homeWon, awayScore, homeScore],
    ]) {
      if (!teamGames[team]) teamGames[team] = [];
      teamGames[team].push({ won, gf, ga, date: g.commence_time });
    }
  }

  const upsert = teamStatsUpsertStmt();
  const tx = db.transaction(() => {
    for (const [team, games] of Object.entries(teamGames)) {
      games.sort((a, b) => new Date(b.date) - new Date(a.date));
      const wins = games.filter((x) => x.won).length;
      const losses = games.length - wins;
      const last10 = games.slice(0, 10);
      const l10w = last10.filter((x) => x.won).length;
      const l10l = last10.length - l10w;
      const rs = games.reduce((s, x) => s + (x.gf || 0), 0);
      const ra = games.reduce((s, x) => s + (x.ga || 0), 0);
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
  return { league, teams: Object.keys(teamGames).length, games: rows.length };
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
  // 顯式傳 null（例如 standings API 失敗）時不可用預設 []，需正規化
  const mlbStandings = Array.isArray(options.mlbStandings) ? options.mlbStandings : [];
  const mlbScheduleGame = options.mlbScheduleGame ?? null;
  const eloOverride = options.eloOverride ?? null;

  let homeMlb = null;
  let awayMlb = null;
  let homePitcherStats = null;
  let awayPitcherStats = null;
  let homePitcherName = null;
  let awayPitcherName = null;
  let homeInjurySummary = { count: 0, names: [] };
  let awayInjurySummary = { count: 0, names: [] };
  let homeFallbackRating = 0.5;
  let awayFallbackRating = 0.5;
  let homeL10 = 'N/A';
  let awayL10 = 'N/A';
  let homePitcherEra = null;
  let awayPitcherEra = null;
  const venueName = getVenueName(mlbScheduleGame);
  const commenceTime = options.commenceTime ?? options.commence_time ?? null;

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
      const pitOptions = {
        cutoffDate: mlbScheduleGame.officialDate ?? null,
        excludeGamePk: mlbScheduleGame.gamePk ?? null,
      };
      const [homeStats, awayStats] = await Promise.all([
        getMlbPitcherPregameFeatures(pitchers.home?.id, commenceTime, pitOptions),
        getMlbPitcherPregameFeatures(pitchers.away?.id, commenceTime, pitOptions),
      ]);
      homePitcherStats = homeStats;
      awayPitcherStats = awayStats;
      homePitcherName = pitchers.home?.name || null;
      awayPitcherName = pitchers.away?.name || null;
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

    // KBO：官網當日先發 → 與 MLB 同形 homePitcherStats
    if (league === 'KBO' && config.enableKboPitchers !== false) {
      if (options.homePitcherStats || options.awayPitcherStats) {
        homePitcherStats = options.homePitcherStats ?? null;
        awayPitcherStats = options.awayPitcherStats ?? null;
        homePitcherName = options.homePitcherName ?? null;
        awayPitcherName = options.awayPitcherName ?? null;
      } else {
        const kboP = await resolveKboPitchersForGame(homeTeam, awayTeam, commenceTime, {
          dateYmd: options.kboDateYmd,
          scheduleRows: options.kboScheduleRows,
        });
        homePitcherStats = kboP.homePitcherStats;
        awayPitcherStats = kboP.awayPitcherStats;
        homePitcherName = kboP.homePitcherName;
        awayPitcherName = kboP.awayPitcherName;
      }
      homePitcherEra = homePitcherStats?.era ?? null;
      awayPitcherEra = awayPitcherStats?.era ?? null;
    }
  }

  // MLB 也讀 team_stats：近窗 OPS/WHIP/RPG；NPB/KBO 另含戰績與 Elo
  // 回測可傳 teamStatsOverride（開賽前 point-in-time，防洩漏）
  const homeStatsRow =
    options.teamStatsOverride?.[homeTeam] ?? getTeamStats(league, homeTeam);
  const awayStatsRow =
    options.teamStatsOverride?.[awayTeam] ?? getTeamStats(league, awayTeam);
  const strength = resolveNpbTeamStrength(homeStatsRow, awayStatsRow, league);
  const hasNpbStrength = strength.hasStrength;

  const totalsProjection = computeTotalsProjection({
    league,
    homeMlb,
    awayMlb,
    homePitcherStats,
    awayPitcherStats,
    homePitcherName,
    awayPitcherName,
    venueName,
    bookmakers,
    homeTeamStats: homeStatsRow,
    awayTeamStats: awayStatsRow,
    eloOverride,
  });

  // 明星缺陣：回測可傳 starAbsence（boxscore）；否則用傷兵名單姓名（初盤）
  let homeStar = { penalty: 0, hits: [] };
  let awayStar = { penalty: 0, hits: [] };
  if (config.enableStarImpact && league === 'MLB') {
    if (options.starAbsence) {
      homeStar = options.starAbsence.home || homeStar;
      awayStar = options.starAbsence.away || awayStar;
    } else {
      homeStar = starPenaltyFromInjuryNames(homeTeam, homeInjurySummary.names);
      awayStar = starPenaltyFromInjuryNames(awayTeam, awayInjurySummary.names);
    }
  }

  let matchupCore = null;
  let h2h;

  if (league === 'MLB') {
    // MatchupCore 只保留情境/熱門陷阱標籤；勝率 SSOT 一律以 H2h(泊松λ) 覆寫
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
      homeStarPenalty: homeStar.penalty,
      awayStarPenalty: awayStar.penalty,
      homeStarHits: homeStar.hits,
      awayStarHits: awayStar.hits,
      homeFallbackRating,
      awayFallbackRating,
      venueName,
      // 三盤口統一使用市場校準後的 scoring lambda（SSOT）
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
      homeStarPenalty: homeStar.penalty,
      awayStarPenalty: awayStar.penalty,
      homeStarHits: homeStar.hits,
      awayStarHits: awayStar.hits,
      homeFallbackRating,
      awayFallbackRating,
      venueName,
      homeRuns: totalsProjection.probabilityHomeRuns,
      awayRuns: totalsProjection.probabilityAwayRuns,
      hasNpbStrength,
      eloOverride,
    });
  }

  const coreFactors = h2h.factors || [];
  const totalsFactors = totalsProjection.factors.filter((f) => !coreFactors.some((c) => c === f));

  let dataQuality = matchupCore?.dataQuality ?? totalsProjection.dataQuality ?? 0.35;
  if (league === 'NPB' || league === 'KBO') {
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
    homePitcherName,
    awayPitcherName,
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
    starImpact: { home: homeStar, away: awayStar },
    venueName,
    parkFactor: totalsProjection.parkFactor ?? 1,
    totalsProjection,
    projectedTotal: totalsProjection.finalTotal,
    matchupCore,
    hasTeamStrength: hasNpbStrength || Boolean(homeMlb && awayMlb),
    dataQuality,
  };
}
