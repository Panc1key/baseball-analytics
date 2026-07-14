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

export function formatSpreadPick(team, point) {
  return `${team} ${point > 0 ? '+' : ''}${point}`;
}

export function formatTotalPick(name, point) {
  const label = name === 'Over' ? '大' : '小';
  return `${label} ${point}`;
}

export function rankLabel(rank) {
  if (rank === 1) return '主推';
  if (rank === 2) return '次推';
  return `第${rank}推`;
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

      const homeRuns = analysis.homeRuns;
      const awayRuns = analysis.awayRuns;
      if (homeRuns != null && awayRuns != null) {
        const expectedMargin = isHome ? homeRuns - awayRuns : awayRuns - homeRuns;
        if (expectedMargin < (config.spreadsMinExpectedMargin ?? -0.35)) return false;

        const poissonCover = poissonCoverProb(homeRuns, awayRuns, spread.point, isHome);
        if (poissonCover < config.spreadsMinCoverProb) return false;
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

  for (const [team, side] of [
    [game.home_team, 'home'],
    [game.away_team, 'away'],
  ]) {
    const odds = markets.h2h[team];
    if (!odds?.price) continue;

    const modelProb = side === 'home' ? analysis.homeWinProb : analysis.awayWinProb;
    const rawModelProb =
      side === 'home'
        ? (analysis.rawModelHomeProb ?? modelProb)
        : (analysis.rawModelAwayProb ?? modelProb);
    const marketProb =
      side === 'home' ? analysis.marketHomeProb : analysis.marketAwayProb;
    const impliedProb = decimalToImpliedProb(odds.price);
    const edgePct = (modelProb - impliedProb) * 100;

    if (matchup) {
      const gate = qualifiesH2hSide(matchup, side);
      if (!gate.ok) continue;
    } else {
      if (edgePct < config.h2hMinEdgePct) continue;
      if (analysis.confidence < config.h2hMinConfidence) continue;
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
    const cover = estimateCoverProbDetails(teamWinProb, spread.point, {
      pitcherEdge,
      pickIsHome: isHome,
      oppWinProb,
      homeRuns: analysis.homeRuns,
      awayRuns: analysis.awayRuns,
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
    const edgePct = (coverProb - impliedProb) * 100;

    if (coverProb < config.spreadsMinCoverProb) continue;
    if (edgePct < config.spreadsMinEdgePct) continue;
    if (ev < config.minEvThreshold) continue;

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
      .map((g) =>
        enrichCandidate(
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
        )
      )
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
    .filter((c) => c.side !== 'under' || projection.totalsContext?.underViable)
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
      enriched.score = Math.max(0, enriched.score - (config.totalsPrimaryScorePenalty || 15));
      if (o.side === 'under') {
        enriched.score = Math.max(0, enriched.score - 12);
        if (enriched.score < config.recommendWatchScore) enriched.tier = null;
      }
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

  const h2h = pickH2hCandidate(game, markets, analysis);
  const spread = pickSpreadCandidate(game, markets, analysis, bookmakers);
  const total = pickTotalCandidate(game, markets, analysis, bookmakers);

  let propCandidates = [];
  if (config.enablePlayerProps && propsContext.propsMap && Object.keys(propsContext.propsMap).length) {
    propCandidates = pickPropCandidates(game, propsContext.propsMap, analysis, propsContext);
  }

  const allCandidates = [...[h2h, spread, total].filter(Boolean), ...propCandidates];
  if (!allCandidates.length) return [];

  const pickContext = {
    analysis: { ...analysis, homeTeam: game.home_team, awayTeam: game.away_team },
    homeMlb: analysis.homeMlb,
    awayMlb: analysis.awayMlb,
  };

  const scored = allCandidates
    .map((c) => {
      const { score, signals } = computeActionableScore(c, pickContext);
      return {
        ...c,
        actionableScore: score,
        edgeSignals: signals?.length ? signals : c.edgeSignals,
      };
    })
    .filter((c) => c.tier && c.actionableScore >= 0)
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

    results.push({
      ...pick,
      pickRank: rank,
      isPrimary: rank === 1,
      rankLabel: rankLabel(rank),
      reasoning: buildPickReasoning(pick, baseReasoning),
      bookmaker: pick.odds?.bookmaker || pick.bookmaker,
    });
    usedMarkets.add(pick.market);
    if (rank >= config.maxPicksPerGame) break;
  }

  return assignBetStrategies(results, pickContext).map(enrichWithSuggestedStake);
}
