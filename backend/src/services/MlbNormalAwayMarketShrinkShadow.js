/**
 * μ：normal 類型 + 推客 → 勝率向市場收縮
 * P' = (1-w)*P + w*(1/odds)；重算 EV 後再進 Locked B 門檻／排序
 *
 * 2026-08-08：固定 w=0.35 疊 price 過閘 apply。
 * 同日在 true25+minEv1.5% 底座重設：w=0.38 相對 0.35 約 +$355.5／LOY 全正／expanding 正；
 * w≥0.40 翻車 → 禁止再抬。月度重選 w 仍禁止。
 *
 * env: MLB_NORMAL_AWAY_MARKET_SHRINK=off|compare|apply（預設 apply）
 */
import { config } from '../config.js';
import { resolveMlbGameType } from './MlbLayeredArchitecture.js';

export const MLB_NORMAL_AWAY_MARKET_SHRINK_SPEC = Object.freeze({
  id: 'mu_normal_away_market_shrink_v0',
  openedAt: '2026-08-08',
  layer: 'mu',
  role: 'apply_fixed_w',
  shrinkWeight: 0.38,
  when: Object.freeze({
    type: 'normal',
    pickAway: true,
  }),
  evidence: Object.freeze({
    artifact: 'tmp-layered-price-mu-sweep.json',
    stressArtifact: 'tmp-mu-price-stack-stress.json',
    retargetArtifact: 'tmp-mu-w-retarget.json',
    bestFixedW: 0.38,
    priorFixedW: 0.35,
    dUsdVsPrior035: 355.5,
    dHrPpVsPrior035: 0.68,
    byYearDeltaUsdVsPrior035: Object.freeze({
      2024: 50,
      2025: 69.5,
      2026: 236,
    }),
    leaveOneYearAllPos: true,
    expandingFixedDeltaUsd: 355.5,
    note: 'w=0.38 相對 0.35 全閘；w=0.40 起失敗 → 固定 0.38 apply',
  }),
  note: 'normal×客勝：P 向市場收縮；固定 w=0.38；正式 apply',
});

export function resolveNormalAwayMarketShrinkMode(raw = null) {
  const v = String(
    raw ??
      config.mlbNormalAwayMarketShrinkMode ??
      process.env.MLB_NORMAL_AWAY_MARKET_SHRINK ??
      'apply'
  )
    .trim()
    .toLowerCase();
  if (v === 'apply' || v === 'on' || v === 'true' || v === '1') return 'apply';
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  return 'compare';
}

/**
 * @returns {{ matched: boolean, weight: number, pRaw: number|null, pCal: number|null, reason: string|null }}
 */
export function resolveNormalAwayMarketShrink({
  pickHome,
  modelProbability,
  odds,
  features,
  totalsLine = null,
  homeOdds = null,
  gameType = null,
  spec = MLB_NORMAL_AWAY_MARKET_SHRINK_SPEC,
} = {}) {
  const type =
    gameType?.type ||
    resolveMlbGameType({ features, totalsLine, homeOdds })?.type ||
    'normal';
  const pRaw = Number(modelProbability);
  const o = Number(odds);
  if (
    pickHome ||
    type !== 'normal' ||
    !Number.isFinite(pRaw) ||
    !Number.isFinite(o) ||
    o <= 1
  ) {
    return {
      matched: false,
      weight: 0,
      pRaw: Number.isFinite(pRaw) ? pRaw : null,
      pCal: null,
      reason: null,
      type,
    };
  }
  const w = Number(spec.shrinkWeight) || 0;
  const marketP = 1 / o;
  const pCal = (1 - w) * pRaw + w * marketP;
  return {
    matched: true,
    weight: w,
    pRaw,
    pCal,
    marketP,
    reason: 'mu_normal_away_market_shrink',
    type,
  };
}

/**
 * 套到 moneyline classification：
 * - compare：只打標，不改 modelProbability / expectedValue
 * - apply：改機率與 EV，供排序／門檻使用
 */
export function applyNormalAwayMarketShrinkToClassification(
  cls,
  {
    features,
    totalsLine = null,
    homeOdds = null,
    gameType = null,
    mode = null,
  } = {}
) {
  const resolved = resolveNormalAwayMarketShrinkMode(mode);
  if (resolved === 'off' || !cls || cls.tier === 'blocked') return cls;

  const pickHome = cls.side === 'home' || cls.pickHome === true;
  const soft = resolveNormalAwayMarketShrink({
    pickHome,
    modelProbability: cls.modelProbability,
    odds: cls.odds,
    features,
    totalsLine,
    homeOdds,
    gameType,
  });
  const meta = {
    mode: resolved,
    specId: MLB_NORMAL_AWAY_MARKET_SHRINK_SPEC.id,
    matched: soft.matched,
    weight: soft.weight,
    pRaw: soft.pRaw,
    pCal: soft.pCal,
    marketP: soft.marketP ?? null,
    reason: soft.reason,
    type: soft.type,
    note: MLB_NORMAL_AWAY_MARKET_SHRINK_SPEC.note,
  };
  if (!soft.matched) {
    return { ...cls, normalAwayMarketShrinkShadow: meta };
  }

  if (resolved !== 'apply') {
    return {
      ...cls,
      normalAwayMarketShrinkShadow: {
        ...meta,
        appliesToProbability: false,
        wouldShrink: true,
      },
      reasons: [...(cls.reasons || []), soft.reason],
    };
  }

  const p = soft.pCal;
  const odds = Number(cls.odds);
  const ev = p * (odds - 1) - (1 - p);
  const minEv = Number(cls.rules?.minimumExpectedValue ?? cls.minimumExpectedValue);
  let tier = cls.tier;
  const reasons = [...(cls.reasons || []), soft.reason];
  if (
    Number.isFinite(minEv) &&
    Number.isFinite(ev) &&
    ev < minEv &&
    (tier === 'recommendation' || tier === 'value')
  ) {
    tier = 'blocked';
    reasons.push('mu_normal_away_shrink_ev_below_min');
  }
  return {
    ...cls,
    tier,
    modelProbability: p,
    expectedValue: ev,
    normalAwayMarketShrink: true,
    normalAwayMarketShrinkShadow: {
      ...meta,
      appliesToProbability: true,
      wouldShrink: true,
    },
    reasons,
  };
}
