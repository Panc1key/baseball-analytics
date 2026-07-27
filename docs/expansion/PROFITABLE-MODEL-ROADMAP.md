# 棒球模型盈利化修復路線圖

> 舊模型基線：`baseball-v2.9.0`  
> 建立日期：2026-07-20  
> 狀態：正式推薦已停用；目前僅保留「賽前事實 → 獨立概率 → 市場錯價 → 研究方向 Top1/Top3 → 紙上 walk-forward」  

## 凍結（2026-07-25）

**MLB 正式推理骨架已凍結：兩隊預期得分 → 比分分布 → 獨贏／大小。**  
詳見 [`MLB-INFERENCE-FREEZE.md`](./MLB-INFERENCE-FREEZE.md) 與 `backend/src/services/MlbInferenceFreeze.js`。

凍結期間禁止再開第二套平行預測；篩選門檻／紙上規則可變，算式與特徵增減需另開變更。  
已完成整合：research-only 不再誤關 NPB／KBO；版本字串對齊 v4.5；Baseline 改 opt-in shadow 且不擋資料閘門。

## 零、管線切換規則

舊 `recommendations`、`flat_bet`、`primary`、建議注碼與串關邏輯不再作為 MLB 前端決策來源。
新管線以 `mlb_prematch_truth_snapshots`、`mlb_paper_candidates` 與
`mlb_paper_bets` 為審計資料來源，語意如下：

- `research` / `model_output`：研究方向輸出，不是推薦。
- `blocked_data`：賽前真實資料不足。
- `no_signal`：有模型但相對市場錯價不足。
- `research_observation`：有正 edge，可進入當日 Top 排序；**不是**正式推薦。
- `dailyRank` / `researchTier`：當日依 edge 排序的 Top1 / Top3 / watchlist。
- Walk-forward 紙上驗證：評估 Top1/Top3 命中與 ROI；**不是**盈利證明，也不是實投授權。
- `actual_bet`：未來手動建立的真實帳，必須與紙上帳分離；目前禁止自動產生。

所有資料因子必須保存 `verified`、`partial` 或 `missing` 狀態、來源、擷取時間、
有效期限與未納入模型原因。資料缺失時，不得以預設值或舊快取偽裝為真實資料。

## 一、目標與基本原則

本次目標不是增加推薦數量，也不是透過調低門檻製造更高的表面命中率，而是將目前模型改造成：

1. 使用當時可取得的資料進行分析。
2. 輸出經過樣本外校準的概率。
3. 能完整追蹤研究方向、錯價、結算及績效。
4. 能證明模型是否比去水市場概率提供額外資訊。
5. 只有通過驗收的聯盟及盤型才允許實際下注。

模型是否盈利，必須由樣本外結果決定。任何權重、勝率或 EV 在通過驗證前，都只能視為實驗數值。

## 二、目前結論

目前最大的問題不是單一公式或下注門檻，而是資料、概率、推薦及實際結果沒有形成統一的可審計閉環。

已確認的現況：

- 正式推薦／均注／建議金額已停用；前端只顯示研究方向與錯價排序。
- 已建立嚴格 PIT 賠率契約；歷史回放缺少開賽前快照時直接排除，不再讀取 `games.raw_odds`。
- `mlb-team-pit-v7` 已以 1,195 場重建；牛棚特徵有 1,148 場（96.1%）具備雙方開賽前最近三場官方 boxscore。
- `mlb-team-pit-v8` 已加入免費 boxscore 的近 14 場打擊品質（OBP／SLG／K%／BB%）與近 7 場牛棚品質（ERA／WHIP／K-BB%／HR9）；共同完整樣本 1,040 場（87.0%）。
- v8 selection 未支持簡單近期平均：近期打擊 Brier 0.2623、牛棚品質 0.2580、投手＋近期 boxscore 0.2584，均未勝過簡化基準，因此不部署。
- `mlb-foundation-pit-v1` 已回填 2024–2025 官方例行賽並重建 6,054 場；固定十特徵完整樣本 5,324 場（87.9%）。
- 跨季契約固定為 2024 訓練、2025 selection／calibration、2026 final。2025 selection 中四項隊級基準 Brier 0.2474，固定十特徵為 0.2479，投手特徵未穩定改善。
- 2026 同批 1,035 場 PIT 比較：市場 Brier 0.2497／LogLoss 0.6927；四項隊級基準 0.2517／0.6970；固定十特徵 0.2516／0.6972，兩者均未勝市場，正式推薦保持停用。
- 牛棚消融沒有改善 selection：team-only Brier 0.2560／LogLoss 0.7052，加入牛棚後惡化為 Brier 0.2570／LogLoss 0.7072，因此未部署。
- 歷史投手特徵已納入 v3 時間驗證；在 1,014 場共同完整 cohort 中，selection 選出 `team_plus_recent_pitcher`。live probable starter 會保存影子概率，但與 IL 衝突或缺失時直接阻擋。
- 嚴格時間驗證（55% train / 15% selection / 15% calibration / 15% final test）結果：
  - 使用歷史實際先發的 recent-pitcher 上限模型，Final test：Brier 0.2446、LogLoss 0.6822、accuracy 52.9%。
  - 同批 138 場 PIT 市場：Brier 0.2406、LogLoss 0.6746、accuracy 59.4%。
  - 投手上限模型相對市場 Brier 劣化 0.0044、LogLoss 劣化 0.0085，仍禁止部署。
  - 四個 rolling blocked folds 中，模型沒有任何一個 fold 同時在 Brier 與 LogLoss 勝過市場。
  - 資料庫目前只有 2026 球季，尚不能做跨季驗證。
