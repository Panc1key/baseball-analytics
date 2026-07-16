/**
 * 滾球分析引擎 v1.3
 * - 初盤 prior + 比分條件更新
 * - LiveDiscipline 硬閘（開局/0-0/平手凍結、市場衝突、<65% 禁強推）
 * - 對齊初盤立場：早段禁止翻案推出初盤已拒絕方向
 * - 膠著硬切獨贏；禁止對沖；無比分不推薦
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
import { loadPrematchStance } from './PrematchLiveGuard.js';
import {
  getMlbStandings,
  getMlbScheduleWindow,
  matchMlbTeam,
  extractLinescoreState,
} from './MlbStatsService.js';
import {
  fetchYahooNpbLiveScores,
  matchYahooScoreToGame,
} from './NpbYahooScores.js';
import {
  assessMarketPreference,
} from './MarketPreference.js';
import {
  fetchAllLeagueOdds,
  fetchAllLeagueScores,
} from './OddsApiClient.js';

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
  if (live.inningSource === 'mlb_linescore' || live.inningSource === 'yahoo_npb') q += 0.12;
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

function gatePick(game, pick, live, hasScore, dq, prematchStance = null) {
  const discipline = enforceLiveDiscipline(pick, {
    hasScore,
    dataQuality: dq,
    live,
    prematchStance,
  });
  const gated = applyDisciplineToCandidate(pick, discipline, config.baseStakeUnit);
  if (!gated) {
    console.warn(formatDisciplineRejectLog(game.id, discipline.rejectReasons));
    return null;
  }
  return gated;
}

function buildH2hLiveCandidates(game, markets, analysis, live, hasScore, prematchStance) {
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
    if (odds.price < (config.liveMinOdds ?? 1.55)) continue;

    const rawProb = side === 'home' ? live.homeWinProb : live.awayWinProb;
    const implied = decimalToImpliedProb(odds.price);
    const oppositeTeam = side === 'home' ? game.away_team : game.home_team;
    const oppositeOdds = markets.h2h?.[oppositeTeam]?.price;
    const marketProb = oppositeOdds
      ? removeVig(implied, decimalToImpliedProb(oppositeOdds)).fairA
      : implied;
    const calibrated = calibrateModelProb(rawProb, marketProb, maxEdge);
    if ((calibrated - marketProb) * 100 < minEdge) continue;

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
      edgeProb:
        Math.round((modelProb - (enriched.marketProb ?? enriched.impliedProb)) * 1000) / 10,
      offeredEdgeProb:
        Math.round((modelProb - enriched.impliedProb) * 1000) / 10,
      reasoning: buildLiveReasoning(game, live, hasScore, 'h2h', enriched),
    };

    const gated = gatePick(game, pick, live, hasScore, dq, prematchStance);
    if (!gated) continue;
    if (gated.ev < minEv || gated.edgeProb < minEdge) continue;
    options.push(gated);
  }

  options.sort((a, b) => b.ev - a.ev || b.edgeProb - a.edgeProb);
  return options.slice(0, 1);
}

function buildTotalsLiveCandidates(game, markets, analysis, live, hasScore, prematchStance) {
  if (!config.liveEnableTotals) return [];
  if (!hasScore) return [];

  const minEv = config.liveMinEvThreshold ?? config.minEvThreshold;
  const minEdge = config.liveTotalsMinEdgePct ?? 4;
  const underMinEdge = Math.max(minEdge, config.liveUnderMinEdgePct ?? 6.5);
  const maxEdge = config.liveMaxModelEdgePct ?? 0.045;
  const results = [];
  const dq = liveDataQuality(analysis, live, hasScore);

  for (const [, tot] of Object.entries(markets.totals || {})) {
    if (!tot?.price || tot.point == null) continue;
    if (tot.price < (config.liveMinOdds ?? 1.55)) continue;
    const isOver = tot.name === 'Over' || tot.name === '大';
    const sideMinEdge = isOver ? minEdge : underMinEdge;
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
    if ((calibrated - marketProb) * 100 < sideMinEdge) continue;

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
      edgeProb:
        Math.round((modelProb - (enriched.marketProb ?? enriched.impliedProb)) * 1000) / 10,
      offeredEdgeProb:
        Math.round((modelProb - enriched.impliedProb) * 1000) / 10,
      reasoning: buildLiveReasoning(game, live, hasScore, 'totals', enriched),
    };

    const gated = gatePick(game, pick, live, hasScore, dq, prematchStance);
    if (!gated) continue;
    if (gated.ev < minEv || gated.edgeProb < sideMinEdge) continue;
    results.push(gated);
  }

  results.sort((a, b) => b.ev - a.ev || b.edgeProb - a.edgeProb);
  return results.slice(0, 1);
}

function appendCalibrationNote(parts, pick) {
  const raw = pick?.rawModelProb;
  const cal = pick?.modelProb;
  if (raw == null || cal == null) return;
  const rawPct = raw * 100;
  const calPct = cal * 100;
  if (Math.abs(rawPct - calPct) >= 2) {
    parts.push(`原始 ${rawPct.toFixed(1)}% → 校準 ${calPct.toFixed(1)}%（貼市上限）`);
  }
}

function selectLivePicks(h2h, totals, preference) {
  const max = config.maxLivePicksPerGame ?? 1;
  // 膠著時硬切獨贏：只留大小，避免文案寫「優先大小」卻仍推獨贏
  const pool = preference?.preferTotals
    ? (totals.length ? [...totals] : [])
    : [...h2h, ...totals];
  if (!pool.length) return [];

  pool.sort((a, b) => {
    if (preference?.preferTotals) {
      const aTot = a.market === 'totals' ? 1 : 0;
      const bTot = b.market === 'totals' ? 1 : 0;
      if (aTot !== bTot) return bTot - aTot;
    }
    return (
      (b.ev ?? 0) * (b.dataQuality ?? 0.5) - (a.ev ?? 0) * (a.dataQuality ?? 0.5) ||
      (b.modelProb ?? 0) - (a.modelProb ?? 0)
    );
  });

  return pool.slice(0, Math.max(1, max));
}

function buildLiveReasoning(game, live, hasScore, market, pick) {
  const scoreTxt = hasScore
    ? `比分 ${live.awayScore}-${live.homeScore}（客-主）`
    : '比分待同步';
  const inningCore =
    live.inningLabel ||
    `約第 ${live.inningsPlayed} 局`;
  const parts = [
    `滾球 · ${inningCore} · 剩 ${live.inningsRemaining} 局`,
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
  appendCalibrationNote(parts, pick);
  return parts.filter(Boolean).join(' | ');
}

export function getLiveGames() {
  const grace = config.liveGameGraceHours ?? 6;
  return db
    .prepare(`
    SELECT * FROM games
    WHERE league IN (${BASEBALL_LEAGUE_SQL})
      AND completed = 0
      AND IFNULL(status, '') NOT IN ('completed', 'cancelled', 'postponed')
      AND datetime(commence_time) <= datetime('now')
      AND datetime(commence_time) > datetime('now', '-${grace} hours')
      AND raw_odds IS NOT NULL
    ORDER BY commence_time ASC
  `)
    .all();
}

/** 將 Yahoo 比分寫入 DB；完賽則標 completed=1 */
function persistYahooNpbScore(gameId, yahooHit) {
  if (!yahooHit || yahooHit.homeScore == null || yahooHit.awayScore == null) return false;
  const done =
    yahooHit.status === 'completed' ||
    yahooHit.linescore?.completed === true ||
    /終了/.test(yahooHit.inningLabel || '');
  if (done) {
    db.prepare(`
      UPDATE games
      SET home_score = ?, away_score = ?, status = 'completed', completed = 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(yahooHit.homeScore, yahooHit.awayScore, gameId);
  } else {
    db.prepare(`
      UPDATE games
      SET home_score = ?, away_score = ?, status = ?, completed = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      yahooHit.homeScore,
      yahooHit.awayScore,
      yahooHit.status || 'in_progress',
      gameId
    );
  }
  return done;
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
      getMlbScheduleWindow({ daysBack: 1, daysForward: 1 }),
    ]);
  } catch (err) {
    console.warn('[live] MLB 資料失敗:', err.message);
  }

  let yahooNpbScores = [];
  try {
    yahooNpbScores = await fetchYahooNpbLiveScores();
    console.log(`[live] Yahoo NPB 比分 ${yahooNpbScores.length} 場`);
  } catch (err) {
    console.warn('[live] Yahoo NPB 比分失敗:', err.message);
  }

  const liveGames = getLiveGames();
  const saved = [];
  let analyzed = 0;
  let rejected = 0;
  let linescoreHits = 0;
  let yahooScoreHits = 0;

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

    let linescore = mlbScheduleGame ? extractLinescoreState(mlbScheduleGame) : null;
    if (linescore) linescoreHits += 1;

    // NPB：Odds API 常無比分，用 Yahoo 補
    let yahooHit = null;
    if (game.league === 'NPB' && yahooNpbScores.length) {
      yahooHit = matchYahooScoreToGame(game, yahooNpbScores);
      if (yahooHit?.linescore?.inningsPlayed != null) {
        linescore = {
          ...yahooHit.linescore,
          homeScore: yahooHit.homeScore,
          awayScore: yahooHit.awayScore,
        };
        linescoreHits += 1;
      }
      if (yahooHit?.homeScore != null && yahooHit?.awayScore != null) {
        yahooScoreHits += 1;
        const finished = persistYahooNpbScore(game.id, yahooHit);
        if (finished) {
          analyzed += 1;
          continue;
        }
      }
    }

    // 已完賽（DB 狀態）不推滾球
    if (
      game.completed ||
      game.status === 'completed' ||
      linescore?.completed ||
      /終了/.test(linescore?.label || '')
    ) {
      if (!game.completed && (linescore?.completed || /終了/.test(linescore?.label || ''))) {
        db.prepare(`
          UPDATE games SET completed = 1, status = 'completed', updated_at = datetime('now') WHERE id = ?
        `).run(game.id);
      }
      analyzed += 1;
      continue;
    }

    const analysis = await analyzeMatchup(
      game.league,
      game.home_team,
      game.away_team,
      bookmakers,
      { mlbStandings, mlbScheduleGame }
    );

    const parsed = parseScores(game);
    const homeScore =
      linescore?.homeScore != null
        ? linescore.homeScore
        : yahooHit?.homeScore != null
          ? yahooHit.homeScore
          : parsed.homeScore;
    const awayScore =
      linescore?.awayScore != null
        ? linescore.awayScore
        : yahooHit?.awayScore != null
          ? yahooHit.awayScore
          : parsed.awayScore;
    const hasScore =
      (homeScore != null && awayScore != null && !Number.isNaN(Number(homeScore))) ||
      parsed.hasScore;

    const leagueAvgRuns = game.league === 'NPB' || game.league === 'KBO' ? 4.0 : 4.5;
    const priorHome =
      analysis.homeRuns != null && analysis.awayRuns != null ? analysis.homeRuns : leagueAvgRuns;
    const priorAway =
      analysis.homeRuns != null && analysis.awayRuns != null ? analysis.awayRuns : leagueAvgRuns;

    const live = projectLiveState({
      commenceTime: game.commence_time,
      homeScore: Number(homeScore) || 0,
      awayScore: Number(awayScore) || 0,
      homeRunsPrior: analysis.scoringHomeRuns ?? priorHome,
      awayRunsPrior: analysis.scoringAwayRuns ?? priorAway,
      priorHomeWin: analysis.homeWinProb ?? 0.5,
      linescore,
    });

    const markets = extractMarkets(bookmakers);
    if (!hasScore) {
      analyzed += 1;
      rejected += 1;
      continue;
    }

    const preference = assessMarketPreference(analysis, game, live);
    const prematchStance = loadPrematchStance(game.id);
    const h2h = buildH2hLiveCandidates(
      game,
      markets,
      analysis,
      live,
      hasScore,
      prematchStance
    );
    const totals = buildTotalsLiveCandidates(
      game,
      markets,
      analysis,
      live,
      hasScore,
      prematchStance
    );
    const picks = selectLivePicks(h2h, totals, preference);
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
        reasoning: [
          pick.reasoning,
          preference.preferTotals && preference.reason
            ? `選盤: ${preference.reason}`
            : null,
        ]
          .filter(Boolean)
          .join(' | '),
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
        inningSource: live.inningSource,
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
    JSON.stringify({
      liveGames: liveGames.length,
      rejectedNoScore: rejected,
      linescoreHits,
      yahooScoreHits,
      yahooNpbFetched: yahooNpbScores.length,
    }),
    analysisRunId
  );

  return {
    liveGames: liveGames.length,
    analyzed,
    rejectedNoScore: rejected,
    linescoreHits,
    yahooScoreHits,
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
      AND g.completed = 0
      AND IFNULL(g.status, '') NOT IN ('completed', 'cancelled', 'postponed')
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
      is_started: true,
    }));
}

