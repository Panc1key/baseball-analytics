/**
 * 賽事型態 → 市場路由 v2（研究用）。
 *
 * - duel（雙邊都穩）→ 大小「小」；獨贏封鎖
 * - high_total（雙邊高分結構）→ 大小「大」；獨贏封鎖
 * - one_sided（單邊崩風險）→ 不下大小 lean；獨贏降級／觀察分差
 * - unclear → 不下 lean；獨贏封鎖
 * - normal → 可看獨贏
 *
 * 不改動預期得分均值。
 */

import {
  buildPregameRegimeSignals,
  scoreGameRegimeFromPregame,
  softRegimeStrengths,
} from './MlbGameRegimeService.js';

export const MLB_REGIME_MARKET_ROUTER_VERSION = 'mlb-regime-market-router-v2';

export function resolveMlbRegimeMarketPlan({
  features,
  signals = null,
  scored = null,
} = {}) {
  const regimeSignals = signals || buildPregameRegimeSignals(features || {});
  const regimeScored = scored || scoreGameRegimeFromPregame(regimeSignals);
  const strengths = softRegimeStrengths(regimeScored);
  const predicted = regimeScored.predicted || 'normal';

  const homeRisk = Number(regimeSignals.homePitchingBlowupRisk) || 0;
  const awayRisk = Number(regimeSignals.awayPitchingBlowupRisk) || 0;
  let blowupSideClarity = 'none';
  if (predicted === 'one_sided') {
    if (homeRisk > awayRisk) blowupSideClarity = 'home_pitching';
    else if (awayRisk > homeRisk) blowupSideClarity = 'away_pitching';
    else blowupSideClarity = 'both_or_unclear';
  } else if (predicted === 'high_total') {
    blowupSideClarity = 'both_or_unclear';
  }

  const base = {
    version: MLB_REGIME_MARKET_ROUTER_VERSION,
    duelScore: regimeScored.duelScore,
    oneSidedScore: regimeScored.oneSidedScore,
    highTotalScore: regimeScored.highTotalScore,
    blowupScore: regimeScored.blowupScore,
    blowupSideClarity,
    strengths,
    actionable: false,
    confidence: 'research',
  };

  if (predicted === 'duel') {
    return {
      ...base,
      primaryMarket: 'totals',
      totalsLean: 'under',
      moneylineAllowed: false,
      moneylinePriority: 'blocked',
      reason: 'both_stable_starters_prefer_totals_under',
      regimePredicted: 'duel',
    };
  }

  if (predicted === 'high_total') {
    return {
      ...base,
      primaryMarket: 'totals',
      totalsLean: 'over',
      moneylineAllowed: false,
      moneylinePriority: 'blocked',
      reason: 'both_sides_high_total_structure_prefer_over',
      regimePredicted: 'high_total',
    };
  }

  if (predicted === 'one_sided') {
    return {
      ...base,
      // 單邊崩：不是自動「大」；先不給大小 lean，避免 1-5／2-11 類映射錯誤
      primaryMarket: 'margin',
      totalsLean: null,
      moneylineAllowed: true,
      moneylinePriority: 'secondary',
      reason: 'one_sided_collapse_risk_no_auto_totals_lean',
      regimePredicted: 'one_sided',
    };
  }

  if (predicted === 'unclear') {
    return {
      ...base,
      primaryMarket: 'totals',
      totalsLean: null,
      moneylineAllowed: false,
      moneylinePriority: 'blocked',
      reason: 'regime_unclear_no_lean',
      regimePredicted: 'unclear',
    };
  }

  return {
    ...base,
    primaryMarket: 'moneyline',
    totalsLean: null,
    moneylineAllowed: true,
    moneylinePriority: 'primary',
    reason: 'normal_moneyline_allowed',
    regimePredicted: 'normal',
  };
}

export function buildMlbRegimeTotalsLeanDecision({
  marketPlan,
  expectedTotal,
  totalLine = 8.5,
  overProbability = null,
  underProbability = null,
} = {}) {
  if (!marketPlan || marketPlan.primaryMarket !== 'totals' || !marketPlan.totalsLean) {
    return null;
  }
  const line = Number(totalLine);
  const total = Number(expectedTotal);
  const lean = marketPlan.totalsLean;
  let modelAgrees = null;
  if (Number.isFinite(total) && Number.isFinite(line)) {
    modelAgrees = lean === 'over' ? total > line : total < line;
  }
  let probability = null;
  if (lean === 'over' && Number.isFinite(Number(overProbability))) {
    probability = Number(overProbability);
  }
  if (lean === 'under' && Number.isFinite(Number(underProbability))) {
    probability = Number(underProbability);
  }
  return {
    market: 'totals',
    lean,
    line: Number.isFinite(line) ? line : null,
    expectedTotal: Number.isFinite(total) ? total : null,
    modelAgrees,
    probability,
    reason: marketPlan.reason,
    researchOnly: true,
  };
}

export function describeMlbRegimeMarketPlan(plan) {
  if (!plan) return '無型態路由';
  if (plan.regimePredicted === 'duel' && plan.totalsLean === 'under') {
    return '雙邊先發都穩 → 主看大小球「小」，暫不主推獨贏';
  }
  if (plan.regimePredicted === 'high_total' && plan.totalsLean === 'over') {
    return '雙邊高分結構 → 主看大小球「大」，暫不主推獨贏';
  }
  if (plan.regimePredicted === 'one_sided') {
    return '單邊崩風險 → 不自動押大小；觀察分差／被打邊，獨贏僅次要';
  }
  if (plan.regimePredicted === 'unclear') {
    return '型態不明 → 不下大小 lean，暫不主推獨贏';
  }
  return '普通場 → 可看獨贏';
}
