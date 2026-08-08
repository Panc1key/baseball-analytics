/**
 * T4b：缺任一邊 ERA（wide）→ 獨贏日排序軟降權
 *
 * 與正式 T4（缺雙 ERA 且缺線）分離；不改 resolveMlbGameType。
 * 回測：tmp-t4-wide-type-separation.json → λ0.05 約 +$278／年份可過；
 * 切片本身亦正 EV，屬 TopK 換血，故只升 compare。
 *
 * env: MLB_MISSING_ERA_SOFT_SHADOW=off|compare|apply（預設 compare）
 */
import { config } from '../config.js';
import { detectUnclearBreadth } from './MlbUnclearReduceShadow.js';

export const MLB_MISSING_ERA_SOFT_SPEC = Object.freeze({
  id: 't4b_missing_era_soft_rank_v0',
  openedAt: '2026-08-08',
  role: 'compare_shadow_only',
  detector: 'T4b_missing_either_era',
  rankPenaltyLambda: 0.05,
  evidence: Object.freeze({
    artifact: 'tmp-t4-wide-type-separation.json',
    stressArtifact: 'tmp-t4b-missing-era-stress.json',
    bestCell: 'wide_soft_lam0.05',
    dUsd: 278,
    dHrPp: 0.43,
    byYearDeltaUsd: Object.freeze({
      2024: 236.5,
      2025: -2,
      2026: 43.5,
    }),
    typeSep: Object.freeze({
      wideN: 321,
      dMeanTotal: 0.361,
      dHomeWinPp: -0.71,
    }),
    stress: Object.freeze({
      expandingWfDeltaUsd: 192.5,
      expandingBeatHurtFlat: '2/1/12',
      leaveOneYear: Object.freeze({
        2024: -104.5,
        2025: -2,
        2026: 43.5,
      }),
      note: '固定樣本仍正；expanding WF 合計 +$192.5；但 leave-one-year 留出 2024 −$104.5 → 禁止 apply',
    }),
    note: '類型+固定路由過關；加壓 LOY 未過 → 維持 compare，禁止默認 apply。',
    gatePassedForCompare: true,
    gatePassedForApply: false,
  }),
  note: '缺 ERA 局獨贏軟降權（T4b）；只打標／compare；過人工覆核才可試 apply。',
});

export function resolveMissingEraSoftMode(raw = null) {
  const v = String(
    raw ??
      config.mlbMissingEraSoftShadowMode ??
      process.env.MLB_MISSING_ERA_SOFT_SHADOW ??
      'compare'
  )
    .trim()
    .toLowerCase();
  if (v === 'apply' || v === 'on' || v === 'true' || v === '1') return 'apply';
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  return 'compare';
}

export function resolveMissingEraSoftPenalty({
  features,
  totalsLine = null,
  spec = MLB_MISSING_ERA_SOFT_SPEC,
} = {}) {
  const unclear = detectUnclearBreadth(features, {
    totalsLine,
    breadth: 'wide',
  });
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
    reason: 't4b_missing_era_soft_rank',
    unclear,
  };
}

export function applyMissingEraSoftToClassification(
  cls,
  { features, totalsLine = null, mode = null } = {}
) {
  const resolved = resolveMissingEraSoftMode(mode);
  if (resolved === 'off' || !cls || cls.tier === 'blocked') {
    return cls;
  }
  const soft = resolveMissingEraSoftPenalty({ features, totalsLine });
  const meta = {
    mode: resolved,
    specId: MLB_MISSING_ERA_SOFT_SPEC.id,
    matched: soft.matched,
    penalty: soft.penalty,
    reason: soft.reason,
    unclear: soft.unclear,
    note: MLB_MISSING_ERA_SOFT_SPEC.note,
  };
  if (!soft.matched) {
    return { ...cls, missingEraSoftShadow: meta };
  }
  return {
    ...cls,
    missingEraSoft: soft.matched,
    missingEraSoftPenalty: soft.penalty,
    missingEraSoftShadow: {
      ...meta,
      appliesToRank: resolved === 'apply',
      wouldPenalizeRank: true,
    },
    reasons: [...(cls.reasons || []), soft.reason],
  };
}

export function missingEraSoftRankPenaltyFromClassification(cls) {
  if (!cls?.missingEraSoftShadow?.appliesToRank) return 0;
  return Number(cls.missingEraSoftPenalty) || 0;
}
