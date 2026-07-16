import { config } from '../config.js';
import {
  calcEV,
  calcEVWithPush,
  decimalToImpliedProb,
  decimalToNetOdds,
  estimateCoverProbDetails,
} from '../utils/odds.js';
import { enrichCandidate } from './PickScorer.js';
import { poissonCoverProb } from '../models/GameScoreModel.js';
import { pickPropCandidates } from './PlayerPropAnalyzer.js';
import {
  computeTotalsProjection,
  buildTotalCandidates,
} from './TotalsModel.js';
import { computeActionableScore } from './EdgeSignals.js';
import { assignBetStrategies } from './BetStrategy.js';
import { enrichWithSuggestedStake } from './StakeSizer.js';
import { qualifiesH2hSide } from './MatchupCore.js';
import { assessMarketPreference } from './MarketPreference.js';

function scoringLambdas(analysis) {
  return {
    homeRuns: analysis.scoringHomeRuns ?? analysis.homeRuns,
    awayRuns: analysis.scoringAwayRuns ?? analysis.awayRuns,
  };
}

/** 保存完整主盤候選宇宙；推薦門檻之外的候選也保留供 walk-forward 回測。 */
function buildDecisionUniverse(game, markets, analysis, bookmakers = []) {
  const decisions = [];
  const isNpbFamily = game.league === 'NPB' || game.league === 'KBO';

  for (const [team, side] of [
    [game.home_team, 'home'],
    [game.away_team, 'away'],
  ]) {
    const odds = markets.h2h?.[team];
    if (!odds?.price) continue;
    const modelProb = side === 'home' ? analysis.homeWinProb : analysis.awayWinProb;
    const rawModelProb =
      side === 'home'
        ? (analysis.rawModelHomeProb ?? modelProb)
        : (analysis.rawModelAwayProb ?? modelProb);
    const marketProb =
      side === 'home' ? analysis.marketHomeProb : analysis.marketAwayProb;
    const impliedProb = decimalToImpliedProb(odds.price);
    const ev = calcEV(modelProb, decimalToNetOdds(odds.price));
    const edgeProb = (modelProb - (marketProb ?? impliedProb)) * 100;
    const rejectReasons = [];
    if (odds.price < (config.prematchMinOdds ?? 1.7)) rejectReasons.push('賠率過低');
    if (isNpbFamily && analysis.hasTeamStrength !== true) rejectReasons.push('隊力不足');
    if (ev < config.minEvThreshold) rejectReasons.push('EV不足');
    decisions.push({
      market: 'h2h',
      pick: team,
      line: null,
      oddsDecimal: odds.price,
      rawModelProb,
      marketProb,
      modelProb,
      impliedProb,
      ev,
      edgeProb,
      dataQuality: analysis.dataQuality,
      eligible: rejectReasons.length === 0,
      rejectReason: rejectReasons.join('；') || null,
    });
  }

  const { homeRuns, awayRuns } = scoringLambdas(analysis);
  for (const spread of Object.values(markets.spreads || {})) {
    if (!spread?.price || spread.point == null) continue;
    const isHome = spread.name === game.home_team;
    const teamWinProb = isHome ? analysis.homeWinProb : analysis.awayWinProb;
    const cover = estimateCoverProbDetails(teamWinProb, spread.point, {
      pitcherEdge: analysis.pitcherEdge ?? 0,
      pickIsHome: isHome,
      oppWinProb: isHome ? analysis.awayWinProb : analysis.homeWinProb,
      homeRuns,
      awayRuns,
      bookmakers,
      teamName: spread.name,
    });
    const impliedProb = decimalToImpliedProb(spread.price);
    const modelProb = cover.coverProb;
    const ev = calcEVWithPush(
      modelProb * (1 - cover.pushProb),
      cover.pushProb,
      decimalToNetOdds(spread.price)
    );
    const edgeProb = (modelProb - (cover.marketProb ?? impliedProb)) * 100;
    const rejectReasons = [];
    if (!isSpreadAlignedWithModel(spread, game, analysis)) rejectReasons.push('方向不符');
    if (spread.price < (config.prematchMinOdds ?? 1.7)) rejectReasons.push('賠率過低');
    if (modelProb < config.spreadsMinCoverProb) rejectReasons.push('蓋盤率不足');
    if (edgeProb < config.spreadsMinEdgePct) rejectReasons.push('優勢不足');
    if (ev < config.minEvThreshold) rejectReasons.push('EV不足');
    decisions.push({
      market: 'spreads',
      pick: formatSpreadPick(spread.name, spread.point),
      line: spread.point,
      oddsDecimal: spread.price,
      rawModelProb: cover.rawModelProb,
      marketProb: cover.marketProb,
      modelProb,
      impliedProb,
      ev,
      edgeProb,
      dataQuality: analysis.dataQuality,
      eligible: rejectReasons.length === 0,
      rejectReason: rejectReasons.join('；') || null,
    });
  }

  for (const total of buildTotalCandidates(
    markets,
    analysis.totalsProjection,
    game.league
  )) {
    const rejectReasons = [];
    if (!total.structuralOk) rejectReasons.push(total.skipReason || '結構不符');
    if (total.ev < (config.totalsMinEv ?? config.minEvThreshold)) {
      rejectReasons.push('EV不足');
    }
    decisions.push({
      ...total,
      edgeProb: total.edgePct,
      dataQuality: analysis.totalsProjection?.dataQuality ?? analysis.dataQuality,
      eligible: rejectReasons.length === 0,
      rejectReason: rejectReasons.join('；') || null,
    });
  }

  return decisions;
}

