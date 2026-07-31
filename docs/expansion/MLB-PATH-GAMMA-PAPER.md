# MLB 路徑 γ：鎖定 B 紙上實盤（停選注進化）

> 啟動日：2026-07-28  
> 疊加升格：2026-07-30（`frozen_b+shrink` 納入正式鎖定）  
> 原則：**不改** `ev02_max230` 選注常數、v4.5 權重、疊加係數；只累積活體紙上帳本，對照鎖定基準 KPI。  
> 基準包：`MLB-B-BASELINE-LOCK.md`（B-baseline-2026-07-30）

---

## 1. 為什麼走 γ

A′／選注微調在同池 PIT 上邊際已薄。  
本階段目標：**確認鎖定 B（含疊加）在真實賽程是否仍站得住**，再決定要不要開下一輪影子。

---

## 2. 你要設的環境

```env
MLB_PAPER_RULE_PROFILE=ev02_max230
MLB_PAPER_FLAT_STAKE_USD=75
# 預設開啟疊加；回滾升格前純 B：
# MLB_LOCKED_B_OVERLAY=false
```

（報表對照歷史基準仍用 @$50 口徑；config 均注另列。）

---

## 3. 閉環（已接）

每次 `fullRefresh`：

1. 結算 `mlb_paper_bets`  
2. 跑賽前 truth pipeline（**含** residual + toxic shrink）  
3. **`promoteDailyLockedBPaperCandidates`** → `paper_candidate`  
4. **`autoCreateEligiblePaperBets`** → 紙上注  

新優化候選**不**進此閉環，直到另開影子驗證並升格。

---

## 4. 怎麼看報表

```bash
cd backend
node scripts/reportMlbPathGammaPaper.mjs
```

產物：`tmp-path-gamma-paper-report.json`  
API：`GET /mlb/paper-ledger` → `data.pathGamma`（含 `frozenBShadow` 狀態：已升格）

| 欄位 | 意義 |
|------|------|
| `baselineLock` | 現行鎖定 KPI（611／55.32%／+$4007 @$50 三窗） |
| `liveLedger.overallAt50` | 活體結算 |
| `frozenBShadow` | 疊加狀態（`promoted_to_formal_lock`） |
| `drift.*` | 相對鎖定窗偏離 |

---

## 5. 操作紀律

1. **禁止**為抬勝率改 B 門檻／日內結構／權重／疊加 `b`・`w`。  
2. 樣本 &lt;20：只記帳。  
3. 新想法：另開影子腳本 → 台帳 → 過閘再升格。  
4. 回滾疊加：`MLB_LOCKED_B_OVERLAY=false`；回滾選注：`MLB_PAPER_RULE_PROFILE=frozen_v1`。

---

## 6. 一週節奏建議

| 頻率 | 動作 |
|------|------|
| 每日／排程 | sync + fullRefresh |
| 每週 1 次 | `reportMlbPathGammaPaper.mjs` |
| 滿 ~20～40 結算注 | 對照基準再決定下一影子 |
