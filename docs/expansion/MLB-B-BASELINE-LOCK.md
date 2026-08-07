# MLB B 線基準包鎖定（停微調）

> 鎖定日：2026-07-30（升格自影子 `frozen_b+shrink`）  
> 前一版：2026-07-28（純 `ev02_max230`，無殘差／shrink）  
> 2026-07-31：`maximumPickOdds` 2.30→**2.50**（`auditMlbMaxOddsUpperBandDiag`；≥2.50 仍毒）  
> **2026-08-03：組合包** — 獨贏主倉 + Hybrid 大小 + 串關規則（`locked_b_package_v2026-08-03`）  
> **2026-08-04：組合包** — Hybrid **v1.1**：Over·raw `absGap≤1.25`（`locked_b_package_v2026-08-04`）  
> 狀態：**紙上主基準**；選注常數、v4.5 權重、疊加係數不再為「抬勝率」而改  
> 之後進化：另開**影子觀察**，確認後再升格；**禁止**日常掃本包常數

---

## 1. 基準包內容（B-baseline-2026-07-30）

| 層 | 鎖定內容 |
|----|----------|
| 模型 | `mlb-expected-runs-nb-v4.5`（16 特徵） |
| profile | `ev02_max230`（`.env`：`MLB_PAPER_RULE_PROFILE=ev02_max230`） |
| **疊加** | **`frozen_b+shrink`**：客隊殘差 `b≈-0.0605`（`a=0`）+ 毒客 shrink `w=0.45`／P≥55%／homeWinPct≥65% |
| EV / margin / P | ≥2% / ≥0.25 / ≥50%（shrink 後再過閘） |
| 賠率帶 | minOdds≥1.85、maxOdds≤2.50、eitherSide≥1.2 |
| 資料閘 | 雙先發 ID、完整 h2h≥2庄；**earlyExits 軟罰 λ=0.20**（非硬擋） |
| 日內 | TopK=3、P2 λ=0.15、early軟罰 0.20、`dropThirdIfMarginBelow=0.5`、`dropSecondIfOddsBelow=1.95` |
| 注碼 | 均注 **$50**（不接 Kelly） |

紙上對照（@$50，2024-04～09 + 2025-04～09 + 2026-04～07/22）：

| KPI | 值 |
|-----|-----|
| 注數 | ~611～697（窗略異） |
| 勝率 | ~55% |
| ROI | ~13～14% |
| @$50 | ~+$4k～+$4.9k |

回滾疊加（回升格前純 ev02）：`.env` → `MLB_LOCKED_B_OVERLAY=false`  
回滾更舊選注底座：`MLB_PAPER_RULE_PROFILE=frozen_v1`

程式：`MlbFrozenBShadow.js`（規格）／`MlbPrematchTruthPipeline`（殘差）／`classifyMlbMoneylineCandidate`（shrink）  
台帳：`MLB-B-LINE-EXPERIMENT-LEDGER.md`

---

## 1b. 組合包（2026-08-04）— 獨贏 + Hybrid 大小 + 串關

程式：`MlbLockedBPackage.js` → API `lockedBPackage`；UI「今日鎖定 B 組合包」。

| 層 | 鎖定內容 |
|----|----------|
| 獨贏 | 上文 B 主倉（含高 EV `shrink_w15_l15` apply） |
| 大小 | **Hybrid** `totals_sat_hybrid_v1.1`：Under=raw gap≥0.6；Over=投手公園 μ−0.70 且 gap≥0.9；**Over·raw 另限 absGap≤1.25** |
| 注碼 | **一律均注 $50**（`.env`：`MLB_TOTALS_SATELLITE_STAKE_USD=50`，`PRIMARY=hybrid`） |
| 分欄 | 大小**不混**獨贏 TopK；不寫入 `mlb_paper_bets` |
| 串關優先 | **同日獨贏 2 串**：可看選邊、賠率≤2.10、排名前兩腿 @$50 |
| 串關次選 | **R1 獨贏 × Hybrid Under**（優先異場）@$50 |

Hybrid v1.1（@$50，相對 v1 無 cap；`auditMlbTotalsHybridBestScheme`）：

| | 注數 | 勝率 | ROI | Δ$ |
|--|------|------|-----|-----|
| v1（無 raw cap） | 1387 | 55.2% | 6.9% | +4763 |
| **v1.1（raw≤1.25）** | **787** | **58.3%** | **13.4%** | **+5270** |

三年皆贏 v1；回滾 raw cap：`.env` → `MLB_TOTALS_RAW_OVER_MAX_ABS_GAP=off`。

