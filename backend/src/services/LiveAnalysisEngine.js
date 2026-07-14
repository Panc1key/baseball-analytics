/**
 * 滾球分析引擎 v1.1
 * - 初盤 prior + 比分條件更新
 * - LiveDiscipline 硬閘（市場衝突 / <65% 禁強推 / 最壞風險）
 * - 禁止對沖；無比分不推薦
 */

import db from '../db/database.js';
import { randomUUID } from 'crypto';
import { config, BASEBALL_LEAGUE_SQL, LEAGUES } from '../config.js';
import { analyzeMatchup } from './TeamAnalyzer.js';
import { extractMarkets } from '../utils/odds.js';
import {
  calcEV,
  calcEVWithPush,
  decimalToImpliedProb,
  decimalToNetOdds,
  calibrateModelProb,
  removeVig,
} from '../utils/odds.js';
import { enrichCandidate } from './PickScorer.js';
import { classifyBetStrategy } from './BetStrategy.js';
import { enrichWithSuggestedStake } from './StakeSizer.js';
import {
  projectLiveState,
  liveTotalDistribution,
} from '../models/LiveScoreModel.js';
import {
  enforceLiveDiscipline,
  applyDisciplineToCandidate,
  formatDisciplineRejectLog,
} from './LiveDiscipline.js';
import {
  getMlbStandings,
  getMlbScheduleRange,
  matchMlbTeam,
} from './MlbStatsService.js';

function clearLiveRecommendations() {
  db.prepare(
    `DELETE FROM recommendations WHERE league IN (${BASEBALL_LEAGUE_SQL}) AND phase = 'live'`
  ).run();
}

