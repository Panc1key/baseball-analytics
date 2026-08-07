/**
 * 方向準度 Round2：直接優化「誰贏／分差」（不動正式 μ 權重寫庫）
 *
 * 候選：
 * - prod μ 方向（基線）
 * - logistic 主勝頭（吃 μ分差 + 主客勝率等）
 * - 特徵差分 logistic（側向向量差）
 * - ridge 分差回歸
 * - μ 與 logistic 投票／混合
 * - 條件強主收縮（僅薄分差）
 *
 * 用法: node scripts/auditMlbDirectionAccuracyRound2.mjs
 * 產物: tmp-direction-accuracy-round2.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import { getCachedMlbGameWeather } from '../src/services/MlbGameWeatherService.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  buildMlbExpectedRunsSideFeatures,
  predictMlbExpectedRunsMean,
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
  calibrateMlbScoreMarkets,
  MLB_EXPECTED_RUNS_FEATURE_KEYS,
  MLB_V45_SELECTED_FEATURE_KEYS,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const STRONG = 0.65;

function finite(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

function enrichSideVector(base, features, side) {
  const homeWinPct = finite(features?.home?.homeWinPct, 0.5);
  const awayWinPct = finite(features?.away?.awayWinPct, 0.5);
  const homeSeason = finite(features?.home?.seasonWinPct, 0.5);
  const awaySeason = finite(features?.away?.seasonWinPct, 0.5);
  return {
    ...base,
    offenseRoleWinPct: side === 'home' ? homeWinPct : awayWinPct,
    opponentRoleWinPct: side === 'home' ? awayWinPct : homeWinPct,
    seasonWinPctDiffForOffense:
      side === 'home' ? homeSeason - awaySeason : awaySeason - homeSeason,
  };
}

function loadGameRows(fromIso, toIsoExclusive) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam,
              g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND datetime(f.commence_time) >= datetime(?)
         AND datetime(f.commence_time) < datetime(?)
       ORDER BY datetime(f.commence_time), f.game_id`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, fromIso, toIsoExclusive);

  const out = [];
  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const hs = +row.homeScore;
    const as = +row.awayScore;
    if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) continue;
    features.parkFactor = resolveMlbParkFactor({
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    features.weather = getCachedMlbGameWeather({
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    const homeVec = enrichSideVector(
      buildMlbExpectedRunsSideFeatures(features, 'home'),
      features,
      'home'
    );
    const awayVec = enrichSideVector(
      buildMlbExpectedRunsSideFeatures(features, 'away'),
      features,
      'away'
    );
    if (!MLB_EXPECTED_RUNS_FEATURE_KEYS.every((k) => Number.isFinite(homeVec[k]))) continue;
    if (!MLB_EXPECTED_RUNS_FEATURE_KEYS.every((k) => Number.isFinite(awayVec[k]))) continue;
    out.push({
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      homeScore: hs,
      awayScore: as,
      features,
      homeVector: homeVec,
      awayVector: awayVec,
      homeWinPct: finite(features?.home?.homeWinPct, 0.5),
      awayWinPct: finite(features?.away?.awayWinPct, 0.5),
      homeSeason: finite(features?.home?.seasonWinPct, 0.5),
      awaySeason: finite(features?.away?.seasonWinPct, 0.5),
      parkFactor: finite(features.parkFactor, 1),
    });
  }
  return out;
}

function fairHome(homeOdds, awayOdds) {
  const ih = 1 / homeOdds;
  const ia = 1 / awayOdds;
  return ih / (ih + ia);
}

function marketHomeProb(row) {
  const pit = resolvePitOdds(row.gameId, row.commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const home =
      m.outcomes.find((o) => o.name === row.homeTeam) ||
      m.outcomes.find((o) =>
        String(o.name).includes(String(row.homeTeam).split(' ').pop())
      );
    const away =
      m.outcomes.find((o) => o.name === row.awayTeam) ||
      m.outcomes.find((o) =>
        String(o.name).includes(String(row.awayTeam).split(' ').pop())
      );
    if (!home?.price || !away?.price) continue;
    const ho = +home.price;
    const ao = +away.price;
    if (!Number.isFinite(ho) || !Number.isFinite(ao)) continue;
    const vig = 1 / ho + 1 / ao;
    if (!best || vig < best.vig) {
      best = { vig, p: fairHome(ho, ao) };
    }
  }
  return best?.p ?? null;
}

const muModel = getLatestMlbExpectedRunsValidation().model;

function attachMu(row) {
  const homeMu = predictMlbExpectedRunsMean(muModel, row.homeVector);
  const awayMu = predictMlbExpectedRunsMean(muModel, row.awayVector);
  const dist = buildMlbScoreDistribution({
    homeMean: homeMu,
    awayMean: awayMu,
    homeDispersion: muModel.dispersion,
    awayDispersion: muModel.dispersion,
  });
  const markets = calibrateMlbScoreMarkets(
    deriveMlbScoreMarkets(dist, { totalLine: 8.5 }),
    muModel.moneylineTemperature ?? 1
  );
  return {
    ...row,
    homeMu,
    awayMu,
    muMargin: homeMu - awayMu,
    pMuHome: markets.homeWinProbability,
  };
}

/** 標準化 + logistic / ridge */
function standardizeFit(rows, xFn) {
  const xs = rows.map(xFn);
  const dim = xs[0].length;
  const mean = Array(dim).fill(0);
  const scale = Array(dim).fill(1);
  for (const x of xs) {
    for (let i = 0; i < dim; i += 1) mean[i] += x[i];
  }
  for (let i = 0; i < dim; i += 1) mean[i] /= xs.length;
  for (const x of xs) {
    for (let i = 0; i < dim; i += 1) scale[i] += (x[i] - mean[i]) ** 2;
  }
  for (let i = 0; i < dim; i += 1) {
    scale[i] = Math.max(0.01, Math.sqrt(scale[i] / Math.max(1, xs.length - 1)));
  }
  const z = (x) => x.map((v, i) => (v - mean[i]) / scale[i]);
  return { mean, scale, z, zs: xs.map(z) };
}

