/**
 * 診斷：模型「低估主勝」是純主場效應，還是與選邊／主場強度交互？
 *
 * 只診斷、不改模型、不改選注。
 *
 * 切片：
 * A) 全場：按主隊賽季主場勝率（homeWinPct）五分位 → 模型主勝P vs 實際
 * B) 鎖定 B 已選注：主選 vs 客選 → 模型P vs 實際命中；並交叉賠率帶
 *
 * 用法: node scripts/auditMlbHomeUnderestimationDiag.mjs
 * 產物: tmp-home-underestimation-diag.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
} from '../src/services/MlbExpectedRunsModel.js';
import {
  applyFrozenResidualToPrediction,
  applyFrozenToxicShrink,
  MLB_FROZEN_B_SHADOW_SPEC,
} from '../src/services/MlbFrozenBShadow.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, '../tmp-home-underestimation-diag.json');

const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

const B = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: MLB_FROZEN_B_SHADOW_SPEC.selection.minimumH2hBookmakers,
};
const DROP_R3 = MLB_FROZEN_B_SHADOW_SPEC.selection.dropThirdIfMarginBelow;
const DROP_R2_MAX = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsBelow;
const DROP_R2_MIN = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsMin;
const STAKE = 50;
const N_BUCKETS = 5;

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function finite(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function books(g, c, h, a) {
  const pit = resolvePitOdds(g, c);
  if (!pit?.bookmakers?.length) return [];
  const out = [];
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const home =
      m.outcomes.find((o) => o.name === h) ||
      m.outcomes.find((o) => String(o.name).includes(String(h).split(' ').pop()));
    const away =
      m.outcomes.find((o) => o.name === a) ||
      m.outcomes.find((o) => String(o.name).includes(String(a).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const ho = +home.price;
    const ao = +away.price;
    if (!Number.isFinite(ho) || !Number.isFinite(ao)) continue;
    out.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao });
  }
  return out;
}

function summarizeUnits(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0 };
  let hits = 0;
  let unit = 0;
  let odds = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
  };
}

function applyDrop(sorted) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
  if (
    slots.length >= 2 &&
    slots[1].pickOdds >= DROP_R2_MIN &&
    slots[1].pickOdds < DROP_R2_MAX
  ) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}

function assignQuintiles(rows, valueKey) {
  const indexed = rows
    .map((r, i) => ({ i, v: r[valueKey] }))
    .sort((a, b) => a.v - b.v || a.i - b.i);
  const n = indexed.length;
  const bucketOfIndex = new Array(n);
  for (let rank = 0; rank < n; rank += 1) {
    bucketOfIndex[indexed[rank].i] = Math.min(
      N_BUCKETS,
      Math.floor((rank * N_BUCKETS) / n) + 1
    );
  }
  const ranges = {};
  for (let b = 1; b <= N_BUCKETS; b += 1) ranges[b] = [];
  const out = rows.map((r, i) => {
    const bucket = bucketOfIndex[i];
    ranges[bucket].push(r[valueKey]);
    return { ...r, bucket };
  });
  const gapEdges = {};
  for (let b = 1; b <= N_BUCKETS; b += 1) {
    const g = ranges[b].sort((a, c) => a - c);
    gapEdges[b] = g.length
      ? {
          min: Number(g[0].toFixed(4)),
          max: Number(g[g.length - 1].toFixed(4)),
          n: g.length,
        }
      : null;
  }
  return { rows: out, edges: gapEdges };
}

function calibHome(rows) {
  if (!rows.length) {
    return {
      n: 0,
      modelPHomeMean: null,
      actualHomeWinRate: null,
      calibrationError: null,
      homeWinPctMean: null,
    };
  }
  let p = 0;
  let y = 0;
  let hw = 0;
  for (const r of rows) {
    p += r.modelPHome;
    y += r.homeWon ? 1 : 0;
    hw += r.homeWinPct;
  }
  const n = rows.length;
  const modelPHomeMean = p / n;
  const actualHomeWinRate = y / n;
  return {
    n,
    modelPHomeMean: Number(modelPHomeMean.toFixed(4)),
    actualHomeWinRate: Number(actualHomeWinRate.toFixed(4)),
    calibrationError: Number((actualHomeWinRate - modelPHomeMean).toFixed(4)),
    homeWinPctMean: Number((hw / n).toFixed(4)),
  };
}

/** 對「選邊機率」校準：模型給選邊的 P vs 是否命中 */
function calibPick(rows) {
  if (!rows.length) {
    return {
      n: 0,
      modelPPickMean: null,
      actualHitRate: null,
      calibrationError: null,
      avgOdds: null,
      usd50: 0,
      roi: null,
    };
  }
  let p = 0;
  let y = 0;
  let odds = 0;
  let unit = 0;
  for (const r of rows) {
    p += r.modelProb;
    y += r.hit ? 1 : 0;
    odds += r.pickOdds;
    unit += r.hit ? r.pickOdds - 1 : -1;
  }
  const n = rows.length;
  const modelPPickMean = p / n;
  const actualHitRate = y / n;
  return {
    n,
    modelPPickMean: Number(modelPPickMean.toFixed(4)),
    actualHitRate: Number(actualHitRate.toFixed(4)),
    calibrationError: Number((actualHitRate - modelPPickMean).toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
  };
}

function oddsBand(odds) {
  if (odds < 1.85) return '<1.85';
  if (odds < 2.0) return '1.85-2.00';
  if (odds < 2.15) return '2.00-2.15';
  return '2.15-2.30';
}

function selectLockedB(pool) {
  const byDay = new Map();
  for (const g of pool) {
    const pred = g.lockedPred;
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? g.homeOdds : g.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    if ((pickHome ? g.homeEarly : g.awayEarly) > (pickHome ? g.awayEarly : g.homeEarly)) {
      continue;
    }
    modelProb = applyFrozenToxicShrink(modelProb, pickOdds, {
      pickHome,
      homeWinPct: g.homeWinPct,
    });
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue) continue;
    if (margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (pickOdds < B.minimumPickOdds || pickOdds > B.maximumPickOdds) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({
      gameId: g.gameId,
      day: g.day,
      window: g.window,
      pickHome,
      pickOdds,
      modelProb,
      modelPHome: +pred.markets.homeWinProbability,
      homeWinPct: g.homeWinPct,
      ev,
      margin,
      bScore,
      hit: pickHome ? g.homeWon : !g.homeWon,
      homeWon: g.homeWon,
      oddsBand: oddsBand(pickOdds),
    });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    applyDrop(arr).forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) throw new Error('missing_formal_v45_model');

const games = [];
for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);

  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    features.gameId = row.gameId;
    features.commenceTime = row.commenceTime;
    features.homeTeam = row.homeTeam;
    features.awayTeam = row.awayTeam;
    const hs = +row.homeScore;
    const as = +row.awayScore;
    if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) continue;
    const homeWinPct = finite(features?.home?.homeWinPct);
    if (homeWinPct == null) continue;

    const base = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const lockedPred = applyFrozenResidualToPrediction(
      model,
      base,
      homeWinPct - 0.5
    );

    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    let homeOdds = null;
    let awayOdds = null;
    if (bs.length >= 2) {
      bs.sort((a, b) => a.vig - b.vig);
      homeOdds = bs[0].homeOdds;
      awayOdds = bs[0].awayOdds;
    }
    const sig = buildPregameRegimeSignals(features);
    const pitchers = features?.pitchers || {};

    games.push({
      gameId: row.gameId,
      window: w.key,
      day: hk(row.commenceTime),
      homeWon: hs > as,
      homeWinPct,
      modelPHome: +lockedPred.markets.homeWinProbability,
      modelPHomeRaw: +base.markets.homeWinProbability,
      homeOdds,
      awayOdds,
      homeEarly: +sig.homeEarlyExitsLast3 || 0,
      awayEarly: +sig.awayEarlyExitsLast3 || 0,
      lockedPred,
      hasBooks:
        homeOdds != null &&
        awayOdds != null &&
        homeOdds >= 1.2 &&
        awayOdds >= 1.2 &&
        (pitchers.homeIdentity?.id ?? pitchers.home?.id) != null &&
        (pitchers.awayIdentity?.id ?? pitchers.away?.id) != null,
    });
  }
}

