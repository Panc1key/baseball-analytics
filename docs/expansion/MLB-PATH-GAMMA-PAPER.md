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
3. **`promoteDailyLockedBPaperCandidates`** → `paper_candidate`（僅開賽前放出時窗內）  
4. **`autoCreateEligiblePaperBets`** → 紙上注  

可看選邊／紙上晉升時窗：`.env` `MLB_LOCKED_B_RELEASE_HOURS=8`（預設；`0`=關閉）。未進時窗只顯示「過門檻未放出」，不顯示選邊與賠率。

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

---

## 7. 活體日記（切片標籤，不改閘門）

### 2026-08-01（HK）｜1/3

紙上：國民 @2.13 負、皇家 @1.95 負、紅襪 @1.93 中；單位約 −1.07。

| 選邊 | 結果 | 切片標籤（長期觀察） |
|------|------|----------------------|
| 華盛頓國民 | 負 | `away_pitcher_edge_vs_strong_home`（客＋先發優勢挑強主場） |
| 堪薩斯皇家 | 負 | `weak_vs_weaker_coors_away`（弱旅對更弱＋Coors 客） |
| 波士頓紅襪 | 中 | `away_pitcher_underdog_still_picked`（客＋先發下風仍選） |

紀律備註：結構偏順兩場未中、偏逆一場中了 → **方差**，不改 v4.5／鎖定 B／賠率帶。  
下一步優先級（另開，不碰獨贏閘）：① 全場大小分最小可行規則 ② NPB／KBO 期望得分骨架 ③ 讓分／隊總分。

### 大小分衛星（2026-08-01）

- 規格：`MlbTotalsSatellite.js`（`totals_sat_v2026-08-01b`）  
- 閘門：`|μ−line|≥0.6`、EV≥3%、edge≥3%、P≥52%、賠率 1.5–2.4、盤口≤10  
- 三窗：2024 **+2.8%**／+$1,038；2025 **+3.0%**／+$976；2026 **+5.3%**／+$1,117；合併 **+3.5%**／+$3,131 @$50  
- 狀態：**準正式過閘、仍影子**（不進紙上帳本、不與鎖定 B 混排）  
- Grok A/B/C：溫度校準選注不穩；高分盤(>10)≈打平維持砍；閘門重掃勝出  
- under vs over（只診斷）：under ROI 更高但注少（278 vs 1528）；2024 over 略負 → **暫不改成只押一邊**  
- **Under 平行影子**（2026-08-01）：同 01b 閘門只取小；三窗 +26.7%／+11.4%／+2.7%；合併 ROI **+14.1%**（298 注）；UI 另列，不替換主衛星  
- **Grok 定案**：Under 觀察過關後可**單獨**升紙上衛星帳本（門檻 ≥25 注／≥8 有選邊日）；仍不混 B、不替換 01b  
- 讓分 ±1.5：**正式擱置**（雙邊／單邊皆過不了 2024）  
- 隊總分：historical 不支援；**現階段不接** event-odds；等大小分兩條影子穩了再評  
- **下一刀唯一優先**：Under 平行影子跑完觀察期 → 單獨紙上帳本  
- 腳本：`auditMlbTotalsSatGrokAbc.mjs`／`auditMlbTotalsSatUnderOnly3y.mjs`／`auditMlbRunLineSatDualYear.mjs`

### 準正式影子 → 紙上衛星帳本（過閘條件，尚未接帳本）

見 `MLB_TOTALS_SATELLITE_PAPER_PROMOTE_GATES`。

**每日 checklist**
1. 只跟鎖定 B「可看選邊」下獨贏（或明確空倉）。  
2. 大小分衛星：只記錄／極小注，不與獨贏搶注碼、不混排。  
3. 記：獨贏注數與結果、大小分注數與結果、累計活體 ROI。  
4. 對照門檻（注數／有選邊日／ROI）；觸及提前升或喊停只標記，不改規則。  
5. 收工：不因當日輸贏改閘門、不加新盤口、不做新實驗。

**盯 KPI**：累計注數、有選邊天數、活體勝率／ROI、是否背離 2026 回測、單周回撤。

| 動作 | 條件 |
|------|------|
| 提前升紙上衛星帳本 | ≥40 注且≥10 有選邊日；活體 ROI≥0（最好≥+2%）；非單周崩盤後翻本 |
| 喊停實盤大小分 | ROI≤−5% 且≥25 注；或連續 10 有選邊日淨虧且背離回測；或日注異常暴增／暴減 |
| 觀察期黑名單 | 再調閘門／校準進選注／只押一邊／TopK／混排／讓分隊總分道具／新特徵／改獨贏／因單周改常數 |
| 過關後優先序 | **唯一**：Under 平行影子觀察→單獨紙上帳本；讓分擱置；隊總分暫緩；不改 01b／不混 B |

### Under 平行影子觀察門檻（略降）

見 `MLB_TOTALS_UNDER_ONLY_PAPER_PROMOTE_GATES`：≥14 日／≥25 注／≥8 有選邊日；活體 ROI≥0（最好≥+2%）；升帳本後仍分倉。

### 讓分（正式擱置）

- spreads 24/25 已回補；雙邊／單邊三窗皆不過 2024 → **從優先序拿掉**  
- 除非新盤源或規則結構變化，否則不再挖
