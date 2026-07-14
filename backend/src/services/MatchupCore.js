/**
 * MLB 場次分析核心 — 先算「這場誰佔優、優勢多大」，再映射到各盤口
 * 最終勝率由 H2hModel + Poisson 得分模型校準（applyCalibratedProbabilities）
 */

import { config } from '../config.js';
import {
  parseL10Rate,
  pythagoreanWinPct,
  log5WinProb,
  extractFairH2hProb,
  clampProb,
} from './H2hModel.js';
import { calcEV, decimalToImpliedProb, decimalToNetOdds } from '../utils/odds.js';

const MLB_HOME_FIELD = 0.028;

function clamp01(v, min = 0.05, max = 0.95) {
  return Math.max(min, Math.min(max, v));
}

export function injuryImpact(summary) {
  const count = summary?.count ?? 0;
  if (!count) return { penalty: 0, label: null };
  const penalty = Math.min(0.06, count * 0.009 + (count >= 4 ? 0.015 : 0));
  const names = (summary?.names || []).slice(0, 3).join('、');
  return {
    penalty,
    label: names ? `傷兵 ${count} 人（${names}）` : `傷兵 ${count} 人`,
  };
}

export function buildTeamSituationScore({
  mlbTeam,
  injurySummary = null,
  pitcherStats = null,
  isHome = false,
}) {
  const factors = [];
  if (!mlbTeam) {
    return { score: 0.5, factors, hasCore: false };
  }

  const season = mlbTeam.winPct ?? 0.5;
  const pyth = pythagoreanWinPct(mlbTeam.runsScored, mlbTeam.runsAllowed) ?? season;
  const l10 = parseL10Rate(mlbTeam.last10) ?? season;
  const momentum = l10 - season;

  let score =
    pyth * 0.35 +
    l10 * 0.3 +
    season * 0.15 +
    Math.max(-0.08, Math.min(0.08, momentum * 0.5));

  factors.push(
    `Pyth ${(pyth * 100).toFixed(0)}% · L10 ${mlbTeam.last10 || 'N/A'} · 動量 ${momentum >= 0 ? '+' : ''}${(momentum * 100).toFixed(0)}%`
  );

  const inj = injuryImpact(injurySummary);
  if (inj.penalty > 0) {
    score -= inj.penalty;
    factors.push(inj.label);
  }

  if (pitcherStats) {
    const era = pitcherStats.era ?? 4.5;
    const whip = pitcherStats.whip ?? 1.3;
    const quality = 4.5 - era * 0.12 - (whip - 1.3) * 0.35;
    score += Math.max(-0.04, Math.min(0.04, quality * 0.02));
    factors.push(`先發 ERA ${era.toFixed(2)} WHIP ${whip.toFixed(2)}`);
  }

  if (isHome) {
    score += MLB_HOME_FIELD;
    factors.push('主場');
  }

  return {
    score: clamp01(score),
    factors,
    hasCore: true,
    momentum,
    pyth,
    l10,
  };
}

export function resolveAdaptiveMarketBlend(modelHomeProb, marketHomeProb, baseWeight) {
  if (marketHomeProb == null) return 0;
  const gap = Math.abs(modelHomeProb - marketHomeProb);
  if (gap >= 0.1) return Math.max(0.15, baseWeight - 0.2);
  if (gap >= 0.06) return Math.max(0.2, baseWeight - 0.12);
  return baseWeight;
}

function blend(modelProb, marketProb, weight) {
  if (marketProb == null || weight <= 0) return modelProb;
  const w = Math.max(0, Math.min(0.65, weight));
  return modelProb * (1 - w) + marketProb * w;
}

