/**
 * 籃球標準定價：效率×節奏 → 期望得分/淨勝分
 * 淨勝分 ~ Normal(μ, σ)；業界（KenPom / Vegas 基準）常用 σ≈11–12
 */

/** Abramowitz–Stegun erf 近似 */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-a * a));
  return sign * y;
}

export function normalCdf(x, mean = 0, sd = 1) {
  if (sd <= 0) return x >= mean ? 1 : 0;
  return 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));
}

/** P(X > threshold) for X~N(mean,sd^2)；連續近似，不分 push */
export function normalPAbove(mean, sd, threshold) {
  return 1 - normalCdf(threshold, mean, sd);
}

/**
 * 讓分：P(margin + line > 0)
 * - 半分／四分盤：連續近似，無走盤
 * - 整數盤：±0.5 點窗近似 push
 */
export function normalCoverProb(expectedMargin, line, sd) {
  const adjMean = expectedMargin + line;
  const frac = Math.abs(line) - Math.floor(Math.abs(line) + 1e-12);

  // 整數盤（含 0、-3、+4）
  if (frac < 1e-9) {
    const winProb = 1 - normalCdf(0.5, adjMean, sd);
    const lossProb = normalCdf(-0.5, adjMean, sd);
    const pushProb = Math.max(0, 1 - winProb - lossProb);
    return { winProb, pushProb, lossProb };
  }

  // 其餘（.5 / .25 等）：無走盤
  const winProb = 1 - normalCdf(0, adjMean, sd);
  return { winProb, pushProb: 0, lossProb: 1 - winProb };
}

/**
 * 標準常態分位數逆函數 Φ^{-1}（Acklam 近似）
 * 用於：市場勝率 → 隱含淨勝分
 */
export function inverseNormalCdf(p) {
  const pp = Math.max(1e-10, Math.min(1 - 1e-10, p));
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580577e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
  ];

  const plow = 0.02425;
  const phigh = 1 - plow;
  let q;
  let r;

  if (pp < plow) {
    q = Math.sqrt(-2 * Math.log(pp));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (pp > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - pp));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  q = pp - 0.5;
  r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/** 市場主勝率 → 隱含期望淨勝分（與 Φ(margin/σ)=p 對齊） */
export function marginFromWinProb(homeWinProb, sigma) {
  return inverseNormalCdf(homeWinProb) * sigma;
}

export function normalTotalOverProb(expectedTotal, line, sd) {
  // 半分線為主：P(total > line)
  return 1 - normalCdf(line, expectedTotal, sd);
}
