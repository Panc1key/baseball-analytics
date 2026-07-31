/**
 * 診斷：鎖定 B「主選」低估是否主要由「強主場」解釋？
 *
 * 只影子、不改正式。
 * 1) 主選按 homeWinPct 分桶：P vs 命中、EV/margin/odds
 * 2) 僅對「主選 × 強主場」做 P×1.03 / 1.05 影子重選，雙窗 @$50
 *
 * 用法: node scripts/auditMlbHomePickStrongHomeDiag.mjs
 * 產物: tmp-home-pick-strong-home-diag.json
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
const outPath = path.join(__dirname, '../tmp-home-pick-strong-home-diag.json');

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
/** 強主場門檻（與毒縮切片一致） */
const STRONG_HOME = 0.65;
const UPLIFTS = [1.03, 1.05];

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

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0 };
  }
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
  const edges = {};
  for (let b = 1; b <= N_BUCKETS; b += 1) {
    const g = ranges[b].sort((a, c) => a - c);
    edges[b] = g.length
      ? {
          min: Number(g[0].toFixed(4)),
          max: Number(g[g.length - 1].toFixed(4)),
          n: g.length,
        }
      : null;
  }
  return { rows: out, edges };
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function calibAndDist(bets) {
  if (!bets.length) {
    return {
      n: 0,
      modelPMean: null,
      actualHitRate: null,
      calibrationError: null,
      avgEv: null,
      avgMargin: null,
      avgOdds: null,
      money: summarize([]),
    };
  }
  let p = 0;
  let y = 0;
  for (const b of bets) {
    p += b.modelProb;
    y += b.hit ? 1 : 0;
  }
  const n = bets.length;
  const modelPMean = p / n;
  const actualHitRate = y / n;
  return {
    n,
    modelPMean: Number(modelPMean.toFixed(4)),
    actualHitRate: Number(actualHitRate.toFixed(4)),
    calibrationError: Number((actualHitRate - modelPMean).toFixed(4)),
    avgEv: Number(mean(bets.map((b) => b.ev)).toFixed(4)),
    avgMargin: Number(mean(bets.map((b) => b.margin)).toFixed(4)),
    avgOdds: Number(mean(bets.map((b) => b.pickOdds)).toFixed(3)),
    money: summarize(bets),
  };
}

/**
 * 從候選池產出鎖定 B 選注。
 * upliftCfg: { homeStrongMult } 僅對「會選主且 homeWinPct≥STRONG」的模型P乘上調後再算 EV／排序
 */
function selectLockedB(pool, { homeStrongMult = 1 } = {}) {
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
    const upliftApplied =
      pickHome && (g.homeWinPct ?? 0) >= STRONG_HOME && homeStrongMult !== 1;
    if (upliftApplied) {
      modelProb = Math.min(0.95, modelProb * homeStrongMult);
    }
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
      homeWinPct: g.homeWinPct,
      strongHome: (g.homeWinPct ?? 0) >= STRONG_HOME,
      upliftApplied,
      ev,
      margin,
      bScore,
      hit: pickHome ? g.homeWon : !g.homeWon,
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

function packByWindow(bets, baselineByWindow) {
  const byWindow = {};
  for (const w of WINDOWS) {
    const s = summarize(bets.filter((b) => b.window === w.key));
    const base = baselineByWindow[w.key];
    byWindow[w.key] = {
      ...s,
      deltaUsdVsBaseline: base ? s.usd50 - base.usd50 : null,
    };
  }
  const overall = summarize(bets);
  const baseAll = baselineByWindow.__merged;
  return {
    overall: {
      ...overall,
      deltaUsdVsBaseline: baseAll ? overall.usd50 - baseAll.usd50 : null,
    },
    byWindow,
    gate: {
      mergedGt: baseAll != null && overall.usd50 > baseAll.usd50,
      y2025Ge: baselineByWindow['2025'] != null &&
        byWindow['2025'].usd50 >= baselineByWindow['2025'].usd50,
      y2026Ge: baselineByWindow['2026'] != null &&
        byWindow['2026'].usd50 >= baselineByWindow['2026'].usd50,
    },
  };
}

const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) throw new Error('missing_formal_v45_model');

