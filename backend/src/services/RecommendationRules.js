import { config } from '../config.js';
import {
  calcEV,
  decimalToImpliedProb,
  decimalToNetOdds,
  estimateCoverProb,
} from '../utils/odds.js';
import { enrichCandidate } from './PickScorer.js';
import { pickPropCandidates } from './PlayerPropAnalyzer.js';
import {
  computeTotalsProjection,
  buildTotalCandidates,
} from './TotalsModel.js';

export function formatSpreadPick(team, point) {
  return `${team} ${point > 0 ? '+' : ''}${point}`;
}

export function formatTotalPick(name, point) {
  const label = name === 'Over' ? '大' : '小';
  return `${label} ${point}`;
}

/** 讓分方向與模型一致，禁止雙方皆為讓分方 */
export function isSpreadAlignedWithModel(spread, game, analysis) {
  const isHome = spread.name === game.home_team;
  const teamWinProb = isHome ? analysis.homeWinProb : analysis.awayWinProb;
  const oppWinProb = isHome ? analysis.awayWinProb : analysis.homeWinProb;

  if (spread.point < 0) {
    return teamWinProb > oppWinProb && teamWinProb >= 0.51;
  }
  if (spread.point > 0) {
    return teamWinProb >= 0.38;
  }
  return false;
}

function pickH2hCandidate(game, markets, analysis) {
  const options = [];

  for (const [team, odds] of [
    [game.home_team, markets.h2h[game.home_team]],
    [game.away_team, markets.h2h[game.away_team]],
  ]) {
    if (!odds?.price) continue;

    const isHome = team === game.home_team;
    const modelProb = isHome ? analysis.homeWinProb : analysis.awayWinProb;
    const impliedProb = decimalToImpliedProb(odds.price);
    const edgePct = (modelProb - impliedProb) * 100;

    options.push({
      market: 'h2h',
      marketGroup: 'main',
      pick: team,
      line: null,
      odds,
      oddsDecimal: odds.price,
      modelProb,
      ev: calcEV(modelProb, decimalToNetOdds(odds.price)),
      confidence: analysis.confidence,
      structuralOk: true,
      edgePct,
      isFavorite: modelProb >= 0.5,
    });
  }

  if (!options.length) return null;

  options.sort((a, b) => b.ev - a.ev || b.edgePct - a.edgePct);

  for (const opt of options) {
    if (opt.ev < config.minEvThreshold) continue;
    if (opt.edgePct < config.h2hMinEdgePct) continue;
    if (analysis.confidence < config.h2hMinConfidence) continue;

    const enriched = enrichCandidate(opt, analysis, game.league, 'h2h');
    if (!enriched.tier) continue;
    if (enriched.ev < config.minEvThreshold) continue;
    if (enriched.edgeProb <= 0) continue;

    const modelFavorsHome = analysis.homeWinProb >= analysis.awayWinProb;
    const pickIsHome = opt.pick === game.home_team;
    if (modelFavorsHome !== pickIsHome) continue;

    return enriched;
  }

  return null;
}

function pickSpreadCandidate(game, markets, analysis) {
  const raw = [];

  for (const [, spread] of Object.entries(markets.spreads)) {
    if (!isSpreadAlignedWithModel(spread, game, analysis)) continue;

    const isHome = spread.name === game.home_team;
    const teamWinProb = isHome ? analysis.homeWinProb : analysis.awayWinProb;
    const coverProb = estimateCoverProb(teamWinProb, spread.point);
    const ev = calcEV(coverProb, decimalToNetOdds(spread.price));

    raw.push({
      spread,
      pick: formatSpreadPick(spread.name, spread.point),
      line: spread.point,
      odds: spread,
      oddsDecimal: spread.price,
      modelProb: coverProb,
      ev,
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
            ev: g.ev,
            confidence: analysis.confidence,
            structuralOk: true,
          },
          analysis,
          game.league,
          'spreads'
        )
      )
      .filter((g) => g.tier);

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
    .filter((c) => c.ev >= (config.totalsMinEv ?? config.minEvThreshold));

  if (!raw.length) return null;

  const scored = raw
    .map((o) => {
      const enriched = enrichCandidate(
        { ...o, confidence: analysis.confidence },
        { ...analysis, factors: [...(analysis.factors || []), ...(projection.factors || [])] },
        game.league,
        'totals'
      );
      // 大小盤數據品質較低時降低評分，讓獨贏/讓分有機會成為主推
      if (projection.dataQuality < 0.7) {
        enriched.score = Math.max(0, enriched.score - (config.totalsPrimaryScorePenalty || 8));
        if (enriched.score < config.recommendWatchScore) enriched.tier = null;
      }
      return enriched;
    })
    .filter((o) => o.tier);

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || b.ev - a.ev);
  return scored[0];
}

/** 單場主推：主盤中評分最高者（大小盤不再默認霸佔） */
export function pickPrimaryRecommendation(candidates) {
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => b.score - a.score || b.ev - a.ev)[0];
}

/**
 * 每場可有多條推薦（不同盤口），但同類盤口互斥
 */
export function pickGameRecommendations(game, markets, analysis, baseReasoning, propsContext = {}) {
  const results = [];
  const usedMarkets = new Set();
  const bookmakers = propsContext.bookmakers || [];

  const h2h = pickH2hCandidate(game, markets, analysis);
  const spread = pickSpreadCandidate(game, markets, analysis);
  const total = pickTotalCandidate(game, markets, analysis, bookmakers);

  const mainCandidates = [h2h, spread, total].filter(Boolean);
  const primary = pickPrimaryRecommendation(mainCandidates);

  const ordered = [];
  if (primary) ordered.push(primary);
  for (const c of mainCandidates) {
    if (c && c !== primary) ordered.push(c);
  }

  for (const pick of ordered) {
    if (usedMarkets.has(pick.market)) continue;
    const reasoningParts = [baseReasoning];
    if (pick.market === 'h2h') reasoningParts.push('獨贏');
    else if (pick.market === 'spreads') reasoningParts.push(`讓分 ${pick.line}`);
    else if (pick.market === 'totals') {
      reasoningParts.push(
        `預估總分 ${pick.projectedTotal?.toFixed(1) ?? '?'}` +
          `（市場${pick.marketLine ?? '?'}）| 盤口 ${pick.line}`
      );
    }

    results.push({
      ...pick,
      isPrimary: pick === primary,
      reasoning: reasoningParts.join(' | '),
      bookmaker: pick.odds.bookmaker,
    });
    usedMarkets.add(pick.market);
  }

  if (config.enablePlayerProps && propsContext.propsMap && Object.keys(propsContext.propsMap).length) {
    const props = pickPropCandidates(game, propsContext.propsMap, analysis, propsContext);
    for (const p of props.slice(0, 2)) {
      if (usedMarkets.has(p.market)) continue;
      results.push(p);
      usedMarkets.add(p.market);
    }
  }

  return results
    .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0) || b.score - a.score)
    .slice(0, config.maxPicksPerGame);
}
