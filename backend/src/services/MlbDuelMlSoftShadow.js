/**
 * R3：投手對決局 → 獨贏日排序軟降權（不刪單）
 *
 * 對決局總分結構已由 R1 禁 Over；本模組只處理獨贏 TopK 換血。
 * env: MLB_DUEL_ML_SOFT_SHADOW=off|compare|apply（預設 compare，過年份閘才升 apply）
 */
import { config } from '../config.js';
import {
  detectPitcherDuel,
  MLB_GAME_SHAPE_SHADOW_SPEC,
} from './MlbGameShapeShadow.js';

export const MLB_DUEL_ML_SOFT_SPEC = Object.freeze({
  id: 'pitcher_duel_ml_soft_rank_v0',
  openedAt: '2026-08-08',
  role: 'compare_until_year_gate',
  pitcherDuel: Object.freeze({ ...MLB_GAME_SHAPE_SHADOW_SPEC.pitcherDuel }),
  /** 網格最佳細胞 λ=0.05；未過全年份閘 → 僅對照 */
  rankPenaltyLambda: 0.05,
  evidence: Object.freeze({
    artifact: 'tmp-duel-ml-soft-on-locked-b.json',
    bestCell: 'lam0.05',
    dUsd: 134.5,
    dHrPp: 0.22,
    byYearDeltaUsd: Object.freeze({
      2024: -146,
      2025: 50,
      2026: 230.5,
    }),
    duelInBaseline: Object.freeze({
      n: 19,
      hitRate: 0.5263,
      usd50: 64.5,
      note: '對決獨贏切片本身不毒；硬跳過整體 −$51',
    }),
    hardSkipUsd: -51,
    gatePassed: false,
    note: '整體略正但 2024 固定約 −$146 → 預設 compare，禁止 apply。',
  }),
  note: '對決局獨贏：只扣日排序分，不删單；過全年份閘才進正式排序。',
});

export function resolveDuelMlSoftMode(raw = null) {
  const v = String(
    raw ??
      config.mlbDuelMlSoftShadowMode ??
      process.env.MLB_DUEL_ML_SOFT_SHADOW ??
      'compare'
  )
    .trim()
    .toLowerCase();
  if (v === 'apply' || v === 'on' || v === 'true' || v === '1') return 'apply';
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  return 'compare';
}

/**
 * @returns {{ matched: boolean, penalty: number, reason: string|null, pitcherDuel: object }}
 */
export function resolveDuelMlSoftPenalty({
  features,
  totalsLine = null,
  spec = MLB_DUEL_ML_SOFT_SPEC,
} = {}) {
  const pitcherDuel = detectPitcherDuel(features, {
    totalsLine,
    spec: { ...MLB_GAME_SHAPE_SHADOW_SPEC, pitcherDuel: spec.pitcherDuel },
  });
  if (!pitcherDuel.matched) {
    return {
      matched: false,
      penalty: 0,
      reason: null,
      pitcherDuel,
    };
  }
  return {
    matched: true,
    penalty: Number(spec.rankPenaltyLambda) || 0,
    reason: 'pitcher_duel_ml_soft_rank',
    pitcherDuel,
  };
}

export function applyDuelMlSoftToClassification(
  cls,
  { features, totalsLine = null, mode = null } = {}
) {
  const resolved = resolveDuelMlSoftMode(mode);
  if (resolved === 'off' || !cls || cls.tier === 'blocked') {
    return cls;
  }
  const soft = resolveDuelMlSoftPenalty({ features, totalsLine });
  const meta = {
    mode: resolved,
    specId: MLB_DUEL_ML_SOFT_SPEC.id,
    matched: soft.matched,
    penalty: soft.penalty,
    reason: soft.reason,
    pitcherDuel: soft.pitcherDuel,
    note: MLB_DUEL_ML_SOFT_SPEC.note,
  };
  if (!soft.matched) {
    return { ...cls, duelMlSoftShadow: meta };
  }
  return {
    ...cls,
    duelMlSoft: soft.matched,
    duelMlSoftPenalty: soft.penalty,
    duelMlSoftShadow: {
      ...meta,
      appliesToRank: resolved === 'apply',
      wouldPenalizeRank: true,
    },
    reasons: [...(cls.reasons || []), soft.reason],
  };
}

/** 給日排序用：apply 才返回懲罰值 */
export function duelMlSoftRankPenaltyFromClassification(cls) {
  if (!cls?.duelMlSoftShadow?.appliesToRank) return 0;
  return Number(cls.duelMlSoftPenalty) || 0;
}
