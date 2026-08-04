/**
 * 亞聯精簡 ExpectedRuns（研究）
 * - 特徵：AsianOpeningFoundation（庫內 PIT）
 * - 模型：對「該側得分」做標準化線性回歸（ridge），再泊松估獨贏
 * - 明確：不載入 mlb-expected-runs-nb-v4.5 權重，不進 Locked B
 */
import {
  ASIAN_FOUNDATION_FEATURE_KEYS,
  buildAsianGameFoundationFeatures,
  featuresToVector,
} from './AsianOpeningFoundation.js';

export const ASIAN_EXPECTED_RUNS_LITE_ID = 'asian-expected-runs-lite-v3';

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}
function std(xs, m = mean(xs)) {
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length);
  return Math.sqrt(v) || 1;
}

export function poissonHomeWinProb(homeMu, awayMu, maxRuns = 18) {
  const h = Math.max(0.5, Number(homeMu) || 4);
  const a = Math.max(0.5, Number(awayMu) || 4);
  let pHome = 0;
  let pAway = 0;
  let pDraw = 0;
  const homeP = [];
  const awayP = [];
  let hs = 0;
  let as_ = 0;
  for (let i = 0; i <= maxRuns; i += 1) {
    const ph = Math.exp(-h) * h ** i / factorial(i);
    const pa = Math.exp(-a) * a ** i / factorial(i);
    homeP[i] = ph;
    awayP[i] = pa;
    hs += ph;
    as_ += pa;
  }
  // normalize truncated
  for (let i = 0; i <= maxRuns; i += 1) {
    homeP[i] /= hs;
    awayP[i] /= as_;
  }
  for (let i = 0; i <= maxRuns; i += 1) {
    for (let j = 0; j <= maxRuns; j += 1) {
      const p = homeP[i] * awayP[j];
      if (i > j) pHome += p;
      else if (i < j) pAway += p;
      else pDraw += p;
    }
  }
  // 無和局盤：平手機率對半分（與多數亞盤結算不同時需另適配）
  return {
    homeWinProb: pHome + pDraw / 2,
    awayWinProb: pAway + pDraw / 2,
    drawProb: pDraw,
    homeMu: h,
    awayMu: a,
  };
}

const factCache = [1];
function factorial(n) {
  while (factCache.length <= n) {
    factCache.push(factCache[factCache.length - 1] * factCache.length);
  }
  return factCache[n];
}

/**
 * 訓練：examples[{ x:number[], y:number }]
 * x 預設對齊 ASIAN_FOUNDATION_FEATURE_KEYS；可用 featureKeys 子集（仍從完整 x 取欄）
 */
export function trainAsianRunsLinear(
  examples,
  { ridge = 1e-2, featureKeys = null } = {}
) {
  const fullKeys = ASIAN_FOUNDATION_FEATURE_KEYS;
  const keys = featureKeys?.length ? [...featureKeys] : [...fullKeys];
  const idx = keys.map((k) => fullKeys.indexOf(k));
  if (idx.some((i) => i < 0)) {
    return {
      id: ASIAN_EXPECTED_RUNS_LITE_ID,
      ok: false,
      reason: 'unknown_feature_key',
      n: examples.length,
    };
  }
  const dim = keys.length;
  const n = examples.length;
  if (n < 40) {
    return {
      id: ASIAN_EXPECTED_RUNS_LITE_ID,
      ok: false,
      reason: 'too_few_examples',
      n,
    };
  }
  const means = [];
  const scales = [];
  for (let j = 0; j < dim; j += 1) {
    const col = examples.map((e) => e.x[idx[j]]);
    const m = mean(col);
    means.push(m);
    scales.push(std(col, m));
  }
  // design matrix with intercept; ridge on non-intercept
  const p = dim + 1;
  const XtX = Array.from({ length: p }, () => Array(p).fill(0));
  const XtY = Array(p).fill(0);
  for (const e of examples) {
    const row = [1];
    for (let j = 0; j < dim; j += 1) {
      row.push((e.x[idx[j]] - means[j]) / scales[j]);
    }
    for (let i = 0; i < p; i += 1) {
      XtY[i] += row[i] * e.y;
      for (let j = 0; j < p; j += 1) {
        XtX[i][j] += row[i] * row[j];
      }
    }
  }
  for (let i = 1; i < p; i += 1) XtX[i][i] += ridge * n;

  const beta = solveLinearSystem(XtX, XtY);
  return {
    id: ASIAN_EXPECTED_RUNS_LITE_ID,
    ok: true,
    n,
    featureKeys: keys,
    featureIndexInFull: idx,
    means,
    scales,
    intercept: beta[0],
    weights: Object.fromEntries(keys.map((k, i) => [k, beta[i + 1]])),
    ridge,
  };
}