export function computeH2hEdges(homeWinProb, awayWinProb, homeOdds, awayOdds) {
  const homeImplied = homeOdds ? decimalToImpliedProb(homeOdds) : null;
  const awayImplied = awayOdds ? decimalToImpliedProb(awayOdds) : null;

  const homeEv = homeOdds ? calcEV(homeWinProb, decimalToNetOdds(homeOdds)) : null;
  const awayEv = awayOdds ? calcEV(awayWinProb, decimalToNetOdds(awayOdds)) : null;

  const homeEdge = homeImplied != null ? (homeWinProb - homeImplied) * 100 : null;
  const awayEdge = awayImplied != null ? (awayWinProb - awayImplied) * 100 : null;

  let bestSide = null;
  let bestEv = -Infinity;
  if (homeEv != null && homeEv > bestEv) {
    bestEv = homeEv;
    bestSide = 'home';
  }
  if (awayEv != null && awayEv > bestEv) {
    bestEv = awayEv;
    bestSide = 'away';
  }

  const marketFavorite =
    homeImplied != null && awayImplied != null
      ? homeImplied >= awayImplied
        ? 'home'
        : 'away'
      : null;

  const favoriteTrap =
    marketFavorite != null &&
    bestSide != null &&
    bestSide !== marketFavorite &&
    bestEv >= config.minEvThreshold;

  return {
    home: { ev: homeEv, edgePct: homeEdge, implied: homeImplied, odds: homeOdds },
    away: { ev: awayEv, edgePct: awayEdge, implied: awayImplied, odds: awayOdds },
    bestSide,
    bestEv,
    favoriteTrap,
    modelFavorite: homeWinProb >= awayWinProb ? 'home' : 'away',
    marketFavorite,
  };
}

function extractH2hOdds(bookmakers, homeTeam, awayTeam) {
  let homeOdds = null;
  let awayOdds = null;
  for (const book of bookmakers || []) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m) continue;
    const ho = m.outcomes?.find((o) => o.name === homeTeam);
    const ao = m.outcomes?.find((o) => o.name === awayTeam);
    if (ho?.price && (homeOdds == null || ho.price > homeOdds)) homeOdds = ho.price;
    if (ao?.price && (awayOdds == null || ao.price > awayOdds)) awayOdds = ao.price;
  }
  return { homeOdds, awayOdds };
}

/**
 * 以 Poisson/Log5 校準後的勝率覆寫 MatchupCore，並重算雙邊 EV
 */
export function applyCalibratedProbabilities(matchupCore, homeWinProb, awayWinProb, bookmakers, homeTeam, awayTeam) {
  if (!matchupCore) return null;

  const { homeOdds, awayOdds } = extractH2hOdds(bookmakers, homeTeam, awayTeam);
  const edges = computeH2hEdges(homeWinProb, awayWinProb, homeOdds, awayOdds);
  const factors = [...(matchupCore.factors || [])];

  if (edges.favoriteTrap && !factors.some((f) => f.includes('熱門陷阱') || f.includes('過度追捧'))) {
    factors.push('市場過度追捧熱門，EV 更佳在另一側');
  }
  if (edges.bestSide) {
    const sideLabel = edges.bestSide === 'home' ? homeTeam : awayTeam;
    const evLine = `EV 最佳: ${sideLabel} (${(edges.bestEv * 100).toFixed(1)}%)`;
    if (!factors.some((f) => f.startsWith('EV 最佳'))) factors.push(evLine);
  }

  return {
    ...matchupCore,
    homeWinProb,
    awayWinProb,
    confidence: Math.abs(homeWinProb - 0.5) * 2,
    edges,
    factors,
  };
}

