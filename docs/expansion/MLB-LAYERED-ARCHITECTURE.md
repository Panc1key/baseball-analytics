# MLB 分層架構基準（強制）

> 生效日：2026-08-08  
> 版本：`mlb-layered-arch-v1`  
> 程式 SSOT：`backend/src/services/MlbLayeredArchitecture.js`  
> **之後所有 MLB 改動必須在本基準上進行；禁止再原地把類型／路由／估分／定價揉成一團。**

與 `MLB-INFERENCE-FREEZE.md` 的關係：

- **推理骨架凍結**：仍是「兩隊預期得分 → 分布 → 獨贏／大小」（μ 層）。
- **本文件**：在骨架之上強制加上 **類型 → 路由**，再進入估分／定價消費。

---

## 一、四層總圖（第 0 級，必須）

```
① 類型 Type     → 這是什麼局？
② 路由 Route    → 主攻哪個市場？禁什麼／降權什麼？
③ 估分 μ        → 大概得幾分、勝率多少？
④ 定價 Price    → EV／賠率帶／日 TopK 出不出單？
```

| 層 | 只准回答 | 主要程式掛點 |
|----|----------|--------------|
| Type | `pitcher_duel` / `strong_home` / `offense_game` / `normal` / `unclear` | `resolveMlbGameType` |
| Route | bans / leans / rankPenalties | `resolveMlbMarketRoute` |
| μ | 期望得分與分布 | `predictMlbGameRuns`（凍結入口） |
| Price | 門檻與 TopK | `classifyMlbMoneylineCandidate`、`MlbResearchRanker`、`classifyMlbTotalsHybridCandidate` |

**鐵律**

1. 改 Type 不得假裝成「調 μ 權重就修好了」。
2. 改 Price（TopK／EV）不得宣稱「認清了比賽類型」。
3. LLM 最多服務 Type 的 **T5 投票**，不得當 μ 主腦、不得否決 T1–T4 規則（除非另開回測過關單）。
4. 禁止再平行發明第二套「像不像對決」判定；一律走 `resolveMlbGameType`。

---

## 二、第 1 級工作單元（建議細度）

### ① 類型子判定器

| ID | 問題 | 狀態 |
|----|------|------|
| T1 | 雙先發穩 + 線低 → 對決 | **正式認定來源**（規則） |
| T2 | 主勝賠短 + 先發不崩 → 強主 | **正式認定來源** |
| T3 | 高打／崩盤傾向 | 正式定義過嚴（n≈8）；alt rpg≥5+era≥4.8 全樣本均分可分，但 Hybrid 命中僅 ~7 場；ban Over 表面 +$201 幾乎全在 2024 → **research only**，不開路由 |
| T4 | 缺數 → unclear | 啟用（嚴格：缺雙 ERA 且缺線） |
| T4b | 缺任一邊 ERA | **compare 影子**（`MlbMissingEraSoftShadow`）；固定樣本 λ0.05 約 +$278，expanding WF +$192.5，但 **leave-one-year 2024 −$104.5** → 禁止 apply |
| T5 | LLM 形態票 | 只投票；傷病 LLM 不進選邊 |

合成優先級：`unclear` → `pitcher_duel` → `strong_home` → `offense_game` → `normal`。

### ② 路由動作（一條一個開關）

| ID | 動作 | 狀態 | 回測備註 |
|----|------|------|----------|
| R1 | 對決 → **禁 Over** | **apply** | Hybrid Δ勝率 +0.63pp／約 +$89.5 |
| R2 | 對決 → 偏 Under（不自動翻） | lean | 展示／研究 |
| R3 | 對決 → 獨贏排序降權 | **compare** | Locked B 最佳 λ0.05 約 +$134.5，但 **2024 −$146**；硬跳過 −$51；對決獨贏切片本身不毒 |
| R4 | 強主 → 客勝軟降權 | **compare** | 整體略正但 2025 不穩，禁止 apply |
| R5 | unclear → 少推 | **compare** | 嚴格 T4 在 Locked B 池 n≈0；寬缺 ERA 影子約 +$278（屬 type 加寬，不得冒充正式 R5） |
| R6 | normal／offense → 放行 | apply | Locked B + Hybrid 預設 |

