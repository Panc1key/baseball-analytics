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
  savedAt: '2026-08-05',
  formalWiredAt: '2026-08-05',
  role: 'formal_recommend_ml',
  wiredToFormal: true,
  formalScope: Object.freeze({
    moneyline: true,
    totals: false,
    kbo: false,
    paperLedger: false,
    dailyTopK: 3,
    service: 'NpbPrematchRecommend.js',
    packageId: 'npb_formal_mu025_if_dev_ge15_topk3_v2026-08-05',
    route: 'GET /api/npb/prematch',
    note: '獨贏正式日推已接（條件 μ + 日 TopK=3）；大小／KBO／紙上帳仍未接',
  }),
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
   * Round4：條件收縮 |μ−league|≥1.5 才套 0.25（修 2025-04 無結構噪音）
   * 證據：auditNpbShadowOptRound4 → tmp-npb-shadow-opt-round4.json
   */
  savedImproveShadow: Object.freeze({
    id: 'ridge_mu025_if_dev_ge_15',
    parentShadowId: 'ridge_poisson_cal_same',
    head: 'ridge_poisson',
    features: 'foundation_full_with_pitcher',
    calibrate: true,
    shrink: primary.shrink,
    temp: primary.temp,
    shrinkToLeague: 0.25,
    minAbsMuDevFromLeague: 1.5,
    gate: 'mid',
    status: 'saved_observe_marginal',
    artifact: 'tmp-npb-saved-shadow-mu025-if-dev-ge15.json',
    audit: 'scripts/auditNpbShadowOptRound4.mjs',
    paperEvidenceUsd50: Object.freeze({
      bets: 256,
      hitRate: 0.6016,
      roi: 0.1318,
      usd50: 1688,
      deltaVsParentUsd50: 50,
      byYearDeltaUsd50: Object.freeze({
        '2024': 50,
        '2025': 0,
        '2026': 0,
      }),
    }),
    replaces: 'ridge_cal_mu_league_025',
    note:
      '2026-08-05 round4：僅當 |μ0−league|≥1.5 才 μ→league 0.25；Δ$+$50 且 2025 年 Δ$=0；仍 research_only、不換主看',
  }),
  /**
   * Round3 無條件 mu_league_025（保留對照；2025-04 −$50）
   * 證據：auditNpbRidgeShadowOptimize / round3
   */
  savedImproveShadowUnconditional: Object.freeze({
    id: 'ridge_cal_mu_league_025',
    parentShadowId: 'ridge_poisson_cal_same',
    head: 'ridge_poisson',
    features: 'foundation_full_with_pitcher',
    calibrate: true,
    shrink: primary.shrink,
    temp: primary.temp,
    shrinkToLeague: 0.25,
    gate: 'mid',
    status: 'saved_observe_marginal_superseded',
    artifact: 'tmp-npb-saved-shadow-mu-league-025.json',
    audit: 'scripts/auditNpbRidgeShadowOptimize.mjs',
    paperEvidenceUsd50: Object.freeze({
      bets: 258,
      hitRate: 0.6008,
      roi: 0.1305,
      usd50: 1683,
      deltaVsParentUsd50: 45,
      byYearDeltaUsd50: Object.freeze({
        '2024': 95,
        '2025': -50,
        '2026': 0,
      }),
    }),
    note:
      '無條件 μ→league 0.25；round4 顯示 2025-04 hurt 無結構特徵（僅 1 場分歧）；已由 if_dev_ge_15 接替為主邊際',
  }),
  /**
   * 大小盤研究影子（多數樣本在 2026；歷史 h2h 回填缺 totals）
   * 證據：auditNpbShadowOptRound2 → tmp-npb-shadow-opt-round2.json
   */
  savedTotalsShadow: Object.freeze({
    id: 'totals_poisson_mu025_mid',
    parentControl: 'gap_legacy',
    head: 'ridge_poisson_totals',
    muShrinkToLeague: 0.25,
    prob: 'poissonTotalOverUnderProb(μh+μa)',
    calibrateMlShrinkTemp: false,
    gate: Object.freeze({
      minOdds: 1.7,
      maxOdds: 2.2,
      minProb: 0.52,
      minEdge: 0.02,
      minEv: 0.02,
    }),
    status: 'saved_observe_thin_year',
    artifact: 'tmp-npb-saved-shadow-totals-poisson-mu025.json',
    audit: 'scripts/auditNpbShadowOptRound2.mjs',
    paperEvidenceUsd50: Object.freeze({
      bets: 351,
      hitRate: 0.5271,
      roi: 0.0053,
      usd50: 93,
      deltaVsGapLegacyUsd50: 235,
      gapLegacyUsd50: -142,
      yearCoverageNote: '2024/2025 raw+pit totals=0；僅 2026 有盤',
    }),
    note:
      '2026-08-05：泊松對線 + μ→聯賽 0.25 優於 gap；樣本僅 2026，禁止正式',
  }),
  /**
   * 大小盤邊際改進（相對 savedTotalsShadow）
   * 證據：auditNpbShadowOptRound3 → tmp-npb-shadow-opt-round3.json
   */
  savedTotalsImproveShadow: Object.freeze({
    id: 'totals_poisson_mu025_edge03',
    parentShadowId: 'totals_poisson_mu025_mid',
    muShrinkToLeague: 0.25,
    minEdge: 0.03,
    minEv: 0.03,
    status: 'saved_observe_marginal_thin_year',
    artifact: 'tmp-npb-saved-shadow-totals-edge03.json',
    audit: 'scripts/auditNpbShadowOptRound3.mjs',
    paperEvidenceUsd50: Object.freeze({
      bets: 340,
      hitRate: 0.5294,
      roi: 0.0102,
      usd50: 174,
      deltaVsSavedTotalsUsd50: 81,
    }),
    coverageNote: '仍幾乎僅 2026；under≈35 腿（round4 標 thin_under）',
    note: '2026-08-05 round3：edge≥3% 略優於 mid；round4 確認 under 腿過少，雙邊不升格',
  }),
  /**
   * Round4：Over-only + edge03（相對 mid +$41；無 under 腿問題）
   */
  savedTotalsOverOnlyShadow: Object.freeze({
    id: 'totals_poisson_mu025_edge03_over',
    parentShadowId: 'totals_poisson_mu025_mid',
    muShrinkToLeague: 0.25,
    minEdge: 0.03,
    minEv: 0.03,
    side: 'over',
    status: 'saved_observe_marginal_thin_year',
    artifact: 'tmp-npb-saved-shadow-totals-edge03-over.json',
    audit: 'scripts/auditNpbShadowOptRound4.mjs',
    paperEvidenceUsd50: Object.freeze({
      bets: 305,
      hitRate: 0.5279,
      roi: 0.0088,
      usd50: 134,
      deltaVsSavedTotalsUsd50: 41,
    }),
    coverageNote: '僅 2026；只打 Over',
    note: '2026-08-05 round4：雙邊 edge03 的 under 過 thin；Over-only 可討論但仍 thin-year、不升格',
  }),
  round2Ablation: Object.freeze({
    edgeFilters:
      'maxEdge/maxEv/odds 帶：ROI 可升但 Δ$ 相對主影子為負（砍量），不作主看',
    totalsPoisson: 'poisson_mu025_mid 已存；round3 edge03 為邊際層',
    artifact: 'tmp-npb-shadow-opt-round2.json',
  }),
  round3Ablation: Object.freeze({
    muLeagueGrid: '0.15 與 0.25 結果相同 +$45；0.35 僅 +$7；2025-04 單一Hurt −$50',
    totalsCoverage: '2024/2025 totals 覆蓋 0/0；補歷史需 Odds API，暫不自動燒額',
    artifact: 'tmp-npb-shadow-opt-round3.json',
  }),
  round4Ablation: Object.freeze({
    april2025:
      'mu025 vs cal 僅 1 場分歧；focusHurtLooksStructural=false；砍月敏感度僅報告（Δ$ 45→95）',
    conditionalMu:
      'if |μ−league|≥1.5 → mu025：Δ$+$50、2025 年 Δ$=0；已存為 savedImproveShadow',
    totalsAsymmetry:
      'mid under 38 / over 313；edge03/04 thin_under；edge03_over +$41 已存 over-only 邊際',
    artifact: 'tmp-npb-shadow-opt-round4.json',
  }),
  round5Ablation: Object.freeze({
    formalFreq: '不限：147 有注日、均 1.74 注／日；條件收縮套用率 28.9%',
    dailyTopK:
      'TopK=3：238 注 ROI 15.3% @$50=+1826（Δ+$138 vs 不限）；已寫入 NPB_FORMAL_PACKAGE.dailyTopK',
    topK2: 'TopK=2 Δ$−344 — 過砍',
    topK4: 'TopK=4 Δ$−137 — 不如 3',
    artifact: 'tmp-npb-formal-opt-round5.json',
    audit: 'scripts/auditNpbFormalOptRound5.mjs',
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
      id: 'ridge_mu025_if_dev_ge_15',
      head: 'ridge_poisson',
      calibrate: true,
      shrink: primary.shrink,
      temp: primary.temp,
      shrinkToLeague: 0.25,
      minAbsMuDevFromLeague: 1.5,
      status: 'saved_observe_marginal',
      note: 'round4 主邊際：條件 μ→league',
    }),
    Object.freeze({
      id: 'ridge_cal_mu_league_025',
      head: 'ridge_poisson',
      calibrate: true,
      shrink: primary.shrink,
      temp: primary.temp,
      shrinkToLeague: 0.25,
      status: 'saved_observe_marginal_superseded',
      note: '無條件 mu025；已被 if_dev_ge_15 接替',
    }),
    Object.freeze({
      id: 'totals_poisson_mu025_mid',
      head: 'ridge_poisson_totals',
      status: 'saved_observe_thin_year',
      note: '大小盤泊松影子；幾乎僅 2026',
    }),
    Object.freeze({
      id: 'totals_poisson_mu025_edge03',
      head: 'ridge_poisson_totals',
      status: 'saved_observe_marginal_thin_year',
      note: 'totals mid 上 edge≥3%；under 腿 thin',
    }),
    Object.freeze({
      id: 'totals_poisson_mu025_edge03_over',
      head: 'ridge_poisson_totals',
      status: 'saved_observe_marginal_thin_year',
      note: 'Over-only + edge03；round4',
    }),
  ]),
  note:
    'NPB 獨贏已接正式日推（條件 μ→league）；大小／KBO／紙上仍觀察；Δ$／分年／注量一併看；不自動升 totals',
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
