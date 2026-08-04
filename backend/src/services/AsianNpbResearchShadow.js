/**
 * NPB 研究影子協定（對齊 MLB FrozenB / HighEvShrink 影子紀律）
 *
 * - 凍結基線：logistic_h2h mid（AsianResearchFreeze.NPB_primary）
 * - 新想法只開影子對照，禁止改基線常數、禁止正式／紙上
 * - 升格條件：多年 OOS Δ$ 明顯優於基線 + 單年不系統拖後腿 + 注量可複驗
 */
import { ASIAN_RESEARCH_FREEZE } from './AsianResearchFreeze.js';

const primary = ASIAN_RESEARCH_FREEZE.candidates.NPB_primary;

/** @type {const} */
export const NPB_RESEARCH_SHADOW_SPEC = Object.freeze({
  id: 'npb_research_shadow_v1',
  openedAt: '2026-08-04',
  savedAt: '2026-08-04',
  role: 'research_shadow_only',
  wiredToFormal: false,
  parentFreezeId: ASIAN_RESEARCH_FREEZE.id,
  baseline: Object.freeze({
    id: 'NPB_primary',
    head: primary.head,
    features: primary.features,
    shrink: primary.shrink,
    temp: primary.temp,
    gate: primary.gate,
    note: '凍結主看：勿為抬注數／抬 ROI 改常數；新想法另開影子',
  }),
  gates: Object.freeze({
    mid: Object.freeze({
      minOdds: 1.7,
      maxOdds: 2.3,
      minProb: 0.52,
      minEdge: 0.02,
      minEv: 0.02,
    }),
  }),
  stakeUsd: 50,
  observation: Object.freeze({
    minShadowBets: 80,
    yearDeltaFloorUsd50: -100,
    earlyStopNetUsd50: -200,
    promoteRequires: Object.freeze([
      'delta_usd50_vs_baseline > 0 on multi-year OOS',
      'no single season systematically worse beyond yearDeltaFloor',
      'wiredToFormal remains false until explicit user promote',
    ]),
    failIf: Object.freeze([
      'higher volume but ROI worse than baseline (overconfident fake edge)',
      'calendar cherry-pick (drop months) without structural reason',
    ]),
  }),
  /**
   * 已保存的主影子候選（觀察期；不換主看、不接正式）
   * 證據：auditNpbResearchShadow → tmp-npb-research-shadow.json
   */
  savedPrimaryShadow: Object.freeze({
    id: 'ridge_poisson_cal_same',
    head: 'ridge_poisson',
    features: 'foundation_full_with_pitcher',
    calibrate: true,
    shrink: primary.shrink,
    temp: primary.temp,
    shrinkToLeague: 0,
    gate: 'mid',
    status: 'saved_observe',
    artifact: 'tmp-npb-saved-shadow-ridge-cal-same.json',
    audit: 'scripts/auditNpbResearchShadow.mjs',
    paperEvidenceUsd50: Object.freeze({
      bets: 257,
      hitRate: 0.5992,
      roi: 0.1274,
      usd50: 1638,
      deltaVsBaselineUsd50: 830,
      byYear: Object.freeze({
        '2024': Object.freeze({ bets: 182, usd50: 961, deltaUsd50: 447 }),
        '2025': Object.freeze({ bets: 66, usd50: 364, deltaUsd50: 295 }),
        '2026': Object.freeze({ bets: 9, usd50: 314, deltaUsd50: 89 }),
      }),
      windowNote: 'expanding month OOS；warmup 前兩月；無平手；mid gate',
    }),
    note:
      '2026-08-04 保存：同 shrink/temp 校準後 ridge→泊松優於 logistic；foundation 已含先發；重疊／分歧見 overlap 產物；仍 research_only',
    overlapArtifact: 'tmp-npb-saved-shadow-overlap.json',
    snapshotArtifact: 'tmp-npb-saved-shadow-ridge-cal-same.json',
  }),
  /**
   * 相對主影子的邊際改進（觀察；不取代 savedPrimaryShadow）
   * 證據：auditNpbRidgeShadowOptimize → tmp-npb-ridge-shadow-optimize.json
   */
  savedImproveShadow: Object.freeze({
    id: 'ridge_cal_mu_league_025',
    parentShadowId: 'ridge_poisson_cal_same',
    head: 'ridge_poisson',
    features: 'foundation_full_with_pitcher',
    calibrate: true,
    shrink: primary.shrink,
    temp: primary.temp,
    shrinkToLeague: 0.25,
    gate: 'mid',
    status: 'saved_observe_marginal',
    artifact: 'tmp-npb-saved-shadow-mu-league-025.json',
    audit: 'scripts/auditNpbRidgeShadowOptimize.mjs',
    paperEvidenceUsd50: Object.freeze({
      bets: 258,
      hitRate: 0.6008,
      roi: 0.1305,
      usd50: 1683,
      deltaVsParentUsd50: 45,
      maeTotal: 3.096,
      maeDeltaVsParent: -0.042,
      byYearDeltaUsd50: Object.freeze({
        '2024': 95,
        '2025': -50,
        '2026': 0,
      }),
    }),
    ablationNote: Object.freeze({
      dropPitcher: 'Δ$ −1100 vs parent — 先發特徵對 ridge 獨贏有貢獻，禁止再砍',
      pitcherCoreOnly: 'Δ$ −1256 — 不可只留 pitcher_core',
      strongerRidge: 'Δ$ −434 — 過強正則傷注量',
      totalsGated: '仍近打平；MAE 略降但大小盤未就緒',
    }),
    note:
      '2026-08-04 優化輪保存：μ→訓練窗聯賽均總分 shrink 0.25；相對主影子僅 +$45，屬邊際；2025 略負須續盯',
  }),
  /** 對照／負對照影子 */
  openShadows: Object.freeze([
    Object.freeze({
      id: 'ridge_poisson_raw',
      head: 'ridge_poisson',
      calibrate: false,
      status: 'negative_control',
      note: '未校準負對照：注多假 edge；Δ$ 觸 earlyStop',
    }),
    Object.freeze({
      id: 'ridge_poisson_cal_same',
      head: 'ridge_poisson',
      calibrate: true,
      shrink: primary.shrink,
      temp: primary.temp,
      shrinkToLeague: 0,
      status: 'saved_observe',
      note: '已保存主影子',
    }),
    Object.freeze({
      id: 'ridge_cal_mu_league_025',
      head: 'ridge_poisson',
      calibrate: true,
      shrink: primary.shrink,
      temp: primary.temp,
      shrinkToLeague: 0.25,
      status: 'saved_observe_marginal',
      note: '主影子上 μ→聯賽收縮 0.25；邊際改進觀察中',
    }),
  ]),
  note:
    '學習 MLB：基線凍住；影子只觀察；Δ$／分年／注量一併看；不自動升格、不接推薦',
});

