/**
 * 獨贏（Moneyline / H2H）勝率模型
 * MLB：Pythagorean + 近況 + 先發投手 + 傷兵 + 市場校準
 * NPB/KBO：滾動 Elo + RPG/RAPG 泊松 + 市場校準
 */

import { decimalToImpliedProb, removeVig } from '../utils/odds.js';
import { config } from '../config.js';
import { blendScoreWithLog5 } from '../models/GameScoreModel.js';
import { eloHomeWinProb, eloToStrength, getTeamElo } from './BaseballElo.js';
import { getDixonColesRho } from '../models/DixonColes.js';

const PYTH_EXPONENT = 1.83;
/** MLB 主場優勢（勝率尺度，供 Log5 / 情境分共用） */
export const MLB_HOME_FIELD = 0.035;

export function parseL10Rate(last10) {
  if (!last10 || last10 === 'N/A') return null;
  const [w, l] = last10.split('-').map((n) => parseInt(n, 10));
  if (Number.isNaN(w) || Number.isNaN(l) || w + l === 0) return null;
  return w / (w + l);
}

/** Pythagorean 期望勝率（比實際戰績更能預測未來） */
export function pythagoreanWinPct(runsScored, runsAllowed, exponent = PYTH_EXPONENT) {
  const rs = Number(runsScored);
  const ra = Number(runsAllowed);
  if (!rs || !ra || rs + ra <= 0) return null;
  const rsE = Math.pow(rs, exponent);
  const raE = Math.pow(ra, exponent);
  return rsE / (rsE + raE);
}

/**
 * Log5：兩隊實力轉單場勝率（棒球分析常用）
 * pA、pB 為 0~1 的球隊實力估計
 */
export function log5WinProb(pA, pB) {
  const a = Math.max(0.01, Math.min(0.99, pA));
  const b = Math.max(0.01, Math.min(0.99, pB));
  const den = a + b - 2 * a * b;
  if (den <= 0) return 0.5;
  return (a - a * b) / den;
}

/** MLB 球隊綜合實力（0~1） */
export function buildMlbTeamStrength(mlbTeam) {
  if (!mlbTeam) return 0.5;

  const season = mlbTeam.winPct || 0.5;
  const pyth = pythagoreanWinPct(mlbTeam.runsScored, mlbTeam.runsAllowed) ?? season;
  const l10 = parseL10Rate(mlbTeam.last10) ?? season;

  // Pythagorean 權重最高，減少「運氣戰績」干擾
  return season * 0.25 + pyth * 0.45 + l10 * 0.3;
}

/** 先發投手對單場勝率的邊際影響（保守估計） */
export function estimatePitcherEdge(homePitcher, awayPitcher) {
  if (!homePitcher || !awayPitcher) return 0;

  const homeEra = homePitcher.era || 4.5;
  const awayEra = awayPitcher.era || 4.5;
  const homeWhip = homePitcher.whip || 1.3;
  const awayWhip = awayPitcher.whip || 1.3;

  // 綜合 ERA + WHIP，數值越低投手越強
  const homeQuality = homeEra * 0.55 + homeWhip * 2.8;
  const awayQuality = awayEra * 0.55 + awayWhip * 2.8;
  const qualityDiff = awayQuality - homeQuality;

  // 先發大約影響單場 30~40%，係數刻意保守
  return Math.max(-0.045, Math.min(0.045, qualityDiff * 0.01));
}

/** 傷兵對球隊實力的折損 */
export function injuryStrengthPenalty(injuryCount) {
  if (!injuryCount) return 0;
  return Math.min(0.035, injuryCount * 0.006);
}

