# MLB 紙上選場交接：主線跟 B，不跟 A

> 交接日：2026-07-25（P2：2026-07-27；minOdds≥1.85 正式：2026-07-27）  
> **2026-07-28：B 基準包鎖定，停選注／權重微調** → 見 `MLB-B-BASELINE-LOCK.md`  
> 給下一位 agent／開發者：**不要再為抬勝率改 B 選注常數**；進化改走 A′ 增量或重訓。  
> **禁止**把舊勝率線 A（margin≥1）原樣當正式方向。  
> 預測骨架仍凍結：`docs/expansion/MLB-INFERENCE-FREEZE.md`。  
> 紙上主基準：`ev02_max230` + dropR3/R2 + ≥2庄（鎖定說明見 BASELINE-LOCK）。  
> 均注：`config.mlbPaperFlatStakeUsd`（預設 75）；**不接 Kelly**。  
> **實驗台帳（勿重複掃描）**：`docs/expansion/MLB-B-LINE-EXPERIMENT-LEDGER.md`  
> **規則凍結／回滾**：`docs/expansion/MLB-PAPER-RULE-FREEZE.md`


---

## 0. 一句話

> 賺錢主線是 **B（長賠 / EV / ROI）**，且 **2026-07-28 起基準包凍結**。  
> 舊 A（高勝率短賠）歷史上過不了自身損益平衡；若要加場／抬體感勝率，只能開 **獨立 A′ 增量模組**，禁止與 B 門檻揉成一鍋。
---

## 1. 兩種情況（必讀）

同一套 ExpectedRuns 模型（`mlb-expected-runs-nb-v4.5`），只改「要不要下、下哪邊」的紙上規則。  
樣本：約 2026-01～07 歷史 PIT（腳本結果；細節見 `backend/tmp-mlb-ab-walkforward.json`、`tmp-mlb-ab-hybrid-lift.json`）。

### 情況 A：衝勝率、短賠

| 項目 | 內容 |
|------|------|
| 規則意象 | `P≥55%` + `margin≥1`（常不卡硬 EV） |
| 場次 | ~156–159 |
| 勝率 | ~59%（看起來高） |
| 均賠 | ~**1.65** |
| 自身損益平衡 | ~**60.5%**（勝率仍常 **低於** 均賠要求） |
| ROI | **負**（約 -1.6%） |
| Walk-forward | **不過**；月切片不穩（僅個別月好看） |
| 產品判語 | `margin_rule_unstable_do_not_trust_yet` |

**本質**：勝率高是因為多選短熱門；門檻被均賠抬高，**高勝率 ≠ 賺錢**。

### 情況 B：衝 ROI、較長賠

| 項目 | 內容 |
|------|------|
| 規則意象 | `EV≥3%` + `margin≥0.25` + `P≥50%` + **每日 Top3（按 EV）** |
| 場次 | ~210 |
| 勝率 | ~**54.8%**（看起來較低） |
| 均賠 | ~**2.03** |
| 自身損益平衡 | ~**49.4%**（勝率 **高於** 要求） |
| ROI | **正**（約 +10%） |
| Walk-forward | **較穩**；月切片多月過自身平衡 |
| 產品判語 | `prefer_B_historically` |

**本質**：勝率不必很高；長賠把損益平衡壓低，**條件 ROI 才是 KPI**。

### 對照一句

| | A | B（主線） |
|--|--|--|
| 使用者體感 | 「比較準、熱門」 | 「勝率一般、但賠率夠」 |
| 歷史賺錢？ | 否 | 是（在此窗） |
| 下一步 | **僅對照／禁止當正式** | **繼續開發** |

---

## 2. 使用者已拍板的決策

1. **正式紙上主線 = B，不是 A。**
2. 不要為了「均賠平均到 1.8、又要勝率升、又要熱門不錯冷門也中」硬合 A+B；掃描後能靠近 1.8，但場次或 ROI 必須讓步，使用者選擇 **算了**。
3. 不要再開第二套正式勝率引擎；繼續鎖在 ExpectedRuns → 分布 → 獨贏／大小。
4. 優先用 **歷史 PIT** 驗證規則，不要等好幾週 live paper 才敢改常數。
5. 優化 B 時：**抬條件勝率可以，但不要把均賠壓回 A 那種 ~1.65**（會把「能賺錢的長賠」濾掉）。

---

## 3. 程式現況（B 已接入）

正式常數在：

`backend/src/services/MlbExpectedRunsModel.js` → `MLB_MONEYLINE_RECOMMENDATION_RULES`

目前已是 **B + 軟過濾 + 日內 P2 罰分 + minOdds≥1.85**（不是舊勝率線 A）：

