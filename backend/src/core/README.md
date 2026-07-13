# core — 跨運動共用層

未來集中放置與運動無關的邏輯：

- `ev.js` — 期望值、Kelly（由 `utils/odds.js` 遷移）
- `scoring.js` — 評分與 tier（由 `PickScorer.js` 遷移）
- `betStrategy.js` — 均注 / 錨腿分類（由 `BetStrategy.js` 遷移）
- `recommendationGate.js` — 全局門檻：minOdds、minEv、minProb

**現狀：** 上述邏輯仍在 `services/` 與 `utils/`，本目錄為遷移預留。
