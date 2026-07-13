# MatchupCore — 場次分析核心

## 設計原則

**先算一場比賽的完整情境，再映射到獨贏 / 讓分 / 大小 / 球員盤。**

```
輸入：戰績、近況、先發、傷兵、市場賠率
  ↓
MatchupCore.buildMatchupAnalysis()
  ↓
輸出：homeWinProb、edges（兩邊 EV）、favoriteTrap、因素說明
  ↓
RecommendationRules → 各盤口候選
```

## 與舊 H2hModel 的差異

| 舊邏輯 | 新邏輯 |
|--------|--------|
| 季賽戰績權重高 | 先發 + L10 動量權重更高 |
| 傷兵僅人數×0.006 | 傷兵名單 + 人數階梯折損 |
| 必須推模型看好的一方 | **兩邊都算 EV，推 EV 最高且達標的一方** |
| 固定市場混合 40% | 模型與市場背離時**降低**混合權重 |
| 無「熱門陷阱」 | 市場熱門但 EV 在冷門 → 標記並允許推冷門 |

## 關鍵輸出欄位

- `matchupCore.homeSituation` / `awaySituation` — 情境分數
- `matchupCore.edges.home/away` — 各側 EV、edge%、賠率
- `matchupCore.edges.bestSide` — EV 最佳方向
- `matchupCore.edges.favoriteTrap` — 是否市場過度追捧熱門

## 待擴展

- [ ] 傷兵按 WAR / 先發打者加權（需球員級數據）
- [ ] 打者近期安打 → 映射到 batter_hits 盤
- [ ] 足球：xG、傷病、主客 form → 同一 MatchupCore 介面
