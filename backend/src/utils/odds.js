/**
 * 賠率與 EV 計算工具
 */

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

/** 依勝率與讓分線估算蓋盤機率 */
export function estimateCoverProb(winProb, spreadPoint) {
  const absLine = Math.abs(spreadPoint);
  if (spreadPoint < 0) {
    return Math.max(0.05, Math.min(0.95, winProb - absLine * 0.12 - 0.04));
  }
  return Math.max(0.05, Math.min(0.95, winProb + absLine * 0.08));
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