- 因此模型部署狀態為 `eligible=false`；Top1/Top3 紙上 ROI 只能作排名研究，不能推翻概率模型未勝市場的結論。
- `bet_log` 沒有實際下注紀錄。
- 現行舊模型為 `v2.9.0`，可靠度校準表仍屬於舊版，不得解讀為已驗證命中率。
- Dixon–Coles 參數擬合樣本為 0，實際回退至 `rho=0`。
- 現有單元測試能證明程式護欄正常，但不能證明模型可以盈利。

因此，目前顯示的模型概率是研究輸出，不是已驗證的實際命中率。
評估目標改為：校準概率、相對市場 edge、每日 Top1/Top3 紙上 ROI／CLV，而不是追求全場命中率。

## 三、七項核心問題

### 1. 缺少推薦到績效的閉環

目前存在三套平行績效軌道：

- `HistoricalBacktest`：用現行算法重跑歷史。
- `recommendation_snapshots`：保存當時發布的推薦。
- `bet_log`：預計作為真實投注帳，但目前為空。

三者沒有統一，導致無法準確回答：

- 當時使用哪個模型版本？
- 使用了哪些開賽前資料？
- 哪些推薦真的下注？
- 實際使用哪個賠率及注碼？
- 哪個聯盟、盤型及概率區間正在虧損？

### 2. 現版概率沒有可靠度校準

校準表必須符合：

- `modelVersion` 完全一致。
- 按 `league × market` 分組。
- 每個分組具有足夠樣本。
- 訓練區間與驗證區間分離。

目前 `v2.9.0` 沒有符合條件的校準表，因此不得把 58% 解讀為實際長期命中率。

### 3. Poisson 結構過度簡化

目前主要得分模型以固定期望得分 `lambda` 建立 Poisson 分布。它不能完整描述：

- 牛棚可用性及近期使用量。
- 先發投手退場後的狀態切換。
- 棒球得分的厚尾分布。
- 安打及保送造成的得分串連。
- 不同局數與比分下的戰術變化。
- 高低比分環境中的變異數差異。

後續需要比較：

- 標準 Poisson。
- 負二項分布。
- 混合 Poisson。
- 先發階段與牛棚階段的分段模型。
- 經驗得分分布或模擬模型。

### 4. 手工權重及啟發式規則過多

目前模型同時包含：

- Pythagorean、Log5、L10 及主場加成。
- 先發、球場、OPS、WHIP 及形態修正。
- Poisson 與市場概率混合。
- `preferTotals`、contrarian、edge signals。
- tier、actionable score、flat bet 等多層門檻。

這些規則可能各自合理，但疊加後難以確認真正提供預測能力的訊號，也容易造成局部補丁互相衝突。

需要建立簡單基準模型，逐項進行消融測試：

1. 純去水市場基準。
2. 市場加先發。
3. 市場加先發及隊伍進攻。
4. 加入球場及形態。
5. 加入完整比分分布。

只有能在樣本外改善 Brier、Log Loss 或 CLV 的特徵才保留。

### 5. 回測存在時點及前視風險

需要確保所有回測特徵只能使用開賽前已知資料：

- 戰績及排名必須鎖定至比賽當日。
- 近期 OPS、WHIP、RPG 必須使用 point-in-time 視窗。
- 先發及打線必須記錄當時發布狀態。
- 賠率必須記錄實際同步時間，區分 opening、推薦時點及 closing。
- 權重訓練、概率校準及最終測試必須使用不同時間區間。

未使用 point-in-time 資料的回測不得作為盈利證據。

### 6. 資料特徵不完整

MLB 後續應補充：

- 牛棚近 3 日及近 7 日使用量。
- 可用後援投手與高槓桿投手狀態。
- 確認先發及先發打線。
- 左右投及左右打對位。
- 投手球種、球速、三振及保送能力。
- 天氣、風向、溫度及降雨。
- 旅行距離、休息日及連戰狀態。

NPB/KBO 額外缺少：

- 可靠的先發投手資料。
- 即時打線及傷病。
- 球場與天氣資料。
- 穩定的即時比分補源。
- 真正的 rolling OPS/WHIP，而非賽季累積值。

在上述資料缺失時，模型必須明確降低資料品質及概率可信度，而不是使用 fallback 後仍輸出精確高勝率。

### 7. 推薦標籤及產品語意不一致

正式語意應統一為：

- `flat_bet`：通過完整驗證及風控，可進入正式下注候選。
- `primary` 但非 `flat_bet`：高優先觀察，不是正式下注。
- `watch`：存在方向性訊號，但穩定度不足。
- `sample`：僅供回測，禁止下注。

所有 API、前端清單、Slate、滾球頁面及績效報表必須使用相同定義。

## 四、分階段實作方案

### P0：停止實投並凍結基線

- 將 `v2.9.0` 設為 paper trading only。
- 凍結配置、權重及模型版本。
- 禁止測試期間持續調整門檻。
- 保存每次分析的有效配置與資料快照。

驗收：每一筆推薦都能還原當時的模型版本、配置、特徵及盤口。

### P1：建立真實績效閉環

- 將正式 `flat_bet` 推薦自動建立 pending 紀錄。
- 保存推薦賠率、實際下注賠率、注碼及時間。
- 自動結算 win、loss、push、void。
- 區分未下注推薦與實際下注。
- 建立按版本、聯盟、盤型及概率區間的績效查詢。

