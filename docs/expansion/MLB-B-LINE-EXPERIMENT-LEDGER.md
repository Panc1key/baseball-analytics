# MLB B 線實驗台帳（勿重複掃描）

> 用途：之後做規則優化前 **先讀本表**。已結案實驗不要用同一底座、同一窗、同一訊號族再掃一遍，除非資料／規則底座變了。  
> 正式底座（寫本時）：紙上實驗對照鎖 **`ev02_max230` + ≥2庄 + eitherSide≥1.2**（見 `MLB-B-LINE-NEXT-OPT-ANALYSIS.md`）；回滾點仍為 `frozen_v1`／`min185`。  
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
| `min-h2h-books-2` | 2026-07-27 | `minimumH2hBookmakers: 2`（單莊完整 h2h 不進推薦） | `scripts/auditMlbMultibookOnEv02.mjs` → `tmp-multibook-on-ev02.json` |
| `drop-r3-margin-050` | 2026-07-28 | `ev02_max230.dropThirdIfMarginBelow: 0.5`（第3名 margin&lt;0.50→當日 Top2）；WF／holdout 過閘 | `scripts/auditMlbDailyDropR3MarginWf.mjs` → `tmp-daily-drop-r3-margin-wf.json` |
| `drop-r2-lowodds-195` | 2026-07-28 | `ev02_max230.dropSecondIfOddsBelow: 1.95`（第2名賠率∈[1.85,1.95)→去掉 R2）；WF／holdout 過閘 | `scripts/auditMlbDailyDropR2LowOddsWf.mjs` → `tmp-daily-drop-r2-lowodds-wf.json` |

相對「僅 min185、不卡 ID」基線：合併約 **+$255 @$50**（注數約 −11%，勝率／ROI 略升；2025↑、2026 持平）。  
同窗內 `require_both_hands`／`ids+hands` 與 `require_both_ids` **結果相同**，正式只接 ID 閘（資料品質），不另接投打左右切片。

`drop-r3-margin-050` 紙上對照（相對 ev02+≥2庄 基線 Top3）：合併 **406 注／勝率 55.17%／+$2,369 @$50**（keep ~89%、雙窗皆≥基線）；expanding OOS 與 2025→2026 holdout 固定 T=0.50 皆優於基線。**凍結點 `frozen_v1` 不含此規則。**