// A) 按主場勝率分桶
const { rows: homePctRows, edges: homePctEdges } = assignQuintiles(
  games,
  'homeWinPct'
);
const homePctLabels = {
  1: '主場最弱',
  2: '主場偏弱',
  3: '主場中等',
  4: '主場偏強',
  5: '主場最強',
};
const byHomeWinPctBucket = {};
for (let b = 1; b <= N_BUCKETS; b += 1) {
  const subset = homePctRows.filter((r) => r.bucket === b);
  byHomeWinPctBucket[b] = {
    label: homePctLabels[b],
    homeWinPctRange: homePctEdges[b],
    overall: calibHome(subset),
    byWindow: Object.fromEntries(
      WINDOWS.map((w) => [
        w.key,
        calibHome(subset.filter((r) => r.window === w.key)),
      ])
    ),
  };
}

// B) 鎖定 B 主選 vs 客選
const lockPool = games.filter((g) => g.hasBooks);
const lockedBets = selectLockedB(lockPool);
const homePicks = lockedBets.filter((b) => b.pickHome);
const awayPicks = lockedBets.filter((b) => !b.pickHome);

const lockedSide = {
  all: calibPick(lockedBets),
  homePicks: calibPick(homePicks),
  awayPicks: calibPick(awayPicks),
  homePicksByOddsBand: Object.fromEntries(
    ['<1.85', '1.85-2.00', '2.00-2.15', '2.15-2.30'].map((band) => [
      band,
      calibPick(homePicks.filter((b) => b.oddsBand === band)),
    ])
  ),
  awayPicksByOddsBand: Object.fromEntries(
    ['<1.85', '1.85-2.00', '2.00-2.15', '2.15-2.30'].map((band) => [
      band,
      calibPick(awayPicks.filter((b) => b.oddsBand === band)),
    ])
  ),
  byWindow: {
    home: Object.fromEntries(
      WINDOWS.map((w) => [
        w.key,
        calibPick(homePicks.filter((b) => b.window === w.key)),
      ])
    ),
    away: Object.fromEntries(
      WINDOWS.map((w) => [
        w.key,
        calibPick(awayPicks.filter((b) => b.window === w.key)),
      ])
    ),
  },
  // 客選且強主場（與毒縮切片對齊）
  toxicAwayStrongHome: calibPick(
    awayPicks.filter((b) => (b.homeWinPct ?? 0) >= 0.65)
  ),
  awayNotToxic: calibPick(
    awayPicks.filter((b) => (b.homeWinPct ?? 0) < 0.65)
  ),
};

