/**
 * 棒球初盤模型契約（單一真相來源）
 *
 * 資料流（禁止旁路另算一套勝率）：
 *
 *   隊力 / 投手 / 球場
 *        ↓
 *   λ_home, λ_away          ← TotalsModel / NpbScoreModel（Elo 調 λ）
 *        ↓
 *   聯合計分分布            ← GameScoreModel（獨立泊松 ± Dixon–Coles ρ）
 *        ↓
 *   盤口概率                ← 獨贏 / 讓分 / 大小 皆由同一組 λ 推出
 *        ↓
 *   市場去水混合            ← H2hModel / odds（shrinkage）
 *        ↓
 *   可靠度校準 C(p)         ← ProbabilityCalibration（同版本、足量切片）
 *        ↓
 *   最終 edge 上限          ← PickScorer / calibrateModelProb（不可旁路）
 *        ↓
 *   EV → 決策門檻           ← PickScorer / BetStrategy（以 EV + p_cal 為主）
 *
 * 模組職責：
 * - BaseballElo：滾動 Elo；回測必須用 walk-forward（開賽前狀態）
 * - GameScoreModel：唯一計分引擎（泊松 / DC）
 * - ProbabilityCalibration：Brier/LogLoss + 分箱校準表
 * - PickScorer：排序分可作 UI，硬決策以 EV 與最低校準勝率為準
 */

export const MODEL_PIPELINE_VERSION = 'baseball-v2.9.1';

/**
 * SSOT 硬約束（v2.9.1：KBO 當日先發入 λ；v2.9.0：校準護欄／均注收緊）：
 * 1. 有 λ 時獨贏以泊松為主（Elo/Log5 權重受 ssotPoissonMinWeight 限制）
 * 2. 讓分/大小共用同一 ρ
 * 3. 滾球 prior λ 鎖定 feature_snapshots，不用滾球盤重估
 * 4. modelProb>72% 不得 primary；−1.5 均注需蓋盤≥70%
 * 5. 獨贏均注 modelProb≥64%（砍軟熱門噪音帶）
 * 6. 可靠度校準表須同 modelVersion 且切片達最低樣本
 */

export const MODEL_STAGES = [
  'strength_to_lambda',
  'score_distribution',
  'market_probs',
  'market_blend',
  'versioned_reliability_calibration',
  'final_market_edge_cap',
  'ev_and_gates',
];