驗收：推薦數、下注數、已結算數及 P&L 可以完整對帳。

### P2：統一 point-in-time 資料

- 回測預設強制 PIT。
- 禁止使用比賽後更新的 standings、rolling stats 或賽季統計。
- 保存 opening、推薦時點及 closing odds。
- 對缺失或過期資料建立明確品質標籤。

驗收：同一場比賽在相同快照下可以完全重現相同概率。

### P3：建立市場基準及時間切分驗證

- 使用去水市場概率作為基準。
- 依時間切分 train、calibration、test。
- 禁止隨機切分造成未來資料洩漏。
- 比較模型與市場的 Brier、Log Loss、CLV。

驗收：模型必須在未參與訓練的時間區間優於市場基準。

### P4：簡化及重建模型

- 建立最小基準模型。
- 對每一個特徵做消融測試。
- 比較 Poisson、負二項及分段得分模型。
- 移除無法改善樣本外指標的手工 bonus 與權重。
- 將不同聯盟分開建模，不共用未驗證係數。

驗收：新增複雜度必須帶來可重現的樣本外改善。

### P5：補充高價值資料

優先順序：

1. MLB 牛棚狀態。
2. 確認先發與打線。
3. 天氣及球場即時環境。
4. 投打左右對位。
5. NPB/KBO 先發與即時比分。
6. 旅行及休息狀態。

驗收：新特徵必須有時點、來源、缺失率及消融測試報告。

進度：

- 牛棚 PIT 契約、歷史重建及消融已完成；目前結果不改善樣本外概率，保留 shadow，不進部署模型。
- 先發 season/recent challenger 已完成；歷史使用實際先發辨識，live 使用官方 probable，正進行 forward shadow 驗證。
- 先發與 IL 來源衝突會標記 `conflicting` 並阻擋該場投手 challenger。

#### 待驗證補充來源：Sofascore

Sofascore 保留為後續資料擴充候選，暫時不得直接進入模型、推薦資格或回測。
它可能補足裁判、賽前打線、場地／天氣與逐球紀錄；但頁面同時混有賽後資料，
且資料取得方式、發布時間、服務條款與歷史快照完整度尚未驗證。

若後續接入，必須先完成：

1. 確認取得方式可持續且符合服務條款，不以脆弱的前端爬取作為唯一來源。
2. 保存原始回應、來源 ID、擷取時間與可用時間。
3. 與 MLB 官方資料交叉比對先發、打線、場地及裁判，統計覆蓋率與衝突率。
4. 將賽前已知與賽後才產生的欄位嚴格分離。
5. 只在樣本外消融測試證明增益後，才允許該特徵影響模型。

### P6：重新建立概率校準

- 只使用凍結模型產生的樣本。
- 按聯盟及盤型分組。
- 樣本不足時回退 identity，不跨盤型借用校準。
- 保存 calibration slope、intercept、Brier 及分箱結果。

驗收：預測 55%、60%、65% 的分組，其實際命中率與預測概率一致。

### P7：恢復實投的升級門檻

至少滿足：

- 凍結版本累積 300–500 筆模擬投注。
- 核心盤型至少 100 筆；次要盤型至少 50 筆。
- Brier 與 Log Loss 優於去水市場基準。
- 長期 CLV 為正。
- 扣除水位後 ROI 為正。
- 最大回撤在預先設定範圍內。
- 結果不是由單一聯盟、單一高賠率區間或少數大勝貢獻。

未通過上述條件時，維持 paper trading。

## 五、不可使用的錯誤修復方式

以下做法不能解決根本問題：

- 因為推薦太少而直接把 58% 降至 55%。
- 因為近期輸球而臨時提高或降低某隊權重。
- 使用同一批歷史資料反覆調參並宣稱回測盈利。
- 只看命中率，不計賠率、ROI、CLV 及最大回撤。
- 把 `watch` 或 `primary` 當成正式均注。
- 使用市場概率校準後，又宣稱模型具有完全獨立的高 edge。
- 每次虧損後立即升級模型版本，導致永遠沒有足量的版本樣本。

## 六、盈利模型的驗收指標

### 概率品質

- Brier Score。
- Log Loss。
- Calibration slope / intercept。
- 按概率區間的預測與實際命中率。

### 市場比較

- 去水市場基準。
- Closing Line Value。
- 模型相對市場的增量 Brier / Log Loss。

### 投注績效

- ROI。
- 實際 P&L。
- 最大回撤。
- 最長連敗。
- 各聯盟、盤型、賠率及 edge 分組績效。

### 營運品質

- 資料缺失率。
- 資料延遲。
- 隊名匹配失敗率。
- 推薦與下注對帳率。
- 自動結算成功率。

## 七、明日建議執行順序

1. 確認 `v2.9.0` 暫停實投，只保留模擬推薦。
2. 設計推薦、模擬下注及實際下注的統一資料模型。
3. 打通 `recommendation_snapshots`、`bet_log` 與自動結算。
4. 建立現版 performance 儀表板。
5. 將歷史回放改成強制 point-in-time。
6. 建立去水市場基準及時間切分框架。
7. 再開始比較模型結構及新增資料特徵。

在 P0–P3 完成以前，不應繼續調整推薦門檻或宣稱模型勝率。

## 八、MLB 預期得分地基模型

已建立 `mlb-expected-runs-nb-v1`，不使用市場賠率作特徵。模型先估計主客隊
得分均值，再以負二項分布統一推導獨贏、讓分與大小球概率。

