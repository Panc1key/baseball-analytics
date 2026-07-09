/**
 * 大小盤（Totals）模型
 * 核心：市場主盤線為錨點 + 球隊進攻/失分 + 球場 + 先發投手
 * 僅在模型與市場方向一致且達門檻時推薦
 */

import { config } from '../config.js';
import {
  calcEV,
  decimalToImpliedProb,
  decimalToNetOdds,
  removeVig,
  calibrateModelProb,
} from '../utils/odds.js';
import { getParkFactor } from '../data/parkFactors.js';

const MLB_LEAGUE_RUNS_PER_GAME = 8.8;
const MLB_TEAM_RUNS_AVG = MLB_LEAGUE_RUNS_PER_GAME / 2;

/** 從戰績計算場均得分/失分 */
export function runsPerGame(mlbTeam) {
  if (!mlbTeam) return MLB_TEAM_RUNS_AVG;
  const gp = (mlbTeam.wins || 0) + (mlbTeam.losses || 0);
  if (!gp) return MLB_TEAM_RUNS_AVG;
  return (mlbTeam.runsScored || 0) / gp;
}

export function runsAllowedPerGame(mlbTeam) {
  if (!mlbTeam) return MLB_TEAM_RUNS_AVG;
  const gp = (mlbTeam.wins || 0) + (mlbTeam.losses || 0);
  if (!gp) return MLB_TEAM_RUNS_AVG;
  return (mlbTeam.runsAllowed || 0) / gp;
}

/** 先發投手質量（越低越強） */
function pitcherRunSuppression(pitcherStats) {
  if (!pitcherStats) return 0;
  const era = pitcherStats.era ?? 4.5;
  const whip = pitcherStats.whip ?? 1.3;
  return (era - 4.5) * 0.12 + (whip - 1.3) * 0.35;
}

/**
 * 單隊預期得分
 * 進攻 vs 對手投手/守備，再乘球場與主場
 */
export function projectTeamRuns({
  offenseRpg,
  oppRunsAllowedRpg,
  oppPitcherStats = null,
  parkFactor = 1,
  isHome = false,
}) {
  const base = (offenseRpg + oppRunsAllowedRpg) / 2;
  let runs = base * parkFactor;
  if (isHome) runs *= 1.02;
  runs += pitcherRunSuppression(oppPitcherStats);
  return Math.max(2.2, Math.min(7.5, runs));
}

/** 從賠率提取市場共識大小盤 */
export function extractMarketTotals(bookmakers) {
  const byLine = new Map();

  for (const book of bookmakers || []) {
    const market = book.markets?.find((m) => m.key === 'totals');
    if (!market?.outcomes?.length) continue;

    const over = market.outcomes.find((o) => o.name === 'Over');
    const under = market.outcomes.find((o) => o.name === 'Under');
    if (!over?.point || !over.price || !under?.price) continue;

    const line = over.point;
    if (!byLine.has(line)) {
      byLine.set(line, { line, books: 0, overPrices: [], underPrices: [] });
    }
    const row = byLine.get(line);
    row.books += 1;
    row.overPrices.push(over.price);
    row.underPrices.push(under.price);
  }

  if (!byLine.size) return null;

  let best = null;
  for (const row of byLine.values()) {
    const avgOver = row.overPrices.reduce((a, b) => a + b, 0) / row.overPrices.length;
    const avgUnder = row.underPrices.reduce((a, b) => a + b, 0) / row.underPrices.length;
    const fair = removeVig(decimalToImpliedProb(avgOver), decimalToImpliedProb(avgUnder));
    const candidate = {
      line: row.line,
      books: row.books,
      overImplied: decimalToImpliedProb(avgOver),
      underImplied: decimalToImpliedProb(avgUnder),
      fairOverProb: fair.fairA,
      fairUnderProb: fair.fairB,
      avgOverPrice: avgOver,
      avgUnderPrice: avgUnder,
    };
    if (!best || row.books > best.books || (row.books === best.books && row.line > best.line)) {
      best = candidate;
    }
  }

  return best;
}