`drop-r2-lowodds-195` 紙上對照（相對 dropR3 基線）：合併 **358 注／勝率 56.42%／+$2,682 @$50**（keep ~88%、合併 +$313）；R2 低賠帶子池本身勝率僅 ~45.8%。**勿與「全順位硬切低賠」混淆**（第一刀已否決）。

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
| `min-h2h-books-3` | 2026-07-27 | ev02+books | 要求 ≥3 庄 | 過閘但總美元低於 ≥2；**維持 2** | `tmp-multibook-on-ev02.json` |
| `ev01-on-ev02-books2` | 2026-07-27 | ev02+≥2庄 | EV 2%→1% | 場次↑、總美元↓；**不接** | `tmp-ev01-on-ev02-multibook.json` |
| `offense-k9-cross` | 2026-07-28 | ev02+≥2庄 | 擋「得分優勢<0 且 K9>0.3」等 | 合併小幅+$／勝率↑，但 **2026 窗低於基線**→未過嚴格閘；**暫不進正式** | `tmp-offense-k9-cross-on-current.json` |
| `offense-k9-soft-vs-hard` | 2026-07-28 | 同上 | 硬擋 vs 日內軟罰分 λ=0.05…10 | 軟罰分**幾乎救不了六月**（當日合格池常只剩毒單仍進 Top3）；硬擋副作用大；**維持基線不改** | `tmp-offense-k9-soft-vs-hard.json` |
| `odds-sweet-hard-cut` | 2026-07-28 | ev02+≥2庄 | 硬切 1.95–2.15／1.95–2.20；minOdds≥1.95 | 勝率可到 **55–56%**，但注數只剩 **59–77%**（砍太多）；**不接** | `scripts/auditMlbOddsSweetSpotOnCurrent.mjs` → `tmp-odds-sweet-spot-on-current.json` |
| `minOdds-190` | 2026-07-28 | 同上 | minOdds 1.85→1.90 | 勝率略降、合併 $↓；**不接** | 同上 |
| `daily-skip-r3-lowodds-toxic` | 2026-07-28 | ev02+≥2庄 | 跳過第3名低賠／攻K毒 | 診斷：**R3 低賠／毒反而賺**；跳過後勝率↓；**不接** | `tmp-daily-structure-route-on-current.json` |
| `daily-topk2-always` | 2026-07-28 | 同上 | 一律 TopK=2 | 勝率幾乎不動、總美元↓；**不接** | 同上 |
| `daily-drop-r2-by-margin` | 2026-07-28 | dropR3 基線 | 砍 R2 低 margin | **反直覺**：R2 margin&lt;0.50 反而賺、≥0.50 虧；砍了傷賬；**不接** | `tmp-daily-r2-structure-on-dropR3.json` |
| `soft-route-keep-volume` | 2026-07-28 | dropR3+dropR2 | 高margin／中EV／甜區／低賠軟罰分或軟加分 | 軟重排常**加場但勝率/$↓**（稀釋硬規則）；無 keep≥90% 且嚴格過閘者；**維持現行** | `scripts/auditMlbSoftRouteKeepVolumeOnCurrent.mjs` → `tmp-soft-route-keep-volume-on-current.json` |
| `feature-miss-soft` | 2026-07-28 | dropR3+dropR2 | 過自信／薄邊／攻K／高K9優勢等軟沉或硬擋 | 薄邊軟沉合併略升但 **2026 略低基線**→未過嚴格閘；高K9軟沉同；**不接**；選注可先凍結 | `scripts/auditMlbFeatureMissOnCurrent.mjs` → `tmp-feature-miss-on-current.json` |
| `feature-weight-scale-v45` | 2026-07-28 | 選注凍結 | 先發／攻擊／Obp／對手RA／platoon／rest 權重×0～1.5 | **全部劣於**現行 v4.5；**不改正式權重** | `scripts/auditMlbFeatureWeightScaleOnFrozenPicks.mjs` → `tmp-feature-weight-scale-on-frozen-picks.json` |

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
| `sweet-195-220` 升正式 | **否決當正式**（注數砍過多） | 見 `odds-sweet-hard-cut`；profile 可留研究用 |
| `odds-soft-prefer-195-215` | 弱候選／暫不接 | 注數 100% 保留；勝率僅 +0.4pp（54.4%）；合併 +$269 但 **2025 窗低於基線**→未過嚴格閘 |
| `daily-drop-r3-margin050` | **已接入** `ev02_max230` | WF 過閘後寫入 `dropThirdIfMarginBelow: 0.5`；凍結點不含 |
| `daily-drop-r2-lowodds-195` | **已接入** `ev02_max230` | WF 過閘後寫入 `dropSecondIfOddsBelow: 1.95`；與全切低賠不同 |
| `soft-route-keep-volume` | **否決本輪** | 保量軟路由未勝過現行硬結構；見 Rejected |
| `feature-miss-on-current` | **否決本輪／診斷保留** | hit≠miss 最大差在牛棚球數／近期用球／BB／ERA；薄邊軟沉弱候選未過嚴格閘；**選注常數建議先凍結** |
| `selection-lock-2026-07-28` | **已凍結** | 見 `MLB-PAPER-RULE-FREEZE.md`「實驗選注鎖定」；後續只動模型實驗 |
| `feature-weight-scale-v45` | **否決本輪** | 內存權重縮放未勝過 v4.5；正式模型不變 |
| `b-baseline-lock-2026-07-28` | **基準包鎖定／停 B 微調** | 全文：`MLB-B-BASELINE-LOCK.md`；進化改 A′ 增量或重訓 |
| `threshold-relax-on-frozen` | 已開 `ev02_max230` | 見門檻放寬節；`max_none` 否決 |
| `multibook-on-ev02` | **已接入** ≥2庄 | ≥3 不如 ≥2 |
| `ev01-on-ev02-books2` | **否決** | 場次↑美元↓ |
| `failure-slices-on-current` | 分析完成 | 候選毒區 `1.85–1.95`；第一刀硬切／抬 min 未過「勝率+注數」雙約束 |
| `book-ref-scan-on-current` | **否決改价** | 無政策過嚴格閘；**維持 lowest_vig** |
| `stake-asia-inventory` | 盤點完成 | 注碼線性；NPB/KBO 有 games+odds，需獨立產線 |

### 固定基線後分析（2026-07-27）

詳見 `docs/expansion/MLB-B-LINE-NEXT-OPT-ANALYSIS.md`。

- 複跑：`auditMlbFailureSlicesOnCurrent.mjs` → `tmp-failure-slices-on-current.json`  
- 複跑：`auditMlbBookRefScanOnCurrent.mjs` → `tmp-book-ref-scan-on-current.json`  
- 複跑：`auditMlbStakeAsiaInventory.mjs` → `tmp-stake-asia-inventory.json`


### 門檻放寬（2026-07-27，底座=frozen_v1）

複跑：`node scripts/auditMlbThresholdRelaxOnFrozen.mjs` → `tmp-threshold-relax-on-frozen.json`  
窗：2025-04～09 + 2026-04～07；基線合併 **388 注／勝率 54.4%／ROI 9.3%／$50≈1809**。

