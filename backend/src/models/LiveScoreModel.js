/**
 * 滾球條件得分模型 v1.1
 * 對照事故總結加強：一邊倒降速、後期節奏塌陷、接近局主場殘差
 */

import {
  poissonPmf,
  poissonHomeWinProb,
  poissonTotalDistribution,
  poissonTotalOverProb,
} from './GameScoreModel.js';
import { config } from '../config.js';

const MAX_EXTRA_RUNS = 14;
const REGULATION_INNINGS = 9;
const TYPICAL_GAME_MS = 3 * 3600 * 1000;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function estimateInningsPlayed(commenceTime, now = Date.now()) {
  if (!commenceTime) return 1;
  const start = new Date(commenceTime).getTime();
  if (Number.isNaN(start) || now <= start) return 0.3;
  const elapsed = now - start;
  const frac = clamp(elapsed / TYPICAL_GAME_MS, 0, 1.15);
  const innings = frac < 0.15 ? frac * 10 : 1.5 + (frac - 0.15) * (7.5 / 0.85);
  return clamp(innings, 0.4, 8.7);
}

export function estimateInningsRemaining(commenceTime, now = Date.now()) {
  const played = estimateInningsPlayed(commenceTime, now);
  return clamp(REGULATION_INNINGS - played, 0.4, 8.6);
}

/**
 * 一邊倒 / 後期節奏塌陷係數（防線性 pace 外推）
 * 事故：大比分領先後仍高估 Over
 */
export function blowoutSlowdownFactor(absMargin, inningsPlayed) {
  let factor = 1;
  const soft = config.liveBlowoutMarginSoft ?? 4;
  const hard = config.liveBlowoutMarginHard ?? 6;

  if (absMargin >= hard) factor *= config.liveBlowoutScoreFactorHard ?? 0.58;
  else if (absMargin >= soft) factor *= config.liveBlowoutScoreFactorSoft ?? 0.78;

  if (inningsPlayed >= 7) factor *= config.liveLateInningFactor7 ?? 0.72;
  else if (inningsPlayed >= 6) factor *= config.liveLateInningFactor6 ?? 0.85;

  return clamp(factor, 0.35, 1);
}

/**
 * 剩餘得分 lambda
 */
export function remainingLambdas(
  homeRunsPrior,
  awayRunsPrior,
  inningsRemaining,
  { homeScore = 0, awayScore = 0, inningsPlayed = 0 } = {}
) {
  if (!(Number(inningsRemaining) > 0)) {
    const absMargin0 = Math.abs((Number(homeScore) || 0) - (Number(awayScore) || 0));
    return {
      homeLambdaRem: 0,
      awayLambdaRem: 0,
      remainingFrac: 0,
      slowdownFactor: 1,
      absMargin: absMargin0,
    };
  }

  const frac = clamp(inningsRemaining / REGULATION_INNINGS, 0.05, 1);
  const absMargin = Math.abs((Number(homeScore) || 0) - (Number(awayScore) || 0));
  const slow = blowoutSlowdownFactor(absMargin, inningsPlayed);

  let home = (homeRunsPrior ?? 4.5) * frac * slow;
  let away = (awayRunsPrior ?? 4.5) * frac * slow;

  // 領先方更可能降速（換投 / 控場）；落後方略抬追分，但仍受 slow 壓制
  if (absMargin >= (config.liveBlowoutMarginSoft ?? 4)) {
    if (homeScore > awayScore) {
      home *= 0.88;
      away *= 0.95;
    } else if (awayScore > homeScore) {
      away *= 0.88;
      home *= 0.95;
    }
  }

  return {
    homeLambdaRem: clamp(home, 0.12, 7),
    awayLambdaRem: clamp(away, 0.12, 7),
    remainingFrac: frac,
    slowdownFactor: Math.round(slow * 100) / 100,
    absMargin,
  };
}

export function liveHomeWinProb({
  homeScore,
  awayScore,
  homeLambdaRem,
  awayLambdaRem,
  priorHomeWin = 0.5,
}) {
  const H = Number(homeScore) || 0;
  const A = Number(awayScore) || 0;
  let win = 0;
  let lose = 0;
  let tie = 0;

  for (let x = 0; x <= MAX_EXTRA_RUNS; x++) {
    const px = poissonPmf(x, homeLambdaRem);
    for (let y = 0; y <= MAX_EXTRA_RUNS; y++) {
      const p = px * poissonPmf(y, awayLambdaRem);
      const fh = H + x;
      const fa = A + y;
      if (fh > fa) win += p;
      else if (fh < fa) lose += p;
      else tie += p;
    }
  }

  const extrasHome = 0.48 + (priorHomeWin - 0.5) * 0.35;
  const homeWin = win + tie * clamp(extrasHome, 0.35, 0.65);
  return clamp(homeWin, 0.05, 0.95);
}

/**
 * 接近比分時強化主場剩餘優勢（事故：平手仍低估主隊）
 */