// 全場基礎：不經選注過濾的整體主勝校準
const overallHomeCalib = calibHome(games);
const overallHomeCalibRaw = (() => {
  if (!games.length) return null;
  let p = 0;
  let y = 0;
  for (const r of games) {
    p += r.modelPHomeRaw;
    y += r.homeWon ? 1 : 0;
  }
  const n = games.length;
  return {
    n,
    modelPHomeMean: Number((p / n).toFixed(4)),
    actualHomeWinRate: Number((y / n).toFixed(4)),
    calibrationError: Number((y / n - p / n).toFixed(4)),
  };
})();

function interpret() {
  const errs = [1, 2, 3, 4, 5].map(
    (b) => byHomeWinPctBucket[b].overall.calibrationError
  );
  const allPositive = errs.every((e) => e != null && e > 0.01);
  const spreadsWithStrength =
    errs[4] != null &&
    errs[0] != null &&
    errs[4] - errs[0] > 0.03;
  const shrinksWithStrength =
    errs[0] != null &&
    errs[4] != null &&
    errs[0] - errs[4] > 0.03;
  const homeErr = lockedSide.homePicks.calibrationError;
  const awayErr = lockedSide.awayPicks.calibrationError;
  const homeUnderOnHomePicks = homeErr != null && homeErr > 0.03;
  const awayOverOnAwayPicks = awayErr != null && awayErr < -0.03;
  const awayUnderOnAwayPicks = awayErr != null && awayErr > 0.03;

  let verdict;
  if (
    allPositive &&
    !spreadsWithStrength &&
    !shrinksWithStrength &&
    homeUnderOnHomePicks &&
    Math.abs(awayErr || 0) < 0.03
  ) {
    verdict =
      '較像乾淨的主場基礎低估：各主場強度桶誤差同向，鎖定B主選實際命中明顯高於模型P，客選無對稱大偏差。可討論很輕的主勝校准（需小心與 shrink 疊加）。';
  } else if (allPositive && homeUnderOnHomePicks && awayOverOnAwayPicks) {
    verdict =
      '主選低估＋客選高估並存：不只是主場基礎偏移，選邊／客隊身份有交互；不宜直接全局上調主勝P。';
  } else if (spreadsWithStrength) {
    verdict =
      '主場低估隨主場強度升高而加重：偏「強主場吃不夠」的交互，不是均勻主場常數。';
  } else if (shrinksWithStrength) {
    verdict =
      '弱主場桶誤差更大：偏與弱主／先發或其他切片交互，不是單純全局主場常數。';
  } else if (homeUnderOnHomePicks && awayUnderOnAwayPicks) {
    verdict =
      '主選與客選都出現「實際>模型P」：更像整體機率偏保守（溫度／尖度），不純是主場效應。';
  } else {
    verdict =
      '主場低估存在，但與主場強度／選邊的交互型態不乾淨；暫不建議直接做全局主勝輕校准。';
  }

  return {
    verdict,
    flags: {
      allPositiveHomeBucketErrors: allPositive,
      errorGrowsWithHomeStrength: spreadsWithStrength,
      errorShrinksWithHomeStrength: shrinksWithStrength,
      homePicksUnderconfident: homeUnderOnHomePicks,
      awayPicksOverconfident: awayOverOnAwayPicks,
      awayPicksUnderconfident: awayUnderOnAwayPicks,
      homePickError: homeErr,
      awayPickError: awayErr,
      bucketErrors: errs,
    },
  };
}

