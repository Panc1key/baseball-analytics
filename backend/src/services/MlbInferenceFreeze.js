/**
 * MLB 推理骨架凍結契約（不改算式、不加減特徵）。
 *
 * 唯一正式推理：兩隊預期得分 → 比分分布 → 獨贏／大小／讓分概率。
 * 其餘路徑僅 shadow、路由或 audit，不得另算一套可下注意義的勝率。
 */
export const MLB_INFERENCE_FREEZE = Object.freeze({
  frozenAt: '2026-07-25',
  skeleton: 'expected-runs-score-distribution',
  formalPredictor: 'predictMlbGameRuns',
  /** soft 調均值／方差：僅 audit scripts，禁止進 PrematchTruth 正式路徑 */
  auditOnlyPredictor: 'predictMlbGameRunsWithRegime',
  orchestrator: 'MlbPrematchTruthPipeline',
  ranker: 'MlbResearchRanker.selectExpectedRunsResearchDirection',
  classifier: 'classifyMlbMoneylineCandidate',
  /** 可附加、不改均值 */
  routingAllowed: 'attachMlbRegimeMarketPlan',
  shadowOnly: Object.freeze([
    'MlbHistoricalBaseline.predictMlbBaseline (opt-in MLB_BASELINE_SHADOW=true)',
    'PitcherInjuryIntelService',
    'MlbModelValidation',
    'selectBaselineH2hEdge / selectResearchDirection (deprecated for ranking)',
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
    rule: '唯一準確率／方向來源 = ExpectedRuns 均值與其導出市場概率；篩選門檻只影響紙上規則，不開第二套預測骨架。',
  };
}