```js
// 正式 = MLB_MONEYLINE_RULE_PROFILES.min185
minimumModelProbability: 0.5
minimumExpectedRunMargin: 0.25
minimumExpectedValue: 0.03
minimumPickOdds: 1.85
maximumPickOdds: 2.2
requirePickEarlyExitsNotHigher: true
requireBothPitcherIdentities: true
dailyTopK: 3
dailyRankBy: 'penalized_ev'
highEvRankPenaltyLambda: 0.15
...
```

對照 profile（審計用，非正式）：`base_p2`（無 minOdds／不卡 ID）、`sweet_195_220`（1.95–2.20）、**`ev02_max230`**（EV≥2% + maxOdds≤2.30，門檻放寬掃描過嚴格閘）。  
紙上切換：`.env` → `MLB_PAPER_RULE_PROFILE=ev02_max230`；改虧回 `frozen_v1`。  
盤口 sanity：`minimumEitherSideOdds: 1.2`（擋 1.01/34 類髒獨贏）。  
多莊共識：`minimumH2hBookmakers: 2`（相對 ev02 基線合併 +$204；中位偏離過濾等價、不另加）。  
複跑：`node scripts/auditMlbMinOddsAb.mjs`、`node scripts/auditMlbIdentityScanOnMin185.mjs`、`node scripts/auditMlbThresholdRelaxOnFrozen.mjs`、`node scripts/auditMlbMultibookOnEv02.mjs`。

日內 TopK：`score = EV - λ`（僅當 `EV≥0.12` 且 `P∈[0.53,0.56)`）；其餘仍按 EV。  
分類入口：`classifyMlbMoneylineCandidate`；排序入口：`attachDailyResearchRanks`／`scoreMlbMoneylineDailyRank`。

相關凍結／整合：`docs/expansion/MLB-INFERENCE-FREEZE.md`、`backend/src/services/MlbInferenceFreeze.js`。

---

## 4. 已做過、不要重踩的實驗

| 實驗 | 結論 |
|------|------|
| 關掉 market-anchor 看「裸勝率」 | 無幫助；**維持 anchor ON** |
| 抬 `margin≥1`（A）衝勝率 | 近窗好看 → **WF 垮**；勿升級 |
| A vs B 同窗並跑 | **prefer_B** |
| B 上抬勝率、保 ≥90% 場次、均賠≥1.9 | 最佳候選：`combo_max22_early`（maxOdds≤2.2 + earlyExits 不高於對手）≈ 已寫進正式規則 |
| A∪B 賠率帶 / daily hybrid 壓均賠≈1.8 | 可抬勝率、均賠可靠近 1.8，但 **場次大砍或 ROI 大掉**；使用者 **不做** |
| 日內 P2 罰分（λ=0.15） | 有效窗 holdout／OOS 過關；**已寫進正式排序** |
| 在 P2 底座上再加 `ml_allowed` | 只砍約 3 注；勝率／ROI **略降**；與排除 duel/high_total 幾乎等同；**不要接正式** |
| 抬 `dailyTopK`→4/5 | 第 4 名雙窗邊際虧；**維持 Top3** |
| minOdds≥1.85（相對無 minOdds 基線） | 合併窗總美元↑、ROI↑；場次略少；**已接正式** |
| 1.95–2.20 帶 | 總美元更高但場次更少；**研究 profile only**，未接正式 |
| Kelly／模型 p 分注 | 模型 p 偏樂觀時全凱利可虧；**暫不接**；均注 `mlbPaperFlatStakeUsd` |
| rest／先發間隔過濾（min185 底座） | 池內幾乎無 rest≤3；`rest∈[4,6]` 合併僅 +$26 且 **2026 大掉**；**不接正式** |
| bullpen load／blowup（min185 底座） | 無過濾過閘門；對手超載子池 ROI 好看但總美元↓；**不接正式** |
| identity 雙先發 ID | 合併 +$255、嚴格雙窗過；**已接正式** `requireBothPitcherIdentities` |
| identity 僅 pit_probable／投打左右切片 | pit 樣本過少；切片不穩；**不接** |

腳本產出（勿當秘密、可複跑）：

- `backend/scripts/auditMlbStrictRuleWalkForward.mjs`
- `backend/scripts/auditMlbLineBFilterLift.mjs` → `tmp-mlb-lineb-filter-lift.json`
- `backend/scripts/auditMlbAbHybridLift.mjs` → `tmp-mlb-ab-hybrid-lift.json`
- `backend/scripts/auditMlbStrictThresholdSweep.mjs`
- `backend/scripts/auditMlbMinOddsAb.mjs` → `tmp-mlb-minodds-ab.json`
- `backend/tmp-lineb-p2-strict-wf.json`（P2 固定 λ 複驗）
- `backend/tmp-lineb-ml-allowed-on-p2.json`（P2 上 ml_allowed 對照）
- `backend/scripts/auditMlbRestScanOnMin185.mjs` → `tmp-rest-scan-on-min185.json`
- `backend/scripts/auditMlbBullpenScanOnMin185.mjs` → `tmp-bullpen-scan-on-min185.json`
- `backend/scripts/auditMlbIdentityScanOnMin185.mjs` → `tmp-identity-scan-on-min185.json`
- **台帳**：`docs/expansion/MLB-B-LINE-EXPERIMENT-LEDGER.md`
---

