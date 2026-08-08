/**
 * Price：type 感知日排序微調（不改 μ）
 *
 * 過閘細胞（疊 μ normal-away shrink w=0.38）：
 * - normal×客：rank −0.01
 * - strong_home×客：rank +0.02（注意：與舊 R4「降權客」方向相反；R4 未過閘）
 *
 * env: MLB_TYPE_AWARE_RANK_SHADOW=off|compare|apply（預設 compare）
 */
import { config } from '../config.js';
import { resolveMlbGameType } from './MlbLayeredArchitecture.js';

export const MLB_TYPE_AWARE_RANK_SPEC = Object.freeze({
  id: 'price_type_aware_rank_v0',
  openedAt: '2026-08-08',
  layer: 'price',
  role: 'apply_with_mu_stack',
  normalAwayPenalty: 0.01,
  strongHomeAwayBoost: 0.02,
  evidence: Object.freeze({
    artifact: 'tmp-price-mu-followup.json',
    stressArtifact: 'tmp-mu-price-stack-stress.json',
    alone: Object.freeze({
      id: 'price_pen_normal_away_0.01',
      dUsd: 253,
      dHrPp: 0.38,
      byYear: Object.freeze({ 2024: 149.5, 2025: 2, 2026: 101.5 }),
    }),
    stackedWithMu035: Object.freeze({
      id: 'mu035_plus_pen0.01_boostStrongAway02',
      dUsd: 568.5,
      dHrPp: 0.64,
      byYear: Object.freeze({ 2024: 169, 2025: 349.5, 2026: 50 }),
      expandingFixedDeltaUsd: 402,
      monthlyPosNeg: '10/6',
      leaveOneYearAllPos: true,
    }),
    note: '與 μ shrink 固定參數疊用過全閘 → 默認 apply',
    gatePassedForCompare: true,
    gatePassedForApply: true,
  }),
  note: 'type 感知排序微調；強主客 boost（與舊 R4 降客相反）；正式 apply',
});

export function resolveTypeAwareRankMode(raw = null) {
  const v = String(
    raw ??
      config.mlbTypeAwareRankShadowMode ??
      process.env.MLB_TYPE_AWARE_RANK_SHADOW ??
      'apply'
  )
    .trim()
    .toLowerCase();
  if (v === 'apply' || v === 'on' || v === 'true' || v === '1') return 'apply';
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  return 'compare';
}

export function resolveTypeAwareRankDelta({
  pickHome,
  features,
  totalsLine = null,
  homeOdds = null,
  gameType = null,
  spec = MLB_TYPE_AWARE_RANK_SPEC,
} = {}) {
  const type =
    gameType?.type ||
    resolveMlbGameType({ features, totalsLine, homeOdds })?.type ||
    'normal';
  let delta = 0;
  const reasons = [];
  if (type === 'normal' && !pickHome) {
    delta -= Number(spec.normalAwayPenalty) || 0;
    reasons.push('price_pen_normal_away');
  }
  if (type === 'strong_home' && !pickHome) {
    delta += Number(spec.strongHomeAwayBoost) || 0;
    reasons.push('price_boost_strong_home_away');
  }
  return {
    matched: reasons.length > 0,
    delta,
    reasons,
    type,
  };
}

export function applyTypeAwareRankToClassification(
  cls,
  { features, totalsLine = null, homeOdds = null, gameType = null, mode = null } = {}
) {
  const resolved = resolveTypeAwareRankMode(mode);
  if (resolved === 'off' || !cls || cls.tier === 'blocked') return cls;
  const pickHome = cls.side === 'home' || cls.pickHome === true;
  const soft = resolveTypeAwareRankDelta({
    pickHome,
    features,
    totalsLine,
    homeOdds,
    gameType,
  });
  const meta = {
    mode: resolved,
    specId: MLB_TYPE_AWARE_RANK_SPEC.id,
    matched: soft.matched,
    delta: soft.delta,
    reasons: soft.reasons,
    type: soft.type,
    note: MLB_TYPE_AWARE_RANK_SPEC.note,
  };
  if (!soft.matched) {
    return { ...cls, typeAwareRankShadow: meta };
  }
  return {
    ...cls,
    typeAwareRankDelta: soft.delta,
    typeAwareRankShadow: {
      ...meta,
      appliesToRank: resolved === 'apply',
      wouldAdjustRank: true,
    },
    reasons: [...(cls.reasons || []), ...soft.reasons],
  };
}

export function typeAwareRankDeltaFromClassification(cls) {
  if (!cls?.typeAwareRankShadow?.appliesToRank) return 0;
  return Number(cls.typeAwareRankDelta) || 0;
}
