/**
 * MLB 紙上選注規則凍結點（可回滾）。
 *
 * 在改 TopK／亞聯／放寬門檻之前：正式預設必須能一鍵回到此快照。
 * 凍結內容只含「選注／排序規則」，不含 ExpectedRuns 均值算式（那屬 MlbInferenceFreeze）。
 */
export const MLB_PAPER_RULE_FREEZE = Object.freeze({
  freezeId: 'mlb-paper-rule-v2026-07-27',
  frozenAt: '2026-07-27',
  label: 'B+P2 + minOdds≥1.85 + 雙先發 ID + dailyTopK=3',
  /** 對應 MlbExpectedRunsModel 內 profile id（凍結時與 min185 相同） */
  profileId: 'min185',
  paperEvidence: Object.freeze({
    windows: ['2025-04~09', '2026-04~07'],
    approxCalendarMonths: 9.72,
    bets: 388,
    hitRate: 0.5438,
    avgOdds: 2.01,
    roi: 0.0932,
    usd50Pnl: 1809,
    notes: [
      'auditMlbMinOddsAb / auditMlbIdentityScanOnMin185',
      '去掉 TopK 場次幾乎不升（tmp-no-topk-scan.json）',
      'rest／bullpen 硬過濾已否決（見實驗台帳）',
    ],
  }),
  rules: Object.freeze({
    minimumModelProbability: 0.5,
    minimumExpectedRunMargin: 0.25,
    minimumExpectedValue: 0.03,
    minimumPickOdds: 1.85,
    maximumPickOdds: 2.2,
    requirePickEarlyExitsNotHigher: true,
    requireBothPitcherIdentities: true,
    maximumAbsoluteZScore: 3.5,
    dailyTopK: 3,
    dailyRankBy: 'penalized_ev',
    highEvRankPenaltyLambda: 0.15,
    highEvRankPenaltyMinEv: 0.12,
    highEvRankPenaltyProbMin: 0.53,
    highEvRankPenaltyProbMaxExclusive: 0.56,
  }),
  stakeDefaultUsd: 75,
  rollback: Object.freeze({
    env: 'MLB_PAPER_RULE_PROFILE=min185',
    /** 或顯式凍結別名 */
    envAlias: 'MLB_PAPER_RULE_PROFILE=frozen_v1',
    docs: 'docs/expansion/MLB-PAPER-RULE-FREEZE.md',
    ledger: 'docs/expansion/MLB-B-LINE-EXPERIMENT-LEDGER.md',
  }),
});

export function getMlbPaperRuleFreezeSnapshot() {
  return {
    ...MLB_PAPER_RULE_FREEZE,
    rules: { ...MLB_PAPER_RULE_FREEZE.rules },
  };
}

/**
 * 實驗改壞時：把正式 profile 指回凍結點。
 * （程式內常數回滾指引；實際切換靠 env / resolveMlbMoneylineRuleProfile）
 */
export function describeMlbPaperRuleRollback() {
  return {
    freezeId: MLB_PAPER_RULE_FREEZE.freezeId,
    steps: [
      '將 .env 設為 MLB_PAPER_RULE_PROFILE=frozen_v1（或 min185）',
      '重啟後端；確認 API／紙上推薦使用該 profile',
      '複跑 node scripts/auditMlbMinOddsAb.mjs 對照紙上指標是否回到凍結附近',
      '勿刪除 MLB_MONEYLINE_RULE_PROFILES.frozen_v1／min185',
    ],
  };
}
