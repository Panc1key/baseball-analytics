# MLB 傷愈回歸（IL Return）可回放旗標

> 對齊日：2026-07-31（Cursor × Grok 對辯後）  
> 狀態：**基礎設施已落地**；正式選注常數未改；排序輕罰／v4.6 待真旗標影子

## 對齊結論（雙 AI）

1. 接法保 **(i) 排序輕罰**，不做 P 乘子重過閘  
2. 代理 C1/C2 **不能**否決真旗標  
3. 下一刀優先：**真 IL 回填**（本文件）→ 再 WF 排序輕罰 / 進 v4.6

## 資料契約

| 欄位 | 定義 |
|------|------|
| 來源 | `GET https://statsapi.mlb.com/api/v1/transactions` |
| 表 | `mlb_il_transaction_events`（`placed` / `activated`） |
| 解析 | description 含 `placed … injured list` / `activated … injured list` |

### `is_return_pitcher`（Grok C，已實作可回放）

```
days_since_last_il_exit <= 45
AND season_ip_before_this_start < 30
```

- `days_since_last_il_exit`：開賽日前最近一次 `activated` 事件  
- `season_ip_before`：特徵列當下 `pitchers.*.inningsPitched`（賽前累計）  
- `career_ip > 100`：**暫不強制**（避免再打 API；可後補）

寫入位置：`features.pitchers.homeIlReturn` / `awayIlReturn`

## 腳本

```bash
# 1) 回填交易事件
node scripts/backfillMlbIlTransactions.mjs --from=2024-03 --to=2026-07

# 2) 標註特徵列
node scripts/annotateMlbIlReturnOnFeatures.mjs --from=2025-04-01 --to=2026-07-28
```

產物：`tmp-backfill-mlb-il-transactions.json`、`tmp-annotate-mlb-il-return.json`

## 下一步（影子，仍不改正式）

對鎖定 B 候選池：若**選邊** `isReturnPitcher` → 日內 `score -= λ`（建議先掃 λ∈{0.05,0.10,0.15}）  
閘門：合併 Δ$、2025/2026 雙窗、Expanding WF。  
過閘才討論接入；否則只當 v4.6 特徵候選。

### 首輪真旗標排序輕罰結果（2026-07-31）

腳本：`auditMlbTrueIlReturnRankPenaltyShadow.mjs` → `tmp-shadow-true-il-return-rank-penalty.json`

- 基線入選中觸發真回歸：**僅約 10 注**（樣本仍薄）  
- λ=0.05…0.25：**合併 Δ$ 皆負**（約 −66～−161），雙窗不過  

→ **真旗標排序輕罰本輪未過閘**；資料基礎設施仍保留供 v4.6／更細切分（例如只要 days≤21、或只罰客隊）。  
舊代理弱正（+$211）**不能**再用；真旗標已否決「同款輕罰直接接入」。

## 明確不做

- 用 P×0.9 重過 EV 閘（已影子為負）  
- 用 rest/ERA 代理冒充真 IL 結案
