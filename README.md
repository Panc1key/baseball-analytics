# Baseball Analytics - MLB 賽前研究系統

個人用 MLB 賽前資料研究工具。目前採取 `research_only` 模式：
不提供實投推薦、均注、串關或建議下注金額。

> 目的：建立可稽核的賽前資料、紙上帳本與樣本外驗證流程；未通過驗證前不宣稱盈利。

## 功能

- 初盤賠率抓取（The Odds API）
- MLB 官方戰績 / 先發投手分析
- NPB/KBO 近期勝率（從比分歷史推算）
- 單場 EV 推薦（獨贏、讓分）
- 串關組合推薦
- 投注紀錄與盈虧追蹤

## 前置需求

1. **Node.js 18+**
2. **The Odds API Key**（免費 500 次/月）
   - 註冊：https://the-odds-api.com
   - 支援 `baseball_mlb`、`baseball_npb`、`baseball_kbo`

## 快速開始

### 1. 後端

```bash
cd backend
cp .env.example .env
# 編輯 .env，填入 ODDS_API_KEY

npm install
npm run dev
```

後端預設：`http://localhost:3100`

### 2. 前端

```bash
cd frontend
npm install
npm run dev
```

前端預設：`http://localhost:5175`

### 3. 使用流程

1. 打開前端頁面
2. 點擊「同步並分析」拉取最新初盤
3. 查看「單場推薦」與「串關推薦」
4. 點「記錄 $2 / $1」追蹤你的測試投注
5. 賽後在「投注紀錄」標記贏/輸

## API 配額建議

免費方案 500 次/月，預設每 2 小時自動同步一次（約 6 次/天 × 6 請求 = 36 次/天）。

可調整 `.env` 中的 `SYNC_CRON` 降低頻率。

## 模型說明

| 聯盟 | 數據來源 | 模型因子 |
|------|----------|----------|
| MLB | statsapi.mlb.com + Odds API | 戰績、近10場、先發 ERA、主場優勢、市場機率 |
| NPB/KBO | Odds API 比分歷史 | 近期勝率、市場公平機率加權 |

EV 公式：`勝率 × 淨賠率 - (1 - 勝率)`

僅推薦 EV ≥ 3%（可配置）的場次。

## 目錄結構

```
baseball-analytics/
├── backend/
│   ├── src/
│   │   ├── services/     # 賠率、分析、推薦引擎
│   │   ├── routes/       # REST API
│   │   ├── utils/        # EV / 賠率轉換
│   │   └── db/           # SQLite
│   └── data/             # analytics.db
└── frontend/
│   └── src/              # Vue 3 賽前事實資料面板
└── collector/            # 獨立 Python 外部資料蒐集與封存工具
    ├── sofascore_collector/
    ├── data/             # collector.db（原始資料與標準化列）
    └── exports/          # 僅 prematch 的 Node.js 交接檔
```

## 資料責任邊界

| 元件 | 唯一責任 | 禁止事項 |
|---|---|---|
| `collector/` Python | 取得、封存、標準化外部資料 | 計算推薦、調整權重、寫入投注帳 |
| `backend/` Node.js | 驗證時間點、建立特徵、紙上追蹤與 PIT 驗證 | 直接依賴未審核爬蟲回應 |
| `frontend/` Vue | 顯示資料來源、`✓/△/×` 狀態與研究結果 | 將模型輸出包裝為投注訊號 |

## 後續可擴展

- [ ] 回測模組（歷史推薦 vs 實際結果）
- [ ] Closing Line Value (CLV) 追蹤
- [ ] NPB/KBO 付費統計 API 接入
- [ ] Telegram 推送通知
- [ ] 大小分 (totals) 專項模型

## 免責聲明

本軟體僅供數據分析與個人學習測試，不構成投注建議。請遵守當地法律法規，理性投注。
