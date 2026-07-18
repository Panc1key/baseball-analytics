/**
 * Dixon–Coles 低分相關修正
 * 在獨立泊松聯合質量上，對 (0,0)(0,1)(1,0)(1,1) 乘上 τ(h,a;λh,λa,ρ)
 */

import db from '../db/database.js';
import { config } from '../config.js';

const FACT = [1];
for (let i = 1; i <= 24; i++) FACT[i] = FACT[i - 1] * i;

function localPoissonPmf(k, lambda) {
  if (k < 0 || lambda <= 0) return k === 0 && lambda <= 0 ? 1 : 0;
  if (k > 24) return 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / FACT[k];
}

export function dixonColesTau(h, a, lambdaH, lambdaA, rho) {
  const r = Number(rho) || 0;
  if (r === 0) return 1;
  const lh = Math.max(0.05, Number(lambdaH) || 0.05);
  const la = Math.max(0.05, Number(lambdaA) || 0.05);
  if (h === 0 && a === 0) return Math.max(1e-6, 1 - lh * la * r);
  if (h === 0 && a === 1) return Math.max(1e-6, 1 + lh * r);
  if (h === 1 && a === 0) return Math.max(1e-6, 1 + la * r);
  if (h === 1 && a === 1) return Math.max(1e-6, 1 - r);
  return 1;
}

export function jointScoreMass(h, a, lambdaH, lambdaA, rho = 0) {
  return (
    localPoissonPmf(h, lambdaH) *
    localPoissonPmf(a, lambdaA) *
    dixonColesTau(h, a, lambdaH, lambdaA, rho)
  );
}

export function getDixonColesRho(league) {
  if (league === 'NPB') return config.dixonColesRhoNpb ?? 0;
  if (league === 'KBO') return config.dixonColesRhoKbo ?? 0;
  return 0;
}

/**
 * 用完賽比分對獨立泊松 + ρ 做網格極大似然（λ 用聯盟均值近似）
 * 回傳使平均對數似然最大的 ρ
 */
export function fitDixonColesRho(league, opts = {}) {
  const games = db
    .prepare(
      `
    SELECT home_score, away_score
    FROM games
    WHERE league = ?
      AND completed = 1
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND NOT (home_score = 0 AND away_score = 0)
  `
    )
    .all(league);

  if (games.length < 40) {
    return { league, rho: 0, n: games.length, note: '樣本不足' };
  }

  let sumH = 0;
  let sumA = 0;
  for (const g of games) {
    sumH += Number(g.home_score);
    sumA += Number(g.away_score);
  }
  const lambdaH = sumH / games.length;
  const lambdaA = sumA / games.length;

  const lo = opts.lo ?? -0.15;
  const hi = opts.hi ?? 0.15;
  const step = opts.step ?? 0.01;
  let bestRho = 0;
  let bestLl = -Infinity;

  for (let rho = lo; rho <= hi + 1e-9; rho += step) {
    let ll = 0;
    for (const g of games) {
      const h = Math.min(24, Math.max(0, Math.round(Number(g.home_score))));
      const a = Math.min(24, Math.max(0, Math.round(Number(g.away_score))));
      const p = jointScoreMass(h, a, lambdaH, lambdaA, rho);
      ll += Math.log(Math.max(1e-12, p));
    }
    if (ll > bestLl) {
      bestLl = ll;
      bestRho = Math.round(rho * 1000) / 1000;
    }
  }

  // 聯盟均值 λ 的 MLE 偏粗，ρ 封頂避免邊界解失真
  const capped = Math.max(-0.08, Math.min(0.08, bestRho));

  return {
    league,
    rho: capped,
    rawRho: bestRho,
    n: games.length,
    lambdaH: Math.round(lambdaH * 100) / 100,
    lambdaA: Math.round(lambdaA * 100) / 100,
    logLik: bestLl,
  };
}

export function fitAllDixonColesRho() {
  return {
    NPB: fitDixonColesRho('NPB'),
    KBO: fitDixonColesRho('KBO'),
  };
}
