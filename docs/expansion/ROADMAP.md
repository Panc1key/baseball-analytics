# 多運動分析平台 — 擴展路線圖

> 倉庫名稱暫為 `baseball-analytics`，架構按多運動平台規劃。  
> **當前唯一實作重點：MLB 初盤，獨贏/讓分，賠率 ≥1.75，長期勝率 >57%。**

## 階段規劃

| 階段 | 範圍 | 狀態 |
|------|------|------|
| **P0** | MLB 初盤：降幻覺、嚴格正 EV、ROI 追蹤 | 進行中 |
| **P1** | 賽季日曆提醒（MLB / NBA / 足球） | 待開發 |
| **P2** | NBA 主盤（複用 core EV + 評分框架） | 目錄已建 |
| **P3** | 足球 1X2 / 亞盤 | 目錄已建 |
| **P4** | 電競 CS2 / LoL（需獨立賠率 API） | 目錄已建 |

## 目錄對照

```
backend/src/
├── core/              # 共用：EV、評分、推薦門檻、bet_log（逐步從 services 抽離）
├── sports/
│   ├── mlb/           # 美職（當前主力，程式仍在 services/ 與 data/）
│   ├── npb/ kbo/      # 棒球亞洲聯盟
│   ├── nba/ nfl/      # 美國籃球 / 橄欖球
│   ├── soccer/        # 足球
│   └── esports/       # CS2 / LoL 等
├── adapters/
│   ├── odds/          # The Odds API、未來電競 API
│   └── stats/         # statsapi.mlb.com、未來籃球/足球統計
└── calendar/          # 賽季起迄、每日活躍運動提醒

frontend/src/sports/   # 按運動拆分頁面（未來）
```

## 單場盈利標準（全局）

- 十進制賠率 **≥ 1.75**（損益平衡勝率約 57.1%）
- 模型勝率建議 **≥ 58%**（留安全邊際）
- **EV ≥ 3%**，且 `edge_prob > 0`
- 僅 **primary** 且通過 `flat_bet` 策略的場次進均注 Tab

## 資料源

| 運動 | 賠率 | 統計 |
|------|------|------|
| MLB | The Odds API | statsapi.mlb.com |
| NPB/KBO | The Odds API | 比分歷史 fallback |
| NBA/NFL/足球 | The Odds API | 待接入 |
| 電競 | OddsPapi 等（非 Odds API） | 待接入 |

## 原則

1. **一運動一模型**：不共用棒球的 Totals 公式到籃球。
2. **初盤 only**：不做滾球，直到單運動 ROI 穩定。
3. **事實勝率優先**：所有改動以 `bet_log` 結算勝率驗證，不靠回測自嗨。

詳見 [MLB-PRIORITY.md](./MLB-PRIORITY.md)。
