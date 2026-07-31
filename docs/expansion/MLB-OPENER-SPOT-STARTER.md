# MLB Opener／臨時先發（賽前定義＋影子）

> 對齊日：2026-07-31（Grok 選此主題）  
> 正式選注：**不改**；本輪只定契約＋影子

## 定義（賽前可觀測、可回放）

官方歷史特徵**沒有**可靠 `opener` 標籤，故用賽季累計代理：

| ID | 規則 | 含義 |
|----|------|------|
| `sparseStart`（v4.6 凍結） | GS ∈ [1,3] **且** 該先發所屬隊賽前 `wins+losses` ≥ 15 | 季中稀疏／臨時先發（排除開季輪值噪聲） |
| `sparseStartRaw`（影子舊定義） | 本季 GS ∈ [1,3]（無開季保護） | 僅歷史影子對照；**不進 v4.6 向量** |
| `bullpenish` | IP/GS &lt; 4 且 GS≤10 | 牛棚體型短先發 |
| `spotOrOpener` | sparse ∨ bullpenish | 寬代理（診斷用） |
| `strictOpenerish` | GS≤2 且 IP/GS &lt; 4.5 | 嚴代理（極稀） |

> 影子腳本 `auditMlbOpenerSpotStarterShadow.mjs` 仍可用 raw GS∈[1,3] 重現舊切片；正式特徵以協定 §1.1 為準。

腳本：`auditMlbOpenerSpotStarterShadow.mjs`  
產物：`tmp-shadow-opener-spot-starter.json`

## 鎖定 B 基線切片（重要）

基線約 420 注：

| 旗標 | 觸發佔比 | 觸發勝率／@$50 | 非觸發勝率／@$50 |
|------|----------|----------------|------------------|
| **sparseStart** | **~19%** | **45.6%／−$259** | 59.2%／+$3568 |
| spotOrOpener | ~19% | 45.0%／−$309 | 59.4%／+$3618 |
| strictOpenerish | ~0.5% | 樣本≈2 | — |
| bullpenish | ~0.2% | 幾乎無 | — |

→ **稀疏／臨時先發是鎖定 B 內明顯較弱的子池**（與球評直覺同向），但要用對方法處理。

## 排序輕罰結果

- `sparseStart`／`spotOrOpener` 輕罰：多數 **Δ$ 負或不穩**（擠排名後頂上更差的單）  
- `strictOpenerish` λ=0.05：Δ$ **+$44**、雙窗過，但觸發≈2 注 → **統計無意義，不接入**

## 對辯結論（建議）

1. **不要**用 opener／臨時先發做選場排序輕罰／硬跳（接法問題與 IL 類似）。  
2. **要**把 `sparseStart`（或更乾淨的 opener 真標）當 **v4.6 期望得分結構特徵**——模型應學到這類先發讓己方期望得分下降／對手上升。  
3. 若未來有官方 opener／「bullpen game」標註，再替換代理。

## 與 IL 路線合併進 v4.6 的特徵候選

- `is_return_pitcher`（真 IL，已回填）  
- `sparse_start` / opener 代理（本文件）  

下一刀：特徵進重訓協定設計，而不是再拧選場 λ。
