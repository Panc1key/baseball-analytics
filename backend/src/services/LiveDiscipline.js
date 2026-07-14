/**
 * 滾球紀律硬閘 — 對應事故總結，無法被「軟提示」跳過
 *
 * 強制檢查：
 * 1. 無比分 / 數據不足 → 不推薦
 * 2. EV / edge 門檻
 * 3. 與市場隱含概率嚴重衝突 → 拒絕或降級
 * 4. 真實概率 < 強推線 → 禁止 primary /「強烈」語意
 * 5. 禁止負 EV 對沖建議（系統不產出對沖單）
 * 6. 必須附帶最壞情況（損失 = 全損本金）
 */

import { config } from '../config.js';

const STRONG_PROB = () => config.liveStrongProbFloor ?? 0.65;
const WATCH_ONLY_BELOW = () => config.liveWatchOnlyBelowProb ?? 0.65;
const MAX_MARKET_GAP = () => config.liveMaxMarketProbGap ?? 0.12;
const MIN_DATA_Q = () => config.liveMinDataQuality ?? 0.55;

/**
 * @returns {{
 *   ok: boolean,
 *   rejectReasons: string[],
 *   warnings: string[],
 *   tierCap: 'primary'|'watch'|null,
 *   confidenceLabel: '觀察'|'可考慮'|'偏強',
 *   worstCase: { loseProb: number, stakeLossLabel: string, note: string },
 *   marketConflict: boolean,
 * }}
 */
export function enforceLiveDiscipline(candidate, context = {}) {
  const rejectReasons = [];
  const warnings = [];

  if (!context.hasScore) {
    rejectReasons.push('無比分：數據不足，禁止推薦');
  }

  const dataQ = candidate.dataQuality ?? context.dataQuality ?? 0;
  if (dataQ < MIN_DATA_Q()) {
    rejectReasons.push(`數據品質 ${(dataQ * 100).toFixed(0)}% < ${(MIN_DATA_Q() * 100).toFixed(0)}%`);
  }

  const modelProb = candidate.modelProb ?? 0;
  const implied = candidate.impliedProb ?? 0;
  const ev = candidate.ev ?? -1;
  const edge = candidate.edgeProb ?? 0;
  const market = candidate.market;
  const odds =
    candidate.oddsDecimal ??
    candidate.odds_decimal ??
    candidate.odds?.price ??
    0;

  const minOdds = config.liveMinOdds ?? 1.55;
  const primaryMinOdds = config.livePrimaryMinOdds ?? 1.7;
  if (odds > 0 && odds < minOdds) {
    rejectReasons.push(
      `賠率 ${Number(odds).toFixed(2)} 過低（滾球最低 ${minOdds}，避開鎖死熱門）`
    );
  }

  const minEv = config.liveMinEvThreshold ?? 0.03;
  const minEdge =
    market === 'totals'
      ? (config.liveTotalsMinEdgePct ?? 3.5)
      : (config.liveH2hMinEdgePct ?? 2.5);

  // 低水需更高 EV：否則薄利高方差，實用不值得
  let effectiveMinEv = minEv;
  if (odds > 0 && odds < primaryMinOdds) {
    effectiveMinEv = minEv + (config.liveLowOddsExtraEv ?? 0.04);
  }

  if (ev < effectiveMinEv) {
    rejectReasons.push(
      `EV ${(ev * 100).toFixed(1)}% < 門檻 ${(effectiveMinEv * 100).toFixed(0)}%` +
        (effectiveMinEv > minEv ? '（低水加嚴）' : '')
    );
  }
  if (edge < minEdge) rejectReasons.push(`優勢 ${edge.toFixed(1)}% < 門檻 ${minEdge}%`);

  // 與市場嚴重衝突：模型比市場樂觀過多 → 拒絕（防幻覺硬剛莊家）
  const gap = modelProb - implied;
  let marketConflict = false;
  if (implied > 0 && gap > MAX_MARKET_GAP()) {
    marketConflict = true;
    rejectReasons.push(
      `與市場衝突：模型 ${(modelProb * 100).toFixed(0)}% vs 隱含 ${(implied * 100).toFixed(0)}%（差距 ${(gap * 100).toFixed(0)}pt > ${(MAX_MARKET_GAP() * 100).toFixed(0)}）`
    );
  } else if (implied > 0 && gap > MAX_MARKET_GAP() * 0.7) {
    marketConflict = true;
    warnings.push('接近市場衝突上限，已降置信');
  }

  // 一邊倒後仍推 Over：額外拒絕（二次保險，慢速已在模型內）
  if (
    market === 'totals' &&
    context.live?.isBlowout &&
    (candidate.pick?.startsWith('大') || /^Over/i.test(candidate.pick || ''))
  ) {
    const overBoostNeed = config.liveBlowoutOverExtraEdge ?? 5;
    if (edge < minEdge + overBoostNeed) {
      rejectReasons.push(`一邊倒局面禁止輕推大分（需額外 +${overBoostNeed}% 優勢）`);
    }
  }

  // 系統禁止產出「對沖」類標記
  if (candidate.isHedge || candidate.hedgeOf) {
    rejectReasons.push('禁止負EV/擴倉對沖推薦');
  }

  // 概率表達鐵律：<65% 不得 primary
  let tierCap = null;
  let confidenceLabel = '觀察';
  if (modelProb >= STRONG_PROB()) {
    confidenceLabel = '偏強';
    tierCap = 'primary';
  } else if (modelProb >= 0.55) {
    confidenceLabel = '可考慮';
    tierCap = 'watch';
    warnings.push(`真實概率 ${(modelProb * 100).toFixed(0)}% < 65%，禁止「強烈/大概率」語意`);
  } else {
    confidenceLabel = '觀察';
    tierCap = 'watch';
    if (modelProb < (config.liveMinRecommendProb ?? 0.52)) {
      rejectReasons.push(`勝率 ${(modelProb * 100).toFixed(0)}% 過低，不推薦`);
    } else {
      warnings.push('勝率僅過半，僅可觀察級');
    }
  }

  // 低水不得主推（即使勝率很高）
  if (odds > 0 && odds < primaryMinOdds) {
    if (tierCap === 'primary') tierCap = 'watch';
    warnings.push(`賠率 ${Number(odds).toFixed(2)} < ${primaryMinOdds}，禁止主推（低水縮倉）`);
  }

  if (candidate.tier === 'primary' && modelProb < WATCH_ONLY_BELOW()) {
    tierCap = 'watch';
  }

  // 一邊倒領先方的低水獨贏：再砍注提示
  if (
    market === 'h2h' &&
    context.live?.isBlowout &&
    odds > 0 &&
    odds < primaryMinOdds &&
    modelProb >= 0.8
  ) {
    warnings.push('一邊倒鎖勝熱門：實用價值低，寧可不推或極小注');
  }

  const loseProb = Math.max(0, Math.min(1, 1 - modelProb));
  const worstCase = {
    loseProb,
    stakeLossLabel: '若此單失敗：損失全部建議注碼（滾球不對沖）',
    note: `失敗概率約 ${(loseProb * 100).toFixed(0)}% · 最壞 = -建議注`,
  };

  return {
    ok: rejectReasons.length === 0,
    rejectReasons,
    warnings,
    tierCap,
    confidenceLabel,
    worstCase,
    marketConflict,
  };
}