/** 大於盤口線機率（總分變異較大，斜率較平） */
export function probOverAtLine(projectedTotal, line, steepness = 2.0) {
  const diff = projectedTotal - (line + 0.5);
  return 1 / (1 + Math.exp(-diff / steepness));
}

export function resolveTotalsMarketBlend(league, hasMlbCore, hasPitchers, hasMarket) {
  if (!hasMarket) return 0;
  if (league === 'MLB') {
    if (hasMlbCore && hasPitchers) return config.totalsMarketBlendMlbFull ?? 0.6;
    if (hasMlbCore) return config.totalsMarketBlendMlb ?? 0.65;
    return config.totalsMarketBlendMlbLite ?? 0.7;
  }
  return config.totalsMarketBlendOther ?? 0.75;
}

/**
 * 計算大小盤核心預估
 */
export function computeTotalsProjection({
  league,
  homeMlb = null,
  awayMlb = null,
  homePitcherStats = null,
  awayPitcherStats = null,
  venueName = null,
  bookmakers = [],
}) {
  const parkFactor = league === 'MLB' ? getParkFactor(venueName) : 1.0;
  const market = extractMarketTotals(bookmakers);
  const marketLine = market?.line ?? null;
  const marketOverProb = market?.fairOverProb ?? null;

  let modelTotal = MLB_LEAGUE_RUNS_PER_GAME;
  const factors = [];
  const hasMlbCore = Boolean(homeMlb && awayMlb);
  const hasPitchers = Boolean(homePitcherStats && awayPitcherStats);

  if (league === 'MLB' && hasMlbCore) {
    const homeOff = runsPerGame(homeMlb);
    const awayOff = runsPerGame(awayMlb);
    const homeRa = runsAllowedPerGame(homeMlb);
    const awayRa = runsAllowedPerGame(awayMlb);

    const homeRuns = projectTeamRuns({
      offenseRpg: homeOff,
      oppRunsAllowedRpg: awayRa,
      oppPitcherStats: awayPitcherStats,
      parkFactor,
      isHome: true,
    });
    const awayRuns = projectTeamRuns({
      offenseRpg: awayOff,
      oppRunsAllowedRpg: homeRa,
      oppPitcherStats: homePitcherStats,
      parkFactor,
      isHome: false,
    });
    modelTotal = homeRuns + awayRuns;

    factors.push(
      `模型得分 主${homeRuns.toFixed(1)}+客${awayRuns.toFixed(1)}=${modelTotal.toFixed(1)}` +
        `（主場進攻${homeOff.toFixed(2)} 客進攻${awayOff.toFixed(2)}）`
    );
    if (parkFactor !== 1) factors.push(`球場係數 ${venueName || '未知'} ×${parkFactor.toFixed(2)}`);
  } else if (league === 'MLB' && (homePitcherStats || awayPitcherStats)) {
    const homeEra = homePitcherStats?.era ?? 4.5;
    const awayEra = awayPitcherStats?.era ?? 4.5;
    modelTotal = MLB_LEAGUE_RUNS_PER_GAME + (4.5 - (homeEra + awayEra) / 2) * 0.35;
    factors.push(`僅先發 ERA 估算總分 ${modelTotal.toFixed(1)}`);
  } else {
    modelTotal = { MLB: 8.8, NPB: 8.0, KBO: 9.0 }[league] ?? 8.5;
    factors.push(`聯盟均值總分 ${modelTotal.toFixed(1)}`);
  }

  const marketWeight = resolveTotalsMarketBlend(league, hasMlbCore, hasPitchers, marketLine != null);
  let finalTotal = modelTotal;

  if (marketLine != null) {
    finalTotal = modelTotal * (1 - marketWeight) + marketLine * marketWeight;
    factors.push(
      `市場主盤 ${marketLine} · Over公平${((marketOverProb ?? 0.5) * 100).toFixed(1)}% · 混合${(marketWeight * 100).toFixed(0)}%`
    );
    factors.push(`最終預估總分 ${finalTotal.toFixed(1)}（模型${modelTotal.toFixed(1)}）`);
  }

  const modelMarketGap = marketLine != null ? Math.abs(modelTotal - marketLine) : 0;
  const marketFavorsOver = marketOverProb != null ? marketOverProb >= 0.5 : finalTotal > (marketLine ?? finalTotal);

  return {
    modelTotal,
    finalTotal,
    marketLine,
    marketOverProb,
    marketUnderProb: marketOverProb != null ? 1 - marketOverProb : null,
    marketWeight,
    modelMarketGap,
    marketFavorsOver,
    parkFactor,
    factors,
    hasMlbCore,
    hasPitchers,
    dataQuality: hasMlbCore && hasPitchers ? 0.85 : hasMlbCore ? 0.65 : 0.35,
  };
}

