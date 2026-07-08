import { config } from '../config.js';
import {
  calcEV,
  decimalToImpliedProb,
  decimalToNetOdds,
  estimateCoverProb,
  estimateProjectedTotal,
  probTotalOver,
} from '../utils/odds.js';
import { enrichCandidate } from './PickScorer.js';
import { pickPropCandidates } from './PlayerPropAnalyzer.js';

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
    if (!odds) continue;
    const modelProb = team === game.home_team ? analysis.homeWinProb : analysis.awayWinProb;
    const ev = calcEV(modelProb, decimalToNetOdds(odds.price));
    options.push({
      market: 'h2h',
      marketGroup: 'main',
      pick: team,
      line: null,
      odds,
      oddsDecimal: odds.price,
      modelProb,
      ev,
      confidence: analysis.confidence,
      structuralOk: true,
    });
  }

  if (!options.length) return null;

  options.sort((a, b) => b.modelProb - a.modelProb);
  const best = enrichCandidate(options[0], analysis, game.league, 'h2h');
  const second = options[1];

  if (!best.tier) return null;
  if (second && best.modelProb - second.modelProb < 0.02) return null;

  return best;
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

function pickTotalCandidate(game, markets, analysis) {
  const projectedTotal = estimateProjectedTotal(
    game.league,
    analysis.homePitcherEra,
    analysis.awayPitcherEra
  );

  const options = [];
  for (const [, total] of Object.entries(markets.totals)) {
    const isOver = total.name === 'Over';
    const modelProb = isOver
      ? probTotalOver(projectedTotal, total.point)
      : 1 - probTotalOver(projectedTotal, total.point);
    const ev = calcEV(modelProb, decimalToNetOdds(total.price));

    options.push({
      market: 'totals',
      marketGroup: 'main',
      pick: formatTotalPick(total.name, total.point),
      line: total.point,
      odds: total,
      oddsDecimal: total.price,
      modelProb,
      ev,
      projectedTotal,
      structuralOk: true,
    });
  }

  const scored = options
    .map((o) => enrichCandidate(o, analysis, game.league, 'totals'))
    .filter((o) => o.tier);

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || b.modelProb - a.modelProb);
  return scored[0];
}

/**
 * 每場可有多條推薦（不同盤口），但同類盤口互斥
 */
export function pickGameRecommendations(game, markets, analysis, baseReasoning, propsContext = {}) {
  const results = [];
  const usedMarkets = new Set();

  const h2h = pickH2hCandidate(game, markets, analysis);
  if (h2h) {
    results.push({
      ...h2h,
      reasoning: `${baseReasoning} | 獨贏`,
      bookmaker: h2h.odds.bookmaker,
    });
    usedMarkets.add('h2h');
  }

  const spread = pickSpreadCandidate(game, markets, analysis);
  if (spread) {
    results.push({
      ...spread,
      reasoning: `${baseReasoning} | 讓分 ${spread.line}`,
      bookmaker: spread.odds.bookmaker,
    });
    usedMarkets.add('spreads');
  }

  const total = pickTotalCandidate(game, markets, analysis);
  if (total) {
    results.push({
      ...total,
      reasoning: `${baseReasoning} | 預估總分 ${total.projectedTotal?.toFixed(1)} | 盤口 ${total.line}`,
      bookmaker: total.odds.bookmaker,
    });
    usedMarkets.add('totals');
  }

  if (propsContext.propsMap && Object.keys(propsContext.propsMap).length) {
    const props = pickPropCandidates(game, propsContext.propsMap, analysis, propsContext);
    for (const p of props.slice(0, 4)) {
      if (usedMarkets.has(p.market)) continue;
      results.push(p);
      usedMarkets.add(p.market);
    }
  }

  return results
    .sort((a, b) => b.score - a.score || b.modelProb - a.modelProb)
    .slice(0, config.maxPicksPerGame);
}