export function formatSpreadPick(team, point) {
  return `${team} ${point > 0 ? '+' : ''}${point}`;
}

export function formatTotalPick(name, point) {
  const label = name === 'Over' ? '大' : '小';
  return `${label} ${point}`;
}

export function rankLabel(rank, tier = null) {
  if (tier === 'sample' && rank === 1) return '樣本';
  if (rank === 1) return '主推';
  if (rank === 2) return '次推';
  return `第${rank}推`;
}

function sampleMarketPriority(preferTotals) {
  return preferTotals
    ? { totals: 0, h2h: 1, spreads: 2 }
    : { h2h: 0, spreads: 1, totals: 2 };
}

function rankSampleDecisions(pool, preference) {
  const order = sampleMarketPriority(preference.preferTotals);
  return [...pool].sort((a, b) => {
    const eligA = a.eligible ? 0 : 1;
    const eligB = b.eligible ? 0 : 1;
    if (eligA !== eligB) return eligA - eligB;
    const mA = order[a.market] ?? 9;
    const mB = order[b.market] ?? 9;
    if (mA !== mB) return mA - mB;
    return b.ev - a.ev || (b.edgeProb ?? 0) - (a.edgeProb ?? 0);
  });
}

function pickBestSampleDecision(decisionUniverse, preference) {
  const minOdds = config.sampleMinOdds ?? config.prematchMinOdds ?? 1.7;
  const minEv = config.sampleMinEv ?? config.minEvThreshold ?? 0.03;
  const basePool = (decisionUniverse || []).filter((d) => d.oddsDecimal >= minOdds);
  if (!basePool.length) return null;

  const strictPool = basePool.filter((d) => d.ev >= minEv && (d.edgeProb ?? 0) > 0);
  let ranked = rankSampleDecisions(strictPool, preference);
  if (!ranked.length) {
    ranked = rankSampleDecisions(
      basePool.filter((d) => d.ev >= 0),
      preference
    );
  }
  if (!ranked.length) ranked = rankSampleDecisions(basePool, preference);
  return ranked[0] || null;
}

