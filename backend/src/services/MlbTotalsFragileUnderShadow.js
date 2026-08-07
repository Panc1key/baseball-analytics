/**
 * 大小分提勝率：脆弱小分直接不下（不翻大）
 *
 * 證據：diagnoseMlbUnderBlowupWinrate / tmp-under-blowup-winrate.json
 * - 小分輸單裡約 60% 是超大分打爆（實際−線≥3，平均超線約 6 分）
 * - skip maxStarterEra≥5：剩餘池勝率 +1.35pp、爆分率略降；勿自動翻大
 *
 * MLB_TOTALS_FRAGILE_UNDER_SHADOW=off|compare|apply（預設 apply）
 */
import { config } from '../config.js';

export const MLB_TOTALS_FRAGILE_UNDER_SPEC = Object.freeze({
  id: 'totals_fragile_under_skip_era_ge50',
  openedAt: '2026-08-07',
  maxStarterEra: 5,
  evidence: Object.freeze({
    artifact: 'tmp-under-blowup-winrate.json',
    underPoolBets: 278,
    baselineHitRate: 0.5827,
    keptHitRate: 0.5962,
    deltaHitRatePp: 1.35,
    blowupCatchRate: 0.286,
    deltaUsd50: -174,
    note: '抬勝率優先；美元略降但 ROI 升。晚局獨贏翻盤非此刀範圍。',
  }),
  note: '任一方先發 ERA≥5 的小分 → 不下。不改 μ、不翻大。',
});

export function resolveTotalsFragileUnderMode(
  raw = config.mlbTotalsFragileUnderShadowMode
) {
  const v = String(raw || 'apply').trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  if (v === 'compare' || v === 'shadow') return 'compare';
  return 'apply';
}

export function readMaxStarterEra(features) {
  const home = Number(features?.pitchers?.home?.era);
  const away = Number(features?.pitchers?.away?.era);
  const eras = [home, away].filter((x) => Number.isFinite(x));
  return eras.length ? Math.max(...eras) : null;
}

/**
 * @returns {{ matched: boolean, maxStarterEra: number|null }}
 */
export function matchFragileUnder(totalsClass, features, spec = MLB_TOTALS_FRAGILE_UNDER_SPEC) {
  if (!totalsClass || totalsClass.tier !== 'actionable' || totalsClass.side !== 'under') {
    return { matched: false, maxStarterEra: readMaxStarterEra(features) };
  }
  const maxStarterEra = readMaxStarterEra(features);
  const matched =
    maxStarterEra != null && maxStarterEra >= spec.maxStarterEra;
  return { matched, maxStarterEra };
}

/**
 * compare：只標記；apply：改 blocked。
 */
export function applyTotalsFragileUnderShadow(
  totalsClass,
  features,
  {
    mode = resolveTotalsFragileUnderMode(),
    spec = MLB_TOTALS_FRAGILE_UNDER_SPEC,
  } = {}
) {
  if (!totalsClass || mode === 'off') return totalsClass;
  const { matched, maxStarterEra } = matchFragileUnder(totalsClass, features, spec);
  if (!matched) {
    return {
      ...totalsClass,
      fragileUnderShadow: {
        matched: false,
        maxStarterEra,
        mode,
        specId: spec.id,
      },
    };
  }
  if (mode === 'compare') {
    return {
      ...totalsClass,
      fragileUnderShadow: {
        matched: true,
        wouldSkip: true,
        maxStarterEra,
        mode,
        specId: spec.id,
      },
    };
  }
  return {
    ...totalsClass,
    tier: 'blocked',
    reasons: [...(totalsClass.reasons || []), 'fragile_under_starter_era_ge50'],
    fragileUnderSkip: true,
    fragileUnderShadow: {
      matched: true,
      skipped: true,
      maxStarterEra,
      mode,
      specId: spec.id,
    },
  };
}