export function getLiveStatus() {
  const games = getLiveGames();
  const recCount = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM recommendations r
       JOIN games g ON g.id = r.game_id
       WHERE r.phase = 'live'
         AND r.league IN (${BASEBALL_LEAGUE_SQL})
         AND g.completed = 0
         AND IFNULL(g.status, '') NOT IN ('completed', 'cancelled', 'postponed')`
    )
    .get()?.c;
  return {
    liveGameCount: games.length,
    recommendationCount: recCount ?? 0,
    leagues: Object.keys(LEAGUES),
    note: 'v1.2：MLB linescore + NPB Yahoo 比分補源 + LiveDiscipline',
    version: 'live-v1.2',
    scoreSources: {
      MLB: 'statsapi.mlb.com linescore',
      NPB: 'Yahoo Sportsnavi（Odds API 常無 NPB 滾球比分）',
      KBO: 'The Odds API scores',
    },
    thresholds: {
      minEv: config.liveMinEvThreshold,
      h2hMinEdgePct: config.liveH2hMinEdgePct,
      totalsMinEdgePct: config.liveTotalsMinEdgePct,
      strongProbFloor: config.liveStrongProbFloor,
      maxMarketGap: config.liveMaxMarketProbGap,
      enableTotals: config.liveEnableTotals !== false,
      maxStake: config.liveMaxStake,
      minOdds: config.liveMinOdds,
      primaryMinOdds: config.livePrimaryMinOdds,
      pollMinutes: config.livePollMinutes ?? 5,
    },
  };
}

/**
 * 滾球輕量同步：只更新比分 + 主盤賠率，再跑滾球分析（不重算初盤）
 */
export async function syncLiveDataLite() {
  // Odds API 額度可能已耗盡：比分/賠率失敗時仍繼續 Yahoo NPB
  let scoresData = { results: {}, quota: null };
  let oddsData = { results: {}, quota: null };
  try {
    scoresData = await fetchAllLeagueScores();
  } catch (err) {
    console.warn('[live-sync] Odds 比分整體失敗:', err.message);
  }
  try {
    oddsData = await fetchAllLeagueOdds();
  } catch (err) {
    console.warn('[live-sync] Odds 賠率整體失敗:', err.message);
  }

  let scoreUpdates = 0;
  for (const [code, { scores, error }] of Object.entries(scoresData.results || {})) {
    if (error) {
      console.warn(`[live-sync] ${code} 比分失敗:`, error);
      continue;
    }
    for (const game of scores || []) {
      const hsRaw = game.scores?.find((s) => s.name === game.home_team)?.score;
      const asRaw = game.scores?.find((s) => s.name === game.away_team)?.score;
      const hs = hsRaw != null && hsRaw !== '' ? parseInt(hsRaw, 10) : null;
      const as = asRaw != null && asRaw !== '' ? parseInt(asRaw, 10) : null;
      // Odds API 偶發：status=completed 但 completed 旗標為 false；勿覆寫成 completed=0
      const isDone =
        Boolean(game.completed) ||
        game.status === 'completed' ||
        /終了|final/i.test(String(game.status || ''));
      const gameStatus = isDone
        ? 'completed'
        : game.status || 'in_progress';

      if (isDone) {
        db.prepare(`
          INSERT INTO games (id, league, commence_time, home_team, away_team, completed, home_score, away_score, status, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            completed=1, home_score=?, away_score=?, status=?, updated_at=datetime('now')
        `).run(
          game.id, code, game.commence_time, game.home_team, game.away_team,
          hs, as, gameStatus, hs, as, gameStatus
        );
      } else {
        db.prepare(`
          INSERT INTO games (id, league, commence_time, home_team, away_team, completed, home_score, away_score, status, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            completed = CASE WHEN games.completed = 1 OR games.status = 'completed' THEN 1 ELSE 0 END,
            commence_time = excluded.commence_time,
            home_score = COALESCE(excluded.home_score, games.home_score),
            away_score = COALESCE(excluded.away_score, games.away_score),
            status = CASE
              WHEN games.completed = 1 OR games.status = 'completed' THEN 'completed'
              ELSE excluded.status
            END,
            updated_at = datetime('now')
        `).run(
          game.id, code, game.commence_time, game.home_team, game.away_team,
          hs, as, gameStatus
        );
        scoreUpdates += 1;
      }
    }
  }

  let oddsUpdates = 0;
  for (const [code, { games, error }] of Object.entries(oddsData.results || {})) {
    if (error) {
      console.warn(`[live-sync] ${code} 賠率失敗:`, error);
      continue;
    }
    for (const game of games || []) {
      db.prepare(`
        INSERT INTO games (id, league, commence_time, home_team, away_team, raw_odds, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          raw_odds = excluded.raw_odds,
          commence_time = excluded.commence_time,
          updated_at = datetime('now')
      `).run(
        game.id,
        code,
        game.commence_time,
        game.home_team,
        game.away_team,
        JSON.stringify(game.bookmakers || [])
      );
      oddsUpdates += 1;
    }
  }

  let yahooNpbMatched = 0;
  try {
    const yahooScores = await fetchYahooNpbLiveScores();
    const npbGames = db
      .prepare(
        `SELECT id, home_team, away_team FROM games WHERE league = 'NPB' AND completed = 0`
      )
      .all();
    for (const g of npbGames) {
      const hit = matchYahooScoreToGame(g, yahooScores);
      if (!hit || hit.homeScore == null || hit.awayScore == null) continue;
      persistYahooNpbScore(g.id, hit);
      yahooNpbMatched += 1;
      scoreUpdates += 1;
    }
  } catch (err) {
    console.warn('[live-sync] Yahoo NPB 比分失敗:', err.message);
  }

  return {
    scoreUpdates,
    oddsUpdates,
    yahooNpbMatched,
    oddsQuota: oddsData.quota,
    scoresQuota: scoresData.quota,
  };
}

export async function liveFullRefresh() {
  const sync = await syncLiveDataLite();
  const analysis = await runLiveAnalysis();
  return { sync, analysis, status: getLiveStatus() };
}