function buildSampleFallbackPick(game, analysis, decision, preference, baseReasoning, pickContext) {
  const league = game.league;
  const enriched = enrichCandidate(
    {
      market: decision.market,
      marketGroup: 'main',
      pick: decision.pick,
      line: decision.line ?? null,
      odds: { price: decision.oddsDecimal },
      oddsDecimal: decision.oddsDecimal,
      modelProb: decision.modelProb,
      rawModelProb: decision.rawModelProb,
      marketProb: decision.marketProb,
      ev: decision.ev,
      confidence: analysis.confidence,
      structuralOk: true,
      dataQuality: decision.dataQuality ?? analysis.dataQuality,
      probabilityCalibrated: decision.marketProb != null,
      edgePct: decision.edgeProb,
    },
    analysis,
    league,
    decision.market
  );

  const { score: actionableScore, signals } = computeActionableScore(enriched, pickContext);
  const prefNote = preference.preferTotals && preference.reason ? `選盤: ${preference.reason}` : null;
  const sampleNote = decision.rejectReason ? `樣本候選（${decision.rejectReason}）` : '樣本累積';

  return {
    ...enriched,
    league,
    hasTeamStrength: analysis.hasTeamStrength,
    tier: 'sample',
    score: Math.min(enriched.score ?? 0, (config.recommendWatchScore ?? 50) - 5),
    actionableScore,
    edgeSignals: [...(signals || []), '樣本累積'],
    pickRank: 1,
    isPrimary: false,
    rankLabel: rankLabel(1, 'sample'),
    sampleFallback: true,
    reasoning: [buildPickReasoning({ ...enriched, tier: 'sample' }, baseReasoning), prefNote, sampleNote]
      .filter(Boolean)
      .join(' | '),
    bookmaker: enriched.odds?.bookmaker || enriched.bookmaker,
    marketPreference: preference.preferTotals ? 'totals_first' : 'default',
  };
}

function buildSampleFallbackResults(
  game,
  analysis,
  preference,
  decisionUniverse,
  baseReasoning,
  pickContext
) {
  const decision = pickBestSampleDecision(decisionUniverse, preference);
  if (!decision) return [];
  return [buildSampleFallbackPick(game, analysis, decision, preference, baseReasoning, pickContext)];
}

/** 讓分方向：MatchupCore 熱門陷阱 + 本地 Poisson 結構門控 */
export function isSpreadAlignedWithModel(spread, game, analysis) {
  const isHome = spread.name === game.home_team;
  const teamWinProb = isHome ? analysis.homeWinProb : analysis.awayWinProb;
  const oppWinProb = isHome ? analysis.awayWinProb : analysis.homeWinProb;
  const side = isHome ? 'home' : 'away';
  const matchup = analysis.matchupCore;
  const pitcherEdge = analysis.pitcherEdge ?? 0;
  const pickPitcherEdge = isHome ? pitcherEdge : -pitcherEdge;
  const modelDeficit = oppWinProb - teamWinProb;

  if (spread.point > 0) {
    if (matchup?.edges?.favoriteTrap && matchup.edges.bestSide === side) return true;

    const edge = matchup?.edges?.[side];
    if (edge?.ev >= config.minEvThreshold && edge?.edgePct >= config.h2hMinEdgePct) {
      if (teamWinProb >= config.spreadsMinDogWinProb) return true;
    }

    if (teamWinProb < config.spreadsMinDogWinProb) return false;
    if (modelDeficit > config.spreadsMaxModelDeficit) return false;
    if (pickPitcherEdge < -config.spreadsMaxPitcherDeficit) return false;

    if (spread.point >= 1.5) {
      if (modelDeficit > 0.015 && teamWinProb < 0.49) return false;
      if (teamWinProb < oppWinProb - 0.01) return false;

      const { homeRuns, awayRuns } = scoringLambdas(analysis);
      if (homeRuns != null && awayRuns != null) {
        const expectedMargin = isHome ? homeRuns - awayRuns : awayRuns - homeRuns;
        if (expectedMargin < (config.spreadsMinExpectedMargin ?? -0.35)) return false;

        const poissonCover = poissonCoverProb(homeRuns, awayRuns, spread.point, isHome);
        if (poissonCover < config.spreadsMinCoverProb) return false;
      } else if (config.spreadsBlockPlus15WithoutScoreModel !== false) {
        // NPB/KBO 無得分模型時，+1.5 啟發式極度樂觀 — 僅允許近似均勢且不得作純弱隊受讓
        if (teamWinProb < 0.5) return false;
        if (Math.abs(teamWinProb - oppWinProb) > 0.04) return false;
      }
    }

    return teamWinProb >= oppWinProb - config.spreadsMaxModelDeficit || teamWinProb >= 0.38;
  }

  if (spread.point < 0) {
    return (
      teamWinProb > oppWinProb &&
      teamWinProb >= 0.54 &&
      pickPitcherEdge >= -0.015
    );
  }

  return false;
}