/** 從莊家提取獨贏公平概率（去抽水） */
export function extractFairH2hProb(bookmakers, homeTeam, awayTeam) {
  const pinnacle = bookmakers?.find((b) => /pinnacle/i.test(b.title));
  const books = pinnacle ? [pinnacle] : bookmakers?.slice(0, 3) || [];

  for (const book of books) {
    const h2h = book.markets?.find((m) => m.key === 'h2h');
    if (!h2h) continue;

    const homeOutcome = h2h.outcomes?.find((o) => o.name === homeTeam);
    const awayOutcome = h2h.outcomes?.find((o) => o.name === awayTeam);
    if (!homeOutcome?.price || !awayOutcome?.price) continue;

    const hp = decimalToImpliedProb(homeOutcome.price);
    const ap = decimalToImpliedProb(awayOutcome.price);
    const fair = removeVig(hp, ap);

    return {
      homeProb: fair.fairA,
      awayProb: fair.fairB,
      bookmaker: book.title,
    };
  }
  return null;
}

/** 依數據完整度決定市場權重（數據越弱，越依賴市場） */
export function resolveMarketBlend(league, hasMlbCore, hasPitchers, hasMarket, hasNpbStrength = false) {
  if (!hasMarket) return 0;
  if (league === 'MLB') {
    if (hasMlbCore && hasPitchers) return config.h2hMarketBlendMlbFull ?? 0.4;
    if (hasMlbCore) return config.h2hMarketBlendMlb ?? 0.45;
    return config.h2hMarketBlendMlbLite ?? 0.5;
  }
  // NPB/KBO：有 Elo + 得失分時降低貼市權重
  if ((league === 'NPB' || league === 'KBO') && hasNpbStrength) {
    return config.h2hMarketBlendNpbFull ?? 0.38;
  }
  return config.h2hMarketBlendOther ?? 0.55;
}

export function blendWithMarket(modelProb, marketProb, marketWeight) {
  if (marketProb == null || marketWeight <= 0) return modelProb;
  const w = Math.max(0, Math.min(0.7, marketWeight));
  return modelProb * (1 - w) + marketProb * w;
}

export function clampProb(prob, min = 0.22, max = 0.78) {
  return Math.max(min, Math.min(max, prob));
}

/**
 * 計算獨贏勝率
 * @returns {{ homeWinProb, awayWinProb, confidence, factors, marketHomeProb, components }}
 */
