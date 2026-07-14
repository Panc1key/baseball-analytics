# NBA / 籃球 — 初盤（效率×節奏 + 常態淨勝分）

## 定價標準（對齊業界）

1. **節奏 · 攻防效率**（KenPom / 籃球分析教科書）  
   - `pace`、`offRtg`、`defRtg` 由場均得分反推（無官方 pace 時）  
   - `homePts ≈ pace/100 × (homeOff+awayDef)/2` + 主場分數  
2. **淨勝分** `Margin ~ Normal(μ, σ)`，σ≈11.5（NBA 歷史常見 11–12）  
   - 獨贏：`P(margin>0)=1-Φ(0)`  
   - 讓分：`P(margin+line>0)`；整數盤近似 push  
3. **總分** `Total ~ Normal(μ_t, σ_t)`，σ_t≈14 → `P(Over)`  

參考：KenPom AdjEM×Tempo；FiveThirtyEight Elo/RAPTOR 亦用 rating→概率映射；AgentBets / Basketball Analytics textbook。

## 環境變數

- `BASKETBALL_HOME_COURT_PTS`（預設 3.0）  
- `BASKETBALL_MARGIN_SIGMA`（預設 11.5）  
- `BASKETBALL_TOTAL_SIGMA`（預設 14）  

API：`/api/basketball` · 滾球：未做。
