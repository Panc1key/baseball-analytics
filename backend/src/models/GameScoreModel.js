/**
 * 統一得分模型：Poisson（± Dixon–Coles）推算獨贏 / 讓分 / 大小
 * 與 TotalsModel 共用 homeRuns / awayRuns，確保三盤口邏輯一致
 * 契約見 ModelPipeline.js
 */

import { config } from '../config.js';
import { dixonColesTau } from './DixonColes.js';

const MAX_RUNS = 24;
const FACTORIAL_CACHE = [1];
for (let i = 1; i <= MAX_RUNS; i++) {
  FACTORIAL_CACHE[i] = FACTORIAL_CACHE[i - 1] * i;
}

export function poissonPmf(k, lambda) {
  if (k < 0 || lambda <= 0) return k === 0 && lambda <= 0 ? 1 : 0;
  if (k > MAX_RUNS) return 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / FACTORIAL_CACHE[k];
}

/** 聯合計分質量（獨立泊松 × DC τ） */
export function jointScoreProb(h, a, homeLambda, awayLambda, rho = 0) {
  return (
    poissonPmf(h, homeLambda) *
    poissonPmf(a, awayLambda) *
    dixonColesTau(h, a, homeLambda, awayLambda, rho)
  );
}

/** 九局得分分布；tie 交由延長賽分配，不能全部算作客勝。 */
export function poissonOutcomeProbabilities(
  homeLambda,
  awayLambda,
  maxRuns = MAX_RUNS,
  rho = 0
) {
  let homeWin = 0;
  let awayWin = 0;
  let tie = 0;
  for (let h = 0; h <= maxRuns; h++) {
    for (let a = 0; a <= maxRuns; a++) {
      const p = jointScoreProb(h, a, homeLambda, awayLambda, rho);
      if (h > a) homeWin += p;
      else if (a > h) awayWin += p;
      else tie += p;
    }
  }
  const mass = homeWin + awayWin + tie;
  if (mass > 0) {
    homeWin /= mass;
    awayWin /= mass;
    tie /= mass;
  }
  return { homeWin, awayWin, tie };
}

/** 主隊最終獨贏機率：九局勝 + 九局平手 × 延長賽主勝率。 */
export function poissonHomeWinProb(
  homeLambda,
  awayLambda,
  maxRuns = MAX_RUNS,
  extraInningsHomeProb = 0.5,
  rho = 0
) {
  const outcome = poissonOutcomeProbabilities(homeLambda, awayLambda, maxRuns, rho);
  const extras = Math.max(0.35, Math.min(0.65, extraInningsHomeProb));
  const prob = outcome.homeWin + outcome.tie * extras;
  return Math.max(0.05, Math.min(0.95, prob));
}

/**
 * 讓分蓋盤機率（Poisson 精確計算）
 * @param {number} spreadPoint - 受讓方視角（+1.5 / -1.5）
 * @param {boolean} pickIsHome - 推薦隊是否為主隊
 */
export function poissonCoverProb(
  homeLambda,
  awayLambda,
  spreadPoint,
  pickIsHome,
  maxRuns = MAX_RUNS,
  rho = 0
) {
  return poissonCoverDistribution(
    homeLambda,
    awayLambda,
    spreadPoint,
    pickIsHome,
    maxRuns,
    rho
  ).winProb;
}

/** 讓分勝/負/push 分布。整數盤必須保留 push，不能當成輸。 */
export function poissonCoverDistribution(
  homeLambda,
  awayLambda,
  spreadPoint,
  pickIsHome,
  maxRuns = MAX_RUNS,
  rho = 0
) {
  let winProb = 0;
  let lossProb = 0;
  let pushProb = 0;
  for (let h = 0; h <= maxRuns; h++) {
    for (let a = 0; a <= maxRuns; a++) {
      const p = jointScoreProb(h, a, homeLambda, awayLambda, rho);
      const teamMargin = pickIsHome ? h - a : a - h;
      const adjusted = teamMargin + spreadPoint;
      if (adjusted > 0) winProb += p;
      else if (adjusted < 0) lossProb += p;
      else pushProb += p;
    }
  }
  const mass = winProb + lossProb + pushProb;
  if (mass > 0) {
    winProb /= mass;
    lossProb /= mass;
    pushProb /= mass;
  }
  return { winProb, lossProb, pushProb };
}

/** 大於總分盤口線的機率 */
export function poissonTotalOverProb(homeLambda, awayLambda, line, maxRuns = MAX_RUNS, rho = 0) {
  return poissonTotalDistribution(homeLambda, awayLambda, line, maxRuns, rho).overProb;
}

/** 大小盤 over/under/push 分布。 */
export function poissonTotalDistribution(
  homeLambda,
  awayLambda,
  line,
  maxRuns = MAX_RUNS,
  rho = 0
) {
  let overProb = 0;
  let underProb = 0;
  let pushProb = 0;
  for (let h = 0; h <= maxRuns; h++) {
    for (let a = 0; a <= maxRuns; a++) {
      const p = jointScoreProb(h, a, homeLambda, awayLambda, rho);
      const total = h + a;
      if (total > line) overProb += p;
      else if (total < line) underProb += p;
      else pushProb += p;
    }
  }
  const mass = overProb + underProb + pushProb;
  if (mass > 0) {
    overProb /= mass;
    underProb /= mass;
    pushProb /= mass;
  }
  return { overProb, underProb, pushProb };
}

export function clampGameProb(prob, min = 0.22, max = 0.78) {
  return Math.max(min, Math.min(max, prob));
}

/**
 * SSOT：有 λ 時以泊松獨贏為主；Elo/Log5 僅輕量錨定 + 延長賽平手分配
 * blend = 泊松權重（越高越接近單一生成真相）
 */
export function blendScoreWithLog5({
  log5HomeProb,
  homeRuns,
  awayRuns,
  hasMlbCore,
  hasPitchers,
  hasNpbStrength = false,
  rho = 0,
}) {
  if (homeRuns == null || awayRuns == null) {
    return {
      homeWinProb: log5HomeProb,
      scoreHomeProb: null,
      scoreBlend: 0,
    };
  }
  if (!hasMlbCore && !hasNpbStrength) {
    return {
      homeWinProb: log5HomeProb,
      scoreHomeProb: null,
      scoreBlend: 0,
    };
  }

  const extrasHomeProb = Math.max(
    0.45,
    Math.min(0.55, 0.5 + (log5HomeProb - 0.5) * 0.2)
  );
  const scoreHomeProb = poissonHomeWinProb(
    homeRuns,
    awayRuns,
    MAX_RUNS,
    extrasHomeProb,
    rho
  );

  let blend;
  if (hasMlbCore) {
    blend = hasPitchers
      ? (config.scoreModelBlendMlbFull ?? 0.85)
      : (config.scoreModelBlendMlb ?? 0.75);
  } else {
    blend = config.scoreModelBlendNpb ?? 0.8;
  }
  // SSOT 下限：避免擬合權重把泊松稀釋成第二真相
  const minW = config.ssotPoissonMinWeight ?? 0.72;
  blend = Math.max(minW, Math.min(0.95, blend));

  const homeWinProb = clampGameProb(scoreHomeProb * blend + log5HomeProb * (1 - blend));
  return { homeWinProb, scoreHomeProb, scoreBlend: blend };
}


