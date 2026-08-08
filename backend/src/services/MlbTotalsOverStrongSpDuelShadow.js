/**
 * 影子：雙強先發對決 + 低開總分線 → 禁止 Over（不翻小）
 *
 * 觸發（昨日金鶯@遊騎兵／光芒@水手原型）：
 * - Hybrid actionable Over
 * - line ≤ 7.5
 * - 雙方先發 ERA 皆 ≤ maxStarterEra（預設 4.25）
 * - 若雙方皆有 k9：皆 ≥ minK9（預設 7.5；缺一側 k9 則只看 ERA）
 *
 * MLB_TOTALS_OVER_STRONG_SP_DUEL_SHADOW=off|compare|apply（預設 compare）
 */
import { config } from '../config.js';

export const MLB_TOTALS_OVER_STRONG_SP_DUEL_SPEC = Object.freeze({
  id: 'totals_over_strong_sp_duel_line7',
  openedAt: '2026-08-08',
  role: 'compare_only_shadow',
  /**
   * 主參數：線≤7（歷史砍片 HR≈46%、Δ$+$215）。
   * 線≤7.5 能多蓋「金鶯@遊騎兵」原型，但砍片仍正 ROI → 總美元變差（見審計）。
   */
  maxTotalLine: 7,
  /** 雙方先發 ERA 上限；4.25 可蓋 Eovaldi≈4.21 類 */
  maxStarterEra: 4.25,
  minK9: 0,
  requireBothK9: false,
  evidence: Object.freeze({
    triggerCases: Object.freeze([
      '2026-08-07 Rays@Mariners 大7 → 2-1（Rasmussen/Gilbert）可蓋',
      '2026-08-07 Orioles@Rangers 大7.5 → 1-2：需 maxTotalLine=7.5 才蓋，但該寬刀歷史傷美元',
    ]),
    artifact: 'tmp-totals-over-strong-sp-duel-shadow.json',
    audit: Object.freeze({
      line7_era425: Object.freeze({
        cutN: 32,
        cutHr: 0.4688,
        deltaUsd50: 146.5,
        deltaHitRatePp: 0.79,
      }),
      line75_era425: Object.freeze({
        cutN: 85,
        cutHr: 0.5529,
        deltaUsd50: -378,
        deltaHitRatePp: 0.76,
        note: '砍片仍小賺 → 不宜作主參數',
      }),
    }),
    note: '禁 Over、不翻小；預設 compare。主參數 line≤7。',
  }),
  note:
    '雙強先發（雙方 ERA≤4.25）＋總分線≤7 的 Over → 不下。對準市場已開投手戰、μ 仍追大。',
});

export function resolveTotalsOverStrongSpDuelMode(
  raw = config.mlbTotalsOverStrongSpDuelShadowMode
) {
  const v = String(raw || 'compare').trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  if (v === 'apply') return 'apply';
  if (v === 'compare' || v === 'shadow' || v === 'on' || v === 'true' || v === '1') {
    return 'compare';
  }
  return 'compare';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function readStarterPair(features) {
  const home = features?.pitchers?.home || {};
  const away = features?.pitchers?.away || {};
  return {
    homeEra: num(home.era),
    awayEra: num(away.era),
    homeK9: num(home.kPer9 ?? home.k9 ?? home.strikeoutsPer9Inn),
    awayK9: num(away.kPer9 ?? away.k9 ?? away.strikeoutsPer9Inn),
    homeName: features?.pitchers?.homeIdentity?.name || home.name || null,
    awayName: features?.pitchers?.awayIdentity?.name || away.name || null,
  };
}

/**
 * @returns {{ matched: boolean, reason: string|null, pair: object, line: number|null }}
 */
export function matchOverStrongSpDuel(
  totalsClass,
  features,
  spec = MLB_TOTALS_OVER_STRONG_SP_DUEL_SPEC
) {
  const pair = readStarterPair(features);
  const line = num(totalsClass?.line);
  if (
    !totalsClass ||
    totalsClass.tier !== 'actionable' ||
    totalsClass.side !== 'over'
  ) {
    return { matched: false, reason: null, pair, line };
  }
  if (line == null || line > spec.maxTotalLine) {
    return { matched: false, reason: 'line_above_cap', pair, line };
  }
  if (pair.homeEra == null || pair.awayEra == null) {
    return { matched: false, reason: 'missing_era', pair, line };
  }
  if (pair.homeEra > spec.maxStarterEra || pair.awayEra > spec.maxStarterEra) {
    return { matched: false, reason: 'era_too_high', pair, line };
  }
  const bothK9 = pair.homeK9 != null && pair.awayK9 != null;
  if (spec.requireBothK9) {
    if (!bothK9) {
      return { matched: false, reason: 'missing_k9', pair, line };
    }
    if (pair.homeK9 < spec.minK9 || pair.awayK9 < spec.minK9) {
      return { matched: false, reason: 'k9_too_low', pair, line };
    }
  } else if (spec.minK9 > 0 && bothK9) {
    // 軟條件：兩邊都有 k9 時才檢查；缺 k9 不擋
    if (pair.homeK9 < spec.minK9 || pair.awayK9 < spec.minK9) {
      return { matched: false, reason: 'k9_too_low', pair, line };
    }
  }
  return { matched: true, reason: 'strong_sp_duel_low_line_over', pair, line };
}

/**
 * compare：只標記；apply：改 blocked（不翻 under）。
 */
export function applyTotalsOverStrongSpDuelShadow(
  totalsClass,
  features,
  {
    mode = resolveTotalsOverStrongSpDuelMode(),
    spec = MLB_TOTALS_OVER_STRONG_SP_DUEL_SPEC,
  } = {}
) {
  if (!totalsClass || mode === 'off') return totalsClass;
  const hit = matchOverStrongSpDuel(totalsClass, features, spec);
  if (!hit.matched) {
    return {
      ...totalsClass,
      overStrongSpDuelShadow: {
        matched: false,
        reason: hit.reason,
        pair: hit.pair,
        line: hit.line,
        mode,
        specId: spec.id,
      },
    };
  }
  if (mode === 'compare') {
    return {
      ...totalsClass,
      overStrongSpDuelShadow: {
        matched: true,
        wouldSkip: true,
        reason: hit.reason,
        pair: hit.pair,
        line: hit.line,
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
      'totals_over_strong_sp_duel_skip',
    ],
    overStrongSpDuelSkip: true,
    overStrongSpDuelShadow: {
      matched: true,
      skipped: true,
      reason: hit.reason,
      pair: hit.pair,
      line: hit.line,
      mode,
      specId: spec.id,
    },
  };
}

export function applyTotalsOverStrongSpDuelToCandidate(candidate, features) {
  if (!candidate) return candidate;
  return applyTotalsOverStrongSpDuelShadow(candidate, features || {});
}