function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col] || 1e-12;
    for (let j = col; j <= n; j += 1) M[col][j] /= div;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = col; j <= n; j += 1) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row[n]);
}

export function predictSideRuns(model, featuresOrVector) {
  if (!model?.ok) return 4.2;
  let y = model.intercept;
  const isVec = Array.isArray(featuresOrVector);
  for (let i = 0; i < model.featureKeys.length; i += 1) {
    const k = model.featureKeys[i];
    let raw;
    if (isVec) {
      const fullIdx = model.featureIndexInFull?.[i] ?? ASIAN_FOUNDATION_FEATURE_KEYS.indexOf(k);
      raw = Number(featuresOrVector[fullIdx]) || 0;
    } else {
      raw = Number(featuresOrVector[k]) || 0;
    }
    const z = (raw - model.means[i]) / model.scales[i];
    y += (model.weights[k] || 0) * z;
  }
  return Math.max(1.5, Math.min(9.5, y));
}

/** 將兩隊 μ 往聯賽均分／市場大小線收縮（研究用） */
export function shrinkAsianSideMus(homeMu, awayMu, {
  leagueTotal = 8.2,
  shrinkToLeague = 0,
  marketLine = null,
  shrinkToMarket = 0,
} = {}) {
  let h = Math.max(1.5, Math.min(9.5, Number(homeMu) || 4));
  let a = Math.max(1.5, Math.min(9.5, Number(awayMu) || 4));
  let total = h + a;
  const sL = Math.max(0, Math.min(1, Number(shrinkToLeague) || 0));
  if (sL > 0) {
    total = (1 - sL) * total + sL * Number(leagueTotal);
    const scale = h + a > 0 ? total / (h + a) : 1;
    h *= scale;
    a *= scale;
  }
  const sM = Math.max(0, Math.min(1, Number(shrinkToMarket) || 0));
  if (sM > 0 && Number.isFinite(Number(marketLine))) {
    const t2 = (1 - sM) * (h + a) + sM * Number(marketLine);
    const scale = h + a > 0 ? t2 / (h + a) : 1;
    h *= scale;
    a *= scale;
  }
  return {
    homeMu: Math.max(1.5, Math.min(9.5, h)),
    awayMu: Math.max(1.5, Math.min(9.5, a)),
  };
}

export function predictAsianGameLite(model, game, opts = {}) {
  const built = buildAsianGameFoundationFeatures(game, opts);
  const homeMu = predictSideRuns(model, built.home);
  const awayMu = predictSideRuns(model, built.away);
  const win = poissonHomeWinProb(homeMu, awayMu);
  return {
    ...win,
    ready: built.ready,
    featureVersion: built.featureVersion,
    modelId: model?.id || ASIAN_EXPECTED_RUNS_LITE_ID,
    homeFeatures: built.home,
    awayFeatures: built.away,
  };
}

export function exampleFromGameSide(game, side, opts = {}) {
  const built = buildAsianGameFoundationFeatures(game, opts);
  const feats = side === 'home' ? built.home : built.away;
  const y =
    side === 'home' ? Number(game.home_score) : Number(game.away_score);
  return {
    x: featuresToVector(feats),
    y,
    ready: built.ready,
    day: String(game.commence_time || '').slice(0, 10),
    features: feats,
  };
}

/** 主隊視角對決特徵（研究：直接估獨贏，不經得分回歸） */
export const ASIAN_MATCHUP_FEATURE_KEYS = Object.freeze([
  'eloDiff',
  'eloStrength',
  'pythWinPct',
  'opponentPythWinPct',
  'seasonWinPct',
  'opponentSeasonWinPct',
  'runDiffPerGame',
  'opponentRunDiffPerGame',
  'last10WinPct',
  'opponentLast10WinPct',
  'formWinAccel',
  'rpgAccel',
  'restDiff',
  'seasonRpg',
  'opponentSeasonRpg',
  'seasonRaRpg',
  'opponentSeasonRaRpg',
  'pitcherKnown',
  'opponentPitcherKnown',
  'pitcherStarts',
  'opponentPitcherStarts',
  'pitcherRestDays',
  'opponentPitcherRestDays',
  'pitcherRaRpg',
  'opponentPitcherRaRpg',
  'pitcherRaDiff',
]);

export function matchupVectorFromHomeFeatures(homeFeats) {
  return ASIAN_MATCHUP_FEATURE_KEYS.map((k) => Number(homeFeats[k]) || 0);
}

/**
 * 簡易 L2 logistic（梯度下降）→ P(home win)
 * examples: [{ x:number[], y:0|1 }]
 */
