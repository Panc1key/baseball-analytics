# MLB 紙上選注規則凍結（回滾用）

> 凍結 ID：`mlb-paper-rule-v2026-07-27`  
> 用途：之後改 TopK、放寬門檻、接 NPB／KBO 前，**先保證能回到此點**，避免改虧後找不到原規則。

相關程式：`backend/src/services/MlbPaperRuleFreeze.js`

---

## 凍結內容（正式賺錢底座）

| 項目 | 值 |
|------|-----|
| profile | `min185` ／別名 `frozen_v1` |
| minOdds | ≥ 1.85 |
| maxOdds | ≤ 2.2 |
| EV / margin / P | ≥3% / ≥0.25 / ≥50% |
| earlyExits | 選邊不高於對手 |
| 雙先發 ID | 必須 |
| dailyTopK | **3** |
| 日內排序 | P2 罰分 EV（λ=0.15） |

紙上證據（約 9.7 個月合併窗、$50/注）：**388 注、勝率 ~54.4%、ROI ~+9.3%、約 +$1,809**。

推理骨架另見：`MLB-INFERENCE-FREEZE.md`（均值公式不在本凍結內改）。

---

## 如何回滾

1. `.env` 設：

```bash
MLB_PAPER_RULE_PROFILE=frozen_v1
```

（等價：`min185`）

2. 重啟後端。  
3. 複跑：`node scripts/auditMlbMinOddsAb.mjs`，對照凍結附近的注數／ROI。  
4. **禁止刪除** `MLB_MONEYLINE_RULE_PROFILES.frozen_v1` 與 `min185`。

實驗用 profile 請另開新 id（例如 `no_topk_exp`），不要覆蓋 `frozen_v1`。

---

## 改動前檢查清單

- [ ] 新實驗是否另開 profile／腳本，而非改壞 `frozen_v1`？  
- [ ] 是否已寫入 `MLB-B-LINE-EXPERIMENT-LEDGER.md`？  
- [ ] 未通過雙窗總美元閘門前，是否仍用 `frozen_v1` 當正式？  
