# adapters/stats — 統計資料適配器

| 適配器 | 運動 | 現有位置 |
|--------|------|----------|
| `MlbStatsApi` | MLB | `services/MlbStatsService.js` |
| `NpbStatsApi` | NPB | 未建 |
| `KboStatsApi` | KBO | 未建 |
| `NbaStatsApi` | NBA | 未建 |

原則：統計 API 與賠率 API 分離，由各自 `sports/*/analyze` 組裝。