const pool = [];
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
    const hs = +row.homeScore;
    const as = +row.awayScore;
    if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) continue;
    const homeWinPct = finite(features?.home?.homeWinPct);
    if (homeWinPct == null) continue;

    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) continue;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }

    const base = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const lockedPred = applyFrozenResidualToPrediction(
      model,
      base,
      homeWinPct - 0.5
    );
    const sig = buildPregameRegimeSignals(features);
    pool.push({
      gameId: row.gameId,
      window: w.key,
      day: hk(row.commenceTime),
      homeWon: hs > as,
      homeWinPct,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      homeEarly: +sig.homeEarlyExitsLast3 || 0,
      awayEarly: +sig.awayEarlyExitsLast3 || 0,
      lockedPred,
    });
  }
}

const baselineBets = selectLockedB(pool, { homeStrongMult: 1 });
const homePicks = baselineBets.filter((b) => b.pickHome);
const awayPicks = baselineBets.filter((b) => !b.pickHome);

const baselineByWindow = {
  '2025': summarize(baselineBets.filter((b) => b.window === '2025')),
  '2026': summarize(baselineBets.filter((b) => b.window === '2026')),
  __merged: summarize(baselineBets),
};

// 主選按 homeWinPct 五分位
const { rows: homeBucketed, edges } = assignQuintiles(homePicks, 'homeWinPct');
const labels = {
  1: '主選×主場最弱',
  2: '主選×主場偏弱',
  3: '主選×主場中等',
  4: '主選×主場偏強',
  5: '主選×主場最強',
};
const byHomeWinPctBucket = {};
for (let b = 1; b <= N_BUCKETS; b += 1) {
  byHomeWinPctBucket[b] = {
    label: labels[b],
    homeWinPctRange: edges[b],
    ...calibAndDist(homeBucketed.filter((x) => x.bucket === b)),
  };
}

const homeStrong = homePicks.filter((b) => b.strongHome);
const homeNotStrong = homePicks.filter((b) => !b.strongHome);

const homePickSlices = {
  allHomePicks: calibAndDist(homePicks),
  homeStrong_ge65: calibAndDist(homeStrong),
  homeNotStrong_lt65: calibAndDist(homeNotStrong),
  byQuintile: byHomeWinPctBucket,
  shareOfHomeUnderestimation: (() => {
    // 用「實際命中−模型P」加權：強主場主選對總「低估量」的貢獻
    const totalGap = homePicks.reduce(
      (s, b) => s + ((b.hit ? 1 : 0) - b.modelProb),
      0
    );
    const strongGap = homeStrong.reduce(
      (s, b) => s + ((b.hit ? 1 : 0) - b.modelProb),
      0
    );
    return {
      homePicksN: homePicks.length,
      strongN: homeStrong.length,
      strongShareOfPicks: homePicks.length
        ? Number((homeStrong.length / homePicks.length).toFixed(4))
        : null,
      totalHitMinusPSum: Number(totalGap.toFixed(4)),
      strongHitMinusPSum: Number(strongGap.toFixed(4)),
      strongShareOfGap:
        totalGap !== 0 ? Number((strongGap / totalGap).toFixed(4)) : null,
    };
  })(),
};

// 影子上調
const shadowUplifts = {};
for (const mult of UPLIFTS) {
  const bets = selectLockedB(pool, { homeStrongMult: mult });
  const pack = packByWindow(bets, baselineByWindow);
  const home = bets.filter((b) => b.pickHome);
  const away = bets.filter((b) => !b.pickHome);
  const uplifted = bets.filter((b) => b.upliftApplied);
  shadowUplifts[`x${mult}`] = {
    mult,
    ...pack,
    composition: {
      homePicks: home.length,
      awayPicks: away.length,
      upliftAppliedPicks: uplifted.length,
      homeStrongPicks: home.filter((b) => b.strongHome).length,
    },
    homePicksMoney: summarize(home),
    awayPicksMoney: summarize(away),
    upliftedPicksMoney: summarize(uplifted),
    homeStrongCalib: calibAndDist(home.filter((b) => b.strongHome)),
  };
}