日均期望（歷史均攤，非保證）：有選邊日 B+Hybrid 約 **+$23**；含空手日約 **+$19**（v1 口径；v1.1 注少、單注品質更高）。

---

## 2. 為什麼停 B 微調

已掃盡且否決／無效的方向包括：甜區硬切、保量軟路由、特徵軟罰、v4.5 權重縮放、rest／牛棚硬過濾、Kelly、混大小進 TopK、TopK≥4、**分差／minOdds 讓步**等。  
2026-07-30 升格：`earlyExits` 硬擋 → **軟罰 λ=0.20**。疊加係數（`b`／`w`）仍凍結。  
2026-08-03：大小全局對盤口校準／再猛收 Over 閘門 → **否決**；僅 Hybrid + Over gap0.9 納入組合包。  
2026-08-04：Over·raw **maxAbsGap=1.25** 升格進組合包（**不是**抬 minGap；獨贏常數未動）。

---

## 3. 進化軌道

### 現行：路徑 γ + 已鎖疊加 + 組合包

- 正式推薦／紙上建注（獨贏）= 本包 B。  
- 大小／串關 = 組合包提示（與獨贏同分頁展示）。  
- 新想法 → **影子觀察** → 過閘再升格。  

### 現行可開關 overlay：高 EV 收縮 `shrink_w15_l15`

| 項 | 內容 |
|----|------|
| 開關 | `.env` → `MLB_HIGH_EV_SHRINK_SHADOW=off\|compare\|apply`（**預設 apply**） |
| 範圍 | 僅 **EV≥8%** 子集：`w=0.15` 向市場收縮 → 再過原閘 → 日 Top |
| apply | 套用至可看選邊／紙上晉升；**不改** ev02／`frozen_b+shrink` 主常數 |

程式：`MlbHighEvShrinkShadow.js`

### 現行正式 overlay：手術 B `surgical_b_away_r1_midodds`

| 項 | 內容 |
|----|------|
| 狀態 | **正式套用**（2026-08-08） |
| 開關 | `.env` → `MLB_SURGICAL_AWAY_R1_MIDODDS_SHADOW=off\|compare\|apply`（**預設 apply**） |
| 規則 | **選客 且 dailyRank=1 且賠率∈[1.95, 2.10)** → 從可看選邊／紙上剔除 |
| 範圍 | **只動獨贏**；大小 Hybrid 不受影響 |
| 歷史 @$50 | 砍 118 注；剩餘 n=579；HR **56.48%**（+1.53pp）；ROI **17.91%**；**Δ$+$264**；2024/25/26 皆正 |

程式：`MlbSurgicalAwayR1MidoddsShadow.js`

### 現行正式 overlay：大小 `totals_cut_under_pitcher_park`

| 項 | 內容 |
|----|------|
| 狀態 | **正式套用**（2026-08-08） |
| 開關 | `.env` → `MLB_TOTALS_UNDER_PITCHER_SHADOW=off\|compare\|apply`（**預設 apply**） |
| 規則 | Hybrid **Under（raw_under）且 parkFactor&lt;0.97** → 從可看選邊剔除 |
| 範圍 | **只動大小 Hybrid** |
| 歷史 @$50 | 砍 51 注；剩餘 n=736；HR **59.24%**；ROI **15.21%**；**Δ$+$326** |

程式：`MlbTotalsUnderPitcherShadow.js`

### 不進正式（僅 compare／off）

| 刀 | 預設 | 原因 |
|----|------|------|
| 手術 A（hwp≥65%） | off | 歷史美元不如只開 B；與強主場重疊 |
| 強主場 WinrateStrongHome | compare | Frozen B 純 skip 歷史 Δ$−$306 |
| FragileUnder（ERA≥5） | compare | 抬勝率但 Δ$−$174 |
| 高 EV shrink／方向 blend | compare | 未過正式美元閘 |

### 組合包歷史近似（獨贏+大小 @$50）

| 組合 | 約總盈虧 | vs 雙基準 |
|------|----------|-----------|
| 基準獨贏+Hybrid | +$10,192 | — |
| **正式：手術 B + Under×投手** | **+$10,782** | **+$590** |

---

## 4. 給下一手的一句話

> 正式組合包 = 鎖定 B 獨贏（**手術 B apply**）+ Hybrid v1.1（**Under×投手 apply**）+ 串關。不改 ev02／frozen_b 主常數。回退：`MLB_SURGICAL_AWAY_R1_MIDODDS_SHADOW=compare|off`、`MLB_TOTALS_UNDER_PITCHER_SHADOW=compare|off`。強主場／手術 A／FragileUnder 維持對照。