function pickH2hCandidate(game, markets, analysis) {
  const options = [];
  const matchup = analysis.matchupCore;
  const isNpbFamily = game.league === 'NPB' || game.league === 'KBO';

  if (isNpbFamily && analysis.hasTeamStrength === false) {
    return null;
  }

  for (const [team, side] of [
    [game.home_team, 'home'],
    [game.away_team, 'away'],
  ]) {
    const odds = markets.h2h[team];
    if (!odds?.price) continue;
    if (odds.price < (config.prematchMinOdds ?? 1.7)) continue;

    const modelProb = side === 'home' ? analysis.homeWinProb : analysis.awayWinProb;
    const oppProb = side === 'home' ? analysis.awayWinProb : analysis.homeWinProb;
    const rawModelProb =
      side === 'home'
        ? (analysis.rawModelHomeProb ?? modelProb)
        : (analysis.rawModelAwayProb ?? modelProb);
    const marketProb =
      side === 'home' ? analysis.marketHomeProb : analysis.marketAwayProb;
    const impliedProb = decimalToImpliedProb(odds.price);
    // 優勢與去水後市場比較；實際盈利能力另由 EV（可下注賠率）判定。
    const edgePct = (modelProb - (marketProb ?? impliedProb)) * 100;

    if (matchup) {
      const gate = qualifiesH2hSide(matchup, side);
      if (!gate.ok) continue;
    } else {
      const minEdge = isNpbFamily
        ? (config.h2hMinEdgePctNpb ?? 3)
        : config.h2hMinEdgePct;
      const minFav = isNpbFamily ? (config.h2hMinFavoriteProbNpb ?? 0.56) : 0;
      const minGap = isNpbFamily ? (config.h2hMinProbGapNpb ?? 0.06) : 0;
      const minConf = isNpbFamily
        ? Math.max(config.h2hMinConfidence, 0.12)
        : config.h2hMinConfidence;

      if (edgePct < minEdge) continue;
      if (analysis.confidence < minConf) continue;
      if (minFav > 0 && modelProb < minFav) continue;
      if (minGap > 0 && modelProb - oppProb < minGap) continue;
    }

    const opt = {
      market: 'h2h',
      marketGroup: 'main',
      pick: team,
      line: null,
      odds,
      oddsDecimal: odds.price,
      modelProb,
      rawModelProb,
      marketProb,
      probabilityCalibrated: marketProb != null,
      ev: calcEV(modelProb, decimalToNetOdds(odds.price)),
      confidence: analysis.confidence,
      structuralOk: true,
      edgePct,
      isFavorite: modelProb >= 0.5,
      dataQuality: analysis.dataQuality,
    };

    const enriched = enrichCandidate(opt, analysis, game.league, 'h2h');
    if (!enriched.tier) continue;
    if (enriched.ev < config.minEvThreshold) continue;
    if (enriched.edgeProb <= 0) continue;
    if (
      odds.price < (config.prematchPrimaryMinOdds ?? 1.75) &&
      enriched.tier === 'primary'
    ) {
      enriched.tier = 'watch';
      enriched.score = Math.min(enriched.score, config.recommendPrimaryScore - 0.1);
    }
    options.push(enriched);
  }

  if (!options.length) return null;
  options.sort((a, b) => b.ev - a.ev || b.edgeProb - a.edgeProb);
  return options[0];
}

