import { tennisConfig } from './config.js';
import { calcEV, decimalToNetOdds } from '../utils/odds.js';
import { estimateTennisCoverProb } from './utils/tennisOdds.js';
import { buildTotalCandidates } from './models/TennisTotalsModel.js';
import { enrichTennisCandidate } from './TennisPickScorer.js';

function pickH2hCandidate(game, markets, analysis) {
  const options = [];
  const outcomes = [
    { name: game.home_team, prob: analysis.homeWinProb },
    { name: game.away_team, prob: analysis.awayWinProb },
  ];

  for (const out of outcomes) {
    const odds = markets.h2h[out.name];
    if (!odds?.price) continue;

    const enriched = enrichTennisCandidate(
      {
        market: 'h2h',
        marketGroup: 'main',
        pick: out.name,
        line: null,
        odds,
        oddsDecimal: odds.price,
        modelProb: out.prob,
        confidence: analysis.confidence,
        structuralOk: true,
      },
      analysis,
      game.league,
      'h2h'
    );

    if (enriched.ev < tennisConfig.minEvThreshold) continue;
    if (enriched.edgeProb < tennisConfig.h2hMinEdgePct) continue;
    if (analysis.confidence < tennisConfig.minConfidence) continue;
    if (!enriched.tier) continue;

    const fav =
      analysis.homeWinProb >= analysis.awayWinProb ? game.home_team : game.away_team;
    if (out.name !== fav) continue;

    options.push(enriched);
  }

  options.sort((a, b) => b.score - a.score || b.ev - a.ev);
  return options[0] || null;
}

function pickSpreadCandidate(game, markets, analysis) {
  const scale = tennisConfig.spreadScale ?? 4.5;
  const raw = [];

  for (const [, spread] of Object.entries(markets.spreads || {})) {
    const isHome = spread.name === game.home_team;
    const teamMargin = isHome ? analysis.expectedGameMargin : -analysis.expectedGameMargin;
    const coverProb = estimateTennisCoverProb(teamMargin, spread.point, scale);

    raw.push({
      spread,
      pick: `${spread.name} ${spread.point > 0 ? '+' : ''}${spread.point}`,
      line: spread.point,
      oddsDecimal: spread.price,
      modelProb: coverProb,
      ev: calcEV(coverProb, decimalToNetOdds(spread.price)),
      odds: spread,
    });
  }

  if (!raw.length) return null;

  const scored = raw
    .map((g) =>
      enrichTennisCandidate(
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
          structuralOk: g.ev >= tennisConfig.minEvThreshold,
        },
        analysis,
        game.league,
        'spreads'
      )
    )
    .filter((g) => g.tier && g.ev >= tennisConfig.minEvThreshold);

  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

function pickTotalCandidate(game, markets, analysis) {
  const projection = analysis.totalsProjection;
  const raw = buildTotalCandidates(markets, projection).filter((c) => c.structuralOk);

  const scored = raw
    .map((o) =>
      enrichTennisCandidate(
        { ...o, confidence: analysis.confidence },
        analysis,
        game.league,
        'totals'
      )
    )
    .filter((o) => o.tier && o.ev >= tennisConfig.minEvThreshold);

  scored.sort((a, b) => b.score - a.score || b.ev - a.ev);
  return scored[0] || null;
}

export function pickTennisGameRecommendations(game, markets, analysis, baseReasoning) {
  const results = [];
  const usedMarkets = new Set();

  const h2h = pickH2hCandidate(game, markets, analysis);
  const spread = pickSpreadCandidate(game, markets, analysis);
  const total = pickTotalCandidate(game, markets, analysis);

  const mainCandidates = [h2h, spread, total].filter(Boolean);
  const primary = mainCandidates.sort((a, b) => b.score - a.score)[0];

  const ordered = [];
  if (primary) ordered.push({ ...primary, isPrimary: true });
  for (const c of mainCandidates) {
    if (c && c !== primary) ordered.push({ ...c, isPrimary: false });
  }

  for (const pick of ordered) {
    if (usedMarkets.has(pick.market)) continue;
    const reasoningParts = [baseReasoning];
    if (pick.market === 'h2h') reasoningParts.push('獨贏');
    else if (pick.market === 'spreads') reasoningParts.push(`讓局 ${pick.line}`);
    else if (pick.market === 'totals') {
      reasoningParts.push(`模型 ${pick.modelTotal?.toFixed(1) ?? '?'} 局 · 盤口 ${pick.line}`);
    }

    results.push({
      ...pick,
      reasoning: reasoningParts.join(' | '),
      bookmaker: pick.odds?.bookmaker || pick.bookmaker,
    });
    usedMarkets.add(pick.market);
  }

  return results
    .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0) || b.score - a.score)
    .slice(0, tennisConfig.maxPicksPerGame);
}
