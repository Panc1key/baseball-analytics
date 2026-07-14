/**
 * 籃球大小分：期望總分 ~ Normal(μ, σ_total)
 * 讓分概率由 BasketAnalysis 共用 margin σ
 */
import { basketballConfig, BASKETBALL_LEAGUE_AVG_TOTAL } from '../config.js';
import { normalTotalOverProb } from './BasketballNormal.js';
import { calibrateModelProb, calcEV, decimalToImpliedProb, decimalToNetOdds } from '../../utils/odds.js';

export function extractMarketTotals(bookmakers, leagueAvg = 220) {
  const pinnacle = bookmakers?.find((b) => /pinnacle/i.test(b.title));
  const books = pinnacle ? [pinnacle] : bookmakers?.slice(0, 3) || [];

  for (const book of books) {
    const totals = book.markets?.find((m) => m.key === 'totals');
    if (!totals) continue;
    const overs = totals.outcomes?.filter((o) => o.name === 'Over' && o.point != null) || [];
    if (!overs.length) continue;

    const main = overs.reduce((best, o) => {
      const dist = Math.abs(o.point - leagueAvg);
      const bestDist = Math.abs(best.point - leagueAvg);
      return dist < bestDist ? o : best;
    });
    const under = totals.outcomes?.find((o) => o.name === 'Under' && o.point === main.point);
    if (!under?.price) continue;

    const overImp = decimalToImpliedProb(main.price);
    const underImp = decimalToImpliedProb(under.price);
    const total = overImp + underImp;
    return {
      line: main.point,
      overPrice: main.price,
      underPrice: under.price,
      marketOverProb: total > 0 ? overImp / total : 0.5,
      bookmaker: book.title,
    };
  }
  return null;
}

export function projectMatchPoints({ league, homeProfile, awayProfile, bookmakers, scoreProjection }) {
  const factors = [];
  const leagueAvg = BASKETBALL_LEAGUE_AVG_TOTAL[league] ?? BASKETBALL_LEAGUE_AVG_TOTAL.DEFAULT;

  const modelTotal = scoreProjection?.modelTotal ?? leagueAvg;
  const homeExpected = scoreProjection?.homeExpected ?? modelTotal / 2;
  const awayExpected = scoreProjection?.awayExpected ?? modelTotal / 2;

  if (scoreProjection?.factors?.length) {
    // 主投影已在 h2h 敘事；此處只補市場
  } else {
    factors.push(`預估總分 ${modelTotal.toFixed(1)}`);
  }

  const market = extractMarketTotals(bookmakers, leagueAvg);
  let finalTotal = modelTotal;
  let dataQuality = scoreProjection ? 0.55 : 0.3;

  if ((homeProfile?.gamesPlayed ?? 0) >= 3 || (awayProfile?.gamesPlayed ?? 0) >= 3) {
    dataQuality += 0.2;
  }

  if (market) {
    const blend = dataQuality >= 0.6 ? 0.35 : 0.5;
    finalTotal = modelTotal * (1 - blend) + market.line * blend;
    factors.push(
      `模型 ${modelTotal.toFixed(1)} · 市場 ${market.line}（大${((market.marketOverProb || 0.5) * 100).toFixed(0)}%）· 混合 ${(blend * 100).toFixed(0)}%`
    );
    dataQuality += 0.2;
  }

  return {
    modelTotal,
    finalTotal,
    homeExpected,
    awayExpected,
    marketLine: market?.line ?? null,
    marketOverProb: market?.marketOverProb ?? null,
    modelMarketGap: market ? Math.abs(modelTotal - market.line) : null,
    dataQuality: Math.min(1, dataQuality),
    factors,
  };
}

export function shouldSkipBasketballTotalLine({ projection, line, isOver, modelProb, impliedProb }) {
  const edgePct = (modelProb - impliedProb) * 100;
  const minEdge = basketballConfig.totalsMinEdgePct ?? 2;
  const minContrarian = basketballConfig.totalsMinContrarianEdgePct ?? 5;
  const minGap = basketballConfig.totalsMinLineGap ?? 1.5;
  const minSignal = basketballConfig.totalsMinModelMarketGap ?? 1.2;

  const modelTotal = projection.modelTotal;
  const marketLine = projection.marketLine ?? line;
  const modelMarketGap = projection.modelMarketGap ?? Math.abs(modelTotal - marketLine);

  if (modelMarketGap < minSignal) {
    return { skip: true, reason: `模型${modelTotal.toFixed(1)}≈市場${marketLine}，無優勢` };
  }

  if (isOver && modelTotal < line + minGap) {
    return { skip: true, reason: `模型${modelTotal.toFixed(1)}未支持大${line}` };
  }
  if (!isOver && modelTotal > line - minGap) {
    return { skip: true, reason: `模型${modelTotal.toFixed(1)}未支持小${line}` };
  }

  if (projection.marketOverProb != null) {
    const marketFavorsOver = projection.marketOverProb >= 0.52;
    if (marketFavorsOver !== isOver && edgePct < minContrarian) {
      return { skip: true, reason: '逆市場且優勢不足' };
    }
  }

  if (edgePct < minEdge) {
    return { skip: true, reason: `優勢不足 ${edgePct.toFixed(1)}%` };
  }
  return { skip: false };
}

export function buildTotalCandidates(markets, projection) {
  const candidates = [];
  const sigma = basketballConfig.totalSigma ?? 14;

  for (const [, total] of Object.entries(markets.totals || {})) {
    if (total.point == null) continue;
    const isOver = total.name === 'Over';
    const line = total.point;
    const rawOver = normalTotalOverProb(projection.modelTotal, line, sigma);
    const rawProb = isOver ? rawOver : 1 - rawOver;
    const impliedProb = decimalToImpliedProb(total.price);
    const modelProb = calibrateModelProb(rawProb, impliedProb, basketballConfig.maxModelEdgePct);
    const ev = calcEV(modelProb, decimalToNetOdds(total.price));

    const gate = shouldSkipBasketballTotalLine({
      projection,
      line,
      isOver,
      modelProb,
      impliedProb,
    });

    candidates.push({
      market: 'totals',
      marketGroup: 'main',
      pick: isOver ? `大 ${line}` : `小 ${line}`,
      line,
      side: isOver ? 'over' : 'under',
      odds: total,
      oddsDecimal: total.price,
      modelProb,
      rawModelProb: rawProb,
      impliedProb,
      ev,
      edgePct: (modelProb - impliedProb) * 100,
      projectedTotal: projection.modelTotal,
      modelTotal: projection.modelTotal,
      marketLine: projection.marketLine,
      structuralOk: !gate.skip,
      skipReason: gate.reason,
    });
  }
  return candidates;
}