| 候選 | 注數Δ | 勝率Δ | 合併 $50Δ | 嚴格閘 | 備註 |
|------|-------|-------|-----------|--------|------|
| **`ev02_max230`** | +35 | +0.23pp | +382 | 過 | **已開實驗 profile**；紙上可設 `MLB_PAPER_RULE_PROFILE=ev02_max230` |
| `ev_02`（EV≥2%） | +15 | +0.46pp | +181 | 過 | 更保守備選 |
| `ev_01`（EV≥1%） | +33 | +0.49pp | +219 | 過 | 想再加場可下一步試 |
| `max_none`（不卡 maxOdds） | +44 | −0.21pp | +2391 | 假過 | **否決**：Yankees@Mets 2025-07-06 BetMGM **1.01/34** 髒快照 |
| `max_250`／`max_240` | +36／+27 | 略降 | +287／+227 | 僅普通閘 | 2026 窗低於基線 → 不嚴格 |
| 猛放 `margin≤0.15`／`ev00_m00` | 大增 | 勝率掉 | 總美元掉 | 不過 | **否決**當正式 |
| `min_175`／抬 `P≥55%` | — | — | 總美元掉 | 不過 | 否決 |
| `p_48`／`p_52` | 0 | 0 | 0 | — | 與基線相同（P 非綁定門檻） |

盤口 sanity：`minimumEitherSideOdds: 1.2`。  
多莊共識：`minimumH2hBookmakers: 2`（`auditMlbMultibookOnEv02.mjs` → `tmp-multibook-on-ev02.json`；相對 ev02 基線 +$204）。

---

## 變更日誌

| 日期 | 事項 |
|------|------|
| 2026-07-27 | 建台帳；記入 min185 接入、rest／bullpen 否決、TopK／Kelly／混排等 |
| 2026-07-27 | identity 掃描：接入 `requireBothPitcherIdentities`；否決 pit-only／投打切片 |
| 2026-07-27 | 建立紙上規則凍結 `frozen_v1`（`MLB-PAPER-RULE-FREEZE.md`）；改動前可回滾 |
| 2026-07-27 | 門檻放寬掃描；開 `ev02_max230`；否決 `max_none`；加 `minimumEitherSideOdds` |
| 2026-07-27 | 多莊掃描過閘；接入 `minimumH2hBookmakers: 2`；中位偏離不另加 |
| 2026-07-27 | 確認 ≥3 庄不如 ≥2；EV≥1% 在現行底座否決（`auditMlbEv01OnEv02Multibook.mjs`） |
| 2026-07-27 | 固定基線後分析：失敗切片／庄参考价／注碼+亞聯盤點；**未改選場常數**（`MLB-B-LINE-NEXT-OPT-ANALYSIS.md`） |
| 2026-07-28 | 第一刀賠率甜區：硬切可抬勝率但砍注數；軟偏好保量但勝率幾乎不動；**維持 1.85–2.30**（`tmp-odds-sweet-spot-on-current.json`） |
| 2026-07-28 | 第二刀日內結構：`drop_r3_if_margin_lt_050` 過嚴格閘（55.2%／keep89%／+$265）；**待拍板＋WF 再接**；跳過低賠第3／一律Top2 否決 |
| 2026-07-28 | WF（expanding＋2025→2026 holdout）通過；**接入** `ev02_max230.dropThirdIfMarginBelow=0.5`；`frozen_v1` 不變 |
| 2026-07-28 | 第三刀 R2：診斷低賠 R2 毒；`dropSecondIfOddsBelow=1.95` WF 過閘並接入；砍 R2 低 margin 會傷賬（反直覺） |
| 2026-07-28 | 第四刀保量軟路由：高margin／中EV／甜區／低賠軟調分皆未過閘（軟重排易加弱場稀釋）；**維持 dropR3+dropR2** |
| 2026-07-28 | 第五刀特徵／失誤：診斷保留；薄邊／高K9軟沉未過嚴格閘；**建議凍結選注規則**，下一動改模型或紙上實盤 |
| 2026-07-28 | **凍結**實驗選注 `ev02_max230`+dropR3/R2；權重縮放刀：先發削弱／攻擊加強等皆傷勝率與$；**維持 v4.5** |
| 2026-07-28 | **B 基準包鎖定**（`MLB-B-BASELINE-LOCK.md`）：停選注／權重微調；下一步建議獨立 A′ 增量或重訓／實盤 |

## 回滾

正式改壞時：`.env` 設 `MLB_PAPER_RULE_PROFILE=frozen_v1` 後重啟。細節見 `MLB-PAPER-RULE-FREEZE.md`。
