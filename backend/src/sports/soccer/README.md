# Soccer — 足球初盤（Dixon–Coles 標準）

## 定價標準（對齊業界）

1. **期望進球** `λ, μ`：攻防對碰（gf/ga vs 對手）× 主場加成  
2. **Dixon–Coles**：獨立 Poisson + ρ 修正 0-0/1-0/0-1/1-1  
3. **衍生盤口一律由比分矩陣積分**  
   - 1X2：比分格子勝負和  
   - 亞盤：含 0.25/0.75 quarter 拆線；含 push  
   - 大小：`P(i+j > line)`  

參考：Dixon & Coles (1997)；penaltyblog / ScoreCast 同類架構；FiveThirtyEight SPI 亦為「投影進球 → 分佈」。

## 環境變數

- `FOOTBALL_DC_RHO`（預設 -0.08）
- `API_FOOTBALL_KEY`（可選：陣容/傷病）

滾球：未做。