/** 是否應跳過該盤口線 */
export function shouldSkipTotalLine({ projection, line, isOver, modelProb, impliedProb }) {
  const edgePct = (modelProb - impliedProb) * 100;
  const minEdge = config.totalsMinEdgePct ?? 2;
  const minContrarian = config.totalsMinContrarianEdgePct ?? 5;
  const minSignal = config.totalsMinModelMarketGap ?? 0.35;
  const maxGap = config.totalsMaxModelMarketGap ?? 1.2;

  const marketLine = projection.marketLine ?? line;
  const modelTotal = projection.modelTotal;
  const modelMarketGap = projection.modelMarketGap ?? Math.abs(modelTotal - marketLine);

  // 模型與市場總分幾乎一致 → 無資訊優勢，不推
  if (modelMarketGap < minSignal) {
    return { skip: true, reason: `模型${modelTotal.toFixed(1)}≈市場${marketLine}，無優勢` };
  }

  const modelFavorsOver = modelTotal > marketLine + 0.15;
  const modelFavorsUnder = modelTotal < marketLine - 0.15;

  if (isOver && !modelFavorsOver) {
    return { skip: true, reason: '模型未看好大分' };
  }
  if (!isOver && !modelFavorsUnder) {
    return { skip: true, reason: '模型未看好小分' };
  }

  // 市場定低盤（強投手戰）但模型偏高 → 不輕易博大
  if (isOver && marketLine <= modelTotal - 1.2 && edgePct < minContrarian) {
    return { skip: true, reason: '市場低盤線，模型不應博大' };
  }
  // 市場定高盤但模型偏低 → 不輕易博小
  if (!isOver && marketLine >= modelTotal + 1.2 && edgePct < minContrarian) {
    return { skip: true, reason: '市場高盤線，模型不應博小' };
  }

  if (edgePct < minEdge) {
    return { skip: true, reason: `優勢不足 ${edgePct.toFixed(1)}%` };
  }

  if (modelMarketGap > maxGap && ((isOver && modelFavorsUnder) || (!isOver && modelFavorsOver))) {
    return { skip: true, reason: '模型與市場嚴重背離' };
  }

  if (projection.marketOverProb != null) {
    const marketDirOver = projection.marketOverProb >= 0.5;
    if (marketDirOver !== isOver && edgePct < minContrarian) {
      return { skip: true, reason: '逆市場且優勢不足' };
    }
  }

  return { skip: false };
}

/**
 * 為所有可用大小盤線計算候選
 */
export function buildTotalCandidates(markets, projection, league) {
  const candidates = [];

  for (const [, total] of Object.entries(markets.totals || {})) {
    const isOver = total.name === 'Over';
    const line = total.point;
    const rawProb = isOver
      ? probOverAtLine(projection.modelTotal, line)
      : 1 - probOverAtLine(projection.modelTotal, line);
    const impliedProb = decimalToImpliedProb(total.price);
    const modelProb = calibrateModelProb(rawProb, impliedProb, config.maxModelEdgePct);
    const ev = calcEV(modelProb, decimalToNetOdds(total.price));
    const edgePct = (modelProb - impliedProb) * 100;

    const gate = shouldSkipTotalLine({
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
      projectedTotal: projection.finalTotal,
      modelTotal: projection.modelTotal,
      marketLine: projection.marketLine,
      structuralOk: !gate.skip,
      skipReason: gate.reason,
    });
  }

  return candidates;
}
