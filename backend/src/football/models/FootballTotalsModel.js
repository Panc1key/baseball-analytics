/**
 * 足球大小球模型（總進球）
 * 核心原則：模型預估方向必須與推薦一致，禁止「預估 2.6 球卻推小 2.25」
 */
import { footballConfig } from '../config.js';
import { probGoalsOver } from '../utils/footballOdds.js';
import { calibrateModelProb, calcEV, decimalToImpliedProb, decimalToNetOdds } from '../../utils/odds.js';

const LEAGUE_AVG_GOALS = { WC: 2.72, EPL: 2.78, DEFAULT: 2.58 };

/** 提取主盤大小球線 + 市場大球隱含概率 */
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

function clampGoals(v, min = 1.2, max = 4.5) {
  return Math.max(min, Math.min(max, v));
}

function blendRate(observed, games, leagueAvgHalf) {
  if (!games || games <= 0) return leagueAvgHalf;
  const weight = games >= 4 ? 0.85 : games >= 2 ? 0.6 : 0.35;
  return clampGoals(observed * weight + leagueAvgHalf * (1 - weight), 0.6, 2.6);
}

/** 淘汰賽情境：強隊晉級戰、強弱分明 */
function applyKnockoutContext(modelTotal, marketH2h, factors) {
  if (!marketH2h) return modelTotal;

  const fav = Math.max(marketH2h.homeProb, marketH2h.awayProb);
  const dog = Math.min(marketH2h.homeProb, marketH2h.awayProb);
  const draw = marketH2h.drawProb ?? 0.24;

  let adj = 0;

  // 強隊碾壓弱隊（法國 vs 摩洛哥）：強隊進攻空間大
  if (fav >= 0.55 && dog <= 0.2) {
    adj += 0.32;
    factors.push('淘汰賽強弱分明（強隊進攻） +0.32 球');
  } else if (fav >= 0.5 && dog <= 0.28) {
    adj += 0.18;
    factors.push('淘汰賽一方熱門 +0.18 球');
  }

  // 勢均力敵（英格蘭 vs 挪威）：雙方敢攻
  if (fav <= 0.52 && dog >= 0.28 && draw <= 0.28) {
    adj += 0.15;
    factors.push('勢均力敵開放對決 +0.15 球');
  }

  // 僅在極低和局、雙防守時略降
  if (draw >= 0.3 && fav < 0.45) {
    adj -= 0.1;
    factors.push('和局概率偏高 -0.1 球');
  }

  return modelTotal + adj;
}

