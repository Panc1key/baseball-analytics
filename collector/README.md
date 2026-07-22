# MLB 外部資料蒐集器

此 Python 工具與 `backend/` 的 Node.js 分離。它只做四件事：

1. 取得外部場次資料。
2. 封存原始回應與擷取時間。
3. 將欄位標準化為賽前或賽後資料。
4. 匯出帶時間戳的資料，供 Node.js 管線審核後讀取。

它**不會**計算 EV、調整權重、產生推薦或寫入實際投注帳。

## 安裝

```powershell
cd collector
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .[browser,test]
```

## 兩種輸入方式

### 匯入已保存 JSON（建議先用）

從瀏覽器 Network 對 SofaScore request 選擇 Copy response，保存為 JSON。不要輸出或保存 cookie。

```powershell
python -m sofascore_collector import-json `
  --event-id 15506787 `
  --kind lineups `
  --file .\fixtures\15506787-lineups.json `
  --commence-at 2026-07-19T23:20:00Z
```

`top-performers` 請使用 `--kind top-performers`。它只會被歸類為 `postmatch`，
不能成為同一場的賽前特徵。

### 使用標準 Selenium 瀏覽器蒐集

```powershell
python -m sofascore_collector collect-browser `
  --event-id 15506787 `
  --event-url https://www.sofascore.com/zh/baseball/match/... `
  --commence-at 2026-07-19T23:20:00Z
```

此模式只讀取瀏覽器正常載入的公開網路回應；不保存 cookie、不使用
`undetected_chromedriver`、不繞過驗證。若網站阻擋，命令會明確失敗，不能以空資料替代。

## 資料相位

- `prematch`：擷取時間早於開賽，可經審核後供模型使用。
- `live`：比賽進行中，只能供滾球或賽後資料，不可回灌初盤。
- `postmatch`：開賽後取得，僅可形成下一場的歷史特徵。

## 審計

```powershell
python -m sofascore_collector audit --event-id 15506787
python -m sofascore_collector export-node --event-id 15506787
```

`export-node` 只輸出 `prematch` 快照。沒有賽前快照時會輸出空陣列，絕不使用賽後資料補齊。

> `--commence-at` 一律使用 UTC ISO 8601。香港時間 2026-07-20 07:20 =
> `2026-07-19T23:20:00Z`。