function fitLogistic(rows, xFn, { epochs = 800, lr = 0.05, l2 = 0.02 } = {}) {
  const { mean, scale, z, zs } = standardizeFit(rows, xFn);
  const ys = rows.map((r) => (r.homeScore > r.awayScore ? 1 : 0));
  const dim = zs[0].length;
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
    for (let j = 0; j < dim; j += 1) {
      w[j] -= lr * (gw[j] / n + l2 * w[j]);
    }
  }
  return {
    type: 'logistic',
    mean,
    scale,
    w,
    b,
    predictP(row) {
      const x = z(xFn(row));
      return sigmoid(b + x.reduce((s, v, j) => s + w[j] * v, 0));
    },
  };
}

function fitRidge(rows, xFn, yFn, { epochs = 800, lr = 0.03, l2 = 0.05 } = {}) {
  const { mean, scale, z, zs } = standardizeFit(rows, xFn);
  const ys = rows.map(yFn);
  const dim = zs[0].length;
  let w = Array(dim).fill(0);
  let b = ys.reduce((s, v) => s + v, 0) / ys.length;
  for (let ep = 0; ep < epochs; ep += 1) {
    const gw = Array(dim).fill(0);
    let gb = 0;
    for (let i = 0; i < zs.length; i += 1) {
      const pred = b + zs[i].reduce((s, v, j) => s + w[j] * v, 0);
      const err = pred - ys[i];
      gb += err;
      for (let j = 0; j < dim; j += 1) gw[j] += err * zs[i][j];
    }
    const n = zs.length;
    b -= (lr * gb) / n;
    for (let j = 0; j < dim; j += 1) {
      w[j] -= lr * (gw[j] / n + l2 * w[j]);
    }
  }
  return {
    type: 'ridge',
    mean,
    scale,
    w,
    b,
    predict(row) {
      const x = z(xFn(row));
      return b + x.reduce((s, v, j) => s + w[j] * v, 0);
    },
  };
}

function xMuHead(row) {
  return [
    row.muMargin,
    row.pMuHome,
    row.homeWinPct,
    row.awayWinPct,
    row.homeWinPct - row.awayWinPct,
    row.homeSeason - row.awaySeason,
    row.parkFactor,
    row.homeMu,
    row.awayMu,
  ];
}