固定跨季驗證：

- 2024：訓練。
- 2025：獨立驗證。
- 2026：PIT 市場外測。

第一輪 2026 外測結果：

- 1195 場，總分 MAE 3.60、單隊得分 RMSE 3.30。
- PIT 獨贏：模型 Brier 0.2503，市場 0.2503，模型未勝過市場。
- PIT 大小球：模型 Brier 0.2575，市場 0.2502，模型明顯落後市場。
- 歷史先發身份目前由賽後 boxscore 辨識，尚未達到賽前 probable starter 可重播契約。
- 部署狀態維持封鎖，不產生投注建議。

這一版證明得分分布架構可完整運作，但現有賽前特徵仍不足以形成市場優勢。
下一輪只允許以 2025 validation 選擇特徵，不能使用 2026 final test 調參。

`mlb-expected-runs-nb-v2` 已修正早季極小樣本失真：投手、打擊、牛棚按
局數／場數向聯盟均值收縮，並按先發預計局數拆分先發與牛棚影響。2025
驗證的高信心命中率恢復單調：55%+ 為 59.3%、60%+ 為 63.4%、65%+ 為
71.4%。2026 已被用來定位 v1 異常，因此 v2 的 2026 結果只能視為
observed diagnostics，不能重新標記為未見 final test。大小球仍未勝過市場。

先發身份已新增 `mlb_probable_starter_snapshots` 嚴格賽前帳：只接受
`captured_at < commence_time` 的 MLB 官方 probable starter，並保存每次
變更。歷史 feature rebuild 會優先使用此快照；缺失時的賽後實際先發只能
標記為 `postgame_actual_oracle`。目前 2024–2025 無可重播快照，2026
既有 feature rows 僅 25/1195 場可對齊，因此先發模型仍維持部署封鎖。

已加入無先發身份 fallback：只使用主客場、收縮後近期得失分及打擊過程
特徵；有完整 PIT probable 才切換 full model。2026 路由回放為
635/1195（53.14%），PIT 賠率同批為 627/1177（53.27%），市場方向為
53.10%。60%+ 僅 27 場、19 勝（70.37%）；55%+ 仍未呈單調改善，因此
只屬研究結果，不能開放推薦。

最新 routed model 以實際可下注賠率重播：正 EV 1027 場、ROI +6.38%，
95% 區間 -0.58% 至 +13.35%。edge 門檻由 0% 提高至 8% 時，ROI 由
6.38% 單調升至 13.97%；2.30+ 為 372 場、ROI +13.26%。但四個月份中
4 月貢獻最大，55%+ 在 5–7 月僅約 0.2%–4.5%，尚未具備穩定正式推薦證據。

`mlb-expected-runs-nb-v3` 已修復明確的 train-serve skew：歷史模型使用
近14場逐場 boxscore 打擊與近7場牛棚品質，即時端卻只有近30日官方打擊
且沒有同口徑牛棚品質。v3 暫時移除 OBP、SLG、K-BB、牛棚品質與資料可用
指標，只保留歷史與即時均能 PIT 重播的近期得失分、主場及先發貢獻。

2026 observed diagnostics：

- 總分 MAE 3.593，獨贏 Brier 0.24954，去水市場 Brier 0.25026。
- 所有正 EV 方向仍有 1029 場，平均賠率 2.259、勝率 47.91%，確認存在
  高賠方向氾濫，不能等同推薦。
- 嚴格方向改為「模型預測勝方」且同時要求勝率至少55%、預期分差至少
  0.5分、EV至少3%、完整PIT先發及所有特徵不超過3.5個標準差。
- 嚴格方向只剩105場、60勝，勝率57.14%；平均賠率1.986、ROI +13.67%，
  但95%區間為 -5.43% 至 +32.76%，仍不能宣稱盈利。
- 7月22日晚間17場重播的平均預期總分由 v2 的11.79降至9.24；原先八個
  方向只剩光芒與白襪符合嚴格規則，其餘只能列價值觀察或直接排除。

每次得分預測現保存逐特徵標準分、log-link貢獻、分組得分影響與離群標記。
推薦排序改為勝率、預期分差、最後才是EV；低勝率高賠只可列為價值觀察，
且不足八場時不得強制湊數。由於2026已參與問題定位、歷史先發PIT仍不足、
大小球仍落後市場，v3部署狀態繼續封鎖。

`mlb-expected-runs-nb-v4` 起只使用 2025（5月起）訓練與特徵選擇，2026
僅作已觀察回放；不再使用 2024。打擊與牛棚改回與歷史相同的同季 boxscore
契約（近14場打線、近7場牛棚品質），並由 2025 validation 做消融選擇。
研究方向排序升級為 `mlb-expected-runs-rank-v2`：嚴格方向才進 Top，高賠
價值觀察獨立列出，不足場次不湊數。

v4 消融結果：完整模型與 fallback 皆選 `core_plus_batting`；牛棚品質在
2025 validation 的 MAE 改善不足，暫不納入正式特徵。2026 路由回放嚴格
方向 116 場、勝率 58.6%、平均賠率 1.97、ROI +14.7%，95% 區間仍跨 0；
大小球仍落後市場，部署繼續封鎖。

`mlb-expected-runs-nb-v4.1` 針對大小球落後根因繼續改算法，不做推薦門檻：