export function applyCloseGameHomeBoost(homeWinProb, { absMargin, remainingFrac }) {
  const boostMax = config.liveCloseGameHomeBoost ?? 0.055;
  if (absMargin > 1) return homeWinProb;
  // 平手給滿，差 1 分給一半
  const scale = absMargin === 0 ? 1 : 0.55;
  const boost = boostMax * scale * clamp(remainingFrac ?? 0.5, 0.2, 1);
  return clamp(homeWinProb + boost, 0.05, 0.95);
}

export function liveTotalOverProb({
  homeScore,
  awayScore,
  homeLambdaRem,
  awayLambdaRem,
  line,
}) {
  const H = Number(homeScore) || 0;
  const A = Number(awayScore) || 0;
  const current = H + A;
  if (current > line) return 0.98;
  const need = line - current;
  let over = 0;
  for (let x = 0; x <= MAX_EXTRA_RUNS; x++) {
    const px = poissonPmf(x, homeLambdaRem);
    for (let y = 0; y <= MAX_EXTRA_RUNS; y++) {
      if (x + y > need) over += px * poissonPmf(y, awayLambdaRem);
    }
  }
  return clamp(over, 0.02, 0.98);
}

/** 滾球總分 over/under/push 分布。 */
export function liveTotalDistribution({
  homeScore,
  awayScore,
  homeLambdaRem,
  awayLambdaRem,
  line,
}) {
  const current = (Number(homeScore) || 0) + (Number(awayScore) || 0);
  return poissonTotalDistribution(
    homeLambdaRem,
    awayLambdaRem,
    line - current
  );
}

/**
 * @param {object} opts
 * @param {object} [opts.linescore] extractLinescoreState 結果；優先於開賽時間粗估
 */
export function projectLiveState({
  commenceTime,
  homeScore,
  awayScore,
  homeRunsPrior,
  awayRunsPrior,
  priorHomeWin = 0.5,
  now = Date.now(),
  linescore = null,
}) {
  const hasLinescore =
    linescore?.inningsPlayed != null && linescore?.inningsRemaining != null;
  const gameCompleted =
    Boolean(linescore?.completed) ||
    /終了|中止|キャンセル|延期/.test(String(linescore?.label || ''));

  const inningsPlayed = gameCompleted
    ? Math.max(9, Number(linescore?.inningsPlayed) || 9)
    : hasLinescore
      ? clamp(Number(linescore.inningsPlayed), 0.2, 12)
      : estimateInningsPlayed(commenceTime, now);
  const inningsRemaining = gameCompleted
    ? 0
    : hasLinescore
      ? clamp(Number(linescore.inningsRemaining), 0.05, 8.8)
      : estimateInningsRemaining(commenceTime, now);

  // linescore 比分優先（與 odds 比分不一致時以官方局況為準）
  const hs =
    linescore?.homeScore != null ? Number(linescore.homeScore) : Number(homeScore) || 0;
  const as =
    linescore?.awayScore != null ? Number(linescore.awayScore) : Number(awayScore) || 0;

  const { homeLambdaRem, awayLambdaRem, remainingFrac, slowdownFactor, absMargin } =
    remainingLambdas(homeRunsPrior, awayRunsPrior, inningsRemaining, {
      homeScore: hs,
      awayScore: as,
      inningsPlayed,
    });

  let homeWinProb = liveHomeWinProb({
    homeScore: hs,
    awayScore: as,
    homeLambdaRem,
    awayLambdaRem,
    priorHomeWin,
  });
  homeWinProb = applyCloseGameHomeBoost(homeWinProb, { absMargin, remainingFrac });

  const expectedFinalTotal = hs + as + homeLambdaRem + awayLambdaRem;
  const residualOnlyWin = poissonHomeWinProb(homeLambdaRem, awayLambdaRem);

  return {
    homeScore: hs,
    awayScore: as,
    completed: gameCompleted,
    inningsPlayed: Math.round(inningsPlayed * 10) / 10,
    inningsRemaining: Math.round(inningsRemaining * 10) / 10,
    remainingFrac: Math.round(remainingFrac * 100) / 100,
    homeLambdaRem: Math.round(homeLambdaRem * 100) / 100,
    awayLambdaRem: Math.round(awayLambdaRem * 100) / 100,
    homeWinProb,
    awayWinProb: 1 - homeWinProb,
    expectedFinalTotal: Math.round(expectedFinalTotal * 10) / 10,
    residualOnlyWin,
    scoreMargin: hs - as,
    absMargin,
    slowdownFactor,
    isBlowout: absMargin >= (config.liveBlowoutMarginSoft ?? 4),
    inningSource: hasLinescore
      ? linescore.source || 'mlb_linescore'
      : 'time_estimate',
    inningLabel: hasLinescore
      ? linescore.label
      : `約第 ${Math.round(inningsPlayed * 10) / 10} 局（時間粗估）`,
    outs: linescore?.outs ?? null,
    currentInning: linescore?.currentInning ?? null,
    inningState: linescore?.inningState ?? null,
  };
}

export { poissonTotalOverProb };