/** 將紀律結果套到候選上：降 tier、附加 reasoning、砍注 */
export function applyDisciplineToCandidate(candidate, discipline, baseStake) {
  if (!discipline.ok) return null;

  let tier = candidate.tier;
  if (discipline.tierCap === 'watch' && tier === 'primary') {
    tier = 'watch';
  }

  const stakeCap = config.liveMaxStake ?? 8;
  let stakeMult = config.liveStakeHaircut ?? 0.7;
  const odds =
    candidate.oddsDecimal ?? candidate.odds_decimal ?? candidate.odds?.price ?? 0;
  const primaryMinOdds = config.livePrimaryMinOdds ?? 1.7;
  if (odds > 0 && odds < primaryMinOdds) {
    stakeMult *= 0.55; // 低水再砍倉
  }
  if (discipline.warnings?.some((w) => w.includes('一邊倒鎖勝'))) {
    stakeMult *= 0.5;
  }

  let suggestedStake = candidate.suggestedStake ?? candidate.suggested_stake;
  if (suggestedStake != null) {
    suggestedStake = Math.min(stakeCap, Math.max(1, Math.round(suggestedStake * stakeMult)));
  } else if (baseStake != null) {
    suggestedStake = Math.min(stakeCap, Math.max(1, Math.round(baseStake * stakeMult)));
  }

  const riskLine = `風險: ${discipline.worstCase.note}`;
  const warnLine = discipline.warnings.length
    ? `警告: ${discipline.warnings.join('；')}`
    : null;
  const confLine = `置信: ${discipline.confidenceLabel}（禁止夸大用語）`;

  const reasoning = [candidate.reasoning, confLine, riskLine, warnLine]
    .filter(Boolean)
    .join(' | ');

  return {
    ...candidate,
    tier,
    confidenceLabel: discipline.confidenceLabel,
    suggestedStake,
    suggested_stake: suggestedStake,
    stakeMultiplier: candidate.stakeMultiplier != null
      ? Math.round(candidate.stakeMultiplier * stakeMult * 100) / 100
      : stakeMult,
    worstCaseLoseProb: discipline.worstCase.loseProb,
    marketConflict: discipline.marketConflict,
    reasoning,
    disciplineOk: true,
  };
}

export function formatDisciplineRejectLog(gameId, reasons) {
  return `[live-discipline] skip ${gameId}: ${reasons.join('; ')}`;
}