## 5. 下一位你怎麼繼續工作

### 5.1 開工檢查清單

1. 讀本文件 + `MLB-INFERENCE-FREEZE.md`。
2. 確認 `MLB_MONEYLINE_RECOMMENDATION_RULES` 仍是 B 系（有 `minimumExpectedValue`、`dailyTopK`，**不是** A 的 margin≥1 主規則）。
3. 複跑基準（在 `backend/`）：

```bash
node scripts/auditMlbStrictRuleWalkForward.mjs
node scripts/auditMlbLineBFilterLift.mjs
```

4. 任何新過濾：先 **腳本掃歷史**，通過後再改 `MLB_MONEYLINE_RECOMMENDATION_RULES`；改完再 WF 複驗。

### 5.2 允許做的方向（B 上）

- 在 **B 候選池** 內加／換軟過濾（投手負荷、earlyExits、賠率上/下界、regime、日 TopK 變體等）。
- KPI 優先序建議：
  1. **ROI / 是否過自身均賠平衡**（主）
  2. Walk-forward / 月切片穩定
  3. 條件勝率（在均賠不要塌的前提下）
  4. 場次不要無謂砍光（先前約束曾用「保留 ≥90% B 場次」當掃描條件，可沿用但非死線）
- 約束經驗值：新規則後 **均賠最好仍 ≥ ~1.9**；若均賠掉到 ~1.7 以下，多半在變相走回 A。

### 5.3 禁止／需極高門檻才做

- 把正式規則改回 A（`margin≥1` 當主門檻、拿掉 EV／長賠邏輯）。
- 為了「勝率好看」關掉 EV 或強制短熱門。
- 再開平行正式預測模型；改 NB 均值公式／加減特徵（需另開 ablation，且非本交接預設任務）。
- 把 `predictMlbGameRunsWithRegime` soft 調均值接進 PrematchTruth。
- 重開 A+B「均賠 1.8 合體」當主線（除非使用者重新要求）。
- 在 P2 底座上再接 `ml_allowed`／「排除 duel+high_total」當正式過濾（已掃過，無增益）。

### 5.4 建議的下一小步（任選，先掃再接）

1. rest／bullpen／identity 硬過濾族已結案（見台帳）。下一刀需 **新特徵族** 或把均注帳本落地複驗。
2. 開工前先讀 `docs/expansion/MLB-B-LINE-EXPERIMENT-LEDGER.md`，避免重複實驗。
3. `sweet_195_220` 若要升級正式：需獨立盲測＋使用者拍板；預設保持研究 profile。
4. 不要重開 Kelly；注碼用 `MLB_PAPER_FLAT_STAKE_USD` 均注。
5. **勿**用「僅 pit_probable」當歷史回測選注（本窗幾乎全是 oracle）。
### 5.5 對使用者怎麼講

- 不要承諾「勝率一定到 60% 又均賠 2.0」；B 的優勢是 **長賠降低損益平衡**。
- 若使用者又想要高勝率短賠：提醒情況 A 的歷史失敗，並問是否接受 ROI 變差。

---

## 6. 關鍵檔案索引

| 用途 | 路徑 |
|------|------|
| **實驗台帳（勿重複掃）** | `docs/expansion/MLB-B-LINE-EXPERIMENT-LEDGER.md` |
| **紙上規則凍結／回滾** | `docs/expansion/MLB-PAPER-RULE-FREEZE.md`、`MlbPaperRuleFreeze.js` |
| 正式紙上規則常數 | `backend/src/services/MlbExpectedRunsModel.js` |
| PrematchTruth 編排 | `backend/src/services/MlbPrematchTruthPipeline.js` |
| 推理凍結 | `backend/src/services/MlbInferenceFreeze.js`、`docs/expansion/MLB-INFERENCE-FREEZE.md` |
| 盈利路線圖（含 A/B 筆記） | `docs/expansion/PROFITABLE-MODEL-ROADMAP.md` |
| B 過濾抬升掃描 | `backend/scripts/auditMlbLineBFilterLift.mjs` |
| A/B WF | `backend/scripts/auditMlbStrictRuleWalkForward.mjs` |
| A+B 合體（已否決主線） | `backend/scripts/auditMlbAbHybridLift.mjs` |

---

## 7. 交接驗收標準（給下一位自檢）

做完一輪「B 上改進」應能回答：

1. 相對現行 B 規則，場次／勝率／均賠／ROI／自身平衡是否變好？  
2. Walk-forward 或至少月切片有沒有垮？  
3. 均賠有沒有偷偷掉回 A 區間？  
4. 有沒有改到凍結的均值公式？（不應）

若以上 1–3 沒有實證、或 4 被碰了，不要宣稱升級。