- 診斷：2026 預期總分與實際總分相關僅約 0.08–0.10，盤口約 0.22；相對
  盤口的方向相關接近 0。主客得分殘差相關約 0，共享環境衝擊無法解釋落差。
- 2025 全年無 PIT 賠率快照，無法在 validation 上對市場做大小球溫度校準。
- 新增可 PIT 的靜態 `parkFactor`（主隊主場／確認球場），並納入 2025
  validation 消融候選。
- 消融結果：full 與 fallback 皆選 `core_plus_batting_park`；2025 val 總分
  MAE 由 3.518 降至 3.504。
- 2026 observed：獨贏模型 Brier 0.2492 略優於市場 0.2503；大小球 Brier
  0.2552 仍落後市場 0.2502。部署維持封鎖（final test 非 pristine、先發
  PIT 不足、大小球未勝市場）。

`mlb-expected-runs-nb-v4.2` 補齊天氣／球場證據一致性，並維持 PIT 先發封鎖：

- 新增 `venueMeta`（座標＋屋頂）與 `mlb_game_weather_cache`；以 Open-Meteo
  Archive 回填 2025-05 起 3,185 場比賽時段天氣；固定穹頂用室內中性值。
- 共享環境特徵：`gameTemperatureC`、`gameWindSpeedKph`、
  `gamePrecipProbability`（乘 outdoorExposure）。
- 消融：full 仍選 `core_plus_batting_park`（天氣 MAE 僅再降約 0.0015，RMSE／
  獨贏 Brier 未改善）；fallback 選 `core_plus_batting_park_weather`。
- 路由回放大小球 Brier 由約 0.2562 降至 0.2543，仍落後市場 0.2502。
- PIT 先發覆蓋：2025 development 0／1973；2026 observed 約 25／1195
  （~2%）。2025 無法回溯補 probable；只能靠賽前 scheduler 持續累積快照。
- park／weather evidence 改為 `usedInModel: true`；部署仍封鎖。

高權重路徑完整化（不做低權重天氣堆疊）：

- 正式 full 模型權重最高為對手失分、打擊 OBP／SLG／K-BB、先發 K-BB、
  parkFactor；天氣未入 full。
- `MlbHighWeightFeatureSync`：把 complete PIT snapshot 同步進 feature rows；
  補 `venueName`；舊列標記 `postgame_actual_oracle`。
- live 投手能力改與歷史同一函式 `getMlbPitcherPregameFeaturesFromGameLog`。
- truth pipeline 在完賽且 PIT complete 時自動 sync feature row。
- 部署門檻改為要求 **2026 forward** feature-row PIT 覆蓋 ≥95%（不再要求
  不可能的 2025 development 95%）；目前仍遠低於門檻，部署繼續封鎖。
- API：`GET /mlb/high-weight-feature-coverage`、
  `POST /mlb/high-weight-feature-sync`。

`mlb-expected-runs-nb-v4.3` 繼續優化獨贏算法（非推薦產品）：

- 回測定邊改為「預期得分勝方」，與 classify 規則一致；另單獨報告
  「市場 edge 正 EV 海選」作為幻覺對照，禁止當推薦。
- 特徵選擇改以 2025 validation 獨贏 Brier 為主（總分 MAE 只作寬過濾）；
  天氣退出消融。選中 `core_plus_batting`（含歷史先發貢獻）。
- 獨贏溫度校準只允許 T≥1；本次選 T=1（無需再收斂）。
- 2026 observed：模型獨贏 Brier 略優市場；預期得分定邊勝率約 52.7%、
  ROI 為負。edge 正 EV 海選仍約 47% 勝率／高賠／看似正 ROI（幻覺仍在）。
- 嚴格規則切片約 123 場、勝率約 58.5%、ROI CI 仍跨 0；部署繼續封鎖。

`mlb-expected-runs-nb-v4.4` 強化先發／牛棚訊號（非只改權重）：

- 新增先發 HR/9、FIP、近期 K−BB 相對季節、打線×先發 ERA 交互；
  牛棚 HR/9、K−BB、近 3 場球數負荷。資料皆來自既有 feature rows。
- 消融新增 `starter_strength`／`bullpen_strength`／`pitching_stack`／
  `batting_pitching_stack`。
- **實測：validation 獨贏 Brier 未改善**；正式選模仍為 `core_plus_batting`
  （與 v4.3 相同特徵集）。新 pitching stack 在 validation 方向命中約
  53.4–54.7%（對照 batting 55.1%）、Brier 變差約 0.001–0.003。
- 2026 observed：`pitching_stack` 方向命中略升至約 53.1%（batting 52.7%），
  但 Brier／MAE 無穩定優勢；正式重訓後預期得分定邊仍約 52.7%、ROI 為負。
- 結論：可用訊號已接入並可消融，但**尚未變成可選進正式模型的增益**；
  瓶頸更像是「先發／牛棚表徵不夠預測勝負」，而非權重不夠大。

`mlb-expected-runs-nb-v4.5` 接入免費網上 platoon 資料：

- 來源：`statsapi.mlb.com`（無需 key）。投手對左右打、球隊打擊對左右投，
  用**前一完整球季** `statSplits`（避免同季前視；`byDateRange+sitCodes` 不可靠）。
- 同步腳本 `syncMlbPlatoonFeatures.mjs`：從 boxscore 補先發 id，寫入
  `features.platoon`；2025-05 起 3168 列已全覆蓋。