export function projectMatchGoals({
  league,
  homeProfile,
  awayProfile,
  bookmakers,
  h2hDrawProb = 0.24,
  marketH2h = null,
}) {
  const factors = [];
  const leagueAvg = LEAGUE_AVG_GOALS[league] ?? LEAGUE_AVG_GOALS.DEFAULT;
  const half = leagueAvg / 2;

  const homeGf = blendRate(homeProfile?.goalsPerGame ?? half, homeProfile?.gamesPlayed ?? 0, half);
  const homeGa = blendRate(homeProfile?.goalsAgainstPerGame ?? half, homeProfile?.gamesPlayed ?? 0, half);
  const awayGf = blendRate(awayProfile?.goalsPerGame ?? half, awayProfile?.gamesPlayed ?? 0, half);
  const awayGa = blendRate(awayProfile?.goalsAgainstPerGame ?? half, awayProfile?.gamesPlayed ?? 0, half);

  const homeExpected = (homeGf + awayGa) / 2;
  const awayExpected = (awayGf + homeGa) / 2;
  let modelTotal = homeExpected + awayExpected;

  factors.push(
    `進攻預期 ${homeExpected.toFixed(2)}+${awayExpected.toFixed(2)}=${modelTotal.toFixed(2)} 球`
  );

  if (homeProfile?.tacticalStyle === 'attacking' || awayProfile?.tacticalStyle === 'attacking') {
    modelTotal += 0.22;
    factors.push('進攻型戰術 +0.22 球');
  }
  if (homeProfile?.tacticalStyle === 'defensive' && awayProfile?.tacticalStyle === 'defensive') {
    modelTotal -= 0.25;
    factors.push('雙方防守戰術 -0.25 球');
  }

  modelTotal = applyKnockoutContext(modelTotal, marketH2h, factors);
  modelTotal = clampGoals(modelTotal);

  const market = extractMarketTotals(bookmakers);
  let finalTotal = modelTotal;
  let dataQuality = 0.3;

  if (homeProfile?.hasIntel || awayProfile?.hasIntel) dataQuality += 0.2;
  if ((homeProfile?.gamesPlayed ?? 0) >= 2 || (awayProfile?.gamesPlayed ?? 0) >= 2) {
    dataQuality += 0.25;
  }

  if (market) {
    const modelMarketGap = Math.abs(modelTotal - market.line);
    // 數據越充分，越信任模型；數據弱時才多參考市場
    const blend = dataQuality >= 0.65 ? 0.35 : dataQuality >= 0.45 ? 0.5 : 0.55;
    finalTotal = modelTotal * (1 - blend) + market.line * blend;

    // 市場大球隱含與模型背離過大時，向市場方向微調
    if (market.marketOverProb >= 0.58 && modelTotal < market.line) {
      finalTotal += 0.15;
      factors.push('市場偏大球，模型上調 +0.15');
    } else if (market.marketOverProb <= 0.42 && modelTotal > market.line) {
      finalTotal -= 0.15;
      factors.push('市場偏小球，模型下調 -0.15');
    }

    factors.push(
      `模型 ${modelTotal.toFixed(2)} 球 · 市場 ${market.line}（大${(market.marketOverProb * 100).toFixed(0)}%）· 混合 ${(blend * 100).toFixed(0)}%`
    );
    dataQuality += 0.2;
  } else {
    factors.push(`預估總進球 ${modelTotal.toFixed(2)}（無市場錨定）`);
  }

  finalTotal = clampGoals(finalTotal);

  return {
    modelTotal,
    finalTotal,
    marketLine: market?.line ?? null,
    marketOverProb: market?.marketOverProb ?? null,
    modelMarketGap: market ? Math.abs(modelTotal - market.line) : null,
    dataQuality: Math.min(1, dataQuality),
    factors,
  };
}

/** 模型方向必須與盤口一致（借鑑棒球 TotalsModel） */
export function shouldSkipFootballTotalLine({ projection, line, isOver, modelProb, impliedProb }) {
  const edgePct = (modelProb - impliedProb) * 100;
  const minEdge = footballConfig.totalsMinEdgePct ?? 1.8;
  const minContrarian = footballConfig.totalsMinContrarianEdgePct ?? 4.5;
  const minGap = footballConfig.totalsMinLineGap ?? 0.2;
  const minSignal = footballConfig.totalsMinModelMarketGap ?? 0.15;

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

  if (!isOver && modelTotal > line) {
    return { skip: true, reason: `預估${modelTotal.toFixed(1)}球高於盤口${line}，不可推小` };
  }
  if (isOver && modelTotal < line) {
    return { skip: true, reason: `預估${modelTotal.toFixed(1)}球低於盤口${line}，不可推大` };
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

  for (const [, total] of Object.entries(markets.totals || {})) {
    if (total.point == null) continue;
    const isOver = total.name === 'Over';
    const line = total.point;

    // 用 modelTotal（非混合後 finalTotal）算概率，避免被市場線拉偏後反向推薦
    const rawProb = isOver
      ? probGoalsOver(projection.modelTotal, line)
      : 1 - probGoalsOver(projection.modelTotal, line);
    const impliedProb = decimalToImpliedProb(total.price);
    const modelProb = calibrateModelProb(rawProb, impliedProb, footballConfig.maxModelEdgePct);
    const ev = calcEV(modelProb, decimalToNetOdds(total.price));
    const edgePct = (modelProb - impliedProb) * 100;

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
      edgePct,
      projectedTotal: projection.modelTotal,
      modelTotal: projection.modelTotal,
      marketLine: projection.marketLine,
      structuralOk: !gate.skip,
      skipReason: gate.reason,
    });
  }

  return candidates;
}