export function buildMatchupAnalysis({
  league,
  homeTeam,
  awayTeam,
  bookmakers,
  homeMlb = null,
  awayMlb = null,
  homePitcherStats = null,
  awayPitcherStats = null,
  homeInjurySummary = null,
  awayInjurySummary = null,
  homeFallbackRating = 0.5,
  awayFallbackRating = 0.5,
  venueName = null,
}) {
  const factors = [];

  const homeSit = homeMlb
    ? buildTeamSituationScore({
        mlbTeam: homeMlb,
        injurySummary: homeInjurySummary,
        pitcherStats: homePitcherStats,
        isHome: true,
      })
    : { score: homeFallbackRating, factors: [`近期 ${(homeFallbackRating * 100).toFixed(0)}%`], hasCore: false };

  const awaySit = awayMlb
    ? buildTeamSituationScore({
        mlbTeam: awayMlb,
        injurySummary: awayInjurySummary,
        pitcherStats: awayPitcherStats,
        isHome: false,
      })
    : { score: awayFallbackRating, factors: [`近期 ${(awayFallbackRating * 100).toFixed(0)}%`], hasCore: false };

  factors.push(`${homeTeam}: ${homeSit.factors.join(' · ')}`);
  factors.push(`${awayTeam}: ${awaySit.factors.join(' · ')}`);
  if (venueName) factors.push(`球場 ${venueName}`);

  let rawHomeProb = log5WinProb(homeSit.score, awaySit.score);
  rawHomeProb = clampProb(rawHomeProb, 0.2, 0.8);

  const fairMarket = extractFairH2hProb(bookmakers, homeTeam, awayTeam);
  const marketHomeProb = fairMarket?.homeProb ?? null;

  const hasMlbCore = Boolean(homeMlb && awayMlb);
  const hasPitchers = Boolean(homePitcherStats && awayPitcherStats);
  let baseBlend = config.h2hMarketBlendOther ?? 0.55;
  if (league === 'MLB') {
    if (hasMlbCore && hasPitchers) baseBlend = config.h2hMarketBlendMlbFull ?? 0.4;
    else if (hasMlbCore) baseBlend = config.h2hMarketBlendMlb ?? 0.45;
    else baseBlend = config.h2hMarketBlendMlbLite ?? 0.5;
  }

  const marketWeight = resolveAdaptiveMarketBlend(rawHomeProb, marketHomeProb, baseBlend);
  let homeWinProb = blend(rawHomeProb, marketHomeProb, marketWeight);
  homeWinProb = clampProb(homeWinProb, 0.2, 0.8);
  const awayWinProb = 1 - homeWinProb;

  if (marketHomeProb != null) {
    factors.push(
      `情境主勝 ${(rawHomeProb * 100).toFixed(1)}% → 校準 ${(homeWinProb * 100).toFixed(1)}% · 市場 ${(marketHomeProb * 100).toFixed(1)}%`
    );
  }

  const { homeOdds, awayOdds } = extractH2hOdds(bookmakers, homeTeam, awayTeam);
  const edges = computeH2hEdges(homeWinProb, awayWinProb, homeOdds, awayOdds);

  if (edges.favoriteTrap) {
    factors.push('市場過度追捧熱門，EV 更佳在另一側');
  }
  if (edges.bestSide) {
    const sideLabel = edges.bestSide === 'home' ? homeTeam : awayTeam;
    factors.push(`EV 最佳: ${sideLabel} (${(edges.bestEv * 100).toFixed(1)}%)`);
  }

  const dataQuality =
    (hasMlbCore ? 0.35 : 0.1) +
    (hasPitchers ? 0.25 : 0) +
    (marketHomeProb != null ? 0.2 : 0) +
    0.15 +
    0.05;

  return {
    homeTeam,
    awayTeam,
    homeWinProb,
    awayWinProb,
    rawHomeProb,
    marketHomeProb,
    marketAwayProb: marketHomeProb != null ? 1 - marketHomeProb : null,
    confidence: Math.abs(homeWinProb - 0.5) * 2,
    factors,
    homeSituation: homeSit,
    awaySituation: awaySit,
    edges,
    dataQuality: Math.min(1, dataQuality),
    hasMlbCore,
    hasPitchers,
    marketWeight,
    venueName,
  };
}

export function qualifiesH2hSide(matchup, side) {
  const edge = matchup.edges?.[side];
  if (!edge || edge.ev == null || edge.odds == null) {
    return { ok: false, reason: '無賠率' };
  }

  const minEdge = config.h2hMinEdgePct ?? 1.5;
  if (edge.ev < config.minEvThreshold) {
    return { ok: false, reason: `EV ${(edge.ev * 100).toFixed(1)}%` };
  }
  if (edge.edgePct == null || edge.edgePct < minEdge) {
    return { ok: false, reason: `優勢 ${edge.edgePct?.toFixed(1) ?? '?'}%` };
  }
  if (matchup.confidence < (config.h2hMinConfidence ?? 0.08)) {
    return { ok: false, reason: '場次太接近' };
  }

  return { ok: true, edge };
}