const interpretation = interpret();

const report = {
  generatedAt: new Date().toISOString(),
  modelVersion: validation.modelVersion,
  note: '只診斷；不改模型、不改選注。modelP 含鎖定B殘差；選注P含毒縮。',
  sample: {
    games: games.length,
    lockedPool: lockPool.length,
    lockedBets: lockedBets.length,
    homePicks: homePicks.length,
    awayPicks: awayPicks.length,
    windows: WINDOWS,
  },
  overallHomeCalibration: {
    withLockedResidual: overallHomeCalib,
    rawV45NoResidual: overallHomeCalibRaw,
  },
  sliceA_homeWinPctBuckets: byHomeWinPctBucket,
  sliceB_lockedB_homeVsAway: lockedSide,
  lockedBMoney: {
    home: summarizeUnits(homePicks),
    away: summarizeUnits(awayPicks),
  },
  interpretation,
};

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log('=== Home underestimation diagnostic ===');
console.log('overall home calib (residual):', overallHomeCalib);
console.log('overall home calib (raw):', overallHomeCalibRaw);
console.log('--- A) by homeWinPct bucket ---');
for (let b = 1; b <= N_BUCKETS; b += 1) {
  const x = byHomeWinPctBucket[b].overall;
  console.log(
    `${b} ${homePctLabels[b]} | n=${x.n} hw%=${x.homeWinPctMean} P=${x.modelPHomeMean} act=${x.actualHomeWinRate} err=${x.calibrationError}`
  );
}
console.log('--- B) locked B home vs away picks ---');
console.log('homePicks', lockedSide.homePicks);
console.log('awayPicks', lockedSide.awayPicks);
console.log('toxicAway', lockedSide.toxicAwayStrongHome);
console.log('awayNotToxic', lockedSide.awayNotToxic);
console.log('home by odds', lockedSide.homePicksByOddsBand);
console.log('away by odds', lockedSide.awayPicksByOddsBand);
console.log('VERDICT:', interpretation.verdict);
console.log('wrote', outPath);
