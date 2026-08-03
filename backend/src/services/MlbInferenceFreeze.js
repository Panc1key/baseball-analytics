/**
 * MLB 推理骨架凍結契約（不改算式、不加減特徵）。
 *
 * 唯一正式推理：兩隊預期得分 →（鎖定 B 疊加）→ 比分分布 → 獨贏／大小／讓分概率。
 * 其餘路徑僅 shadow、路由或 audit，不得另算一套可下注意義的勝率。
 */
export const MLB_INFERENCE_FREEZE = Object.freeze({
  frozenAt: '2026-07-25',
  updatedAt: '2026-07-30',
  skeleton: 'expected-runs-score-distribution',
  formalPredictor: 'predictMlbGameRuns',
  formalOverlay: 'frozen_b+shrink (applyFormalLockedBResidual + toxic shrink in classify)',
  /** soft 調均值／方差：僅 audit scripts，禁止進 PrematchTruth 正式路徑 */
  auditOnlyPredictor: 'predictMlbGameRunsWithRegime',
  orchestrator: 'MlbPrematchTruthPipeline',
  ranker: 'MlbResearchRanker.selectExpectedRunsResearchDirection',
  classifier: 'classifyMlbMoneylineCandidate',
  /** 可附加、不改均值 */
  routingAllowed: 'attachMlbRegimeMarketPlan',
  overlayRollbackEnv: 'MLB_LOCKED_B_OVERLAY=false',
  shadowOnly: Object.freeze([
    'MlbHistoricalBaseline.predictMlbBaseline (opt-in MLB_BASELINE_SHADOW=true)',
    'PitcherInjuryIntelService',
    'MlbModelValidation',
    'selectBaselineH2hEdge / selectResearchDirection (deprecated for ranking)',
    'MlbHighEvShrinkShadow shrink_w15_l15（預設 apply 可看選邊；回退 MLB_HIGH_EV_SHRINK_SHADOW=compare|off；不改 ev02 主常數）',
    '未來新優化候選（另開影子，未升格前不進正式）',
  ]),
  legacyMlbBlocked: Object.freeze([
    'TeamAnalyzer.analyzeMatchup (MLB)',
    'RecommendationRules (MLB)',
    'TotalsModel / H2hModel / GameScoreModel (MLB 產出推薦)',
    'recommendations 表的 MLB 新訊號',
  ]),
  leaguesOutsideFreeze: Object.freeze(['NPB', 'KBO']),
});

export function describeMlbInferenceFreeze() {
  return {
    ...MLB_INFERENCE_FREEZE,
    rule:
      '唯一準確率／方向來源 = ExpectedRuns 均值 + 凍結疊加 frozen_b+shrink 與其導出市場概率；篩選門檻只影響紙上規則，不開第二套預測骨架。',
  };
}
