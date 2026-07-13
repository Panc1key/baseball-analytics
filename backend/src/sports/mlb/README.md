# MLB — 美職大聯盟（當前主力）

## 賽季

- 例行賽：約 **3 月底 ～ 9 月底**（2026：3/25–9/27）
- 初盤同步建議：開賽前 3～6 小時

## 模型（現有檔案位置）

| 檔案 | 說明 |
|------|------|
| `services/H2hModel.js` | Pythagorean + Log5 + 先發 + 市場混合 |
| `services/TotalsModel.js` | 大小盤（實驗，均注暫不主推） |
| `services/MlbStatsService.js` | statsapi 戰績 / 先發 |
| `data/parkFactors.js` | 球場係數 |

## 遷移計劃

1. 將上述檔案移入 `sports/mlb/models/`、`sports/mlb/stats/`
2. `AnalysisEngine` 改為調用 `sports/mlb/analyze.js`
3. 保持對外 API 不變
