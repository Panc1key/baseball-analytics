/**
 * R5：unclear 類型 → 少推（日排序軟降權；可選硬跳過）
 *
 * 正式 T4 unclear = 雙邊缺 ERA 且缺總分線。
 * 影子另測「寬 unclear」：缺任一邊 ERA（有線也可）——僅 compare，不改正式 type。
 *
 * env: MLB_UNCLEAR_REDUCE_SHADOW=off|compare|apply（預設 compare）
 */
import { config } from '../config.js';
import { readStarterEras } from './MlbGameShapeShadow.js';

export const MLB_UNCLEAR_REDUCE_SPEC = Object.freeze({
  id: 'unclear_reduce_volume_v0',
  openedAt: '2026-08-08',
  role: 'compare_until_volume_gate',
  /** 與 resolveMlbGameType T4 對齊的嚴格缺數 */
  strictMissingBothEraAndLine: true,
  rankPenaltyLambda: 0.12,
  /** apply 時是否直接不進日 TopK（比軟降更狠） */
  hardSkipFromTopK: false,
  evidence: Object.freeze({
    artifact: 'tmp-unclear-reduce-on-locked-b.json',
    strictEligibleN: 0,
    wideEligibleN: 37,
    wideBestCell: 'unclearWide_lam0.05',
    wideDUsd: 278,
    wideByYear: Object.freeze({ 2024: 236.5, 2025: -2, 2026: 43.5 }),
    gatePassed: false,
    note:
      '嚴格 T4 在 Locked B 池 n=0；寬缺 ERA 影子整體+$278 但屬 type 加寬，不得冒充正式 R5 apply。',
  }),
  note: '不明局：少推／軟降權；過閘且 n 足夠才 apply。',
});

export function resolveUnclearReduceMode(raw = null) {
  const v = String(
    raw ??
      config.mlbUnclearReduceShadowMode ??
      process.env.MLB_UNCLEAR_REDUCE_SHADOW ??
      'compare'
  )
    .trim()
    .toLowerCase();
  if (v === 'apply' || v === 'on' || v === 'true' || v === '1') return 'apply';
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  return 'compare';
}

function finite(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {'strict'|'wide'} breadth
 *   strict = 缺雙 ERA 且缺線（正式 T4）
 *   wide   = 缺任一邊 ERA（影子診斷）
 */
export function detectUnclearBreadth(
  features,
  { totalsLine = null, breadth = 'strict' } = {}
) {
  const eras = readStarterEras(features || {});
  const line = finite(totalsLine);
  const missingEra = eras.homeEra == null || eras.awayEra == null;
  const missingBothEra = eras.homeEra == null && eras.awayEra == null;
  const lineMissing = line == null;

  if (breadth === 'wide') {
    return {
      matched: missingEra,
      breadth: 'wide',
      missingEra,
      missingBothEra,
      lineMissing,
      homeEra: eras.homeEra,
      awayEra: eras.awayEra,
      totalsLine: line,
    };
  }

  return {
    matched: missingEra && lineMissing,
    breadth: 'strict',
    missingEra,
    missingBothEra,
    lineMissing,
    homeEra: eras.homeEra,
    awayEra: eras.awayEra,
    totalsLine: line,
  };
}

export function resolveUnclearReducePenalty({
  features,
  totalsLine = null,
  breadth = 'strict',
  spec = MLB_UNCLEAR_REDUCE_SPEC,
} = {}) {
  const unclear = detectUnclearBreadth(features, { totalsLine, breadth });
  if (!unclear.matched) {
    return {
      matched: false,
      penalty: 0,
      reason: null,
      unclear,
    };
  }
  return {
    matched: true,
    penalty: Number(spec.rankPenaltyLambda) || 0,
    reason: 'unclear_reduce_soft_rank',
    unclear,
  };
}

export function applyUnclearReduceToClassification(
  cls,
  { features, totalsLine = null, breadth = 'strict', mode = null } = {}
) {
  const resolved = resolveUnclearReduceMode(mode);
  if (resolved === 'off' || !cls || cls.tier === 'blocked') {
    return cls;
  }
  const soft = resolveUnclearReducePenalty({ features, totalsLine, breadth });
  const meta = {
    mode: resolved,
    specId: MLB_UNCLEAR_REDUCE_SPEC.id,
    matched: soft.matched,
    penalty: soft.penalty,
    reason: soft.reason,
    unclear: soft.unclear,
    hardSkipFromTopK: Boolean(MLB_UNCLEAR_REDUCE_SPEC.hardSkipFromTopK),
    note: MLB_UNCLEAR_REDUCE_SPEC.note,
  };
  if (!soft.matched) {
    return { ...cls, unclearReduceShadow: meta };
  }
  const hardSkip =
    resolved === 'apply' && Boolean(MLB_UNCLEAR_REDUCE_SPEC.hardSkipFromTopK);
  return {
    ...cls,
    unclearReduce: soft.matched,
    unclearReducePenalty: soft.penalty,
    unclearReduceShadow: {
      ...meta,
      appliesToRank: resolved === 'apply',
      wouldPenalizeRank: true,
      wouldHardSkip: hardSkip || Boolean(MLB_UNCLEAR_REDUCE_SPEC.hardSkipFromTopK),
    },
    ...(hardSkip
      ? {
          tier: 'blocked',
          reasons: [...(cls.reasons || []), soft.reason, 'unclear_hard_skip'],
        }
      : {
          reasons: [...(cls.reasons || []), soft.reason],
        }),
  };
}

export function unclearReduceRankPenaltyFromClassification(cls) {
  if (!cls?.unclearReduceShadow?.appliesToRank) return 0;
  if (cls?.unclearReduceShadow?.hardSkipFromTopK) return 0;
  return Number(cls.unclearReducePenalty) || 0;
}