function interpret() {
  const q = byHomeWinPctBucket;
  const errs = [1, 2, 3, 4, 5].map((b) => q[b].calibrationError);
  const strong = homePickSlices.homeStrong_ge65;
  const weak = homePickSlices.homeNotStrong_lt65;
  const share = homePickSlices.shareOfUnderestimation ||
    homePickSlices.shareOfHomeUnderestimation;
  const strongExplainsMost =
    share?.strongShareOfGap != null && share.strongShareOfGap >= 0.55;
  const strongHasBigError =
    strong.calibrationError != null && strong.calibrationError >= 0.05;
  const weakSmallError =
    weak.calibrationError == null || Math.abs(weak.calibrationError) < 0.04;
  const quintileConcentratedHigh =
    (errs[3] ?? 0) > 0.05 || (errs[4] ?? 0) > 0.05;
  const quintileLowOk =
    Math.abs(errs[0] ?? 0) < 0.05 && Math.abs(errs[1] ?? 0) < 0.06;

  const bestShadow = Object.values(shadowUplifts).sort(
    (a, b) => (b.overall.deltaUsdVsBaseline ?? -1e9) -
      (a.overall.deltaUsdVsBaseline ?? -1e9)
  )[0];
  const shadowHelps = bestShadow?.gate?.mergedGt &&
    bestShadow?.gate?.y2025Ge &&
    bestShadow?.gate?.y2026Ge;

  let verdict;
  if (strongExplainsMost && strongHasBigError && weakSmallError) {
    verdict =
      '主選低估大部分可由「強主場」解釋；條件校准方向成立，但需影子雙窗過閘才討論接入。';
  } else if (strongHasBigError && !strongExplainsMost) {
    verdict =
      '強主場主選確有低估，但佔主選總低估份額不足；主選低估仍有其他來源，不宜只盯強主場校准。';
  } else if (!strongHasBigError && homePickSlices.allHomePicks.calibrationError > 0.04) {
    verdict =
      '主選整體低估存在，但不集中在強主場（homeWinPct≥65%）；換其他結構解釋。';
  } else {
    verdict =
      '「主選×強主場」無法乾淨解釋主選低估；暫不建議條件校准，換方向。';
  }

  return {
    verdict,
    flags: {
      strongExplainsMost,
      strongHasBigError,
      weakSmallError,
      quintileConcentratedHigh,
      quintileLowOk,
      strongShareOfGap: share?.strongShareOfGap ?? null,
      bestShadowMult: bestShadow?.mult ?? null,
      bestShadowDeltaUsd: bestShadow?.overall?.deltaUsdVsBaseline ?? null,
      shadowDualWindowPass: Boolean(shadowHelps),
    },
  };
}

const interpretation = interpret();

const report = {
  generatedAt: new Date().toISOString(),
  modelVersion: validation.modelVersion,
  note:
    '只影子診斷；正式鎖定B／shrink 未改。強主場=homeWinPct≥0.65。上調僅作用於主選且強主場的模型P（縮後）。',
  sample: {
    pool: pool.length,
    lockedBets: baselineBets.length,
    homePicks: homePicks.length,
    awayPicks: awayPicks.length,
    homeStrongPicks: homeStrong.length,
    windows: WINDOWS,
    strongHomeThreshold: STRONG_HOME,
  },
  baselineMoney: {
    overall: baselineByWindow.__merged,
    byWindow: {
      '2025': baselineByWindow['2025'],
      '2026': baselineByWindow['2026'],
    },
    homePicks: summarize(homePicks),
    awayPicks: summarize(awayPicks),
  },
  homePickSlices,
  shadowUplifts,
  interpretation,
};

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log('=== Home-pick × strong-home diagnostic ===');
console.log('locked B:', baselineBets.length, 'home:', homePicks.length, 'strong home picks:', homeStrong.length);
console.log('--- home picks by homeWinPct quintile ---');
for (let b = 1; b <= N_BUCKETS; b += 1) {
  const x = byHomeWinPctBucket[b];
  console.log(
    `${b} ${x.label} | n=${x.n} P=${x.modelPMean} act=${x.actualHitRate} err=${x.calibrationError} EV=${x.avgEv} margin=${x.avgMargin} odds=${x.avgOdds} $=${x.money.usd50}`
  );
}
console.log('strong≥65:', homePickSlices.homeStrong_ge65);
console.log('not strong:', homePickSlices.homeNotStrong_lt65);
console.log('gap share:', homePickSlices.shareOfHomeUnderestimation);
console.log('--- shadow uplifts ---');
for (const [k, v] of Object.entries(shadowUplifts)) {
  console.log(k, {
    overall: v.overall,
    byWindow: v.byWindow,
    gate: v.gate,
    uplifted: v.composition.upliftAppliedPicks,
  });
}
console.log('VERDICT:', interpretation.verdict);
console.log('flags:', interpretation.flags);
console.log('wrote', outPath);
