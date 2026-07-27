# MLB 推理骨架凍結與現況整合檢查

> 凍結日：2026-07-25  
> 原則：**預測兩隊得分 → 比分分布 → 衍生獨贏／大小** 為唯一正式骨架。  
> 本輪**不改算式、不加減特徵**；只盤點、凍結、修正路徑整合。

## 一、凍結契約

| 角色 | 模組 | 狀態 |
|------|------|------|
| 正式預測 | `MlbExpectedRunsModel.predictMlbGameRuns` | **凍結為唯一推理** |
| 編排／事實 | `MlbPrematchTruthPipeline` | **凍結為唯一 MLB 輸出編排** |
| 研究方向 | `MlbResearchRanker` + `classifyMlbMoneylineCandidate` | **凍結為紙上排序語意** |
| 主 API／UI | `GET /mlb/prematch-truth`、`MlbPrematchTruthPanel` | **凍結為唯一前端決策面** |
| 路由（不改均值） | `attachMlbRegimeMarketPlan` | 允許實驗附加 |
| soft 調均值 | `predictMlbGameRunsWithRegime` | **僅 audit，禁止進正式管線** |
| Shadow | `MlbHistoricalBaseline`（opt-in）、傷病 intel、model-validation | 可算、不可定邊 |
| Legacy MLB | `TeamAnalyzer`／`RecommendationRules`／舊 totals | **禁止產生 MLB 新推薦** |
| NPB／KBO | `ModelPipeline` 泊松 λ 路徑 | **不在本凍結範圍**（維持舊 SSOT） |

程式常數：`backend/src/services/MlbInferenceFreeze.js`

## 二、整合進度

### 已完成

1. PrematchTruth 用 `predictMlbGameRuns` + `attachMlbRegimeMarketPlan`，不走 soft regime 調均值。
2. 紙上候選用 `selectExpectedRunsResearchDirection`，不以 baseline edge 定邊。
3. `mlbTruthResearchOnly: true` 擋住 MLB 舊推薦；**只跳過 MLB**，NPB／KBO 仍分析。
4. `POST /analyze` = NPB/KBO `runAnalysis` + MLB PrematchTruth。
5. **版本字串**：slate／快照改讀 `validation.modelVersion`（fallback `mlb-expected-runs-nb-v4.5`）。
6. **Baseline 閘門脫鉤**：不再因 baseline 缺失把場次打成 `blocked_data`；先發／牛棚 mandatory 不再跟 baseline 綁死。
7. **Baseline shadow 預設關閉**（`MLB_BASELINE_SHADOW=true` 才算）；`selectBaselineH2hEdge` 標 deprecated。
8. 前端標示 ExpectedRuns 為正式輸出；ModelValidation 標為 shadow；閘門文案對齊。

### 仍保留／之後可做（仍不改公式）

| 項目 | 說明 |
|------|------|
| 未掛載面板 | `DailySlatePanel`／`LivePanel` 維持不掛 |
| 紙上 A／B 線 | **主線跟 B**；交接見 `MLB-PAPER-LINE-B-HANDOFF.md`。A 僅對照，不改模型 |
| Shadow 對照 UI | 若開啟 `MLB_BASELINE_SHADOW`，可再加「shadow 概率」摺疊列（可選） |
| 舊快照 | DB 內仍可能含 `baseline_*:missing` 閘門字串；前端已標「舊快照」 |

## 三、整合優化方向（不做算式／特徵增減）

1. **單一真相面**：UI 只把 ExpectedRuns 當正式勝率／大小；baseline 必須標 shadow。
2. **單一編排入口**：`fullRefresh` 或 analyze = NPB/KBO + MLB truth。
3. **雙紙上線凍結**：A 勝率線／B ROI 線只改規則常數與腳本。
4. **Legacy 隔離**：MLB 永不寫入可實投 `recommendations`。
5. **審計腳本分流**：`auditMlb*` 結果不得默認寫回正式權重。

## 四、明確禁止（凍結期間）

- 再開一套與 ExpectedRuns 平行的 MLB 勝率模型當正式輸出
- 把 `predictMlbGameRunsWithRegime` 接進 PrematchTruth
- 用傷病 LLM 旗標進均值權重
- 為了衝勝率反覆改分差／EV 卻宣稱「模型升級」
- 關閉 `mlbTruthResearchOnly` 復活舊 MLB 推薦（除非樣本外過關且另開變更單）

## 五、一句話

> 開發正確性鎖在「兩隊得分分布」；盈利性用固定紙上規則驗。骨架已凍結，路徑已向 ExpectedRuns 收斂。
