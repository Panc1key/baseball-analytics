/**
 * 大小提勝率：Under × 近況爆分 × 薄 gap → 不下
 *
 * 證據：auditMlbMaxHitRateShadow / tmp-max-hitrate-shadow.json
 * - 與 FragileUnder 疊加：HR +0.65pp、ROI +1.33pp、Δ$≈−121（@$50，Under×投手後基準）
 *
 * MLB_TOTALS_UNDER_BLOWUP_GAP_SHADOW=off|compare|apply（預設 apply）
 */
import { config } from '../config.js';

export const MLB_TOTALS_UNDER_BLOWUP_GAP_SPEC = Object.freeze({
  id: 'totals_under_blowup_gap08',
  openedAt: '2026-08-08',
  formalAt: '2026-08-08',
  role: 'formal_overlay_applied',
  maxAbsGap: 0.8,
  minBlowupStartsLast3: 1,
  evidence: Object.freeze({
    artifact: 'tmp-max-hitrate-shadow.json',
    withFragileCombo: Object.freeze({
      deltaHitRatePp: 0.65,
      deltaRoiPp: 1.33,
      deltaUsd50: -121,
      note: 'fragile ERA≥5 ∪ blowup×gap<0.8；串關腿勝率優先',
    }),
    alone: Object.freeze({
      deltaHitRatePp: 0.22,
      deltaRoiPp: 0.48,
      deltaUsd50: -44,
    }),
  }),
  note:
    '小分且 |μ−線|<0.8，且任一方近 3 先發 blowup≥1 → 不下。不翻大。',
});

export function resolveTotalsUnderBlowupGapMode(
  raw = config.mlbTotalsUnderBlowupGapShadowMode
) {
  const v = String(raw || 'apply').trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  if (v === 'compare' || v === 'shadow') return 'compare';
  return 'apply';
}

export function readMaxBlowupStartsLast3(features) {
  const vals = [
    Number(features?.pitchers?.homeRecent?.blowupStartsLast3),
    Number(features?.pitchers?.awayRecent?.blowupStartsLast3),
    Number(features?.pitchers?.home?.blowupStartsLast3),
    Number(features?.pitchers?.away?.blowupStartsLast3),
    Number(features?.home?.pitcherRecent?.blowupStartsLast3),
    Number(features?.away?.pitcherRecent?.blowupStartsLast3),
  ].filter((x) => Number.isFinite(x));
  return vals.length ? Math.max(...vals) : 0;
}

/**
 * @returns {{ matched: boolean, maxBlowup: number, absGap: number|null }}
 */
export function matchUnderBlowupGap(
  totalsClass,
  features,
  spec = MLB_TOTALS_UNDER_BLOWUP_GAP_SPEC
) {
  const maxBlowup = readMaxBlowupStartsLast3(features);
  const absGap = Number(totalsClass?.absGap);
  if (
    !totalsClass ||
    totalsClass.tier !== 'actionable' ||
    totalsClass.side !== 'under'
  ) {
    return {
      matched: false,
      maxBlowup,
      absGap: Number.isFinite(absGap) ? absGap : null,
    };
  }
  const matched =
    maxBlowup >= spec.minBlowupStartsLast3 &&
    Number.isFinite(absGap) &&
    absGap < spec.maxAbsGap;
  return {
    matched,
    maxBlowup,
    absGap: Number.isFinite(absGap) ? absGap : null,
  };
}

export function applyTotalsUnderBlowupGapShadow(
  totalsClass,
  features,
  {
    mode = resolveTotalsUnderBlowupGapMode(),
    spec = MLB_TOTALS_UNDER_BLOWUP_GAP_SPEC,
  } = {}
) {
  if (!totalsClass || mode === 'off') return totalsClass;
  const { matched, maxBlowup, absGap } = matchUnderBlowupGap(
    totalsClass,
    features,
    spec
  );
  if (!matched) {
    return {
      ...totalsClass,
      underBlowupGapShadow: {
        matched: false,
        maxBlowup,
        absGap,
        mode,
        specId: spec.id,
      },
    };
  }
  if (mode === 'compare') {
    return {
      ...totalsClass,
      underBlowupGapShadow: {
        matched: true,
        wouldSkip: true,
        maxBlowup,
        absGap,
        mode,
        specId: spec.id,
      },
    };
  }
  return {
    ...totalsClass,
    tier: 'blocked',
    reasons: [
      ...(totalsClass.reasons || []),
      'totals_under_blowup_thin_gap_skip',
    ],
    underBlowupGapSkip: true,
    underBlowupGapShadow: {
      matched: true,
      skipped: true,
      maxBlowup,
      absGap,
      mode,
      specId: spec.id,
    },
  };
}

export function applyTotalsUnderBlowupGapToCandidate(candidate, features) {
  if (!candidate) return candidate;
  return applyTotalsUnderBlowupGapShadow(candidate, features || {});
}
