# adapters/odds — 賠率資料適配器

| 適配器 | 用途 | 現有位置 |
|--------|------|----------|
| `TheOddsApiClient` | MLB/NPB/KBO/NBA/NFL/足球 | `services/OddsApiClient.js` |
| `EsportsOddsClient` | CS2 / LoL（待建） | — |

統一介面建議：

```js
// fetchPrematchOdds(sportKey) -> { games, quota }
// fetchScores(sportKey) -> scores
```