export function trainAsianLogisticHomeWin(examples, { ridge = 0.05, steps = 400, lr = 0.08 } = {}) {
  const dim = ASIAN_MATCHUP_FEATURE_KEYS.length;
  const n = examples.length;
  if (n < 40) {
    return { ok: false, reason: 'too_few_examples', n, id: 'asian-logistic-h2h-v1' };
  }
  const means = [];
  const scales = [];
  for (let j = 0; j < dim; j += 1) {
    const col = examples.map((e) => e.x[j]);
    const m = mean(col);
    means.push(m);
    scales.push(std(col, m));
  }
  const beta = Array(dim + 1).fill(0);
  for (let step = 0; step < steps; step += 1) {
    const grad = Array(dim + 1).fill(0);
    for (const e of examples) {
      let z = beta[0];
      for (let j = 0; j < dim; j += 1) {
        z += beta[j + 1] * ((e.x[j] - means[j]) / scales[j]);
      }
      const p = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
      const err = p - e.y;
      grad[0] += err;
      for (let j = 0; j < dim; j += 1) {
        grad[j + 1] += err * ((e.x[j] - means[j]) / scales[j]);
      }
    }
    beta[0] -= (lr / n) * grad[0];
    for (let j = 1; j <= dim; j += 1) {
      beta[j] -= (lr / n) * (grad[j] + ridge * beta[j]);
    }
  }
  return {
    ok: true,
    id: 'asian-logistic-h2h-v1',
    n,
    featureKeys: ASIAN_MATCHUP_FEATURE_KEYS,
    means,
    scales,
    intercept: beta[0],
    weights: Object.fromEntries(ASIAN_MATCHUP_FEATURE_KEYS.map((k, i) => [k, beta[i + 1]])),
    ridge,
  };
}

export function predictLogisticHomeWin(model, homeFeats) {
  if (!model?.ok) return 0.5;
  const x = matchupVectorFromHomeFeatures(homeFeats);
  let z = model.intercept;
  for (let i = 0; i < model.featureKeys.length; i += 1) {
    const k = model.featureKeys[i];
    z += (model.weights[k] || 0) * ((x[i] - model.means[i]) / model.scales[i]);
  }
  const p = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
  return Math.max(0.05, Math.min(0.95, p));
}

/**
 * 研究用校準：溫度（壓平 logit）+ shrink-to-market
 */
export function applyAsianLogisticCalibration(pOrZ, {
  shrink = 0,
  temp = 1,
  fairHome = 0.5,
  fromLogit = false,
} = {}) {
  let z;
  if (fromLogit) {
    z = Number(pOrZ);
  } else {
    const p0 = Math.max(1e-6, Math.min(1 - 1e-6, Number(pOrZ)));
    z = Math.log(p0 / (1 - p0));
  }
  const zt = z / Math.max(0.5, Number(temp) || 1);
  let p = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, zt))));
  p = Math.max(0.05, Math.min(0.95, p));
  const s = Math.max(0, Math.min(1, Number(shrink) || 0));
  if (s > 0) p = (1 - s) * p + s * Number(fairHome);
  return Math.max(0.05, Math.min(0.95, p));
}

/**
 * 舊模型核心的 PIT 版：賽季 RPG λ + Elo 調 λ（無 ops/whip、無先發）
 */
export function projectEloLambdaRuns(homeFeats, awayFeats, league) {
  const leagueRpg = league === 'KBO' ? 4.5 : 3.9;
  const homeOff = Math.max(0.5, homeFeats.seasonRpg || leagueRpg);
  const awayOff = Math.max(0.5, awayFeats.seasonRpg || leagueRpg);
  const homeDef = Math.max(0.5, homeFeats.seasonRaRpg || leagueRpg);
  const awayDef = Math.max(0.5, awayFeats.seasonRaRpg || leagueRpg);
  let homeRuns = Math.max(
    1.5,
    Math.min(8.5, leagueRpg * (homeOff / leagueRpg) * (awayDef / leagueRpg) + 0.1)
  );
  let awayRuns = Math.max(
    1.5,
    Math.min(8.5, leagueRpg * (awayOff / leagueRpg) * (homeDef / leagueRpg))
  );
  const homeElo = Number(homeFeats.elo) || 1500;
  const awayElo = Number(awayFeats.elo) || 1500;
  const margin = (homeElo + 35 - awayElo) / 400;
  const t = Math.tanh(margin);
  homeRuns *= 1 + 0.08 * t;
  awayRuns *= 1 - 0.08 * t;
  const shrink = Math.min(0.1, Math.abs(t) * 0.07);
  const total = (homeRuns + awayRuns) * (1 - shrink);
  const scale = homeRuns + awayRuns > 0 ? total / (homeRuns + awayRuns) : 1;
  homeRuns = Math.max(1.4, Math.min(8.5, homeRuns * scale));
  awayRuns = Math.max(1.4, Math.min(8.5, awayRuns * scale));
  return poissonHomeWinProb(homeRuns, awayRuns);
}
