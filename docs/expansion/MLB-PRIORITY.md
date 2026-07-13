# MLB 當前優先項（P0）

## 目標

- 單場均注：賠率 ≥1.75，長期勝率 >57%
- 減少「幻覺」：模型勝率不得過度偏離市場
- 主推 **獨贏 / 讓分**；大小盤降級為實驗或暫停均注

## 已知問題（7/9 回測）

| 問題 | 處理方向 |
|------|----------|
| watch 級負 EV 仍顯示 | 推薦列表過濾 `ev < 0` 或無 `bet_strategy` |
| 大小盤主推命中率 ~50% | 均注 Tab 排除 totals；TotalsModel 僅觀察 |
| 錨腿串關與均注混淆 | 前端 Tab 已分離，後端門檻再收緊 |
| 模型過度自信 | `maxModelEdgePct`、市場混合權重維持保守 |

## 待實作清單

- [ ] `MIN_SINGLE_ODDS=1.75` 全局均注門檻
- [ ] `getRecommendations` 預設隱藏負 EV / 無 strategy
- [ ] ROI 儀表板：已結算勝率、按盤口拆分
- [ ] 賽季日曆：MLB 3 月底～9 月底活躍提醒
- [ ] 累積 50+ 筆 bet_log 後再調參

## 現有程式位置（遷移前）

| 模組 | 路徑 |
|------|------|
| 獨贏模型 | `backend/src/services/H2hModel.js` |
| 大小模型 | `backend/src/services/TotalsModel.js` |
| 推薦規則 | `backend/src/services/RecommendationRules.js` |
| 雙軌策略 | `backend/src/services/BetStrategy.js` |
| 分析引擎 | `backend/src/services/AnalysisEngine.js` |
| 球場係數 | `backend/src/data/parkFactors.js` |

遷移目標：`backend/src/sports/mlb/`（逐步，不一次性大改）。