export function computeH2hProbabilities({
  league,
  homeTeam,
  awayTeam,
  bookmakers,
  homeMlb = null,
  awayMlb = null,
  homePitcherStats = null,
  awayPitcherStats = null,
  homeInjuryCount = 0,
  awayInjuryCount = 0,
  homeStarPenalty = 0,
  awayStarPenalty = 0,
  homeStarHits = null,
  awayStarHits = null,
  homeFallbackRating = 0.5,
  awayFallbackRating = 0.5,
  venueName = null,
  homeRuns = null,
  awayRuns = null,
  hasNpbStrength = false,
  eloOverride = null,
}) {
  const factors = [];
  let homeStrength = homeFallbackRating;
  let awayStrength = awayFallbackRating;
  let hasMlbCore = false;
  let hasPitchers = false;
  let pitcherEdge = 0;
  const starHome = Math.max(0, Number(homeStarPenalty) || 0);
  const starAway = Math.max(0, Number(awayStarPenalty) || 0);
  let eloHome = null;
  let eloAway = null;
  const useEloFamily =
    (league === 'NPB' || league === 'KBO') && hasNpbStrength;
  const rho = getDixonColesRho(league);

  if (league === 'MLB' && (homeMlb || awayMlb)) {
    hasMlbCore = Boolean(homeMlb && awayMlb);
    if (homeMlb) {
      homeStrength = buildMlbTeamStrength(homeMlb);
      homeStrength -= injuryStrengthPenalty(homeInjuryCount);
      const pyth = pythagoreanWinPct(homeMlb.runsScored, homeMlb.runsAllowed);
      factors.push(
        `${homeTeam} 戰績 ${homeMlb.wins}-${homeMlb.losses} (${((homeMlb.winPct || 0) * 100).toFixed(1)}%)` +
          ` Pyth ${pyth != null ? (pyth * 100).toFixed(1) : 'N/A'}% 近10 ${homeMlb.last10 || 'N/A'}`
      );
      if (homeInjuryCount > 0) factors.push(`${homeTeam} 傷兵 ${homeInjuryCount} 人`);
      if (starHome > 0) {
        const names = (homeStarHits || []).map((h) => h.name).join('、') || '明星';
        factors.push(`${homeTeam} 明星缺陣標記 −${(starHome * 100).toFixed(1)}%（${names}）`);
      }
    }
    if (awayMlb) {
      awayStrength = buildMlbTeamStrength(awayMlb);
      awayStrength -= injuryStrengthPenalty(awayInjuryCount);
      const pyth = pythagoreanWinPct(awayMlb.runsScored, awayMlb.runsAllowed);
      factors.push(
        `${awayTeam} 戰績 ${awayMlb.wins}-${awayMlb.losses} (${((awayMlb.winPct || 0) * 100).toFixed(1)}%)` +
          ` Pyth ${pyth != null ? (pyth * 100).toFixed(1) : 'N/A'}% 近10 ${awayMlb.last10 || 'N/A'}`
      );
      if (awayInjuryCount > 0) factors.push(`${awayTeam} 傷兵 ${awayInjuryCount} 人`);
      if (starAway > 0) {
        const names = (awayStarHits || []).map((h) => h.name).join('、') || '明星';
        factors.push(`${awayTeam} 明星缺陣標記 −${(starAway * 100).toFixed(1)}%（${names}）`);
      }
    }

    if (homePitcherStats && awayPitcherStats) {
      hasPitchers = true;
      pitcherEdge = estimatePitcherEdge(homePitcherStats, awayPitcherStats);
      const scoreModelActive = homeRuns != null && awayRuns != null && hasMlbCore;
      if (!scoreModelActive) {
        homeStrength += pitcherEdge;
      }
      factors.push(
        `先發質量差 ${(pitcherEdge * 100).toFixed(1)}%（主 ERA ${(homePitcherStats.era || 0).toFixed(2)} WHIP ${(homePitcherStats.whip || 0).toFixed(2)}` +
          ` vs 客 ERA ${(awayPitcherStats.era || 0).toFixed(2)} WHIP ${(awayPitcherStats.whip || 0).toFixed(2)}）`
      );
    }
  } else if (useEloFamily) {
    eloHome = getTeamElo(league, homeTeam, eloOverride);
    eloAway = getTeamElo(league, awayTeam, eloOverride);
    homeStrength = eloToStrength(eloHome);
    awayStrength = eloToStrength(eloAway);
    factors.push(
      `${homeTeam} Elo ${eloHome.toFixed(0)} · 實力 ${(homeStrength * 100).toFixed(1)}%`
    );
    factors.push(
      `${awayTeam} Elo ${eloAway.toFixed(0)} · 實力 ${(awayStrength * 100).toFixed(1)}%`
    );
    factors.push(`${league} 隊力：滾動 Elo + 得失分泊松`);
    // 先發已進 λ，此處只暴露 pitcherEdge 給門控／UI，不加 strength（避免雙計）
    if (homePitcherStats?.era != null && awayPitcherStats?.era != null) {
      hasPitchers = true;
      pitcherEdge = estimatePitcherEdge(homePitcherStats, awayPitcherStats);
      factors.push(
        `先發質量差 ${(pitcherEdge * 100).toFixed(1)}%（主 ERA ${(homePitcherStats.era || 0).toFixed(2)} WHIP ${(homePitcherStats.whip || 0).toFixed(2)}` +
          ` vs 客 ERA ${(awayPitcherStats.era || 0).toFixed(2)} WHIP ${(awayPitcherStats.whip || 0).toFixed(2)}）·已入λ`
      );
    }
  } else {
    factors.push(`${homeTeam} 近期實力 ${(homeStrength * 100).toFixed(1)}%`);
    factors.push(`${awayTeam} 近期實力 ${(awayStrength * 100).toFixed(1)}%`);
    if (league === 'NPB' || league === 'KBO') {
      factors.push(`${league} 隊力不足（樣本不足）· 高度貼市`);
    }
  }

  if (venueName) factors.push(`主場 ${venueName}`);

  homeStrength = Math.max(0.05, Math.min(0.95, homeStrength));
  awayStrength = Math.max(0.05, Math.min(0.95, awayStrength));

  // 輔助先驗：NPB/KBO=Elo；MLB=Log5（有 λ 時僅輕量錨定，不作第二套勝率）
  const homeWithField = Math.min(0.95, homeStrength + MLB_HOME_FIELD);
  const priorHomeProb =
    useEloFamily && eloHome != null
      ? clampProb(eloHomeWinProb(eloHome, eloAway))
      : clampProb(log5WinProb(homeWithField, awayStrength));
  if (useEloFamily && eloHome != null) {
    factors.push(`${league} Elo 先驗主勝 ${(priorHomeProb * 100).toFixed(1)}%（輔助）`);
  }

  const scoreBlend = blendScoreWithLog5({
    log5HomeProb: priorHomeProb,
    homeRuns,
    awayRuns,
    hasMlbCore,
    hasPitchers,
    hasNpbStrength,
    rho,
  });
  let modelHomeProb = priorHomeProb;
  if (scoreBlend.scoreBlend > 0) {
    modelHomeProb = scoreBlend.homeWinProb;
    factors.push(
      `SSOT泊松 主勝${((scoreBlend.scoreHomeProb ?? 0) * 100).toFixed(1)}%` +
        ` · 權重${(scoreBlend.scoreBlend * 100).toFixed(0)}%（Elo/Log5僅輔助）`
    );
  } else {
    modelHomeProb = priorHomeProb;
    factors.push('無得分λ · 退回 Elo/Log5 先驗（非完整 SSOT）');
  }

  // 明星缺陣：在泊松混合後、貼市前直接調整勝率（否則 SSOT λ 路徑會沖掉 strength 懲罰）
  if (starHome > 0 || starAway > 0) {
    const before = modelHomeProb;
    modelHomeProb = clampProb(modelHomeProb - starHome + starAway);
    factors.push(
      `明星缺陣調勝率 ${(before * 100).toFixed(1)}%→${(modelHomeProb * 100).toFixed(1)}%` +
        `（主−${(starHome * 100).toFixed(1)} / 客−${(starAway * 100).toFixed(1)}）`
    );
  }

  // 純模型概率：泊松(+輕量先驗)，不含市場
  const rawModelHomeProb = modelHomeProb;

  const fairMarket = extractFairH2hProb(bookmakers, homeTeam, awayTeam);
  const marketHomeProb = fairMarket?.homeProb ?? null;
  const marketWeight = resolveMarketBlend(
    league,
    hasMlbCore,
    hasPitchers,
    marketHomeProb != null,
    hasNpbStrength
  );

  if (marketHomeProb != null) {
    modelHomeProb = blendWithMarket(modelHomeProb, marketHomeProb, marketWeight);
    modelHomeProb = clampProb(modelHomeProb);
    factors.push(
      `市場主隊 ${(marketHomeProb * 100).toFixed(1)}% · 混合權重 ${(marketWeight * 100).toFixed(0)}%`
    );
  }

  const modelAwayProb = 1 - modelHomeProb;
  const confidence = Math.abs(modelHomeProb - 0.5) * 2;

  const pitcherEdgeFinal =
    hasPitchers && homePitcherStats && awayPitcherStats
      ? estimatePitcherEdge(homePitcherStats, awayPitcherStats)
      : pitcherEdge;

  return {
    homeWinProb: modelHomeProb,
    awayWinProb: modelAwayProb,
    rawModelHomeProb,
    rawModelAwayProb: 1 - rawModelHomeProb,
    calibratedHomeProb: modelHomeProb,
    calibratedAwayProb: modelAwayProb,
    confidence,
    factors,
    marketHomeProb,
    marketAwayProb: marketHomeProb != null ? 1 - marketHomeProb : null,
    pitcherEdge: pitcherEdgeFinal,
    components: {
      homeStrength,
      awayStrength,
      homeWithField,
      marketWeight,
      hasMlbCore,
      hasPitchers,
      pitcherEdge: pitcherEdgeFinal,
      rawModelHomeProb,
      marketHomeProb,
      calibratedHomeProb: modelHomeProb,
    },
  };
}
