# MLB 下一輪優化備忘（2026-07-30）

> 正式選注常數**不改**。本輪完成 A 診斷、B 近失場影子否決放寬、C 串關／漏斗產品。

## A｜為什麼有些天場次很少

- 約 **21%** 比賽日正式選注 = 0；平均一天 MLB ~12 場，合格池常為 0～2。
- **空白日主因（按「當天最多卡點」計）**
  - 缺先發 ID：約一半空白日（歷史特徵庫問題；實盤則是預定先發未齊）
  - 模型選邊賠率 &lt;1.85：約四成空白日
- **不是** Top3 把場砍光——空白日池子本來就是 0。

腳本：`backend/scripts/auditMlbEmptyDayAndNearMiss.mjs`  
產物：`backend/tmp-empty-day-near-miss.json`

## B｜近失場能不能加場？

| 近失類型 | 單獨勝率 | 加進池再 Top3 | 結論 |
|----------|----------|---------------|------|
| margin 0.20–0.25 | 46.8% | Δ場 +16、Δ$ **−422** | 否決放寬 |
| EV 1–2% | 52.8% | Δ場 +7、Δ$ **−183** | 否決放寬 |
| 賠率 1.75–1.85 且其餘過關 | 52.1% | Δ場 +47、Δ$ **−206** | 否決放寬 |

→ **確認不要靠放寬門檻加場。**

### v4.6／下一刀模型候選（影子優先）

1. **probable starter 契約**（高）— 縮 live／回測落差  
2. opener／牛棚賽標記（中）  
3. CLV／推薦時點（中）  
4. 天氣再入模（低，歷史增益極小）

## C｜已產品化（不改選場）

- API `GET /mlb/prematch-truth` 新增：
  - `sameDayParlay`：可看選邊中賠率 ≤2.10 取 Top 兩腿組同日 2 串提示
  - `todayFunnel`：今日場次／資料未齊／已分析／可看選邊＋主因
- UI「今日鎖定 B」顯示串關提示與漏斗條

## 明確不改

- TopK、minOdds 1.85、EV／margin、毒客 shrink 參數

---

## 續作（2026-07-30 晚）｜probable 契約

已做（仍不改選注常數）：

1. **Resolver 優先最新 complete**  
   `MlbProbableStarterService.resolveMlbProbableStarterSnapshot`  
   避免稍後單邊 partial 把整場打成 fallback。煙測：`tmpSmokeProbablePreferComplete.mjs` 通過。

2. **回填 2025 歷史缺 ID**  
   `backfillMlb2025PitcherIdentity.mjs` → 437 場補上雙 ID（`postgame_actual_oracle`）  
   產物：`tmp-backfill-2025-pitcher-identity.json`  
   用途：縮回測「假空白日」；**不是**把歷史假裝成 pit_probable。

3. **漏斗細分**  
   `todayFunnel.pitcherGap`（缺先發閘／IL衝突／身份不完整／非嚴格PIT／保留完整快照）+ UI 顯示。

### 回填後空白日再測（同窗）

見最新 `tmp-empty-day-near-miss.json`：缺 ID 作為空白日主因應明顯下降；剩餘主因以短盤 &lt;1.85 為主。

下一刀仍建議：opener／牛棚賽標記影子，或 live scheduler 更密抓取（不改門檻）。

---

## Grok 靈感細微權重影子（2026-07-31）

腳本：`auditMlbGrokStylePitcherWeightShadow.mjs` → `tmp-shadow-grok-style-pitcher-weights.json`  
底座：現行鎖定 B（含 shrink／early 軟罰）。**未改正式常數。**

| 方向 | 合併 Δ@$50 | 雙窗 | 結論 |
|------|------------|------|------|
| 罰臨時先發 proxy（GS少／短局） | 負數百 | 不過 | 否決 |
| 罰回歸／超高ERA proxy | λ=0.10 約 **+$211** | 過 | **弱正向候選**；需 WF |
| 罰「對上精英先發卻帳面差很多」 | +$44～+$95 | 過但樣本極薄（基線僅 ~7 注觸發） | 觀察，勿急接入 |
| 硬跳過臨時／回歸 | 合併正、**2026 負** | 不過 | 否決硬跳 |
| **加權「先發 ERA 優勢」**（球評選強投） | **−$560～−$995** | 不過 | **明確負向** |
| 罰己方牛棚近3場球數偏多 | 負 | 不過 | 否決 |

人話：把算法調成更像「聽先發質量敘事」會虧；「傷愈／極端ERA 選邊略降權」有小正期望，尚不足以正式升格。

### Grok 對辯規則複測（P 降權後重算 EV 再過閘）

腳本：`auditMlbGrokDebateRulesBC.mjs` → `tmp-shadow-grok-debate-bc.json`

| 規則 | Δ@$50 | 雙窗 | 備註 |
|------|-------|------|------|
| B：`oppEra≤3.4 & ownEra≥5.5 & ip&lt;40` → P×0.92 | **−50** | 不過 | 最終入選幾乎無觸發殘留（多在閘門被踢出） |
| C1 代理 rest≥12 & ip&lt;30 → P×0.90 | **−111** | 不過 | 無真 IL 日期 |
| C2 代理 era≥6 & ip&lt;40 → P×0.90 | **−52** | 不過（26 負） | |
| C3 = C1∨C2 | **−162** | 不過 | |
| B+C3 | **−212** | 不過 | |

對照：先前「只降日內排序分、不改 EV 閘」的 return 罰分曾弱正；**改成 P 乘子重過閘後轉負**。  
真 `days_since_last_il_exit` 庫內尚無 → C 真旗標需另回填才能結案。