function xDiffHead(row) {
  const keys = [
    ...MLB_V45_SELECTED_FEATURE_KEYS.filter((k) => k !== 'isHome'),
    'offenseRoleWinPct',
    'opponentRoleWinPct',
    'seasonWinPctDiffForOffense',
  ];
  return keys.map((k) => finite(row.homeVector[k]) - finite(row.awayVector[k]));
}

function xMuPlusMkt(row) {
  const pMkt = marketHomeProb(row);
  return [
    ...xMuHead(row),
    pMkt == null ? 0.5 : pMkt,
    pMkt == null ? 0 : 1,
    row.pMuHome - (pMkt == null ? 0.5 : pMkt),
  ];
}

function directionReport(rows, pickHomeFn, pHomeFn = null) {
  let n = 0;
  let dirHit = 0;
  let brier = 0;
  let strongN = 0;
  let strongAway = 0;
  let strongAwayHomeAct = 0;
  let maeH = 0;
  let maeA = 0;
  for (const row of rows) {
    const pickHome = pickHomeFn(row);
    const homeWins = row.homeScore > row.awayScore;
    n += 1;
    if (pickHome === homeWins) dirHit += 1;
    const p = pHomeFn ? pHomeFn(row) : pickHome ? 0.55 : 0.45;
    brier += (p - (homeWins ? 1 : 0)) ** 2;
    maeH += Math.abs(row.homeMu - row.homeScore);
    maeA += Math.abs(row.awayMu - row.awayScore);
    if (row.homeWinPct >= STRONG) {
      strongN += 1;
      if (!pickHome) {
        strongAway += 1;
        if (homeWins) strongAwayHomeAct += 1;
      }
    }
  }
  return {
    games: n,
    directionHitRate: Number((dirHit / n).toFixed(4)),
    moneylineBrier: Number((brier / n).toFixed(5)),
    maeHome: Number((maeH / n).toFixed(4)),
    maeAway: Number((maeA / n).toFixed(4)),
    strongHome: {
      games: strongN,
      muPicksAway: strongAway,
      muPicksAwayRate: strongN ? Number((strongAway / strongN).toFixed(4)) : null,
      whenAwayHomeActual: strongAway
        ? Number((strongAwayHomeAct / strongAway).toFixed(4))
        : null,
    },
  };
}

function fitCondShrink(valRows) {
  // if μ picks away & hwp>=t & |margin|<m → force home or shrink
  let best = { t: 0.65, m: 0.4, mode: 'force_home', valDir: -1 };
  for (const t of [0.6, 0.62, 0.65, 0.68]) {
    for (const m of [0.3, 0.5, 0.8, 1.2]) {
      for (const mode of ['force_home', 'shrink_half']) {
        let n = 0;
        let hit = 0;
        for (const row of valRows) {
          let pickHome = row.homeMu >= row.awayMu;
          if (!pickHome && row.homeWinPct >= t && Math.abs(row.muMargin) < m) {
            if (mode === 'force_home') pickHome = true;
            else {
              const pa = row.awayMu - 0.5 * Math.abs(row.muMargin);
              pickHome = row.homeMu >= pa;
            }
          }
          n += 1;
          if (pickHome === row.homeScore > row.awayScore) hit += 1;
        }
        const rate = hit / n;
        if (rate > best.valDir) best = { t, m, mode, valDir: rate };
      }
    }
  }
  return best;
}

console.log('Loading…');
const development = loadGameRows('2025-05-01T00:00:00Z', '2026-01-01T00:00:00Z').map(attachMu);
const split = Math.floor(development.length * 0.7);
const train = development.slice(0, split);
const val = development.slice(split);
const y2024 = loadGameRows('2024-04-01T00:00:00Z', '2024-10-01T00:00:00Z').map(attachMu);
const y2025 = loadGameRows('2025-04-01T00:00:00Z', '2025-10-01T00:00:00Z').map(attachMu);
const y2026 = loadGameRows('2026-04-01T00:00:00Z', '2026-07-23T00:00:00Z').map(attachMu);
console.log({ train: train.length, val: val.length, y2024: y2024.length, y2025: y2025.length, y2026: y2026.length });

