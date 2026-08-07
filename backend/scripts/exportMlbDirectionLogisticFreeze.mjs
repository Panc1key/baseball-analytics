/**
 * 匯出方向 logistic 凍結係數，供 MlbDirectionBlendDisagreeShadow 活體對照。
 * 用法：node scripts/exportMlbDirectionLogisticFreeze.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../data/mlb-direction-logistic-freeze.json');

function sigmoid(z) {
  if (z >= 20) return 1;
  if (z <= -20) return 0;
  return 1 / (1 + Math.exp(-z));
}

function fitLogistic(xs, ys, { epochs = 700, lr = 0.05, l2 = 0.02 } = {}) {
  const dim = xs[0].length;
  const mean = Array(dim).fill(0);
  const scale = Array(dim).fill(1);
  for (const x of xs) for (let i = 0; i < dim; i += 1) mean[i] += x[i];
  for (let i = 0; i < dim; i += 1) mean[i] /= xs.length;
  for (const x of xs) {
    for (let i = 0; i < dim; i += 1) scale[i] += (x[i] - mean[i]) ** 2;
  }
  for (let i = 0; i < dim; i += 1) {
    scale[i] = Math.max(0.01, Math.sqrt(scale[i] / Math.max(1, xs.length - 1)));
  }
  const zs = xs.map((x) => x.map((v, i) => (v - mean[i]) / scale[i]));
  let w = Array(dim).fill(0);
  let b = 0;
  for (let ep = 0; ep < epochs; ep += 1) {
    const gw = Array(dim).fill(0);
    let gb = 0;
    for (let i = 0; i < zs.length; i += 1) {
      const p = sigmoid(b + zs[i].reduce((s, v, j) => s + w[j] * v, 0));
      const err = p - ys[i];
      gb += err;
      for (let j = 0; j < dim; j += 1) gw[j] += err * zs[i][j];
    }
    const n = zs.length;
    b -= (lr * gb) / n;
    for (let j = 0; j < dim; j += 1) w[j] -= lr * (gw[j] / n + l2 * w[j]);
  }
  return { mean, scale, w, b };
}

const model = getLatestMlbExpectedRunsValidation()?.model;
if (!model) throw new Error('no expected-runs model');

const games = db
  .prepare(
    `SELECT g.id, g.home_team, g.away_team, g.home_score, g.away_score, g.commence_time,
            f.features_json
     FROM games g
     JOIN mlb_historical_feature_rows f
       ON f.game_id = g.id AND f.feature_version = ?
     WHERE g.league = 'MLB'
       AND g.completed = 1
       AND g.home_score IS NOT NULL
       AND g.away_score IS NOT NULL
       AND g.commence_time >= '2024-04-01'
       AND g.commence_time < '2026-07-01'
     ORDER BY g.commence_time`
  )
  .all(MLB_BASELINE_FEATURE_VERSION);

console.log('rows', games.length);
const xs = [];
const ys = [];
let skipped = 0;
for (const g of games) {
  let feat;
  try {
    feat = JSON.parse(g.features_json);
  } catch {
    skipped += 1;
    continue;
  }
  const pf = resolveMlbParkFactor({ homeTeam: g.home_team });
  let pred;
  try {
    pred = predictMlbGameRuns(model, { ...feat, parkFactor: pf }, { parkFactor: pf });
  } catch {
    skipped += 1;
    continue;
  }
  const homeMu = Number(pred.homeExpectedRuns);
  const awayMu = Number(pred.awayExpectedRuns);
  const pMuHome = Number(pred.markets?.homeWinProbability);
  if (!Number.isFinite(homeMu) || !Number.isFinite(awayMu) || !Number.isFinite(pMuHome)) {
    skipped += 1;
    continue;
  }
  const homeWinPct = Number(feat?.home?.homeWinPct ?? 0.5);
  const awayWinPct = Number(feat?.away?.awayWinPct ?? feat?.away?.winPct ?? 0.5);
  const homeSeason = Number(feat?.home?.winPct ?? homeWinPct);
  const awaySeason = Number(feat?.away?.winPct ?? awayWinPct);
  xs.push([
    homeMu - awayMu,
    pMuHome,
    homeWinPct,
    awayWinPct,
    homeWinPct - awayWinPct,
    homeSeason - awaySeason,
    Number(pf) || 1,
    homeMu,
    awayMu,
  ]);
  ys.push(Number(g.home_score) > Number(g.away_score) ? 1 : 0);
}

console.log('fit n', xs.length, 'skipped', skipped);
if (xs.length < 500) throw new Error('too few rows for freeze');

const fitted = fitLogistic(xs, ys);
const payload = {
  id: 'mlb-direction-logistic-freeze-v1',
  createdAt: new Date().toISOString(),
  trainFrom: '2024-04-01',
  trainTo: '2026-07-01',
  n: xs.length,
  featureNames: [
    'muMargin',
    'pMuHome',
    'homeWinPct',
    'awayWinPct',
    'winPctDiff',
    'seasonDiff',
    'parkFactor',
    'homeMu',
    'awayMu',
  ],
  mean: fitted.mean,
  scale: fitted.scale,
  w: fitted.w,
  b: fitted.b,
  note: 'for MlbDirectionBlendDisagreeShadow compare-only',
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log('wrote', OUT);