- 新特徵：`opponentStarterIsLefty`、`OpsVsLhb/Rhb`、`offenseOpsVsStarterHand`。
- live truth pipeline 同步附帶 platoon。
- **正式選中 `core_plus_batting_platoon`**（首次勝過純 batting）：
  validation 方向命中約 56.3%（對照 batting 55.1%），Brier 0.2439（對照 0.2444）。
- 2026 observed：方向消融約 53.1%（對照 52.7%）；正式重訓定邊約 52.3%、
  ROI 仍為負；部署繼續封鎖。這是小但真實的 validation 增益，尚未轉成 OOS 盈利。

先發傷病／恢復期情報層（研究用，未進權重）：

- Google News RSS 檢索國際／日文新聞 → DeepSeek 產出結構化旗標
  （`injury_flag / surgery_recovery / workload_management / risk_timing /
  confidence / sources`；`risk_timing`：`pregame_active | recent_return |
  historical_only | none`）
- 寫入 `mlb_pitcher_injury_intel_cache`，並掛入 truth evidence
  `pitcher_injury_intel`（`usedInModel=false`）
- API：`GET/POST /mlb/pitcher-injury-intel`
- 大樣本對照（約 42 完賽／84 投手側）：新聞標題大多可對上，
  但舊版 `injury_flag` **不預測較差賽果**（多為舊傷／已歸隊敘事）。
- v2 重抽取：`historical_only` 與真正風險分離後，`active_risk`
  （僅 `pregame_active`＋`recent_return`）約 14 側；勝率持平、
  team RA／先發 ER **未變差**（甚至略好）。結論：新聞傷病層可當
  證據面板，**暫不進 expected-runs 權重**；狀態特徵應優先官方 IL／
  距歸隊天數，而非 LLM 敘事旗標。
- 對手得分上調消融（`ablateOpponentScoringUplift.mjs`）：假設
  「風險先發 → 調高對手 expected runs」。在有特徵＋完賽樣本
  （25 場／6 側 active）上，基準對受影響對手側幾乎無低估
  （meanError≈0）；任一 uplift（0.25–1.5）皆使 side MAE／affected MAE
  **變差**。因果框架正確，但目前新聞 `active_risk` 訊號不足以改善比分。
- 腳本：`trialDeepseekPitcherFlags.mjs`、`reextractPitcherIntelV2.mjs`、
  `auditPitcherIntelLargeSample.mjs`、`ablateOpponentScoringUplift.mjs`

賽事型態層 Phase 1（`mlb-game-regime-v1`，研究用，未改正式權重）：

- 目標：識別「投手戰 duel／普通 normal／崩盤 blowup」，不再只擠均值總分。
- 服務：`MlbGameRegimeService.js`；審計：`auditMlbGameRegimePhase1.mjs`；
  測試：`test/mlb-game-regime.test.js`。
- 賽後標籤（boxscore）：duel＝總分≤5 且雙先發≥5 局、各≤2 ER；
  blowup＝總分≥14 或先發／牛棚崩（含野手投球）；其餘 normal。
- 樣本約 4884 場：真相總分均值 duel 3.4／normal 7.8／blowup 13.9（標籤清楚）。
- 賽前規則（近期 ERA、ERA gap、預期局數、牛棚近 3 日球數、打線×失控先發）：
  特徵均值方向正確，但 top20% lift 僅約 1.06–1.13；規則 accuracy ~0.32
  （低於「永遠猜 normal」）。預測總分仍有弱排序 duel < normal < blowup。
- 結論：Phase 1 **標籤基礎設施完成且可用**；賽前分離**偏弱**，進 Phase 2
  前應先補更強賽前波動特徵（近 3 場提早退場次數、單場爆分次數、雙重賽／
  opener），再做 soft dispersion／不對稱對手得分，避免硬切型態。

賽事型態層 Phase 2（`mlb-game-regime-phase2-v1`，研究路徑，未替換正式推理）：

- 產品哲學：崩盤只需識別（15 分與 100 分同等），**不以崩盤場總分 MAE 過關**。
- `predictMlbGameRunsWithRegime`：duel 收窄 dispersion；blowup 放大 dispersion；
  均值幾乎不動（避免近分差亂翻勝方）；不對稱風險僅作極小機會標記。
- 驗收（4884 場）：崩盤 precision≈0.285、recall 0.450→0.475；
  勝方方向大致持平（≈55.9%）；非崩盤 side MAE 大致持平；
  **崩盤 total MAE 不納入過關**。`phase2Promising=true`（框架正確、未傷方向）。
  勝率尚未明顯上升：瓶頸仍是賽前崩盤特徵偏弱，不是哲學錯。
- 腳本：`auditMlbGameRegimePhase2.mjs`

市場路由（`mlb-regime-market-router-v2`，研究用，均值模型不變）：

- 賽前型態 v2：`duel`／`one_sided`／`high_total`／`unclear`／`normal`
  （不再把「近況 ERA 差＝大、好＝小」粗暴跳線）。
- `duel`（雙邊都穩）→ 主看大小「小」，獨贏封鎖
- `high_total`（雙邊高分結構；雙邊近況差 alone 不夠）→ 主看大小「大」，獨贏封鎖
- `one_sided`（單邊崩）→ **不下大小 lean**，主市場分差觀察；獨贏僅次要
- `unclear` → 不下 lean，獨贏封鎖
- `normal` → 才允許獨贏為主
- 接入：`attachMlbRegimeMarketPlan`、truth pipeline、前端主市場標籤（含分差觀察）
- v1 近 3 個月問題：約 79% 導向大小球、lean ~48%；錯樣如 STL@LAA 1-5 被當爆分押大、
  DET@CHC 2-11 被當對決押小。根因是粗映射，不是「改看大小球」方向錯。
