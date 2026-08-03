# MLB B 線基準包鎖定（停微調）

> 鎖定日：2026-07-30（升格自影子 `frozen_b+shrink`）  
> 前一版：2026-07-28（純 `ev02_max230`，無殘差／shrink）  
> 2026-07-31：`maximumPickOdds` 2.30→**2.50**（`auditMlbMaxOddsUpperBandDiag`；≥2.50 仍毒）  
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
| 注碼 | 均注（不接 Kelly） |

紙上對照（@$50，2024-04～09 + 2025-04～09 + 2026-04～07/22）：

| KPI | 值 |
|-----|-----|
| 注數 | ~611 |
| 勝率 | ~55.32% |
| ROI | ~13.1% |
| @$50 | ~+$4,007 |
| 相對升格前純 B | 約 +$1,033；三窗皆正 |

回滾疊加（回升格前純 ev02）：`.env` → `MLB_LOCKED_B_OVERLAY=false`  
回滾更舊選注底座：`MLB_PAPER_RULE_PROFILE=frozen_v1`

程式：`MlbFrozenBShadow.js`（規格）／`MlbPrematchTruthPipeline`（殘差）／`classifyMlbMoneylineCandidate`（shrink）  
台帳：`MLB-B-LINE-EXPERIMENT-LEDGER.md`

---

## 2. 為什麼停 B 微調

已掃盡且否決／無效的方向包括：甜區硬切、保量軟路由、特徵軟罰、v4.5 權重縮放、rest／牛棚硬過濾、Kelly、混大小、TopK≥4、**分差／minOdds 讓步**等。  
2026-07-30 升格：`earlyExits` 硬擋 → **軟罰 λ=0.20**（`auditMlbVolumeLiftEarlySoftExpandingWf`）。疊加係數（`b`／`w`）仍凍結。

---

## 3. 進化軌道

### 現行：路徑 γ + 已鎖疊加

- 正式推薦／紙上建注 = 本包。  
- 新想法 → **影子觀察** → 過閘再升格成下一版鎖定。  
- 手冊：`MLB-PATH-GAMMA-PAPER.md`

### 現行可開關 overlay：高 EV 收縮 `shrink_w15_l15`

| 項 | 內容 |
|----|------|
| 開關 | `.env` → `MLB_HIGH_EV_SHRINK_SHADOW=off\|compare\|apply`（**預設 apply**） |
| 範圍 | 僅 **EV≥8%** 子集：`w=0.15` 向市場收縮 → 再過原閘 → 日 Top；排序另扣 λ=0.15×超出 8% 的 EV |
| apply | 套用至可看選邊／紙上晉升；**不改** ev02／`frozen_b+shrink` 主常數；回退設 `compare` 或 `off` |
| compare | 正式選邊不變，僅對照 |
| 證據 | Expanding WF PASS；合併 Δ≈+$327；2026 略拖須持續盯 |

程式：`MlbHighEvShrinkShadow.js`；WF：`auditMlbCalHighEvTailExpandingWf.mjs`

---

### 路徑 α／β

仍可研究，但不得改本包常數當日常實驗。

---

## 4. 給下一手的一句話

> 現行鎖定 B = `ev02_max230` + `frozen_b+shrink`；高 EV `shrink_w15_l15` 預設 **apply**（可一鍵回退）。不要直接拧殘差／毒客旋鈕。