export function npbShadowPromoteVerdict({ baseline, shadow, byYear = {} } = {}) {
  const bUsd = Number(baseline?.usd50) || 0;
  const sUsd = Number(shadow?.usd50) || 0;
  const delta = sUsd - bUsd;
  const bets = Number(shadow?.bets) || 0;
  const obs = NPB_RESEARCH_SHADOW_SPEC.observation;
  const yearFails = [];
  for (const [y, row] of Object.entries(byYear || {})) {
    const d = Number(row?.deltaUsd50);
    if (Number.isFinite(d) && d < obs.yearDeltaFloorUsd50) {
      yearFails.push({ year: y, deltaUsd50: d });
    }
  }
  let status = 'keep_observing';
  let reason = '尚未達升格條件';
  if (bets < obs.minShadowBets) {
    status = 'thin_sample';
    reason = `影子注數 ${bets} < ${obs.minShadowBets}`;
  } else if (delta <= obs.earlyStopNetUsd50) {
    status = 'fail_early_stop';
    reason = `相對基線 Δ$${delta} 觸及 earlyStop`;
  } else if (delta <= 0) {
    status = 'fail_no_lift';
    reason = `相對基線無正 Δ$（Δ$${delta}）`;
  } else if (yearFails.length) {
    status = 'fail_year_drag';
    reason = `單年拖後腿：${yearFails.map((x) => `${x.year}:${x.deltaUsd50}`).join(',')}`;
  } else {
    status = 'candidate_discuss_only';
    reason = 'OOS 有正 Δ$ 且無單年踩線；仍 research_only，需人工決定是否換主看';
  }
  return {
    status,
    promote: false,
    wiredToFormal: false,
    deltaUsd50: delta,
    yearFails,
    reason,
  };
}
