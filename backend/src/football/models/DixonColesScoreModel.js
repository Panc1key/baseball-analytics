/**
 * Dixon–Coles 足球比分矩陣（業界主流）
 * 獨立 Poisson 期望進球 + 低比分相關修正 ρ，再由格子推導：
 * 1X2 / 亞盤 / 大小球 / BTTS
 *
 * 參考：Dixon & Coles (1997)；FiveThirtyEight SPI 亦以投影進球 + 分佈定價
 */

const MAX_GOALS = 10;
const FACT = [1];
for (let i = 1; i <= MAX_GOALS; i++) FACT[i] = FACT[i - 1] * i;

export function poissonPmf(k, lambda) {
  if (k < 0) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  if (k > MAX_GOALS) return 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / FACT[k];
}

/** Dixon–Coles 低比分修正 τ(x,y) */
export function dixonColesTau(x, y, lambda, mu, rho) {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/**
 * 建立歸一化比分聯合分佈 P(homeGoals=i, awayGoals=j)
 * @returns {{ grid: number[][], homeLambda, awayLambda, rho }}
 */
export function buildDixonColesGrid(homeLambda, awayLambda, rho = -0.08, maxGoals = MAX_GOALS) {
  const λ = Math.max(0.05, Math.min(5.5, homeLambda));
  const μ = Math.max(0.05, Math.min(5.5, awayLambda));
  const ρ = Math.max(-0.13, Math.min(-0.01, rho));

  const grid = [];
  let mass = 0;
  for (let i = 0; i <= maxGoals; i++) {
    grid[i] = [];
    const pi = poissonPmf(i, λ);
    for (let j = 0; j <= maxGoals; j++) {
      const raw = pi * poissonPmf(j, μ) * dixonColesTau(i, j, λ, μ, ρ);
      grid[i][j] = Math.max(0, raw);
      mass += grid[i][j];
    }
  }
  if (mass > 0) {
    for (let i = 0; i <= maxGoals; i++) {
      for (let j = 0; j <= maxGoals; j++) grid[i][j] /= mass;
    }
  }
  return { grid, homeLambda: λ, awayLambda: μ, rho: ρ, maxGoals };
}

export function sumGrid(grid, pred) {
  let s = 0;
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      if (pred(i, j)) s += grid[i][j];
    }
  }
  return s;
}

export function outcomeFromGrid(grid) {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      const p = grid[i][j];
      if (i > j) home += p;
      else if (i === j) draw += p;
      else away += p;
    }
  }
  const t = home + draw + away || 1;
  return { homeWinProb: home / t, drawProb: draw / t, awayWinProb: away / t };
}

export function totalFromGrid(grid, line) {
  let over = 0;
  let under = 0;
  let push = 0;
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      const p = grid[i][j];
      const tot = i + j;
      if (tot > line) over += p;
      else if (tot < line) under += p;
      else push += p;
    }
  }
  const mass = over + under + push || 1;
  return { overProb: over / mass, underProb: under / mass, pushProb: push / mass };
}

/**
 * 單一（非 quarter）亞盤：從挑邊視角
 * adjusted = (pickGoals - oppGoals) + line；>0 勝、<0 負、=0 走
 */
export function asianSingleLineFromGrid(grid, pickIsHome, line) {
  let win = 0;
  let loss = 0;
  let push = 0;
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      const p = grid[i][j];
      const margin = pickIsHome ? i - j : j - i;
      const adj = margin + line;
      if (adj > 0) win += p;
      else if (adj < 0) loss += p;
      else push += p;
    }
  }
  const mass = win + loss + push || 1;
  return { winProb: win / mass, lossProb: loss / mass, pushProb: push / mass };
}

/** 拆 quarter 盤：±0.25 / ±0.75 → 兩條半線 */
export function splitAsianQuarterLine(line) {
  const abs = Math.abs(line);
  const sign = line >= 0 ? 1 : -1;
  const whole = Math.floor(abs + 1e-9);
  const frac = abs - whole;
  if (Math.abs(frac - 0.25) < 1e-6) {
    return [sign * whole, sign * (whole + 0.5)];
  }
  if (Math.abs(frac - 0.75) < 1e-6) {
    return [sign * (whole + 0.5), sign * (whole + 1)];
  }
  return [line];
}

/**
 * 亞盤蓋盤（含 quarter）：回傳「贏注期望比例」winUnits（push=退本→0 盈虧）
 * 對 EV：EV = winUnits * netOdds - lossUnits（lossUnits = 1 - winUnits - pushUnits 需細算）
 *
 * 簡化：回傳有效勝率 effectiveWin（把 push 當退本，EV 用 calcEVWithPush）
 */
export function asianHandicapFromGrid(grid, pickIsHome, line) {
  const parts = splitAsianQuarterLine(line);
  if (parts.length === 1) {
    return asianSingleLineFromGrid(grid, pickIsHome, parts[0]);
  }
  const a = asianSingleLineFromGrid(grid, pickIsHome, parts[0]);
  const b = asianSingleLineFromGrid(grid, pickIsHome, parts[1]);
  return {
    winProb: (a.winProb + b.winProb) / 2,
    lossProb: (a.lossProb + b.lossProb) / 2,
    pushProb: (a.pushProb + b.pushProb) / 2,
    split: parts,
  };
}
