import { footballConfig } from './config.js';
import { calcEV, decimalToNetOdds } from '../utils/odds.js';
import { estimateSoccerCoverProb } from './utils/footballOdds.js';
import { buildTotalCandidates } from './models/FootballTotalsModel.js';
import { enrichFootballCandidate } from './FootballPickScorer.js';
import { pickFootballPropCandidates } from './FootballPlayerAnalyzer.js';

function pickH2hCandidates(game, markets, analysis) {
  const options = [];
  const outcomes = [
    { name: game.home_team, prob: analysis.homeWinProb },
    { name: 'Draw', prob: analysis.drawProb, label: '和局' },
    { name: game.away_team, prob: analysis.awayWinProb },
  ];

  for (const out of outcomes) {
    const odds = markets.h2h[out.name];
    if (!odds?.price) continue;

    const modelProb = out.prob;
    const enriched = enrichFootballCandidate(
      {
        market: 'h2h',
        marketGroup: 'main',
        pick: out.label || out.name,
        line: null,
        odds,
        oddsDecimal: odds.price,
        modelProb,
        confidence: analysis.confidence,
        structuralOk: true,
      },
      analysis,
      game.league,
      'h2h'
    );

    if (enriched.ev < footballConfig.minEvThreshold) continue;
    if (enriched.edgeProb < footballConfig.h2hMinEdgePct) continue;
    if (analysis.confidence < footballConfig.minConfidence) continue;
    if (!enriched.tier) continue;

    const favSide =
      analysis.homeWinProb >= analysis.awayWinProb && analysis.homeWinProb >= analysis.drawProb
        ? game.home_team
        : analysis.awayWinProb >= analysis.drawProb
          ? game.away_team
          : 'Draw';
    const pickSide = out.label ? 'Draw' : out.name;
    if (favSide !== pickSide) continue;

    options.push(enriched);
  }

  options.sort((a, b) => b.score - a.score || b.ev - a.ev);
  return options[0] || null;
}

function pickSpreadCandidate(game, markets, analysis) {
  const raw = [];

  for (const [, spread] of Object.entries(markets.spreads || {})) {
    const isHome = spread.name === game.home_team;
    const teamWinProb = isHome ? analysis.homeWinProb : analysis.awayWinProb;
    const coverProb = estimateSoccerCoverProb(
      teamWinProb,
      analysis.drawProb,
      spread.point
    );
    const ev = calcEV(coverProb, decimalToNetOdds(spread.price));

    raw.push({
      spread,
      pick: `${spread.name} ${spread.point > 0 ? '+' : ''}${spread.point}`,
      line: spread.point,
      oddsDecimal: spread.price,
      modelProb: coverProb,
      ev,
      odds: spread,
    });
  }

  if (!raw.length) return null;

  const scored = raw
    .map((g) =>
      enrichFootballCandidate(
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
          structuralOk: g.ev >= footballConfig.minEvThreshold,
        },
        analysis,
        game.league,
        'spreads'
      )
    )
    .filter((g) => g.tier);

  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

function pickTotalCandidate(game, markets, analysis) {
  const projection = analysis.totalsProjection;
  const raw = buildTotalCandidates(markets, projection).filter((c) => c.structuralOk);

  const scored = raw
    .map((o) =>
      enrichFootballCandidate(
        { ...o, confidence: analysis.confidence },
        analysis,
        game.league,
        'totals'
      )
    )
    .filter((o) => o.tier && o.ev >= footballConfig.minEvThreshold);

  scored.sort((a, b) => b.score - a.score || b.ev - a.ev);
  return scored[0] || null;
}

export async function pickFootballGameRecommendations(game, markets, analysis, baseReasoning, propsContext = {}) {
  const results = [];
  const usedMarkets = new Set();

  const h2h = pickH2hCandidates(game, markets, analysis);
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
    else if (pick.market === 'spreads') reasoningParts.push(`讓球 ${pick.line}`);
    else if (pick.market === 'totals') {
      reasoningParts.push(
        `模型 ${pick.modelTotal?.toFixed(1) ?? pick.projectedTotal?.toFixed(1) ?? '?'} 球 · 盤口 ${pick.line}`
      );
    }

    results.push({
      ...pick,
      reasoning: reasoningParts.join(' | '),
      bookmaker: pick.odds?.bookmaker || pick.bookmaker,
    });
    usedMarkets.add(pick.market);
  }

  if (footballConfig.enablePlayerProps && propsContext.propsMap) {
    const props = await pickFootballPropCandidates(
      game,
      propsContext.propsMap,
      analysis,
      propsContext
    );
    for (const p of props) {
      if (usedMarkets.has(`${p.market}|${p.pick}`)) continue;
      results.push({
        ...p,
        isPrimary: false,
        reasoning: `${baseReasoning} | 球員盤`,
        bookmaker: p.bookmaker,
      });
      usedMarkets.add(`${p.market}|${p.pick}`);
    }
  }

  return results
    .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0) || b.score - a.score)
    .slice(0, footballConfig.maxPicksPerGame);
}
