# MLB Expected Runs v4.6 — 訓練／消融協定（凍結草案）

> 對齊日：2026-07-31（Cursor × Grok）  
> 狀態：**協定凍結草案**（特徵定義細節已定死；升格容忍數字仍可微調）  
> 選場輕罰路線已結束；本版只服務「結構特徵進期望得分模型」  
> **正式 `v4.5` 權重／選注常數不變**，直到 §5 雙層閘通過

---

## 0. 一句話目標

在 **不改鎖定 B 選注常數** 的前提下，把兩類「先發身份異常」餵進期望得分模型，用與 v4.5 **同一套訓練／消融／溫度**協定判斷是否值得升格為 `mlb-expected-runs-nb-v4.6`。

---

## 1. 本版只加兩項（凍結清單）

| 特徵族 | 賽前定義（凍結） | 向量鍵 | 資料來源 |
|--------|------------------|--------|----------|
| 真 IL 回歸 | `isReturnPitcher`：`daysSinceLastIlExit≤45` 且 `seasonIpBefore<30` | `opponentStarterIsReturnFromIl` ∈ {0,1} | `mlb_il_transaction_events` + `features.pitchers.*IlReturn` |
| 臨時／稀疏先發 | **見 §1.1 `sparseStart`** | `opponentStarterIsSparseStart` ∈ {0,1} | `pitchers.*.gamesStarted` + 該隊 `wins+losses` |

**明確本版不加：** opener 官方標、牛棚負荷新交互、休息天交互、天氣重入、career_ip 硬閘、選場 λ。

**對稱約定：** 與現有 `opponentStarter*` 一致——預測「打線得分」時，對手先發的身份異常進向量（主隊得分 ← 客投；客隊得分 ← 主投）。

可選診斷用（不進消融主清單）：`spotOrOpener`（sparse∨bullpenish）對照實驗；正式候選仍以 `sparseStart` 為準。

### 1.1 `sparseStart`（已定死，Cursor 確認版）

```
sparseStart =
  (season_gs ∈ [1, 3])
  AND (pitcher_team_games_played ≥ 15)
```

其中：

- `season_gs` = 對手先發本季 `gamesStarted`（特徵列賽前累計）
- `pitcher_team_games_played` = **該先發所屬球隊**賽前 `wins + losses`（已在 `features.home` / `features.away`）

**理由（Grok 建議，Cursor 採納）：** 純 GS∈[1,3] 在開季前兩週會把大量正常輪值誤標成 sparse；加上「該隊已打 ≥15 場」可降開季噪聲，定義仍簡單可回放。

**代理（僅當 W+L 缺失時）：** `commence_time` 日期 ≥ 當年 4 月 20 日。現有 baseline 特徵已有 W+L，正式路徑以 W+L 為準。

**不採用：** 曆法「開季前 N 天」作為主定義（比場次代理更難跨季對齊）。

---

## 2. 訓練窗（必須與 v4.5 一致，禁止「快速重訓」另開協定）

沿用 `runMlbExpectedRunsValidation` 現行切法：

| 集合 | 定義 |
|------|------|
| Development | 2025-05-01 起之 2025 季列（按時間排序） |
| Train | Development 前 70% |
| Validation | Development 後 30% |
| Final / Observed | 2026 季完賽列（與現腳本 `final2026` 同） |

硬條件（不足則拒絕 persist）：

- train ≥ 700、validation ≥ 300、final2026 ≥ 300  
- 特徵列 `feature_version = MLB_BASELINE_FEATURE_VERSION`  
- 雙先發 ID 齊（與現 enrich 一致）

**禁止：** 換年切法、只用 2026 擬合、手調權重當「重訓」、validation 上看完再改定義而不改版本號。

---

## 3. 消融候選（最小集合）

以 v4.5 正式選中集為底座（凍結時：`core_plus_batting_platoon`）。

| key | 特徵 |
|-----|------|
| `base_v45` | 現行選中集（對照） |
| `base_plus_il_return` | base + `opponentStarterIsReturnFromIl` |
| `base_plus_sparse_start` | base + `opponentStarterIsSparseStart` |
| `base_plus_il_and_sparse` | base + 兩項 |

可選對照（不計入「主消融過關」）：`base_plus_spot_or_opener`（替換 sparse 定義）。

Fallback 模型：維持「無嚴格先發身份時」路徑；新旗標在 fallback 一律填 0（或缺＝0），不把 IL／sparse 寫進 fallback 選中集，除非單獨消融證明有效。

---

## 4. 選模指標（與 v4.5 相同）

1. 各候選在 **validation2025** 算 `totalRunsMae`、`moneylineBrier`（及現有 logLoss／方向命中可記錄）  
2. 過濾：丟掉相對最佳 MAE **明顯變差**者（沿用現碼閾值邏輯：`bestMae + 0.02`）  
3. 在剩餘中以 **moneyline Brier 最小** 為主選  
4. 溫度校準：僅允許 T≥1，在 validation 上擬合（禁止 T&lt;1 尖化）  
5. 用 **全 development 重拟合** 最終權重 + 上述 T，再打 **2026 observed**

