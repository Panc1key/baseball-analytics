# 動態選盤架構（EdgeSignals）

## 問題

舊邏輯用固定公式（Log5 + 市場混合）+ 固定盤口優先級，無法表達：

- 足球/棒球：**弱隊低水 vs 黑馬高水近況火熱** → 應投高水正 EV
- 棒球：**打者近期安打增多** → 應投安打大 0.5，而非硬推讓分

## 新流程

```
每場比賽
  → 生成所有候選（h2h / spread / totals / props）
  → EdgeSignals 計算 actionableScore（含近況動量、冷門高水加成）
  → 選最高分 = 主推
  → 僅「本場最佳」且通過門檻的候選標記 flat_bet
```

## 訊號模組

| 訊號 | 狀態 | 說明 |
|------|------|------|
| `teamMomentum` | 已接入 | L10 勝率 − 季賽勝率，寫入 H2hModel |
| `contrarianDog` | 已接入 | 高水冷門 + 模型 edge |
| `totalsModelGap` | 已有 | TotalsModel，需 edge≥4% 才搶均注 |
| `batterRecentHits` | **待接入** | 需 statsapi 打者近期安打序列 |
| `soccerForm` | 未建 | 足球擴展時新增 |

## 球員安打盤（下一步）

`PlayerPropAnalyzer.estimateBatterHitsProb` 目前用固定 0.95 場均，**這是你說的「機械化」核心缺口**。

計劃：

1. `MlbStatsService.getBatterRecentGames(playerId, n=14)`
2. 計算近 14 場安打率 vs 賽季
3. `propTrendBonus` 寫入 EdgeSignals
4. 開啟 `ENABLE_PLAYER_PROPS=true` 後可進均注競爭

## 均注門檻（差異化，不排除大小）

| 盤口 | 最低賠率 | 最低 edge |
|------|----------|-----------|
| 獨贏/讓分 | 1.80 | 2.5% |
| 大小 | 1.80 | 4% |
| 球員盤 | 1.80 | 4% |

每場僅 **1 個** flat_bet（本場 actionableScore 最高者）。