**參數旋鈕**（如 `maxEra=4.25`、`λ=0.08`）屬第 2 級，用網格回測調，**不算新架構層**。

---

## 三、改動門禁（每次 PR／任務必填）

1. **本改動屬於哪一層？** `type` | `route` | `mu` | `price`
2. **動到哪個 T／R 或 μ／Price 子塊？**
3. **驗收指標？**
   - Type：標籤分離度（均分／主勝率）
   - Route：結構錯↓ 且 Δ$／ΔHR，年份閘
   - μ：MAE／方向／校準（不是只看 TopK ROI）
   - Price：在 **固定 type+route** 下的 Locked B／Hybrid ROI
4. **是否行為不變重構？** 若是 → 對照選邊必須一致（Δ 勝率／ROI = 0）

未過門禁不得把影子升 `apply`，不得改 Locked B／Hybrid **主常數** 並宣稱「類型修復」。

---

## 四、明確禁止（避免再轉圈）

- 傷病 DeepSeek 進 μ／定邊（`usedInModel` 維持 false，除非新過關單）
- 用 LLM 單獨當對決／強主正式開關
- 強主「見短熱主就硬切客」（已證約 −$471）
- 再堆平行影子各自重判「像不像對決」
- 無分層聲明就改 `ev02_max230` 主規格

---

## 五、與現況對照

| 已落地 | 對應 |
|--------|------|
| 規則禁大分（GameShape apply） | Type T1 + Route R1（Δ$+$89.5；與 Under 影子 **正交可加**，合計 vs raw 約 +$198） |
| 強主軟降權 compare | Type T2 + Route R4（未升 apply）；**Hybrid 強主片健康**（Over/Under 皆正 EV）→ 禁 Over/Under 皆 REJECT |
| T4b 缺 ERA 軟降權 compare | 固定樣本 +$278；LOY 未過 → compare |
| ExpectedRuns v4.5 | μ 層（凍結入口） |
| Locked B TopK／Hybrid | Price 層 |

| 下一步（按序） | |
|----------------|--|
| Phase A | Pipeline 一律掛 `layeredArchitecture`；日誌可見 type→route→pick（已接） |
| Phase B | R3／R5 已回測 → **皆 compare**；R4 年份穩定後才考慮 apply |
| Phase C | T4b compare；Hybrid 殘餘無新刀 |
| Phase D（μ） | **normal×客勝向市場收縮** 固定 **w=0.38** → **apply**（相對 0.35 約 +$355.5／LOY 全正；**w≥0.40 翻車**，禁止再抬；禁止月度重選 w） |
| Phase D（price） | type 感知：pen normal客 0.01 + boost 強主客 0.02 → **apply**（與 μ 疊用 expanding 固定參 +$402／LOY 全正） |
| Phase D（price 門檻） | stack 底座 minEv **0.02→0.015**（`ev02_max230`）：+$77／LOY 非負 → **apply** |
| Phase D（審計） | 腳本曾硬截 pickOdds≤2.3；正式 maxOdds=2.5。真實 2.5 底座 ≈+$3530／713 注；相對 2.3 增量 +$403 但 **LOY 去 2024 = −$57** → 維持 2.5、標註年份脆弱，不另改 |
| Phase D（對決再罰） | true25 上 `extra_pen_duel_0.02` 固定 +$84.5，但 **LOY 去2024 −$56.5／expanding −$9.5** → **compare，禁止 apply** |
| 正式 | **R1** + **μ/price 疊用** + **minEv 1.5%** + maxOdds≤2.50；E2E 相對 raw（舊審計 2.3 池）約 **+$568**；真實 2.5 池更高但尾段靠 2024 |

---

## 六、一句話

> **先定類型，再定路由，再估分，再定價。**  
> 拆分本身不創造 alpha；創造 alpha 的是過關的路由。拆分是為了讓改動可單測、可回測、不再原地轉圈。

程式：`buildMlbLayeredDecision` / `describeMlbLayeredArchitecture`。