function pickSpreadCandidate(game, markets, analysis, bookmakers = []) {
  const raw = [];
  const pitcherEdge = analysis.pitcherEdge ?? 0;

  for (const [, spread] of Object.entries(markets.spreads)) {
    if (!isSpreadAlignedWithModel(spread, game, analysis)) continue;

    const isHome = spread.name === game.home_team;
    const teamWinProb = isHome ? analysis.homeWinProb : analysis.awayWinProb;
    const oppWinProb = isHome ? analysis.awayWinProb : analysis.homeWinProb;
    const { homeRuns, awayRuns } = scoringLambdas(analysis);
    const cover = estimateCoverProbDetails(teamWinProb, spread.point, {
      pitcherEdge,
      pickIsHome: isHome,
      oppWinProb,
      homeRuns,
      awayRuns,
      bookmakers,
      teamName: spread.name,
    });
    const coverProb = cover.coverProb;
    const winProb = coverProb * (1 - cover.pushProb);
    const ev = calcEVWithPush(
      winProb,
      cover.pushProb,
      decimalToNetOdds(spread.price)
    );
    const impliedProb = decimalToImpliedProb(spread.price);
    const edgePct = (coverProb - (cover.marketProb ?? impliedProb)) * 100;

    if (coverProb < config.spreadsMinCoverProb) continue;
    if (edgePct < config.spreadsMinEdgePct) continue;
    if (ev < config.minEvThreshold) continue;
    // 初盤硬擋短水（1.51 這類鎖死受讓不算可用推薦）
    if (spread.price < (config.prematchMinOdds ?? 1.65)) continue;

    raw.push({
      spread,
      pick: formatSpreadPick(spread.name, spread.point),
      line: spread.point,
      odds: spread,
      oddsDecimal: spread.price,
      modelProb: coverProb,
      rawModelProb: cover.rawModelProb,
      marketProb: cover.marketProb,
      pushProb: cover.pushProb,
      probabilityCalibrated: cover.probabilityCalibrated,
      ev,
      edgePct,
      absLine: Math.abs(spread.point),
    });
  }

  if (!raw.length) return null;

  const byLine = new Map();
  for (const item of raw) {
    const key = item.absLine;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(item);
  }

  const lineCandidates = [];
  for (const [, group] of byLine) {
    const favorites = group.filter((g) => g.line < 0);
    if (favorites.length > 1) continue;

    const scored = group
      .map((g) => {
        const enriched = enrichCandidate(
          {
            market: 'spreads',
            marketGroup: 'main',
            pick: g.pick,
            line: g.line,
            odds: g.odds,
            oddsDecimal: g.oddsDecimal,
            modelProb: g.modelProb,
            rawModelProb: g.rawModelProb,
            marketProb: g.marketProb,
            pushProb: g.pushProb,
            probabilityCalibrated: g.probabilityCalibrated,
            ev: g.ev,
            confidence: analysis.confidence,
            structuralOk: true,
            dataQuality: analysis.dataQuality,
          },
          analysis,
          game.league,
          'spreads'
        );
        // +1.5 主推折扣（config 原先未接線）
        if (g.line >= 1.5 && (config.spreadsPlus15PrimaryPenalty || 0) > 0) {
          enriched.score = Math.max(0, (enriched.score ?? 0) - config.spreadsPlus15PrimaryPenalty);
          if (enriched.score < config.recommendPrimaryScore && enriched.tier === 'primary') {
            enriched.tier = enriched.score >= config.recommendWatchScore ? 'watch' : null;
          }
        }
        if (
          g.oddsDecimal < (config.prematchPrimaryMinOdds ?? 1.72) &&
          enriched.tier === 'primary'
        ) {
          enriched.tier = 'watch';
          enriched.score = Math.min(enriched.score, config.recommendPrimaryScore - 0.1);
        }
        return enriched;
      })
      .filter((g) => g.tier)
      .filter((g) => g.modelProb >= config.spreadsMinCoverProb)
      .filter((g) => g.ev >= config.minEvThreshold)
      .filter((g) => g.edgeProb >= config.spreadsMinEdgePct);

    if (!scored.length) continue;
    scored.sort((a, b) => b.score - a.score || b.modelProb - a.modelProb);
    lineCandidates.push(scored[0]);
  }

  if (!lineCandidates.length) return null;
  lineCandidates.sort((a, b) => b.score - a.score || b.modelProb - a.modelProb);
  return lineCandidates[0];
}