console.log('Fitting heads…');
const logMu = fitLogistic(train, xMuHead);
const logDiff = fitLogistic(train, xDiffHead, { epochs: 600, lr: 0.04, l2: 0.04 });
const logMuMkt = fitLogistic(
  train.filter((r) => marketHomeProb(r) != null),
  xMuPlusMkt,
  { epochs: 800, lr: 0.05, l2: 0.02 }
);
const ridgeMargin = fitRidge(
  train,
  xMuHead,
  (r) => r.homeScore - r.awayScore,
  { epochs: 900, lr: 0.025, l2: 0.05 }
);
const ridgeDiff = fitRidge(
  train,
  xDiffHead,
  (r) => r.homeScore - r.awayScore,
  { epochs: 700, lr: 0.02, l2: 0.06 }
);
const cond = fitCondShrink(val);
console.log('condShrink', cond);

// tune blend weight μ vs logistic on val (direction)
function tuneBlend(pFn) {
  let bestW = 0.5;
  let best = -1;
  for (let w = 0; w <= 1.001; w += 0.1) {
    let n = 0;
    let hit = 0;
    for (const row of val) {
      const p = (1 - w) * row.pMuHome + w * pFn(row);
      n += 1;
      if ((p >= 0.5) === row.homeScore > row.awayScore) hit += 1;
    }
    const rate = hit / n;
    if (rate > best) {
      best = rate;
      bestW = w;
    }
  }
  return { w: Number(bestW.toFixed(2)), valDir: Number(best.toFixed(4)) };
}
const blendMuLog = tuneBlend((r) => logMu.predictP(r));
const blendMuDiff = tuneBlend((r) => logDiff.predictP(r));
console.log('blend', { blendMuLog, blendMuDiff });

const variants = [
  {
    id: 'prod_mu_direction',
    pickHome: (r) => r.homeMu >= r.awayMu,
    pHome: (r) => r.pMuHome,
  },
  {
    id: 'market_favorite',
    pickHome: (r) => {
      const p = marketHomeProb(r);
      return p == null ? r.homeMu >= r.awayMu : p >= 0.5;
    },
    pHome: (r) => marketHomeProb(r) ?? r.pMuHome,
  },
  {
    id: 'logistic_mu_head',
    pickHome: (r) => logMu.predictP(r) >= 0.5,
    pHome: (r) => logMu.predictP(r),
  },
  {
    id: 'logistic_feature_diff',
    pickHome: (r) => logDiff.predictP(r) >= 0.5,
    pHome: (r) => logDiff.predictP(r),
  },
  {
    id: 'logistic_mu_plus_market',
    pickHome: (r) => logMuMkt.predictP(r) >= 0.5,
    pHome: (r) => logMuMkt.predictP(r),
  },
  {
    id: 'ridge_margin_mu_head',
    pickHome: (r) => ridgeMargin.predict(r) >= 0,
    pHome: (r) => sigmoid(ridgeMargin.predict(r) / 3),
  },
  {
    id: 'ridge_margin_feature_diff',
    pickHome: (r) => ridgeDiff.predict(r) >= 0,
    pHome: (r) => sigmoid(ridgeDiff.predict(r) / 3),
  },
  {
    id: 'blend_mu_logistic',
    pickHome: (r) =>
      (1 - blendMuLog.w) * r.pMuHome + blendMuLog.w * logMu.predictP(r) >= 0.5,
    pHome: (r) =>
      (1 - blendMuLog.w) * r.pMuHome + blendMuLog.w * logMu.predictP(r),
    meta: blendMuLog,
  },
  {
    id: 'blend_mu_featdiff_log',
    pickHome: (r) =>
      (1 - blendMuDiff.w) * r.pMuHome + blendMuDiff.w * logDiff.predictP(r) >= 0.5,
    pHome: (r) =>
      (1 - blendMuDiff.w) * r.pMuHome + blendMuDiff.w * logDiff.predictP(r),
    meta: blendMuDiff,
  },
  {
    id: 'cond_strong_thin_margin',
    pickHome: (r) => {
      let pickHome = r.homeMu >= r.awayMu;
      if (
        !pickHome &&
        r.homeWinPct >= cond.t &&
        Math.abs(r.muMargin) < cond.m
      ) {
        if (cond.mode === 'force_home') return true;
        const pa = r.awayMu - 0.5 * Math.abs(r.muMargin);
        return r.homeMu >= pa;
      }
      return pickHome;
    },
    pHome: (r) => r.pMuHome,
    meta: cond,
  },
  {
    id: 'agree_mu_logistic_else_market',
    pickHome: (r) => {
      const muHome = r.homeMu >= r.awayMu;
      const logHome = logMu.predictP(r) >= 0.5;
      if (muHome === logHome) return muHome;
      const p = marketHomeProb(r);
      return p == null ? muHome : p >= 0.5;
    },
    pHome: (r) => {
      const muHome = r.homeMu >= r.awayMu;
      const logHome = logMu.predictP(r) >= 0.5;
      if (muHome === logHome) return r.pMuHome;
      return marketHomeProb(r) ?? r.pMuHome;
    },
  },
];