記錄每個候選的：validation Brier／MAE、2026 Brier／MAE、expectedRunsSide 勝率、strict 紙上摘要（若現管線有）。

---

## 5. 升格閘門（雙層，保留不推翻）

### 5.1 模型層（必要）

相對 `base_v45` 最終模型：

- validation moneyline Brier **≤** base（允許相等；若略差須在報告論證且 5.2 大勝，否則否決）  
- 2026 observed moneyline Brier **不惡化超過** 預先寫死的容忍（建議：**不大於 base + 0.001**；數字可微調）  
- 部署門檻仍參考現有 PIT／樣本規則；**本版可不強求立刻改 deploymentDecision**，但必須輸出對照表

### 5.2 鎖定 B 紙上層（必要，本專案真正 KPI）

用**同一套** `ev02_max230 + frozen_b+shrink + earlySoft + Top3/drop`，只換期望得分模型：

| 閘 | 要求 |
|----|------|
| 合併窗 @$50 | **>** v4.5 鎖定 B 基線 |
| 2025、2026 分窗 @$50 | **≥** 各自基線 |
| 建議 | Expanding WF 月 beat≥hurt 或不差於基線敘述清楚 |

任一模層過、紙上不過 → **不升格正式**，只留研究權重。  
紙上過、模層略差 → 預設 **仍不升格**，除非雙方 AI 書面同意並標註例外。

---

## 6. 實作順序（工程清單）

1. **特徵向量** — 已接：`buildMlbExpectedRunsSideFeatures`  
2. **消融表** — 已接：`runMlbExpectedRunsV46RcAblation`  
3. **版本** — 研究跑：`mlb-expected-runs-nb-v4.6-rc`；正式仍 `v4.5`  
4. **腳本** — `retrainMlbExpectedRunsV46.mjs`、`auditMlbV46LockedBShadow.mjs`  
5. **資料預檢** — 見 `tmp-v46-rc-ablation.json` 的 `identityFlagRates`

### 6.1 首跑 rc 結果（2026-07-31，不升格）

| 候選 | val Brier | 2026 Brier | 鎖定B合併@$50 Δ |
|------|-----------|------------|-----------------|
| `base_v45`（選中） | 0.2439 | 0.2492 | $0（基線） |
| `+il` | 0.2441 | 0.2493 | −$745 |
| `+sparse` | 0.2442 | 0.2492 | −$563 |
| `+il+sparse` | 0.2442 | 0.2493 | −$343 |

→ 協定選模選中 `base_v45`；加特徵後紙上雙窗皆傷。**不升格。** 結構方向仍可能對，但二元旗標進期望得分此輪無效／有害。

### 6.2 rc2 連續值（2026-07-31，不升格）

| 候選 | val Brier Δ | 2026 Brier Δ | 鎖定B合併@$50 Δ | 分窗 |
|------|-------------|--------------|-----------------|------|
| `base_v45` | 0 | 0 | $0 | — |
| `rc2a` daysSinceIlExit | +0.0003 | +0.0006 | **−$1902** | 雙窗傷 |
| `rc2b` season_gs | **−0.0002**（模層略優） | +0.00003 | **−$415** | 雙窗傷 |

→ rc2b 通過模型選模／模層容忍，但**紙上門失敗**。  
→ **協定結論：IL／sparse 這兩類訊號暫不進入期望得分模型**；不做交互項堆疊。正式線維持 v4.5／鎖定 B。

---

## 7. 明確不做（本協定）

- 選場層再罰 IL／sparse（已否決）  
- P 乘子重過 EV 閘  
- 為過閘而放寬 minOdds／TopK／EV  
- 手調 λ「當成」v4.6  
- 未過 §5 就把正式線切到 v4.6

---

## 8. 已關閉／保留的開放問題

| # | 問題 | 狀態 |
|---|------|------|
| 1 | `sparseStart` 開季保護 | **已定死** §1.1（GS∈[1,3] ∧ 該隊 W+L≥15） |
| 2 | IL 連續 `daysSinceLastIlExit` | 本版不加；二元旗標先跑 |
| 3 | 模層 vs 紙上衝突 | 維持 §5：預設兩邊都要過；例外需書面 |

---

## 9. 相關產物

| 產物 | 路徑 |
|------|------|
| IL 旗標 | `docs/expansion/MLB-IL-RETURN-FLAG.md` |
| Opener／sparse | `docs/expansion/MLB-OPENER-SPOT-STARTER.md` |
| 本協定 | `docs/expansion/MLB-V46-TRAINING-PROTOCOL.md` |
| v4.5 重訓入口 | `backend/scripts/retrainMlbExpectedRunsV45.mjs` |
| v4.6-rc 入口 | `backend/scripts/retrainMlbExpectedRunsV46.mjs` |
| 鎖定 B 影子門 | `backend/scripts/auditMlbV46LockedBShadow.mjs` |
