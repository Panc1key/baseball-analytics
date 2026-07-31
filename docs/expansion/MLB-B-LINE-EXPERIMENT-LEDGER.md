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
| `line-a-prime-grid1` | 2026-07-28 | B 凍結 | 舊A／短賠 P↑／margin↑／EV／edge buffer；合併優先 B | **無一** A′ 賺錢且合併≥B；舊A 勝率高仍虧；**不接入** | `scripts/auditMlbLineAPrimeOnFrozenB.mjs` → `tmp-line-a-prime-on-frozen-b.json` |

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
| `early-soft-l020` | **已接入** `ev02_max230` | earlyExits 硬擋→軟罰 λ=0.20；`auditMlbVolumeLiftEarlySoftExpandingWf.mjs` |
| `margin-minodds-relax` | **否決** | 分差讓步明確負優化；minOdds 讓步合併好看但 2025 掉 → 雙窗不過 |
| `soft-route-keep-volume` | **否決本輪** | 保量軟路由未勝過現行硬結構；見 Rejected |
| `feature-miss-on-current` | **否決本輪／診斷保留** | hit≠miss 最大差在牛棚球數／近期用球／BB／ERA；薄邊軟沉弱候選未過嚴格閘；**選注常數建議先凍結** |
| `selection-lock-2026-07-28` | **已凍結** | 見 `MLB-PAPER-RULE-FREEZE.md`「實驗選注鎖定」；後續只動模型實驗 |
| `feature-weight-scale-v45` | **否決本輪** | 內存權重縮放未勝過 v4.5；正式模型不變 |
| `b-baseline-lock-2026-07-28` | **基準包鎖定／停 B 微調** | 全文：`MLB-B-BASELINE-LOCK.md`；進化改 A′ 增量或重訓 |
| `line-a-prime-scan-1` | **否決本輪網格** | 舊A／P58–62／EV短賠等皆傷合併$；見 `MLB-A-PRIME-EXPERIMENT.md` |
| `b-plus-a-inc-param-wf` | **過閘但不接入** | 固定/Expanding 參數 WF；保守候選 `edge02_bLt2`；見 A-PRIME §6 |
| `a-fill-diagnose-tighten` | **分析完成／未接入** | 毒切片 1.75–1.85／低 margin；加嚴 OOS 以 `odds&lt;1.75` 最佳但仍不接；見 A-PRIME §7 |
| `a-fill-tighten-expanding` | **觀察名單／未接入** | Expanding 偏 `odds_lt_175`（+$159）；樣本薄；見 A-PRIME §8；**非必須接入** |
| `a-fill-shadow-ledger` | **影子試跑／未接入** | 12 注影子 +$239／83%；正式仍純 B；見 A-PRIME §9 |
| `path-gamma-paper-2026-07-28` | **現行主路徑** | 停選注進化；晉升閉環＋報表；見 `MLB-PATH-GAMMA-PAPER.md` |
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
| 2026-07-28 | A′ 第一網格：短賠候選全軍覆沒（合併皆≤B）；文件 `MLB-A-PRIME-EXPERIMENT.md`；**B 繼續獨跑** |
| 2026-07-28 | B+A 增量參數 WF：多格過嚴格閘；**使用者決定不接入**；維持純 B |
| 2026-07-28 | A 補場診斷：毒在 1.75–1.85／margin&lt;1.25／B=1 補場；加嚴 OOS 好看但樣本薄，**仍不接入** |
| 2026-07-28 | A 加嚴 Expanding：常選 `odds_lt_175`；定為觀察第一名，**確認「找到合適才接、非必須」** |
| 2026-07-28 | A 影子帳試跑：`odds_lt_175` 歷史 12 注／83%／+$239；**不進正式**；可複跑 `auditMlbAFillShadowLedger.mjs` |
| 2026-07-28 | **切路徑 γ**：paper 晉升閉環＋`reportMlbPathGammaPaper.mjs`／API pathGamma；**停 A′／B 旋鈕**；手冊 `MLB-PATH-GAMMA-PAPER.md` |
| 2026-07-29 | 人工弱點盤點：客+強主場+Rank1；病灶細分為「高幻覺 EV≥10%」子段（20 注 40% −$143），非整包 Rank1 |
| 2026-07-29 | 優化候選 `skip_toxic_r1_if_ev_ge10`：固定窗 Δ+$143／三窗皆正；Expanding WF +$44 但 beat/hurt=2/5 → **不接入**；影子腳本 `auditMlbToxicAwayRank1Ev10Shadow.mjs` |
| 2026-07-29 | β 校準：分桶校準弱；**往市場收縮** `P'=(1-w)P+w/odds`（毒切片）最佳 w=0.5：固定 Δ+$352、幻覺EV Rank1 20→2；Expanding +$333 beat/hurt=4/4 → **影子觀察不接入**；`auditMlbToxicShrinkToMarketGrid.mjs` |
| 2026-07-29 | 收縮穩健加測：w=0.5 對 2024 holdout −$164、月 beat/hurt≈5/6；**保留影子、不正式接入**；`auditMlbToxicShrinkRobustness.mjs` |
| 2026-07-29 | 條件收縮：`shrink_ev_ge10_or_p55 w=0.65` **三窗皆≥raw**（Δ+$325；24+90/25+219/26+17）；WF/holdout 未全過 → **升格影子主候選、仍不接入**；`auditMlbToxicConditionalShrink*.mjs` |
| 2026-07-29 | Hurt 月拆解：選參 WF 與固定 w=0.65 同為 4/6；主因丟掉當月會中的毒單。更穩固定規則 **`shrink_p_ge55 w=0.45`**（OOS 月 3/1/9、ΣΔ+$257、三窗不傷）→ **改為影子主候選**；`auditMlbToxicConditionalShrinkHurtMonths.mjs` |
| 2026-07-29 | 收窄/EV閘/排名專用收縮複測：**未勝過** `p>=55 w=0.45`（誤踢會中僅 1）；判定本切片 overlay **暫時平台**；下一步改特徵／重訓；`auditMlbToxicNarrowPShrink.mjs` 等 |
| 2026-07-29 | β 主場後處理：`home_add_*`／`away_cut_vs_strong` 可壓 Rank1 毒單、月級有時 7/2，但**皆無法三窗同時≥B**（常傷 2024 或 2026）；與 shrink 疊加無增益；**仍以 shrink_p55@0.45 為影子主候選**；`auditMlbHomeStrengthPostHoc.mjs`／`auditMlbAwayCutVsStrongFine.mjs` |
| 2026-07-29 | 整模重訓+homeWinPct：快速重訓遠弱於正式 v4.5（訓練協定不一致）→否決亂重訓；改 **prod 殘差修正** |
| 2026-07-29 | 主場殘差（正式 v4.5 上）：嚴格 OOS 2024 Δ+$344、2026 Δ+$191；24→25 Δ+$371 → **升格模型側影子**（不 persist／不改鎖定 B）；與 shrink 雙影子並列；`auditMlbHomeResidualHoldout.mjs` |
| 2026-07-29 | **殘差+shrink 疊加**：先殘差改均值再 `shrink_p55@0.45`；三窗皆≥B；嚴格 OOS 24+26 Δ+$640（24:+344／26:+296）**勝過** residual_only(+535) 與 shrink_only(+206) → **合併為單一影子主候選** `residual_plus_shrink`（仍不接入／不改鎖定 B）；`auditMlbHomeResidualPlusShrinkStack.mjs` → `tmp-b-home-residual-plus-shrink-stack.json` |
| 2026-07-29 | **影子健康度**：`residual+shrink` 8/9 通過 → `healthy_shadow`（Expanding 7/1/7 Δ+$666；安慰劑翻號/洗牌遠弱於真規則；丟掉注 ROI−78%／新增 +86%）。**唯一 FAIL**：殘差 `a` 符號跨年不穩（24+/25−/26+），`b` 穩定為負；fit24+25→26 僅 +$115 → **可當主影子觀察，禁止接入**；`auditMlbResidualShrinkHealth.mjs` → `tmp-b-residual-shrink-health.json` |
| 2026-07-29 | **a/b 剝離**：`a` 單獨 OOS 有害（−$131）；`b+shrink` 靜態 OOS +$667 > `ab+shrink` +$640；但 Expanding 重擬合時 ab 更穩（7/1 vs 4/3）→ 勿用 a-only；`auditMlbResidualAbComponentAblation.mjs` |
| 2026-07-29 | **強主場作用域**：殘差只修 hw≥65% **全面弱於**全場（best strong OOS +$227）→ **否決作用域收縮**；`auditMlbResidualScopeStrongHome.mjs` |
| 2026-07-29 | **凍結決策**：上線影子會 freeze 不每月重擬合 → 主影子改為 **`frozen_b+shrink`**（a=0，b 來自 2025 擬合×scale0.25，+shrink_p55@0.45）；OOS +$667、月 6/0、安慰劑通過；**仍不接入**；`auditMlbFrozenShadowBvsAb.mjs` → `tmp-b-frozen-shadow-b-vs-ab.json` |
| 2026-07-29 | **影子掛觀察**：`MlbFrozenBShadow.js` + `reportMlbFrozenBShadow.mjs`；pathγ／`GET /mlb/paper-ledger` 帶 `frozenBShadow` 摘要；**不寫 mlb_paper_bets**；手冊 `MLB-PATH-GAMMA-PAPER.md` §4 |
| 2026-07-30 | **體感勝率／串關**：全窗後處理抬 HR 最多約 +0.6pp（難到 60%）；實用規則：**串關腿用影子且賠率≤2.10**（單腿 HR 55.9%、同日兩腿實證命中 **38.2%**／110 日）；保量可去毒客（HR 55.8% keep 92%）；**不改正式 B**；`auditMlbHitRateFirstParlay.mjs` |
| 2026-07-30 | **升格**：`frozen_b+shrink` → **正式鎖定 B 疊加**（`B-baseline-2026-07-30`）；PrematchTruth 套 residual、classify 套毒客 shrink；回滾 `MLB_LOCKED_B_OVERLAY=false`；之後優化另開影子 |
| 2026-07-30 | **接入** `early-soft-l020`：`ev02_max230` 關 early 硬擋、日內軟罰 λ=0.20；否決分差／minOdds 讓步；腳本 `auditMlbVolumeLift*.mjs`／`auditMlbMarginMinOddsRelaxShadow.mjs` |
| 2026-07-30 | **A+B 診斷**：空白日主因=缺先發ID／短盤&lt;1.85（非 Top3）；近失場（margin/EV/1.75–1.85）影子加池皆 **Δ$ 為負**→確認勿放寬；產物 `tmp-empty-day-near-miss.json` |
| 2026-07-30 | **C 產品**：`sameDayParlay`（腿≤2.10）+ `todayFunnel` 進 prematch-truth API／UI；**不改選注常數** |
| 2026-07-30 | **probable 契約**：`resolveMlbProbableStarterSnapshot` 優先最新 complete（不被後續 partial 蓋掉）；`todayFunnel.pitcherGap`；回填 2025 缺 ID（oracle）`backfillMlb2025PitcherIdentity.mjs` |
| 2026-07-31 | **Grok 對辯**：保排序輕罰、棄 P 乘子；落地真 IL 事件表＋標註；`MLB-IL-RETURN-FLAG.md`；影子 `auditMlbTrueIlReturnRankPenaltyShadow.mjs` |
| 2026-07-31 | **opener/臨時先發**：定義＋影子 `auditMlbOpenerSpotStarterShadow.mjs`／`MLB-OPENER-SPOT-STARTER.md`；sparse 子池弱但輕罰負 → 留 v4.6 |
| 2026-07-31 | **v4.6 協定草案**：`MLB-V46-TRAINING-PROTOCOL.md`（IL+sparse 兩特徵；訓練窗／消融／雙層升格閘） |

## 回滾

正式改壞時：`.env` 設 `MLB_PAPER_RULE_PROFILE=frozen_v1` 後重啟。細節見 `MLB-PAPER-RULE-FREEZE.md`。