const windows = [
  { key: 'val', rows: val },
  { key: '2024', rows: y2024 },
  { key: '2025', rows: y2025 },
  { key: '2026', rows: y2026 },
];

const results = variants.map((v) => {
  const byWindow = {};
  for (const w of windows) {
    byWindow[w.key] = directionReport(w.rows, v.pickHome, v.pHome);
  }
  return { id: v.id, meta: v.meta || null, byWindow };
});

const base = results.find((r) => r.id === 'prod_mu_direction');
const ranked = results
  .filter((r) => r.id !== 'prod_mu_direction')
  .map((r) => {
    const d26 = r.byWindow['2026'];
    const d24 = r.byWindow['2024'];
    const b26 = base.byWindow['2026'];
    const b24 = base.byWindow['2024'];
    return {
      id: r.id,
      dir2026: d26.directionHitRate,
      deltaDir2026: Number((d26.directionHitRate - b26.directionHitRate).toFixed(4)),
      brier2026: d26.moneylineBrier,
      deltaBrier2026: Number((d26.moneylineBrier - b26.moneylineBrier).toFixed(5)),
      strongAway2026: d26.strongHome.muPicksAwayRate,
      deltaStrongAway2026: Number(
        (
          (d26.strongHome.muPicksAwayRate ?? 0) -
          (b26.strongHome.muPicksAwayRate ?? 0)
        ).toFixed(4)
      ),
      dir2024: d24.directionHitRate,
      deltaDir2024: Number((d24.directionHitRate - b24.directionHitRate).toFixed(4)),
      deltaBrier2024: Number(
        (d24.moneylineBrier - b24.moneylineBrier).toFixed(5)
      ),
      byWindow: r.byWindow,
      meta: r.meta,
    };
  })
  .sort(
    (a, b) =>
      b.deltaDir2026 - a.deltaDir2026 ||
      a.deltaBrier2026 - b.deltaBrier2026 ||
      b.deltaDir2024 - a.deltaDir2024
  );

const pass = ranked.find(
  (r) =>
    r.deltaDir2026 >= 0.008 &&
    r.deltaBrier2026 <= 0.001 &&
    r.deltaDir2024 >= 0 &&
    r.deltaStrongAway2026 <= 0.02
);

const out = {
  experimentId: 'direction-accuracy-round2-2026-08-07',
  plainLanguage:
    'Round2：直接學誰贏／分差（logistic／ridge／混合／條件收縮），看方向準度能否乾淨提升',
  split: { train: train.length, val: val.length },
  baseline: base,
  ranked,
  results,
  recommendation: {
    wireSuggested: false,
    persistModel: false,
    best: ranked[0]?.id || null,
    passGate: pass?.id || null,
    note: pass
      ? `${pass.id}：2026 方向明顯升、Brier 可接受、2024 不降——可列影子 ML 頭，仍不改正式 μ`
      : ranked[0]
        ? `最佳 ${ranked[0].id}（2026 方向Δ ${ranked[0].deltaDir2026}）未過跨年嚴閘；繼續證明直接勝方頭有空間但未穩`
        : '無',
  },
};

fs.writeFileSync(
  new URL('../tmp-direction-accuracy-round2.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\nBASE 2026', base.byWindow['2026']);
console.log('BASE 2024', base.byWindow['2024']);
console.log('\nRANKED:');
for (const r of ranked) {
  console.log(
    `${r.id.padEnd(32)} dir26=${r.dir2026}(Δ${r.deltaDir2026}) brierΔ=${r.deltaBrier2026} strongAwayΔ=${r.deltaStrongAway2026} dir24Δ=${r.deltaDir2024} brier24Δ=${r.deltaBrier2024}`
  );
}
console.log('\nREC', out.recommendation.note);