function saveLiveRec(rec) {
  const betStrategy =
    rec.betStrategy ??
    classifyBetStrategy(
      {
        tier: rec.tier,
        market: rec.market,
        league: rec.league,
        ev: rec.ev,
        edge_prob: rec.edgeProb,
        model_prob: rec.modelProb,
        odds_decimal: rec.oddsDecimal,
        data_quality: rec.dataQuality,
        pick_rank: rec.pickRank,
      },
      { pickRank: rec.pickRank }
    );

  const recommendationId = db
    .prepare(`
    INSERT INTO recommendations
      (game_id, league, market, pick, line, odds_decimal, bookmaker, model_prob,
       raw_model_prob, market_prob, calibrated_prob, implied_prob, push_prob,
       ev, confidence, reasoning, tier, score, edge_prob, data_quality, market_group,
       bet_strategy, pick_rank, actionable_score, suggested_stake, stake_multiplier,
       phase, model_version, analysis_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?)
  `)
    .run(
      rec.gameId,
      rec.league,
      rec.market,
      rec.pick,
      rec.line,
      rec.oddsDecimal,
      rec.bookmaker,
      rec.modelProb,
      rec.rawModelProb ?? rec.modelProb,
      rec.marketProb ?? rec.impliedProb,
      rec.calibratedProb ?? rec.modelProb,
      rec.impliedProb,
      rec.pushProb ?? 0,
      rec.ev,
      rec.confidence,
      rec.reasoning,
      rec.tier,
      rec.score,
      rec.edgeProb,
      rec.dataQuality,
      'live',
      betStrategy,
      rec.pickRank ?? 1,
      rec.actionableScore ?? null,
      rec.suggestedStake ?? null,
      rec.stakeMultiplier ?? null,
      config.modelVersion,
      rec.analysisRunId
    ).lastInsertRowid;

  db.prepare(`
    INSERT INTO recommendation_snapshots
      (analysis_run_id, recommendation_id, game_id, league, phase, market, pick, line,
       odds_decimal, bookmaker, raw_model_prob, market_prob, calibrated_prob,
       implied_prob, push_prob, ev, confidence, tier, score, edge_prob, data_quality,
       bet_strategy, pick_rank, suggested_stake, reasoning, model_version)
    VALUES (?, ?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rec.analysisRunId,
    recommendationId,
    rec.gameId,
    rec.league,
    rec.market,
    rec.pick,
    rec.line,
    rec.oddsDecimal,
    rec.bookmaker,
    rec.rawModelProb ?? rec.modelProb,
    rec.marketProb ?? rec.impliedProb,
    rec.calibratedProb ?? rec.modelProb,
    rec.impliedProb,
    rec.pushProb ?? 0,
    rec.ev,
    rec.confidence,
    rec.tier,
    rec.score,
    rec.edgeProb,
    rec.dataQuality,
    betStrategy,
    rec.pickRank ?? 1,
    rec.suggestedStake ?? null,
    rec.reasoning,
    config.modelVersion
  );

  return recommendationId;
}

function parseScores(game) {
  const hs = game.home_score;
  const as = game.away_score;
  if (hs != null && as != null) {
    return { homeScore: Number(hs), awayScore: Number(as), hasScore: true };
  }
  return { homeScore: 0, awayScore: 0, hasScore: false };
}

function liveDataQuality(analysis, live, hasScore) {
  let q = 0.2;
  if (analysis?.homeRuns != null && analysis?.awayRuns != null) q += 0.25;
  if (hasScore) q += 0.25;
  if (live.inningsRemaining <= 6) q += 0.1;
  if (analysis?.homeMlb && analysis?.awayMlb) q += 0.1;
  return Math.min(1, q);
}

function applyLiveStakeCap(rec) {
  const haircut = config.liveStakeHaircut ?? 0.7;
  const cap = config.liveMaxStake ?? 8;
  let stake = rec.suggestedStake ?? rec.suggested_stake;
  if (stake == null) return rec;
  stake = Math.min(cap, Math.max(1, Math.round(stake * haircut)));
  return {
    ...rec,
    suggestedStake: stake,
    suggested_stake: stake,
    stakeMultiplier: Math.round((rec.stakeMultiplier ?? 1) * haircut * 100) / 100,
  };
}

function gatePick(game, pick, live, hasScore, dq) {
  const discipline = enforceLiveDiscipline(pick, { hasScore, dataQuality: dq, live });
  const gated = applyDisciplineToCandidate(pick, discipline, config.baseStakeUnit);
  if (!gated) {
    console.warn(formatDisciplineRejectLog(game.id, discipline.rejectReasons));
    return null;
  }
  return gated;
}

function buildH2hLiveCandidates(game, markets, analysis, live, hasScore) {
  const minEv = config.liveMinEvThreshold ?? config.minEvThreshold;
  const minEdge = config.liveH2hMinEdgePct ?? 2.5;
  const maxEdge = config.liveMaxModelEdgePct ?? 0.045;
  const options = [];
  const dq = liveDataQuality(analysis, live, hasScore);

  for (const [team, side] of [
    [game.home_team, 'home'],
    [game.away_team, 'away'],
  ]) {
    const odds = markets.h2h?.[team];
    if (!odds?.price) continue;

    const rawProb = side === 'home' ? live.homeWinProb : live.awayWinProb;
    const implied = decimalToImpliedProb(odds.price);
    const oppositeTeam = side === 'home' ? game.away_team : game.home_team;
    const oppositeOdds = markets.h2h?.[oppositeTeam]?.price;
    const marketProb = oppositeOdds
      ? removeVig(implied, decimalToImpliedProb(oppositeOdds)).fairA
      : implied;
    const calibrated = calibrateModelProb(rawProb, marketProb, maxEdge);
    if ((calibrated - implied) * 100 < minEdge) continue;

    const enriched = enrichCandidate(
      {
        market: 'h2h',
        marketGroup: 'live',
        pick: team,
        line: null,
        odds,
        oddsDecimal: odds.price,
        modelProb: calibrated,
        rawModelProb: rawProb,
        marketProb,
        probabilityCalibrated: true,
        ev: calcEV(rawProb, decimalToNetOdds(odds.price)),
        confidence: Math.abs(live.homeWinProb - 0.5) * 2,
        structuralOk: hasScore,
        dataQuality: dq,
      },
      {
        ...analysis,
        homeWinProb: live.homeWinProb,
        awayWinProb: live.awayWinProb,
        dataQuality: dq,
      },
      game.league,
      'h2h'
    );
    if (!enriched.tier) continue;

    const modelProb = enriched.modelProb;
    const pick = {
      ...enriched,
      modelProb,
      ev: calcEV(modelProb, decimalToNetOdds(enriched.oddsDecimal)),
      edgeProb: Math.round((modelProb - enriched.impliedProb) * 1000) / 10,
      reasoning: buildLiveReasoning(game, live, hasScore, 'h2h', enriched),
    };

    const gated = gatePick(game, pick, live, hasScore, dq);
    if (!gated) continue;
    if (gated.ev < minEv || gated.edgeProb < minEdge) continue;
    options.push(gated);
  }

  options.sort((a, b) => b.ev - a.ev || b.edgeProb - a.edgeProb);
  return options.slice(0, 1);
}

function buildTotalsLiveCandidates(game, markets, analysis, live, hasScore) {
  if (!config.liveEnableTotals) return [];
  if (!hasScore) return [];

  const minEv = config.liveMinEvThreshold ?? config.minEvThreshold;
  const minEdge = config.liveTotalsMinEdgePct ?? 4;
  const maxEdge = config.liveMaxModelEdgePct ?? 0.045;
  const results = [];
  const dq = liveDataQuality(analysis, live, hasScore);

  for (const [, tot] of Object.entries(markets.totals || {})) {
    if (!tot?.price || tot.point == null) continue;
    const isOver = tot.name === 'Over' || tot.name === '大';
    const distribution = liveTotalDistribution({
      homeScore: live.homeScore,
      awayScore: live.awayScore,
      homeLambdaRem: live.homeLambdaRem,
      awayLambdaRem: live.awayLambdaRem,
      line: tot.point,
    });
    const pushProb = distribution.pushProb ?? 0;
    const decisiveMass = Math.max(1e-9, 1 - pushProb);
    const rawProb = isOver
      ? distribution.overProb / decisiveMass
      : distribution.underProb / decisiveMass;
    const implied = decimalToImpliedProb(tot.price);
    const opposite = markets.totals?.[
      `${isOver ? 'Under' : 'Over'}_${tot.point}`
    ];
    const marketProb = opposite?.price
      ? removeVig(implied, decimalToImpliedProb(opposite.price)).fairA
      : implied;
    const calibrated = calibrateModelProb(rawProb, marketProb, maxEdge);
    if ((calibrated - implied) * 100 < minEdge) continue;

    const pickLabel = isOver ? `大 ${tot.point}` : `小 ${tot.point}`;
    const enriched = enrichCandidate(
      {
        market: 'totals',
        marketGroup: 'live',
        pick: pickLabel,
        line: tot.point,
        odds: tot,
        oddsDecimal: tot.price,
        modelProb: calibrated,
        rawModelProb: rawProb,
        marketProb,
        pushProb,
        probabilityCalibrated: true,
        ev: calcEVWithPush(
          calibrated * (1 - pushProb),
          pushProb,
          decimalToNetOdds(tot.price)
        ),
        confidence: Math.abs(rawProb - 0.5) * 2,
        structuralOk: true,
        projectedTotal: live.expectedFinalTotal,
        marketLine: tot.point,
        dataQuality: dq,
      },
      {
        ...analysis,
        homeWinProb: live.homeWinProb,
        awayWinProb: live.awayWinProb,
        dataQuality: dq,
      },
      game.league,
      'totals'
    );
    if (!enriched.tier) continue;

    const modelProb = enriched.modelProb;
    const pick = {
      ...enriched,
      modelProb,
      ev: calcEVWithPush(
        modelProb * (1 - pushProb),
        pushProb,
        decimalToNetOdds(enriched.oddsDecimal)
      ),
      edgeProb: Math.round((modelProb - enriched.impliedProb) * 1000) / 10,
      reasoning: buildLiveReasoning(game, live, hasScore, 'totals', enriched),
    };

    const gated = gatePick(game, pick, live, hasScore, dq);
    if (!gated) continue;
    if (gated.ev < minEv || gated.edgeProb < minEdge) continue;
    results.push(gated);
  }

  results.sort((a, b) => b.ev - a.ev || b.edgeProb - a.edgeProb);
  return results.slice(0, 1);
}

function buildLiveReasoning(game, live, hasScore, market, pick) {
  const scoreTxt = hasScore
    ? `比分 ${live.awayScore}-${live.homeScore}（客-主）`
    : '比分待同步';
  const parts = [
    `滾球 · 約第 ${live.inningsPlayed} 局 · 剩 ${live.inningsRemaining} 局`,
    scoreTxt,
    live.slowdownFactor != null && live.slowdownFactor < 0.99
      ? `節奏折減 ×${live.slowdownFactor}${live.isBlowout ? '（一邊倒降速）' : ''}`
      : null,
    `剩餘期望 主${live.homeLambdaRem}/客${live.awayLambdaRem}`,
    market === 'h2h'
      ? `條件勝率 主${(live.homeWinProb * 100).toFixed(0)}% / 客${(live.awayWinProb * 100).toFixed(0)}%`
      : `預估終場總分 ${live.expectedFinalTotal}`,
    pick?.edgeProb != null
      ? `優勢 ${pick.edgeProb > 0 ? '+' : ''}${Number(pick.edgeProb).toFixed(1)}%`
      : null,
  ];
  return parts.filter(Boolean).join(' | ');
}

export function getLiveGames() {
  const grace = config.liveGameGraceHours ?? 6;
  return db
    .prepare(`
    SELECT * FROM games
    WHERE league IN (${BASEBALL_LEAGUE_SQL})
      AND completed = 0
      AND datetime(commence_time) <= datetime('now')
      AND datetime(commence_time) > datetime('now', '-${grace} hours')
      AND raw_odds IS NOT NULL
    ORDER BY commence_time ASC
  `)
    .all();
}

export async function runLiveAnalysis() {
  clearLiveRecommendations();
  const analysisRunId = randomUUID();
  db.prepare(`
    INSERT INTO analysis_runs (id, model_version, phase, started_at)
    VALUES (?, ?, 'live', datetime('now'))
  `).run(analysisRunId, config.modelVersion);

  let mlbStandings = [];
  let mlbSchedule = [];
  try {
    [mlbStandings, mlbSchedule] = await Promise.all([
      getMlbStandings(),
      getMlbScheduleRange(1),
    ]);
  } catch (err) {
    console.warn('[live] MLB 資料失敗:', err.message);
  }

  const liveGames = getLiveGames();
  const saved = [];
  let analyzed = 0;
  let rejected = 0;

  for (const game of liveGames) {
    let bookmakers = [];
    try {
      bookmakers = JSON.parse(game.raw_odds || '[]');
    } catch {
      continue;
    }
    if (!bookmakers.length) continue;

    const mlbScheduleGame =
      game.league === 'MLB'
        ? mlbSchedule.find((g) => {
            const home = g.teams?.home?.team?.name;
            const away = g.teams?.away?.team?.name;
            if (!home || !away) return false;
            return (
              matchMlbTeam(game.home_team, [{ name: home }]) &&
              matchMlbTeam(game.away_team, [{ name: away }])
            );
          })
        : null;

    const analysis = await analyzeMatchup(
      game.league,
      game.home_team,
      game.away_team,
      bookmakers,
      { mlbStandings, mlbScheduleGame }
    );

    const { homeScore, awayScore, hasScore } = parseScores(game);
    const priorHome =
      analysis.homeRuns != null && analysis.awayRuns != null ? analysis.homeRuns : 4.5;
    const priorAway =
      analysis.homeRuns != null && analysis.awayRuns != null ? analysis.awayRuns : 4.5;

    const live = projectLiveState({
      commenceTime: game.commence_time,
      homeScore,
      awayScore,
      homeRunsPrior: priorHome,
      awayRunsPrior: priorAway,
      priorHomeWin: analysis.homeWinProb ?? 0.5,
    });

    const markets = extractMarkets(bookmakers);
    if (!hasScore) {
      analyzed += 1;
      rejected += 1;
      continue;
    }

    const h2h = buildH2hLiveCandidates(game, markets, analysis, live, hasScore);
    const totals = buildTotalsLiveCandidates(game, markets, analysis, live, hasScore);
    const picks = [...h2h, ...totals];
    analyzed += 1;

    let rank = 0;
    for (const pick of picks) {
      rank += 1;
      let withStake = enrichWithSuggestedStake({
        ...pick,
        pickRank: rank,
        pick_rank: rank,
        bet_strategy: null,
      });
      // 保留紀律層文字與注碼上限（StakeSizer 可能覆寫注碼）
      withStake = applyLiveStakeCap({
        ...withStake,
        tier: pick.tier,
        reasoning: pick.reasoning,
        confidenceLabel: pick.confidenceLabel,
        worstCaseLoseProb: pick.worstCaseLoseProb,
      });
      const actionable = (withStake.score ?? 0) + (withStake.ev ?? 0) * 45;

      saveLiveRec({
        gameId: game.id,
        league: game.league,
        market: withStake.market,
        pick: withStake.pick,
        line: withStake.line ?? null,
        oddsDecimal: withStake.oddsDecimal,
        bookmaker: withStake.odds?.bookmaker || withStake.bookmaker || null,
        modelProb: withStake.modelProb,
        rawModelProb: withStake.rawModelProb ?? withStake.modelProb,
        marketProb: withStake.marketProb ?? withStake.impliedProb,
        calibratedProb: withStake.calibratedProb ?? withStake.modelProb,
        impliedProb: withStake.impliedProb,
        pushProb: withStake.pushProb ?? 0,
        ev: withStake.ev,
        confidence: withStake.confidence ?? Math.abs(live.homeWinProb - 0.5) * 2,
        reasoning: withStake.reasoning,
        tier: withStake.tier,
        score: withStake.score,
        edgeProb: withStake.edgeProb,
        dataQuality: withStake.dataQuality,
        pickRank: rank,
        actionableScore: Math.round(actionable * 10) / 10,
        suggestedStake: withStake.suggestedStake,
        stakeMultiplier: withStake.stakeMultiplier,
        betStrategy: classifyBetStrategy({
          ...withStake,
          pick_rank: rank,
        }),
        analysisRunId,
      });

      saved.push({
        gameId: game.id,
        market: withStake.market,
        pick: withStake.pick,
        ev: withStake.ev,
        tier: withStake.tier,
        liveScore: `${live.awayScore}-${live.homeScore}`,
        inningsPlayed: live.inningsPlayed,
        confidenceLabel: withStake.confidenceLabel,
      });
    }
  }

  db.prepare(`
    UPDATE analysis_runs
    SET completed_at = datetime('now'), recommendation_count = ?, metadata_json = ?
    WHERE id = ?
  `).run(
    saved.length,
    JSON.stringify({ liveGames: liveGames.length, rejectedNoScore: rejected }),
    analysisRunId
  );

  return {
    liveGames: liveGames.length,
    analyzed,
    rejectedNoScore: rejected,
    recommendations: saved.length,
    analysisRunId,
    modelVersion: config.modelVersion,
    samples: saved.slice(0, 8),
  };
}

export function getLiveRecommendations(filters = {}) {
  const { league, minEv = 0, limit = 60 } = filters;
  let sql = `
    SELECT r.*, g.home_team, g.away_team, g.commence_time, g.home_score, g.away_score, g.completed
    FROM recommendations r
    JOIN games g ON g.id = r.game_id
    WHERE r.phase = 'live'
      AND r.league IN (${BASEBALL_LEAGUE_SQL})
      AND r.ev >= ?
  `;
  const params = [minEv];
  if (league) {
    sql += ' AND r.league = ?';
    params.push(league);
  }
  sql += ' ORDER BY r.ev DESC, r.score DESC LIMIT ?';
  params.push(limit);

  return db
    .prepare(sql)
    .all(...params)
    .map((r) => ({
      ...r,
      is_live: true,
      phase: 'live',
      rank_label:
        r.pick_rank === 1
          ? '主推'
          : r.pick_rank === 2
            ? '次推'
            : r.pick_rank
              ? `第${r.pick_rank}推`
              : null,
      live_score:
        r.home_score != null && r.away_score != null
          ? `${r.away_score}-${r.home_score}`
          : null,
    }));
}

export function getLiveStatus() {
  const games = getLiveGames();
  const recCount = db
    .prepare(
      `SELECT COUNT(*) AS c FROM recommendations WHERE phase = 'live' AND league IN (${BASEBALL_LEAGUE_SQL})`
    )
    .get()?.c;
  return {
    liveGameCount: games.length,
    recommendationCount: recCount ?? 0,
    leagues: Object.keys(LEAGUES),
    note: 'v1.1：一邊倒降速 + 主場殘差 + LiveDiscipline 硬閘（市場衝突/<65%禁強推/最壞風險）',
    thresholds: {
      minEv: config.liveMinEvThreshold,
      h2hMinEdgePct: config.liveH2hMinEdgePct,
      totalsMinEdgePct: config.liveTotalsMinEdgePct,
      strongProbFloor: config.liveStrongProbFloor,
      maxMarketGap: config.liveMaxMarketProbGap,
      enableTotals: config.liveEnableTotals !== false,
      maxStake: config.liveMaxStake,
    },
  };
}

export async function liveFullRefresh() {
  const analysis = await runLiveAnalysis();
  return { analysis, status: getLiveStatus() };
}