function pickTotalCandidate(game, markets, analysis, bookmakers) {
  const projection = analysis.totalsProjection
    ?? computeTotalsProjection({
      league: game.league,
      homeMlb: analysis.homeMlb,
      awayMlb: analysis.awayMlb,
      homePitcherStats: analysis.homePitcherStats,
      awayPitcherStats: analysis.awayPitcherStats,
      venueName: analysis.venueName,
      bookmakers: bookmakers || [],
    });

  const raw = buildTotalCandidates(markets, projection, game.league)
    .filter((c) => c.structuralOk)
    .filter((c) => {
      // MLB 小球需投手穩定條件；NPB/KBO 有隊力得失分即可推小
      if (c.side !== 'under') return true;
      if (game.league === 'NPB' || game.league === 'KBO') return true;
      return projection.totalsContext?.underViable;
    })
    .filter((c) => c.ev >= (config.totalsMinEv ?? config.minEvThreshold));

  if (!raw.length) return null;

  const scored = raw
    .map((o) => {
      const enriched = enrichCandidate(
        { ...o, confidence: analysis.confidence, dataQuality: projection.dataQuality },
        { ...analysis, factors: [...(analysis.factors || []), ...(projection.factors || [])] },
        game.league,
        'totals'
      );
      // 跨盤口偏好只在 EdgeSignals 套用一次，避免 totals / under 重複扣分。
      if (o.side === 'over' && projection.totalsContext?.overTrigger) {
        enriched.score += 4;
      }
      if (projection.dataQuality < 0.7 && enriched.score < config.recommendWatchScore) {
        enriched.tier = null;
      }
      return enriched;
    })
    .filter((o) => o.tier);

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || b.ev - a.ev);
  return scored[0];
}

function buildPickReasoning(pick, baseReasoning) {
  const reasoningParts = [baseReasoning];
  if (pick.edgeSignals?.length) {
    reasoningParts.push(`訊號: ${pick.edgeSignals.join('、')}`);
  }
  if (pick.market === 'h2h') reasoningParts.push('獨贏');
  else if (pick.market === 'spreads') reasoningParts.push(`讓分 ${pick.line}`);
  else if (pick.market === 'totals') {
    reasoningParts.push(
      `預估總分 ${pick.projectedTotal?.toFixed(1) ?? '?'}` +
        `（市場${pick.marketLine ?? '?'}）| 盤口 ${pick.line}`
    );
  }
  return reasoningParts.filter(Boolean).join(' | ');
}

/** 單場主推（相容舊邏輯） */
export function pickPrimaryRecommendation(candidates, context = {}) {
  if (!candidates?.length) return null;
  const ranked = candidates
    .map((c) => {
      const { score, signals } = computeActionableScore(c, context);
      return { ...c, actionableScore: score, edgeSignals: signals };
    })
    .filter((c) => c.actionableScore >= 0)
    .sort((a, b) => b.actionableScore - a.actionableScore || b.ev - a.ev);
  return ranked[0] || null;
}

/**
 * 每場多盤口排序推薦：跨獨贏/讓分/大小/球員盤比較優勢分
 */
