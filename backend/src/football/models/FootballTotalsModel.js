/**
 * 足球大小球：由 Dixon–Coles 比分矩陣積分 P(total > line)
 * 期望總進球僅作敘事與門檻；確率一律走分佈
 */
import { footballConfig } from '../config.js';
import { totalFromGrid } from './DixonColesScoreModel.js';
import { calibrateModelProb, calcEV, decimalToImpliedProb, decimalToNetOdds } from '../../utils/odds.js';

export function extractMarketTotals(bookmakers) {
  const pinnacle = bookmakers?.find((b) => /pinnacle/i.test(b.title));
  const books = pinnacle ? [pinnacle] : bookmakers?.slice(0, 3) || [];

  for (const book of books) {
    const totals = book.markets?.find((m) => m.key === 'totals');
    if (!totals) continue;

    const overs = totals.outcomes?.filter((o) => o.name === 'Over' && o.point != null) || [];
    if (!overs.length) continue;

    const main = overs.reduce((best, o) => {
      const dist = Math.abs(o.point - 2.5);
      const bestDist = Math.abs(best.point - 2.5);
      return dist < bestDist ? o : best;
    });

    const under = totals.outcomes?.find(
      (o) => o.name === 'Under' && o.point === main.point
    );
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

/**
 * 投影包裝：總分期望來自 λ+μ；分佈來自 scoreGrid
 */
export function projectMatchGoals({
  homeLambda,
  awayLambda,
  scoreGrid,
  bookmakers,
  xgFactors = [],
}) {
  const factors = [...xgFactors];
  const modelTotal = (homeLambda ?? 0) + (awayLambda ?? 0);
  const market = extractMarketTotals(bookmakers);

  let finalTotal = modelTotal;
  let dataQuality = scoreGrid ? 0.55 : 0.3;

  if (market) {
    const blend = dataQuality >= 0.55 ? 0.35 : 0.5;
    finalTotal = modelTotal * (1 - blend) + market.line * blend;
    factors.push(
      `模型總進球 ${modelTotal.toFixed(2)} · 市場 ${market.line}（大${(market.marketOverProb * 100).toFixed(0)}%）· 混合 ${(blend * 100).toFixed(0)}%`
    );
    dataQuality += 0.2;
  } else {
    factors.push(`模型總進球 ${modelTotal.toFixed(2)}（無市場錨定）`);
  }

  return {
    modelTotal,
    finalTotal,
    homeLambda,
    awayLambda,
    scoreGrid,
    marketLine: market?.line ?? null,
    marketOverProb: market?.marketOverProb ?? null,
    modelMarketGap: market ? Math.abs(modelTotal - market.line) : null,
    dataQuality: Math.min(1, dataQuality),
    factors,
  };
}

export function shouldSkipFootballTotalLine({ projection, line, isOver, modelProb, impliedProb }) {
  const edgePct = (modelProb - impliedProb) * 100;
  const minEdge = footballConfig.totalsMinEdgePct ?? 1.8;
  const minContrarian = footballConfig.totalsMinContrarianEdgePct ?? 4.5;
  const minGap = footballConfig.totalsMinLineGap ?? 0.15;
  const minSignal = footballConfig.totalsMinModelMarketGap ?? 0.12;

  const modelTotal = projection.modelTotal;
  const marketLine = projection.marketLine ?? line;
  const modelMarketGap = projection.modelMarketGap ?? Math.abs(modelTotal - marketLine);

  if (modelMarketGap < minSignal) {
    return { skip: true, reason: `模型${modelTotal.toFixed(1)}≈市場${marketLine}，無優勢` };
  }

  const modelFavorsOver = modelTotal >= line + minGap;
  const modelFavorsUnder = modelTotal <= line - minGap;

  if (isOver && !modelFavorsOver) {
    return { skip: true, reason: `模型${modelTotal.toFixed(1)}球未支持大${line}` };
  }
  if (!isOver && !modelFavorsUnder) {
    return { skip: true, reason: `模型${modelTotal.toFixed(1)}球未支持小${line}` };
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
  const grid = projection.scoreGrid;

  for (const [, total] of Object.entries(markets.totals || {})) {
    if (total.point == null) continue;
    const isOver = total.name === 'Over';
    const line = total.point;

    let rawProb;
    if (grid) {
      const dist = totalFromGrid(grid, line);
      // push 退本：計價用 over/(over+under) 或把 push 均分不進輸贏
      const decisive = dist.overProb + dist.underProb;
      rawProb = isOver
        ? decisive > 0
          ? dist.overProb / decisive
          : 0.5
        : decisive > 0
          ? dist.underProb / decisive
          : 0.5;
    } else {
      // fallback（不應常發生）
      const diff = projection.modelTotal - line;
      rawProb = isOver ? 1 / (1 + Math.exp(-diff / 0.42)) : 1 / (1 + Math.exp(diff / 0.42));
    }

    const impliedProb = decimalToImpliedProb(total.price);
    const modelProb = calibrateModelProb(rawProb, impliedProb, footballConfig.maxModelEdgePct);
    const ev = calcEV(modelProb, decimalToNetOdds(total.price));

    const gate = shouldSkipFootballTotalLine({
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
