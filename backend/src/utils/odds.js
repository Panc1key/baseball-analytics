import { config } from '../config.js';
import { poissonCoverDistribution } from '../models/GameScoreModel.js';

/** 美式賠率 → 隱含機率 */
export function americanToImpliedProb(american) {
  const odds = parseFloat(american);
  if (Number.isNaN(odds) || odds === 0) return 0;
  if (odds > 0) {
    return 100 / (odds + 100);
  }
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

/** 美式賠率 → 十進制淨賠率 (不含本金) */
export function americanToDecimal(american) {
  const odds = parseFloat(american);
  if (Number.isNaN(odds) || odds === 0) return 1;
  if (odds > 0) {
    return odds / 100;
  }
  return 100 / Math.abs(odds);
}

/** 十進制賠率 → 隱含機率 */
export function decimalToImpliedProb(decimal) {
  const d = parseFloat(decimal);
  if (Number.isNaN(d) || d <= 1) return 0;
  return 1 / d;
}

/** 十進制賠率 → 淨賠率 */
export function decimalToNetOdds(decimal) {
  const d = parseFloat(decimal);
  if (Number.isNaN(d) || d <= 1) return 0;
  return d - 1;
}

/**
 * 將模型勝率向市場隱含勝率收斂，避免球員盤等過度自信
 * @param {number} maxEdge - 允許超越市場的最大概率點數（如 0.08 = 8%）
 */
export function calibrateModelProb(modelProb, impliedProb, maxEdge = 0.08) {
  if (modelProb == null || impliedProb == null || impliedProb <= 0) return modelProb;
  const floor = Math.max(0.05, impliedProb - 0.05);
  const ceiling = Math.min(0.95, impliedProb + maxEdge);
  return Math.max(floor, Math.min(ceiling, modelProb));
}

/**
 * 計算期望值 EV
 * @param {number} winProb - 模型預測勝率 (0-1)
 * @param {number} netOdds - 淨賠率 (decimal - 1)
 */
export function calcEV(winProb, netOdds) {
  return winProb * netOdds - (1 - winProb);
}

/** 含走盤的每單位 EV：push 退回本金，不計盈虧。 */
export function calcEVWithPush(winProb, pushProb, netOdds) {
  const lossProb = Math.max(0, 1 - winProb - (pushProb || 0));
  return winProb * netOdds - lossProb;
}

/** 移除莊家抽水後的公平機率 (兩方市場) */
export function removeVig(probA, probB) {
  const total = probA + probB;
  if (total <= 0) return { fairA: 0.5, fairB: 0.5 };
  return { fairA: probA / total, fairB: probB / total };
}

/** 從多莊家賠率取最佳線 */
export function getBestOdds(bookmakers, teamName, marketKey = 'h2h') {
  let bestPrice = null;
  let bestBook = null;

  for (const book of bookmakers || []) {
    const market = book.markets?.find((m) => m.key === marketKey);
    if (!market) continue;
    const outcome = market.outcomes?.find((o) => o.name === teamName);
    if (!outcome?.price) continue;
    const decimal = outcome.price;
    if (bestPrice === null || decimal > bestPrice) {
      bestPrice = decimal;
      bestBook = book.title;
    }
  }

  return bestPrice ? { decimal: bestPrice, bookmaker: bestBook } : null;
}

/** 從 bookmakers 提取 h2h / spreads / totals 最佳盤 */
export function extractMarkets(bookmakers) {
  const result = { h2h: {}, spreads: {}, totals: {} };

  for (const book of bookmakers || []) {
    for (const market of book.markets || []) {
      const key = market.key;
      if (!['h2h', 'spreads', 'totals'].includes(key)) continue;

      for (const outcome of market.outcomes || []) {
        const id =
          key === 'totals'
            ? `${outcome.name}_${outcome.point}`
            : key === 'spreads'
              ? `${outcome.name}_${outcome.point}`
              : outcome.name;

        const existing = result[key][id];
        if (!existing || outcome.price > existing.price) {
          result[key][id] = {
            name: outcome.name,
            point: outcome.point ?? null,
            price: outcome.price,
            bookmaker: book.title,
          };
        }
      }
    }
  }

  return result;
}

/** Kelly 下注比例 (半 Kelly 較保守) */
export function halfKelly(winProb, netOdds) {
  if (netOdds <= 0) return 0;
  const kelly = (winProb * netOdds - (1 - winProb)) / netOdds;
  return Math.max(0, kelly * 0.5);
}

/** 從莊家讓分盤提取公平蓋盤率 */
export function extractFairSpreadCoverProb(bookmakers, teamName, spreadPoint) {
  const pinnacle = bookmakers?.find((b) => /pinnacle/i.test(b.title));
  const books = pinnacle ? [pinnacle] : bookmakers?.slice(0, 5) || [];

  for (const book of books) {
    const market = book.markets?.find((m) => m.key === 'spreads');
    if (!market?.outcomes?.length) continue;

    const teamOutcome = market.outcomes.find(
      (o) => o.name === teamName && o.point != null && Math.abs(o.point - spreadPoint) < 0.01
    );
    if (!teamOutcome?.price) continue;

    const oppOutcome = market.outcomes.find(
      (o) => o.name !== teamName && o.point != null && Math.abs(o.point + spreadPoint) < 0.01
    );
    if (!oppOutcome?.price) continue;

    const fair = removeVig(
      decimalToImpliedProb(teamOutcome.price),
      decimalToImpliedProb(oppOutcome.price)
    );

    return {
      coverProb: fair.fairA,
      bookmaker: book.title,
    };
  }

  return null;
}

/** 讓分蓋盤率：模型 + 市場锚定 */
export function blendCoverWithMarket(modelCover, bookmakers, teamName, spreadPoint) {
  const market = extractFairSpreadCoverProb(bookmakers, teamName, spreadPoint);
  const marketWeight = market?.coverProb != null ? (config.spreadsMarketBlend ?? 0.45) : 0;

  let coverProb = modelCover;
  if (marketWeight > 0) {
    coverProb = modelCover * (1 - marketWeight) + market.coverProb * marketWeight;
  }

  return {
    coverProb: Math.max(0.05, Math.min(0.92, coverProb)),
    marketCoverProb: market?.coverProb ?? null,
  };
}

function clampProb(prob, min = 0.05, max = 0.92) {
  return Math.max(min, Math.min(max, prob));
}

/** 無得分模型時的啟發式蓋盤率（fallback） */
export function estimateCoverProbHeuristic(winProb, spreadPoint, options = {}) {
  const { pitcherEdge = 0, pickIsHome = true, oppWinProb } = options;
  const absLine = Math.abs(spreadPoint);
  const opp = oppWinProb ?? 1 - winProb;
  const margin = winProb - opp;
  const pickPitcherEdge = pickIsHome ? pitcherEdge : -pitcherEdge;

  if (spreadPoint > 0) {
    const competitiveness = Math.max(0, Math.min(1, (winProb - 0.36) / 0.22));
    const oneRunLossProb = 0.06 + competitiveness * 0.05;
    const extraRunLossProb = absLine >= 1.5 ? 0.04 + competitiveness * 0.035 : 0;

    let cover = winProb + oneRunLossProb + extraRunLossProb;
    cover += pickPitcherEdge * 0.6;
    cover += Math.max(0, margin) * 0.08;

    if (margin < -0.04) cover -= Math.abs(margin) * 0.35;
    if (pickPitcherEdge < -0.02) cover += pickPitcherEdge * 0.8;
    if (winProb < 0.42) cover = Math.min(cover, winProb + 0.06);

    return clampProb(cover);
  }

  if (spreadPoint < 0) {
    const runPenalty = absLine <= 1 ? 0.11 : 0.14 + (absLine - 1) * 0.07;
    let cover = winProb - runPenalty - Math.max(0, -margin) * 0.15;
    cover += pickPitcherEdge * 0.8;
    if (margin < 0.03) cover -= 0.04;

    return clampProb(cover, 0.05, 0.88);
  }

  return clampProb(winProb);
}

/**
 * 依勝率、讓分線與場景估算蓋盤機率
 * 優先使用 Poisson 得分模型（與大小盤/獨贏一致），fallback 啟發式
 */
export function estimateCoverProbDetails(winProb, spreadPoint, options = {}) {
  const {
    pitcherEdge = 0,
    pickIsHome = true,
    oppWinProb,
    homeRuns,
    awayRuns,
    bookmakers,
    teamName,
  } = options;

  let rawModelProb;
  let pushProb = 0;
  if (homeRuns != null && awayRuns != null) {
    const dist = poissonCoverDistribution(homeRuns, awayRuns, spreadPoint, pickIsHome);
    pushProb = dist.pushProb;
    const decisiveMass = Math.max(1e-9, dist.winProb + dist.lossProb);
    rawModelProb = dist.winProb / decisiveMass;
  } else {
    rawModelProb = estimateCoverProbHeuristic(winProb, spreadPoint, {
      pitcherEdge,
      pickIsHome,
      oppWinProb,
    });
  }

  if (bookmakers?.length && teamName) {
    const blended = blendCoverWithMarket(rawModelProb, bookmakers, teamName, spreadPoint);
    return {
      coverProb: blended.coverProb,
      rawModelProb,
      marketProb: blended.marketCoverProb,
      pushProb,
      probabilityCalibrated: blended.marketCoverProb != null,
    };
  }

  return {
    coverProb: rawModelProb,
    rawModelProb,
    marketProb: null,
    pushProb,
    probabilityCalibrated: false,
  };
}

/** 相容舊呼叫：回傳最終蓋盤率。 */
export function estimateCoverProb(winProb, spreadPoint, options = {}) {
  return estimateCoverProbDetails(winProb, spreadPoint, options).coverProb;
}

const LEAGUE_AVG_TOTAL = { MLB: 8.8, NPB: 8.0, KBO: 9.0 };

/** 估算比賽總得分 */
export function estimateProjectedTotal(league, homeEra = null, awayEra = null) {
  let total = LEAGUE_AVG_TOTAL[league] || 8.5;
  if (homeEra != null && awayEra != null) {
    const avgEra = (homeEra + awayEra) / 2;
    total += (4.5 - avgEra) * 0.35;
  }
  return Math.max(5, Math.min(14, total));
}

/** 大於盤口線的機率 (logistic 近似) */
export function probTotalOver(projectedTotal, line) {
  const diff = projectedTotal - (line + 0.5);
  return 1 / (1 + Math.exp(-diff / 1.2));
}