export function pickGameRecommendations(game, markets, analysis, baseReasoning, propsContext = {}) {
  const bookmakers = propsContext.bookmakers || [];
  const decisionUniverse = buildDecisionUniverse(game, markets, analysis, bookmakers);
  const preference = assessMarketPreference(analysis, game);

  if (
    (game.league === 'NPB' || game.league === 'KBO') &&
    analysis.hasTeamStrength !== true &&
    config.prematchSampleFallback === false
  ) {
    propsContext.onDecisionCandidates?.({
      candidates: decisionUniverse,
      selected: [],
      preference,
    });
    return [];
  }

  const h2h = pickH2hCandidate(game, markets, analysis);
  const spread = pickSpreadCandidate(game, markets, analysis, bookmakers);
  const total = pickTotalCandidate(game, markets, analysis, bookmakers);

  let propCandidates = [];
  if (config.enablePlayerProps && propsContext.propsMap && Object.keys(propsContext.propsMap).length) {
    propCandidates = pickPropCandidates(game, propsContext.propsMap, analysis, propsContext);
  }

  const allCandidates = [...[h2h, spread, total].filter(Boolean), ...propCandidates];

  const pickContext = {
    preferTotals: preference.preferTotals,
    analysis: {
      ...analysis,
      homeTeam: game.home_team,
      awayTeam: game.away_team,
      league: game.league,
      hasTeamStrength: analysis.hasTeamStrength,
    },
    homeMlb: analysis.homeMlb,
    awayMlb: analysis.awayMlb,
  };

  if (!allCandidates.length) {
    if (config.prematchSampleFallback !== false) {
      const fallback = buildSampleFallbackResults(
        game,
        analysis,
        preference,
        decisionUniverse,
        baseReasoning,
        pickContext
      );
      if (fallback.length) {
        const finalized = assignBetStrategies(fallback, pickContext).map(enrichWithSuggestedStake);
        propsContext.onDecisionCandidates?.({
          candidates: decisionUniverse,
          selected: finalized,
          preference,
        });
        return finalized;
      }
    }
    propsContext.onDecisionCandidates?.({
      candidates: decisionUniverse,
      selected: [],
      preference,
    });
    return [];
  }

  const scored = allCandidates
    .map((c) => {
      const { score, signals } = computeActionableScore(c, pickContext);
      return {
        ...c,
        league: game.league,
        hasTeamStrength: analysis.hasTeamStrength,
        dataQuality: c.dataQuality ?? analysis.dataQuality,
        actionableScore: score,
        edgeSignals: signals?.length ? signals : c.edgeSignals,
      };
    })
    .filter((c) => c.tier && (c.actionableScore >= 0 || c.tier === 'sample'))
    .sort(
      (a, b) =>
        b.actionableScore - a.actionableScore ||
        b.ev - a.ev ||
        b.score - a.score
    );

  const results = [];
  const usedMarkets = new Set();
  let rank = 0;

  for (const pick of scored) {
    if (usedMarkets.has(pick.market)) continue;
    rank += 1;

    let tier = pick.tier;
    let score = pick.score;
    // NPB/KBO：主推等同「可均注」門檻，避免虛高主推
    if (
      (game.league === 'NPB' || game.league === 'KBO') &&
      tier === 'primary' &&
      (pick.modelProb < (config.flatBetMinProbNpb ?? 0.6) ||
        pick.edgeProb < (config.flatBetMinEdgePctNpb ?? 3.5) ||
        (pick.oddsDecimal ?? 0) < (config.flatBetMinOdds ?? 1.8))
    ) {
      tier = 'watch';
      score = Math.min(score, config.recommendPrimaryScore - 0.1);
    }

    const prefNote =
      preference.preferTotals && preference.reason
        ? `選盤: ${preference.reason}`
        : null;

    results.push({
      ...pick,
      tier,
      score,
      pickRank: rank,
      isPrimary: rank === 1,
      rankLabel: rankLabel(rank, tier),
      reasoning: [buildPickReasoning({ ...pick, tier }, baseReasoning), prefNote]
        .filter(Boolean)
        .join(' | '),
      bookmaker: pick.odds?.bookmaker || pick.bookmaker,
      marketPreference: preference.preferTotals ? 'totals_first' : 'default',
    });
    usedMarkets.add(pick.market);
    if (rank >= config.maxPicksPerGame) break;
  }

  if (results.length === 0 && config.prematchSampleFallback !== false) {
    const fallback = buildSampleFallbackResults(
      game,
      analysis,
      preference,
      decisionUniverse,
      baseReasoning,
      pickContext
    );
    results.push(...fallback);
  }

  const finalized = assignBetStrategies(results, pickContext).map(enrichWithSuggestedStake);
  if (typeof propsContext.onDecisionCandidates === 'function') {
    propsContext.onDecisionCandidates({
      candidates: decisionUniverse,
      selected: finalized,
      preference,
    });
  }
  return finalized;
}
