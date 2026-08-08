/**
 * 强主软降权（不做一刀切）
 *
 * 当：市场短热主（强主）且模型选客胜
 * → 只扣日排序分，仍可进池；更难抢 TopK
 *
 * env: MLB_STRONG_HOME_SOFT_SHADOW=off|compare|apply（默认 compare）
 */
import { config } from '../config.js';
import {
  detectStrongHome,
  MLB_GAME_SHAPE_SHADOW_SPEC,
} from './MlbGameShapeShadow.js';

export const MLB_STRONG_HOME_SOFT_SPEC = Object.freeze({
  id: 'strong_home_away_soft_rank_v0',
  openedAt: '2026-08-08',
  role: 'compare_only_until_year_stable',
  strongHome: Object.freeze({
    ...MLB_GAME_SHAPE_SHADOW_SPEC.strongHome,
    /** 回测里 1.85+λ0.08 整体+$91 但 2025−$145 → 暂不 apply */
    maxHomeOdds: 1.85,
  }),
  rankPenaltyLambda: 0.08,
  evidence: Object.freeze({
    artifact: 'tmp-strong-home-soft-on-locked-b.json',
    bestCell: 'odds1.85_lam0.08',
    dUsd: 91.5,
    dHrPp: 0.23,
    byYearDeltaUsd: Object.freeze({
      2024: 300.5,
      2025: -145,
      2026: -64,
    }),
    hardCutBanAway: Object.freeze({
      note: '硬切客更差（约−$471）',
      artifact: 'tmp-strong-home-on-locked-b.json',
    }),
    gatePassed: false,
    note: '整体略正但年份不稳 → 默认 compare，不进正式排序。',
  }),
  note: '强主局推客：软降权不删单；回测未过年份闸，仅对照。',
});

export function resolveStrongHomeSoftMode(raw = null) {
  const v = String(
    raw ??
      config.mlbStrongHomeSoftShadowMode ??
      process.env.MLB_STRONG_HOME_SOFT_SHADOW ??
      'compare'
  )
    .trim()
    .toLowerCase();
  if (v === 'apply' || v === 'on' || v === 'true' || v === '1') return 'apply';
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  return 'compare';
}

/**
 * @returns {{ matched: boolean, penalty: number, reason: string|null, strongHome: object }}
 */
export function resolveStrongHomeAwaySoftPenalty({
  pickHome,
  features,
  homeOdds = null,
  spec = MLB_STRONG_HOME_SOFT_SPEC,
} = {}) {
  const strongHome = detectStrongHome(features, {
    homeOdds,
    spec: { ...MLB_GAME_SHAPE_SHADOW_SPEC, strongHome: spec.strongHome },
  });
  if (pickHome || !strongHome.matched) {
    return {
      matched: false,
      penalty: 0,
      reason: null,
      strongHome,
    };
  }
  return {
    matched: true,
    penalty: Number(spec.rankPenaltyLambda) || 0,
    reason: 'strong_home_away_soft_rank',
    strongHome,
  };
}

export function applyStrongHomeSoftToClassification(cls, {
  features,
  homeOdds = null,
  mode = null,
} = {}) {
  const resolved = resolveStrongHomeSoftMode(mode);
  if (resolved === 'off' || !cls || cls.tier === 'blocked') {
    return cls;
  }
  const pickHome = cls.side === 'home' || cls.pickHome === true;
  const soft = resolveStrongHomeAwaySoftPenalty({
    pickHome,
    features,
    homeOdds,
  });
  const meta = {
    mode: resolved,
    specId: MLB_STRONG_HOME_SOFT_SPEC.id,
    matched: soft.matched,
    penalty: soft.penalty,
    reason: soft.reason,
    strongHome: soft.strongHome,
    note: MLB_STRONG_HOME_SOFT_SPEC.note,
  };
  if (!soft.matched) {
    return { ...cls, strongHomeSoftShadow: meta };
  }
  // compare：只打标，排序是否真扣由 ranker 读 appliesToRank
  // apply：排序真扣
  return {
    ...cls,
    strongHomeAwaySoft: soft.matched,
    strongHomeAwaySoftPenalty: soft.penalty,
    strongHomeSoftShadow: {
      ...meta,
      appliesToRank: resolved === 'apply',
      wouldPenalizeRank: true,
    },
    reasons: [...(cls.reasons || []), soft.reason],
  };
}

/** 给日排序用：apply 才返回惩罚值 */
export function strongHomeSoftRankPenaltyFromClassification(cls) {
  if (!cls?.strongHomeSoftShadow?.appliesToRank) return 0;
  return Number(cls.strongHomeAwaySoftPenalty) || 0;
}
