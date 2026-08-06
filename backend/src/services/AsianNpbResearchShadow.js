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
  totalsFormalWiredAt: '2026-08-06',
  role: 'formal_recommend_ml_totals',
  wiredToFormal: true,
  formalScope: Object.freeze({
    moneyline: true,
    totals: true,
    kbo: false,
    paperLedger: false,
    dailyTopK: 3,
    service: 'NpbPrematchRecommend.js',
    packageId: 'npb_formal_mu025_if_dev_ge15_topk3_v2026-08-05',
    totalsPackageId: 'npb_formal_totals_edge03_over_drop_odds_185_200_v2026-08-06',
    route: 'GET /api/npb/prematch',
    note:
      '獨贏正式（條件 μ + TopK=3）+ 大小正式（edge03 Over + 砍中賠 1.85–2.00）；KBO 仍 pause；用戶 2026-08-06 明示升格 totals（thin-year 已知）',
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
  /**
   * Round6：僅 2026 totals 盈利刀（砍 absGap≥1.5／甜蜜帶／TopK；不補 Odds、不升正式）
   * 證據：auditNpbTotalsOptRound6 → tmp-npb-totals-opt-round6.json
   */
  round6Ablation: Object.freeze({
    parentRefresh:
      'poisson_mu025_mid 重算 349 注 @$50=−185（ROI −1.1%）；4 月 −$226 為主拖累；相對 round2/3 存檔已翻負',
    absGapCap:
      'maxAbsGap<1.5：mid→+$179（Δ+$364）；edge03→+$269；edge03_over→+$283 — 厚邊有毒方向確認',
    gapBand1015:
      'absGap∈[1.0,1.5) 最高 Δ+$687 但僅 77 注；視為過砍／過擬合候選，不存主邊際',
    juneHurt:
      'gap-cap Over-only 在 2026-06 系統 Hurt（lt15 −$305、lt125 −$439）；勿只看總 Δ$',
    moreStableDiscuss:
      'edge03_maxAbsGap_lt15 + 日 TopK=3：216 注 +$221、四個月皆近平／正（4 月僅 −$57）— 穩於甜蜜帶與 lt125',
    topK: '對 gap-cap 再 TopK=2 多過砍；TopK=3 可討論',
    edge05: 'edge05_over Δ$−181 — 負對照',
    doNotPromoteFormal: true,
    noOddsBackfill: true,
    artifact: 'tmp-npb-totals-opt-round6.json',
    audit: 'scripts/auditNpbTotalsOptRound6.mjs',
  }),
  /**
   * Round6 存檔：砍厚邊（maxAbsGap<1.5）+ edge03 Over-only
   * 總 Δ$ 好看但 6 月 Hurt；僅觀察、不接日推
   */
  savedTotalsGapCapOverShadow: Object.freeze({
    id: 'totals_edge03_over_maxAbsGap_lt15',
    parentShadowId: 'totals_poisson_mu025_mid',
    muShrinkToLeague: 0.25,
    minEdge: 0.03,
    minEv: 0.03,
    side: 'over',
    maxAbsGap: 1.5,
    status: 'saved_observe_marginal_thin_year_june_hurt',
    artifact: 'tmp-npb-totals-opt-round6.json',
    audit: 'scripts/auditNpbTotalsOptRound6.mjs',
    paperEvidenceUsd50: Object.freeze({
      bets: 217,
      hitRate: 0.5346,
      roi: 0.0261,
      usd50: 283,
      deltaVsRefreshedMidUsd50: 468,
      june2026Usd50: -305,
    }),
    note:
      '2026-08-06 round6：確認 absGap≥1.5 有毒；Over+gap-cap 總利潤升但 6 月 Hurt，禁止正式',
  }),
  /**
   * Round6 較穩討論檔：edge03 + maxAbsGap<1.5 + 日 TopK=3（雙邊）
   */
  savedTotalsGapCapTopK3Shadow: Object.freeze({
    id: 'totals_edge03_maxAbsGap_lt15_topk3',
    parentShadowId: 'totals_poisson_mu025_mid',
    muShrinkToLeague: 0.25,
    minEdge: 0.03,
    minEv: 0.03,
    maxAbsGap: 1.5,
    dailyTopK: 3,
    status: 'saved_observe_marginal_thin_year',
    artifact: 'tmp-npb-totals-opt-round6.json',
    audit: 'scripts/auditNpbTotalsOptRound6.mjs',
    paperEvidenceUsd50: Object.freeze({
      bets: 216,
      hitRate: 0.5324,
      roi: 0.0205,
      usd50: 221,
      deltaVsRefreshedMidUsd50: 406,
      underLegsOnBaseBeforeTopK: 36,
    }),
    note:
      '2026-08-06 round6：月度較平；under 仍 thin；僅 2026、不升格',
  }),
  nextWork: Object.freeze({
    totals:
      '已接正式日推（用戶 2026-08-06 升格）；持續紙上日更對照；觀察跨季是否翻負；禁 Odds 歷史回填',
    moneyline: '正式已接；與 totals 同板並行',
    kbo: '仍觀察、不接',
  }),
  /**
   * Round10：NPB 效果總覽（正式獨贏重算 + 大小紙上刷新）
   * 證據：auditNpbStatusRound10 → tmp-npb-totals-opt-round10.json
   */
  round10Ablation: Object.freeze({
    moneylineFormalRefresh:
      'TopK3：238 注命中 61.3% ROI 15.3% @$50=+1826（與正式包一致）；未限 256 注 +$1688',
    moneylineByYear: '2024 +$1149／2025 +$364／2026 +$314（但 2026 僅 9 注）',
    totalsShadow:
      'edge03_over+砍中賠：124 注／決定 122；命中 59.8%；ROI 14.6%；+$890；距 150 剩 26',
    liveBoard: '當下 upcoming=0（庫內無未來 NPB 場）',
    promoteTotals: '2026-08-06 用戶明示升格 → formalScope.totals=true',
    doNotPromoteFormal: false,
    userPromotedTotals: true,
    noOddsBackfill: true,
    artifact: 'tmp-npb-totals-opt-round10.json',
    audit: 'scripts/auditNpbStatusRound10.mjs',
  }),
  /**
   * Round9：紙上影子日更／累積門檻
   * 證據：auditNpbTotalsOptRound9 → tmp-npb-totals-opt-round9.json
   */
  round9Ablation: Object.freeze({
    packageId: 'totals_edge03_over_drop_odds_185_200',
    replay: '124 注（含 push）／決定 122；命中 59.8%；@$50=+890',
    pace: '約 1.17 注／日、距 target 150 剩 26（ETA ~23 日）',
    db: '已同步 npb_totals_shadow_paper_bets；live fill／settle 已接',
    api: 'GET /api/npb/totals-research-shadow（?sync=1 日更）；/ledger',
    promote:
      'blocked_observe：bets<150 + thin_year；autoWireBlocked；formalScope.totals 仍 false',
    doNotPromoteFormal: true,
    noOddsBackfill: true,
    artifact: 'tmp-npb-totals-opt-round9.json',
    audit: 'scripts/auditNpbTotalsOptRound9.mjs',
    service: 'NpbTotalsResearchShadow.js',
  }),
  /**
   * Round7：2026-06 gap-cap Hurt 切片（不砍月）
   * 證據：auditNpbTotalsOptRound7 → tmp-npb-totals-opt-round7.json
   */
  round7Ablation: Object.freeze({
    juneFocus:
      'edge03_over_maxAbsGap_lt15：6 月 50 注 −$305（命中 46%）；非 6 月同變體 +$589',
    lineNote:
      'focus 宇宙幾乎全是 line≤7.5（6 月 50/50、其餘 167/167）；砍低線=砍全部，屬 6 月 cherry-pick',
    bothToxicOddsBand:
      'odds∈[1.85,2.00)：6 月 −$171／其餘 −$411 — 雙邊有毒；砍後 focus 85 注 +$865（Δ+$582）',
    juneConcentrated:
      'absGap∈[0.5,1.0) 與 μ−line∈[0.5,1.0)：6 月 −$456、其餘約平；砍後利潤幾乎全來自修 6 月',
    longOdds:
      'odds∈[2.00,2.20) 其餘月極強（+$889）但 6 月仍 −$150；只打長賠注量 44、過薄',
    topK3Transfer:
      'drop_odds_185_200 套在 edge03_maxAbsGap_lt15_topk3：81 注 +$671（Δ+$450）、6 月轉正 +$104',
    doNotPromoteFormal: true,
    noOddsBackfill: true,
    noDropJuneMonth: true,
    artifact: 'tmp-npb-totals-opt-round7.json',
    audit: 'scripts/auditNpbTotalsOptRound7.mjs',
  }),
  /**
   * Round7 存檔：gap-cap Over + 砍中賠帶 1.85–2.00（已被 round8 更簡主觀察接替）
   */
  savedTotalsDropOdds185200Shadow: Object.freeze({
    id: 'totals_edge03_over_gap15_drop_odds_185_200',
    parentShadowId: 'totals_edge03_over_maxAbsGap_lt15',
    muShrinkToLeague: 0.25,
    minEdge: 0.03,
    minEv: 0.03,
    side: 'over',
    maxAbsGap: 1.5,
    dropOddsBand: Object.freeze({ minInclusive: 1.85, maxExclusive: 2.0 }),
    status: 'saved_observe_marginal_thin_year_superseded',
    artifact: 'tmp-npb-totals-opt-round7.json',
    audit: 'scripts/auditNpbTotalsOptRound7.mjs',
    paperEvidenceUsd50: Object.freeze({
      bets: 85,
      hitRate: 0.6235,
      roi: 0.2035,
      usd50: 865,
      deltaVsGapCapOverUsd50: 582,
      june2026Usd50: -134,
      byMonthUsd50: Object.freeze({
        '2026-04': 302,
        '2026-05': 573,
        '2026-06': -134,
        '2026-07': 124,
      }),
    }),
    note:
      '2026-08-06 round7：中賠帶雙邊有毒；round8 改以無 gap-cap 的 edge03_over+砍中賠為主觀察',
  }),
  /**
   * Round8：砍 odds∈[1.85,2.00) 跨變體複驗
   * 證據：auditNpbTotalsOptRound8 → tmp-npb-totals-opt-round8.json
   */
  round8Ablation: Object.freeze({
    hardPass:
      '5 組硬門通過（Δ$>0、注≥80、半月皆正、leave-one-month 最小仍正）；含 mid／edge03／edge03_over／over+gap15',
    best:
      'edge03_over + drop_odds_185_200：122 注 +$890（Δ+$1013）、四月全非負（6 月 +$1）、keepRate 41%',
    midTransfer: 'mid + 砍中賠：140 注 +$631（Δ+$816）；edge03：137 注 +$691（Δ+$786）',
    specificity:
      '鄰近帶負對照：砍 1.70–1.85 弱／負；砍 2.00–2.20 大負（mid Δ−$799）— 中賠帶特異成立',
    gapCapHalfWeak:
      'gap-cap 路徑半月後半常翻負（mid_gap／edge03_gap TopK3）；不如無 gap 的 edge03_over+砍中賠穩',
    stillThinYear: '僅 2026；注量 122–140，未達多年 OOS 升格',
    doNotPromoteFormal: true,
    noOddsBackfill: true,
    artifact: 'tmp-npb-totals-opt-round8.json',
    audit: 'scripts/auditNpbTotalsOptRound8.mjs',
  }),
  /**
   * Round8 主觀察存檔：edge03 Over-only + 砍中賠 1.85–2.00（無強制 gap-cap）
   */
  savedTotalsEdge03OverDropOddsShadow: Object.freeze({
    id: 'totals_edge03_over_drop_odds_185_200',
    parentShadowId: 'totals_poisson_mu025_edge03_over',
    muShrinkToLeague: 0.25,
    minEdge: 0.03,
    minEv: 0.03,
    side: 'over',
    dropOddsBand: Object.freeze({ minInclusive: 1.85, maxExclusive: 2.0 }),
    status: 'formal_wired_thin_year',
    promotedAt: '2026-08-06',
    artifact: 'tmp-npb-totals-opt-round8.json',
    audit: 'scripts/auditNpbTotalsOptRound8.mjs',
    paperEvidenceUsd50: Object.freeze({
      bets: 122,
      hitRate: 0.5984,
      roi: 0.1459,
      usd50: 890,
      deltaVsEdge03OverUsd50: 1013,
      keepRate: 0.411,
      byMonthUsd50: Object.freeze({
        '2026-04': 238,
        '2026-05': 452,
        '2026-06': 1,
        '2026-07': 199,
      }),
      halfSplitUsd50: Object.freeze({ first: 423, second: 467 }),
    }),
    note:
      '2026-08-06 用戶明示升格：已接正式日推；證據僅 2026（thin-year），回滾可關 formalScope.totals',
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
    Object.freeze({
      id: 'totals_edge03_over_maxAbsGap_lt15',
      head: 'ridge_poisson_totals',
      status: 'saved_observe_marginal_thin_year_june_hurt',
      note: 'round6：砍 absGap≥1.5 + Over；6 月 Hurt',
    }),
    Object.freeze({
      id: 'totals_edge03_maxAbsGap_lt15_topk3',
      head: 'ridge_poisson_totals',
      status: 'saved_observe_marginal_thin_year',
      note: 'round6：gap-cap + TopK3；月較穩、仍 thin-year',
    }),
    Object.freeze({
      id: 'totals_edge03_over_gap15_drop_odds_185_200',
      head: 'ridge_poisson_totals',
      status: 'saved_observe_marginal_thin_year_superseded',
      note: 'round7：砍 odds 1.85–2.00 + gap-cap；已被 round8 無 gap 主觀察接替',
    }),
    Object.freeze({
      id: 'totals_edge03_over_drop_odds_185_200',
      head: 'ridge_poisson_totals',
      status: 'formal_wired_thin_year',
      note: '2026-08-06 已接正式：edge03 Over + 砍中賠；僅 2026 證據',
    }),
  ]),
  note:
    'NPB 獨贏＋大小均已接正式日推（大小 thin-year 已知、用戶 2026-08-06 明示升格）；KBO 仍 pause；不燒 Odds 補歷史 totals',
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