- v2 近 3 個月（930 場）：有 lean 比例降至約 **18.5%**（152 duel + 28 high_total）；
  one_sided 404 場不下 lean；大小球 lean 命中約 **51.7%**（under 52.4%／over 48.2%），
  仍接近隨機、`actionable=false`。單元測試已鎖住上述兩類錯判。
- 腳本：`auditMlbRegimeMarketRouteRecent.mjs`

型態 detection 驗收（`mlb-regime-detection-v2`，研究用）：

- 目標：主 KPI 改為「賽前預測 vs 賽後真相」的 precision／分離度，
  **不以大小球 lean 命中率過關**。
- 賽後真相 v2：`duel`／`one_sided`／`high_total`／`normal`
  （單邊投球崩不再併進 blowup；高分但單邊灌分歸 one_sided）。
- API：`labelGameRegimeV2FromBoxscore`、`summarizeRegimeDetectionV2`、
  `evaluateRegimeDetectionV2Pass`。
- 腳本：`auditMlbRegimeDetectionV2.mjs [months]`（預設近 3 個月；`0`=全樣本）。
- 全樣本（4884 場）基線：賽前 precision duel **15.1%**／high_total **5.1%**，
  `detectionPromising=false`。
- v2.1 優化（近 3 場提早退場／爆分訊號 + 打者公園否決 + 提高觸發門檻）：
  先把「雙緊即可」收成「雙緊且深局 + 無近況波動 + 非打者公園」，
  再把 duel 觸發門檻從過嚴的 7 調回 **5**（約 211 場／precision ~16%）。
  門檻=7 時只剩 24 場（~29%），覆蓋過稀、產品上等於幾乎不喊，已撤回。
  high_total 仍弱（~7%）；`detectionPromising` 視結構分離，尚未 actionable。
- 新欄位：`getMlbPitcherRecentStartFeatures` 寫入 `earlyExitsLast3`／`blowupStartsLast3`；
  舊歷史列用聚合代理。下一輪仍應補 opener／雙重賽，並在 high_total 明顯抬升前
  **不要擴大 over lean**。

### 嚴格獨贏門檻實驗（2026-07-25）

公開文獻幾乎沒有可直接套用的 MLB 初盤「條件勝率」配方，只能用自家 PIT 掃描迭代。

- 腳本：`backend/scripts/auditMlbStrictThresholdSweep.mjs`
- 貼市消融：取消市場錨定**不能**拉高生肉方向勝率（近 3 月約 52.5% vs 貼市 52.8%），貼市維持開啟。
- 近 3 月（v4.5，921 場）參數掃描結論：
  - 舊規則 `P≥55% + 分差≥0.5 + EV≥3%` → **105 注、勝率 51.4%、ROI -1.7%**（近窗失效）
  - 新候選 `P≥55% + 分差≥1.0`、**不做硬 EV 過濾** → **134 注、勝率 61.2%**；
    均賠約 1.66（自身損益線約 60.4%）、ROI 約 **+1.5%**（過線但很薄）
  - 分差再拉到 ≥1.25／1.5 近窗反而垮（約 52%／50%）
  - 若優化 ROI 而非勝率：`EV≥3% + 每日 Top3` 勝率約 55%、ROI 約 +8.5%（另一條線）
- 候選曾寫入 A 線常數（`margin=1.0`、`EV=null`）作紙上驗證；**之後已改跟 B**（見下節與交接文件）。

### Walk-forward／按月複驗（2026-07-25）

腳本：`backend/scripts/auditMlbStrictRuleWalkForward.mjs`（預設回看 6 個月）。

**結論：`verdict=margin_rule_unstable_do_not_trust_yet`——分差≥1 的 61% 不可當穩定優勢。**

- 固定 A 線（P≥55% + 分差≥1）擴到約 1–7 月：159 注、勝率 **59.1%**，均賠 1.65
  自身損益線約 60.5%，**未過**；ROI **-1.6%**。
- 按月：僅 **5 月**過自身損益線（67.6%）；4／6 月明顯不夠；7 月勝率 58.1%
  對自身線約 58.7% 仍略欠。
- 按賠率：≤1.6 勝率 63.1% 但需要約 **67.5%** 才打平 → **短賠熱門在虧**；
  ≥1.9 樣本少但過線。
- Walk-forward（每月用此前資料重選分差）：歷史窗幾乎選不出「過自身線」的門檻，
  多次 fallback 到 0.5；OOS 合計勝率 56.0%、ROI **-4.8%**。
- B 線（EV≥3% + 分差≥0.25 + 每日 Top3）同期更穩：勝率約 54.8%、均賠約 2.03、
  ROI 約 **+10%**，且 4–7 月皆過自身損益線（KPI 是 ROI 不是高勝率）。

含義：先前近 3 月掃參的 61% 有樂觀偏差；A 線暫留作實驗對照，**不能升級為可信規則**。
紙上並跑繼續以腳本為準；下一步應優先盯 B 線穩定性與 CLV，而非再抬分差門檻。

### A/B 同窗歷史 walk-forward（2026-07-25，再跑）

腳本同 `auditMlbStrictRuleWalkForward.mjs`（已擴成 A+B）。窗約 1–7 月，1195 場。

