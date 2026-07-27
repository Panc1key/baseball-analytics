# MLB B 線實驗台帳（勿重複掃描）

> 用途：之後做規則優化前 **先讀本表**。已結案實驗不要用同一底座、同一窗、同一訊號族再掃一遍，除非資料／規則底座變了。  
> 正式底座（寫本時）：`B + P2 + minimumPickOdds≥1.85 + requireBothPitcherIdentities + dailyTopK=3`  
> KPI：合併窗總美元／ROI 為主；勝率僅監控。金額若無註明則為 **$50/注、約 2025-04～09 + 2026-04～07 合併窗**。

---

## 怎麼用

1. 新想法先對表：同 `base` + 同 `signal` → **跳過**，直接引用結論。  
2. 只有下列情況才允許重跑：特徵回填變更、正式規則底座變更、或使用者明確要求複驗。  
3. 重跑請用表內「複跑腳本」；結果寫回 `backend/tmp-*.json` 並 **更新本表一列**。

閘門（寫入正式前）：

- 合併窗 `usd50` > 現行基線  
- 2025、2026 分窗都仍正  
- 嚴格：雙窗 `usd50` 都不低於基線  

---

## 已接入正式（Accepted）

| ID | 日期 | 內容 | 產物／腳本 |
|----|------|------|------------|
| `p2-rank-penalty` | 2026-07-27 | 日內高 EV 毒區罰分 λ=0.15 | `tmp-lineb-p2-strict-wf.json` |
| `min185` | 2026-07-27 | `minimumPickOdds: 1.85`；profile `min185` | `scripts/auditMlbMinOddsAb.mjs` → `tmp-mlb-minodds-ab.json` |
| `flat-stake-config` | 2026-07-27 | `mlbPaperFlatStakeUsd`（預設 75）；不接 Kelly | `config.js` / `.env.example` |
| `require-both-pitcher-ids` | 2026-07-27 | `requireBothPitcherIdentities: true`（缺任一邊先發 ID 不進推薦） | `scripts/auditMlbIdentityScanOnMin185.mjs` → `tmp-identity-scan-on-min185.json` |

相對「僅 min185、不卡 ID」基線：合併約 **+$255 @$50**（注數約 −11%，勝率／ROI 略升；2025↑、2026 持平）。  
同窗內 `require_both_hands`／`ids+hands` 與 `require_both_ids` **結果相同**，正式只接 ID 閘（資料品質），不另接投打左右切片。

---

## 已否決／勿再當正式候選（Rejected）

| ID | 日期 | 底座 | 訊號 | 結論 | 複跑腳本／產物 |
|----|------|------|------|------|----------------|
| `topk-4-5` | 2026-07-27 | min185 前／後同邏輯 | `dailyTopK`→4/5 | 第 4 名雙窗邊際虧；**維持 Top3** | `tmp-topk-odds-implementation.json` |
| `ml-allowed-on-p2` | 2026-07-27 | P2 | regime `ml_allowed` | 略降；不接 | `tmp-lineb-ml-allowed-on-p2.json` |
| `kelly-sizing` | 2026-07-27 | B/P2 | 全／半凱莉 | 模型 p 偏樂觀；全凱利可虧；**均注** | `tmp-kelly-vs-flat.json` |
| `hybrid-totals-ev-topk` | 2026-07-27 | B | 獨贏+大小 EV 混排 | 2026 大虧；不接 | `tmp-profit-first-routing.json` |
| `rest-on-min185` | 2026-07-27 | **min185** | 先發 restDays | 池內幾乎無 rest≤3；`rest∈[4,6]` 合併 +$26 但 **2026 大掉**；**不接** | `scripts/auditMlbRestScanOnMin185.mjs` → `tmp-rest-scan-on-min185.json` |
| `bullpen-on-min185` | 2026-07-27 | **min185** | 牛棚球數／blowup／ERA·WHIP | **無一過濾**合併美元>基線且雙窗正；同分 tiebreak 無增益；**不接** | `scripts/auditMlbBullpenScanOnMin185.mjs` → `tmp-bullpen-scan-on-min185.json` |
| `identity-pit-only` | 2026-07-27 | min185 | 僅 `pit_probable` | 歷史池幾乎全是 oracle（pit 僅 5 場）；**不能當回測過濾** | 同上 identity 腳本 |
| `identity-handedness-slices` | 2026-07-27 | min185 | 同側／異側／選邊 L·R | 異側合併略正但不嚴格；選邊 R 2026 負；**不接切片** | 同上 |
| `sweet-195-220-formal` | 2026-07-27 | P2 | 賠率帶 1.95–2.20 | 總美元更高但未升正式；**僅研究 profile** `sweet_195_220` | `auditMlbMinOddsAb.mjs` |
| `ab-margin-line-as-formal` | 較早 | — | 舊勝率線 margin≥1 | WF 不過；**禁止當正式** | 交接 §1 |

### bullpen 補充（避免誤會）

- `opp_bp_overloaded_220`：勝率／ROI 可好看，但場次砍到 ~29%，**總美元低於基線**（精選子池可觀察，**不當正式硬過濾**）。  
- 舊掃描 `tmp-lineb-bullpen-scan-on-p2.json` 是 **P2 無 min185** 底座；結論與本次一致方向，**勿再重複掃同一族硬過濾**。

### rest 補充

- 短休過濾在本池無效（選邊 rest≤3 幾乎為 0）。  
- 勿再掃「擋 rest≤1/2/3」除非 rest 特徵分布明顯改變。

### identity 補充

- 歷史回放窗內 `identityMode` 以 `postgame_actual_oracle` 為主（~465/471）；`pit_probable` 極少 → **勿用「僅 PIT」當回測選注規則**。  
- 正式閘是 **雙 ID 齊全**；live 路徑仍應走嚴格 probable starter，與本過濾互補。

---

## 研究中／未結案（Open）

| ID | 狀態 | 備註 |
|----|------|------|
| `sweet-195-220` 升正式 | 暫停 | 需使用者拍板 + 獨立盲測；profile 已存在 |
| 下一訊號 | 待定 | rest／bullpen／identity 硬過濾族已結案；需新特徵族或產品均注落地複驗 |

---

## 變更日誌

| 日期 | 事項 |
|------|------|
| 2026-07-27 | 建台帳；記入 min185 接入、rest／bullpen 否決、TopK／Kelly／混排等 |
| 2026-07-27 | identity 掃描：接入 `requireBothPitcherIdentities`；否決 pit-only／投打切片 |
| 2026-07-27 | 建立紙上規則凍結 `frozen_v1`（`MLB-PAPER-RULE-FREEZE.md`）；改動前可回滾 |

## 回滾

正式改壞時：`.env` 設 `MLB_PAPER_RULE_PROFILE=frozen_v1` 後重啟。細節見 `MLB-PAPER-RULE-FREEZE.md`。
