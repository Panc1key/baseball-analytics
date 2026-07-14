/**
 * 網球總局數模型（games totals）
 */
import { tennisConfig, isBestOf5Tournament } from '../config.js';
import { probGamesOver } from '../utils/tennisOdds.js';
import { calibrateModelProb, calcEV, decimalToImpliedProb, decimalToNetOdds } from '../../utils/odds.js';

export function extractMarketTotals(bookmakers, leagueAvg = 22.5) {
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

/**
 * 勢均力敵 → 局數偏多；一邊倒 → 局數偏少
 */
export function projectMatchGames({
  leagueCode,
  homeWinProb,
  homeProfile,
  awayProfile,
  bookmakers,
}) {
  const factors = [];
  const bo5 = isBestOf5Tournament(leagueCode);
  const base = bo5 ? tennisConfig.avgGamesBo5 : tennisConfig.avgGamesBo3;

  const gap = Math.abs((homeWinProb ?? 0.5) - 0.5);
  // gap 0 → +2.5 局；gap 0.25 → -3 局
  let modelTotal = base + (0.25 - gap) * 14;

  if (homeProfile?.avgGamesPlayed && awayProfile?.avgGamesPlayed) {
    const hist = (homeProfile.avgGamesPlayed + awayProfile.avgGamesPlayed) / 2;
    modelTotal = modelTotal * 0.55 + hist * 0.45;
    factors.push(`歷史均局 ${hist.toFixed(1)}`);
  }

  factors.push(`基準 ${base.toFixed(1)} 局 · 實力差 ${(gap * 100).toFixed(0)}pt → 模型 ${modelTotal.toFixed(1)}`);

  const market = extractMarketTotals(bookmakers, base);
  let finalTotal = modelTotal;
  let dataQuality = 0.3;

  if (homeProfile?.hasIntel || awayProfile?.hasIntel) dataQuality += 0.25;
  if (market) {
    const blend = dataQuality >= 0.5 ? 0.45 : 0.6;
    finalTotal = modelTotal * (1 - blend) + market.line * blend;
    factors.push(
      `市場 ${market.line}（大${((market.marketOverProb || 0.5) * 100).toFixed(0)}%）· 混合 ${(blend * 100).toFixed(0)}%`
    );
    dataQuality += 0.25;
  }

  const lo = bo5 ? 28 : 15;
  const hi = bo5 ? 55 : 38;
  modelTotal = Math.max(lo, Math.min(hi, modelTotal));
  finalTotal = Math.max(lo, Math.min(hi, finalTotal));

  return {
    modelTotal,
    finalTotal,
    marketLine: market?.line ?? null,
    marketOverProb: market?.marketOverProb ?? null,
    modelMarketGap: market ? Math.abs(modelTotal - market.line) : null,
    dataQuality: Math.min(1, dataQuality),
    factors,
    bestOf5: bo5,
  };
}

export function shouldSkipTennisTotalLine({ projection, line, isOver, modelProb, impliedProb }) {
  const edgePct = (modelProb - impliedProb) * 100;
  const minEdge = tennisConfig.totalsMinEdgePct ?? 2;
  const minContrarian = tennisConfig.totalsMinContrarianEdgePct ?? 5;
  const minGap = tennisConfig.totalsMinLineGap ?? 1;
  const minSignal = tennisConfig.totalsMinModelMarketGap ?? 0.8;

  const modelTotal = projection.modelTotal;
  const marketLine = projection.marketLine ?? line;
  const modelMarketGap = projection.modelMarketGap ?? Math.abs(modelTotal - marketLine);

  if (modelMarketGap < minSignal) {
    return { skip: true, reason: `模型${modelTotal.toFixed(1)}≈市場${marketLine}` };
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
  const scale = tennisConfig.totalsScale ?? 3.5;

  for (const [, total] of Object.entries(markets.totals || {})) {
    if (total.point == null) continue;
    const isOver = total.name === 'Over';
    const line = total.point;
    const rawProb = isOver
      ? probGamesOver(projection.modelTotal, line, scale)
      : 1 - probGamesOver(projection.modelTotal, line, scale);
    const impliedProb = decimalToImpliedProb(total.price);
    const modelProb = calibrateModelProb(rawProb, impliedProb, tennisConfig.maxModelEdgePct);
    const ev = calcEV(modelProb, decimalToNetOdds(total.price));
    const gate = shouldSkipTennisTotalLine({
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