| | A 勝率線（分差≥1） | B ROI 線（EV≥3%+Top3） |
|--|--|--|
| 同窗 | 159 注、59.1%、ROI -1.6%、**未過**自身短賠線 | 210 注、54.8%、ROI **+10.3%**、過線 |
| 按月過自身線 | 4 月僅 1 月過 | **4/4 月皆過** |
| WF OOS 合計 | 56.0%、ROI -4.8%、未過 | 51.8%、ROI **+6.1%**、過線 |
| 後半窗（6–7 月固定規則） | 未過 | 過線、ROI **+15.1%** |
| verdict | `A_unstable` | **`B_holds_walk_forward`** |

總判：`prefer_B_historically`。注意 B 的勝率不高（~52–55%），優勢來自較長賠（均賠 ~2.0）；若 KPI 硬要高勝率，兩條線目前都不可當「高勝率聖杯」。

### B 已接正式紙上常數；A+B 合體不做（2026-07-25）

- 正式 `MLB_MONEYLINE_RECOMMENDATION_RULES` 已改為 **B + 軟過濾**：
  `EV≥3%`、`margin≥0.25`、`P≥50%`、`maxOdds≤2.2`、`earlyExits` 不高於對手、`dailyTopK=3`。
- A∪B 壓均賠≈1.8 可抬勝率，但場次／ROI 必須讓步；**使用者決定不做合體**。
- **交接文件（給下一位 agent）**：`docs/expansion/MLB-PAPER-LINE-B-HANDOFF.md`  
  → 主線繼續在 **B** 上開發，A 僅對照。

### B 日內 P2 罰分落地（2026-07-27）

- 日內排序改為 **penalized EV**：`EV≥0.12` 且 `P∈[0.53,0.56)` 時 `score = EV - 0.15`。
- 有效窗約 2026-04～07：固定 λ 通過後半窗盲測與月 OOS；期望改用約 **56%／ROI ~10%**（勿再用同窗掃參的 59.5%／16.9%）。
- 之後抬勝率：在此底座上另掃參數／訊號；**不要**改回 A 或全局降 EV。
- 複驗產物：`backend/tmp-lineb-p2-strict-wf.json`。

### P2 上 `ml_allowed` 不接（2026-07-27）

- 在正式 P2 底座複掃：`+ ml_allowed` ≈ 排除 duel/high_total，只少約 3 注；
  勝率／ROI 相對 P2 基線 **略降**（約 -0.2pp）。
- **結論：不寫入正式規則**；下一候選改掃 rest／bullpen／identity 等尚未在 P2 上驗過的訊號。
- 對照產物：`backend/tmp-lineb-ml-allowed-on-p2.json`。

### minOdds≥1.85 正式 + TopK 不加場（2026-07-27）

- 正式 `MLB_MONEYLINE_RECOMMENDATION_RULES` = profile **`min185`**（`minimumPickOdds: 1.85`）。
- 對照：`base_p2`、研究用 `sweet_195_220`；複跑 `scripts/auditMlbMinOddsAb.mjs`。
- `dailyTopK` **維持 3**：第 4／5 名雙窗邊際未同時幫總美元。
- 均注：`config.mlbPaperFlatStakeUsd`（env `MLB_PAPER_FLAT_STAKE_USD`，預設 75）；Kelly 暫不接。
- KPI：總美元／ROI 為主；勝率僅監控。注意回放表上的四位數是 **~9.7 個月合併窗**，不是單月。

### rest／先發間隔不接（2026-07-27）

- 在 **min185** 底座掃 rest 過濾：候選池幾乎無 rest≤3（短休過濾無效）。
- 唯一合併窗略贏：`pick_rest∈[4,6]`（+$26 @$50），但 **2026 從 ~$821 掉到 ~$448** → 嚴格雙窗閘門不過。
- **結論：不寫入正式規則**。產物：`backend/tmp-rest-scan-on-min185.json`。
- 台帳：`docs/expansion/MLB-B-LINE-EXPERIMENT-LEDGER.md`（`rest-on-min185`）。

### bullpen 不接（2026-07-27，min185 底座）

- 硬過濾與同分 tiebreak **皆未**讓合併總美元超過 min185 基線且過雙窗閘門。
- `opp_bp≥220` 子池 ROI／勝率可好看，但場次大砍、**總美元下降** → 不當正式過濾。
- **結論：不寫入**。腳本：`scripts/auditMlbBullpenScanOnMin185.mjs` → `tmp-bullpen-scan-on-min185.json`。

### identity 雙先發 ID 接入；其餘 identity 切片不接（2026-07-27）

- `require_both_ids`（及同效的 hands／ids+hands）：合併 **+$255 @$50**，嚴格雙窗過 → 正式 `requireBothPitcherIdentities: true`。
- 歷史窗幾乎全是 `postgame_actual_oracle`；`only_pit_probable` 僅 5 場 → **禁止當回測過濾**。
- 投打同側／異側／選邊 L·R：**不接**。
- 腳本：`scripts/auditMlbIdentityScanOnMin185.mjs`；台帳 ID：`require-both-pitcher-ids`。

## 九、最終判斷

完成上述修復後，可以大幅降低目前的概率幻覺、資料前視、錯誤推薦及無法對帳問題，並將系統改造成正確、可驗證的分析模型。

但工程改造本身不能保證盈利。只有當凍結版本在樣本外持續優於去水市場、取得正 CLV，並在扣除水位後保持正 ROI，才能將其定義為可盈利模型。

如果模型最終無法優於市場，正確的結果應是減少下注或不下注，而不是繼續增加規則來製造推薦。
