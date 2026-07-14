# Tennis — 網球初盤管線已實作

- Odds：動態發現 `tennis_*` active key（大滿貫 / ATP·WTA 500+）
- 盤口：獨贏、讓局（game handicap）、總局數
- 模型：
  - H2H：選手近期勝率 Log5 + 市場混合
  - Spreads：預期局差 logistic
  - Totals：勢均力敵偏大 / 一邊倒偏小（BO3 / BO5）
- API：`/api/tennis` · 滾球：未做
- 空窗期：`activeSports=[]` 時同步不耗多餘聯盟額度
