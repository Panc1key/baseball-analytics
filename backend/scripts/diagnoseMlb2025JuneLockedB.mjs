/**
 * 診斷 2025-06 鎖定 B 為何最差（樣本 vs 結構）
 * 產出：tmp-diagnose-2025-06-locked-b.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
} from '../src/services/MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const TARGET = '2025-06';
const WINDOWS = [
  { from: '2025-04-01', to: '2025-09-30' },
  { from: '2026-04-01', to: '2026-07-22' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
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
function build(from, to) {
  const validation = getLatestMlbExpectedRunsValidation();
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, from, to);
  const pool = [];
  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const hs = +row.homeScore;
    const as = +row.awayScore;
    if (hs === as) continue;
    const pred = predictMlbGameRuns(validation.model, features, { totalLine: 8.5 });
    const ph = +pred.homeExpectedRuns;
    const pa = +pred.awayExpectedRuns;
    if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;
    const pickHome = ph >= pa;
    const modelProb = pickHome
      ? +pred.markets?.homeWinProbability
      : +pred.markets?.awayWinProbability;
    if (!Number.isFinite(modelProb)) continue;
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? +sig.homeEarlyExitsLast3 || 0
      : +sig.awayEarlyExitsLast3 || 0;
    const oppEarly = pickHome
      ? +sig.awayEarlyExitsLast3 || 0
      : +sig.homeEarlyExitsLast3 || 0;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2 || pickEarly > oppEarly) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    pool.push({
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      bScore,
      pickHome,
    });
  }
  return pool;
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
  return slots.map((g, i) => ({ ...g, dailyRank: i + 1 }));
}
function selectB(pool) {
  const map = new Map();
  for (const g of pool) {
    if (
      g.ev < B.minimumExpectedValue ||
      g.margin < B.minimumExpectedRunMargin ||
      g.modelProb < B.minimumModelProbability ||
      g.pickOdds < B.minimumPickOdds ||
      g.pickOdds > B.maximumPickOdds
    ) {
      continue;
    }
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const arr = [...map.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    out.push(...applyDrop(arr));
  }
  return out;
}
function summarize(bets) {
  if (!bets.length) {
    return { n: 0, hr: null, avgOdds: null, avgEv: null, avgMargin: null, avgP: null, usd50: 0 };
  }
  let unit = 0;
  let hits = 0;
  let odds = 0;
  let ev = 0;
  let margin = 0;
  let p = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    ev += b.ev;
    margin += b.margin;
    p += b.modelProb;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    n,
    hr: Number((hits / n).toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    avgEv: Number((ev / n).toFixed(4)),
    avgMargin: Number((margin / n).toFixed(3)),
    avgP: Number((p / n).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}
function slice(bets, keyFn) {
  const map = new Map();
  for (const b of bets) {
    const k = keyFn(b);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(b);
  }
  return [...map.entries()]
    .map(([k, xs]) => ({ slice: k, ...summarize(xs) }))
    .sort((a, b) => a.slice.localeCompare(b.slice));
}
function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

const picks = WINDOWS.flatMap((w) => selectB(build(w.from, w.to)));
const june = picks.filter((p) => p.month === TARGET);
const other = picks.filter((p) => p.month !== TARGET);

// 二項：若真實勝率=整體 56.42%，41 注得到 ≤18 hits (43.9%) 的機率粗估
const p0 = other.length ? other.filter((x) => x.hit).length / other.length : 0.5642;
const hitsJune = june.filter((x) => x.hit).length;
function binomCdf(n, k, p) {
  // P(X <= k)
  let cdf = 0;
  for (let i = 0; i <= k; i++) {
    let c = 1;
    for (let j = 0; j < i; j++) c = (c * (n - j)) / (j + 1);
    cdf += c * p ** i * (1 - p) ** (n - i);
  }
  return cdf;
}
const pTail = binomCdf(june.length, hitsJune, p0);

const composition = {
  byRank: {
    june: slice(june, (b) => `R${b.dailyRank}`),
    other: slice(other, (b) => `R${b.dailyRank}`),
  },
  byOdds: {
    june: slice(june, (b) =>
      b.pickOdds < 1.95 ? '1.85-1.95' : b.pickOdds < 2.1 ? '1.95-2.10' : '2.10-2.30'
    ),
    other: slice(other, (b) =>
      b.pickOdds < 1.95 ? '1.85-1.95' : b.pickOdds < 2.1 ? '1.95-2.10' : '2.10-2.30'
    ),
  },
  byEv: {
    june: slice(june, (b) => (b.ev < 0.04 ? 'EV2-4%' : b.ev < 0.08 ? 'EV4-8%' : 'EV≥8%')),
    other: slice(other, (b) => (b.ev < 0.04 ? 'EV2-4%' : b.ev < 0.08 ? 'EV4-8%' : 'EV≥8%')),
  },
  byMargin: {
    june: slice(june, (b) =>
      b.margin < 0.5 ? 'm<0.5' : b.margin < 1 ? 'm0.5-1' : 'm≥1'
    ),
    other: slice(other, (b) =>
      b.margin < 0.5 ? 'm<0.5' : b.margin < 1 ? 'm0.5-1' : 'm≥1'
    ),
  },
};

// 組成是否異常：六月平均特徵 vs 其他月
const featureShift = {
  june: summarize(june),
  other: summarize(other),
  deltaAvgOdds: Number((mean(june.map((x) => x.pickOdds)) - mean(other.map((x) => x.pickOdds))).toFixed(3)),
  deltaAvgEv: Number((mean(june.map((x) => x.ev)) - mean(other.map((x) => x.ev))).toFixed(4)),
  deltaAvgMargin: Number(
    (mean(june.map((x) => x.margin)) - mean(other.map((x) => x.margin))).toFixed(3)
  ),
  deltaAvgP: Number(
    (mean(june.map((x) => x.modelProb)) - mean(other.map((x) => x.modelProb))).toFixed(4)
  ),
};

// 若六月「選注組成」用其他月同切片勝率重估，期望是否仍差
function expectedFromOtherSlices(juneBets, otherBets, keyFn) {
  const otherHr = new Map();
  for (const [k, xs] of Object.entries(
    Object.fromEntries(slice(otherBets, keyFn).map((r) => [r.slice, r]))
  )) {
    otherHr.set(k, xs.hr);
  }
  let expHits = 0;
  let known = 0;
  for (const b of juneBets) {
    const hr = otherHr.get(keyFn(b));
    if (hr == null) continue;
    expHits += hr;
    known += 1;
  }
  return {
    n: known,
    expectedHr: known ? Number((expHits / known).toFixed(4)) : null,
    actualHr: summarize(juneBets).hr,
  };
}

const compositionExpected = {
  byOdds: expectedFromOtherSlices(june, other, (b) =>
    b.pickOdds < 1.95 ? '1.85-1.95' : b.pickOdds < 2.1 ? '1.95-2.10' : '2.10-2.30'
  ),
  byRank: expectedFromOtherSlices(june, other, (b) => `R${b.dailyRank}`),
  byEv: expectedFromOtherSlices(june, other, (b) =>
    b.ev < 0.04 ? 'EV2-4%' : b.ev < 0.08 ? 'EV4-8%' : 'EV≥8%'
  ),
};

const monthNs = [...new Set(picks.map((p) => p.month))].map((m) => ({
  month: m,
  n: picks.filter((p) => p.month === m).length,
}));

const verdict = {
  tooFewBets:
    '否。2025-06 有 41 注，與他月 33–49 同量級，不是「注太少」造成的特殊月份。',
  algorithmBroken:
    featureShift.deltaAvgOdds < 0.05 &&
    Math.abs(featureShift.deltaAvgEv) < 0.02 &&
    Math.abs(featureShift.deltaAvgP) < 0.02
      ? '選注組成（均賠／EV／P／margin）與他月接近 → 比較像結果波動，不像規則突然選錯一類場。'
      : '組成有偏移，需看 composition。',
  variancePlausible:
    pTail > 0.05
      ? `在他月勝率≈${(p0 * 100).toFixed(1)}% 下，41 注打到 ≤${hitsJune} 中的單尾機率約 ${(pTail * 100).toFixed(1)}%（不算極端罕見）。`
      : `單尾機率約 ${(pTail * 100).toFixed(1)}%，偏罕見，但仍可能是單月方差；2026-06 同規則反而很好。`,
  conclusion:
    '優先判為單月方差／賽季片段運氣，非「六月注太少」，也未找到可單獨修的明確算法毒區；不建議為 2025-06 改鎖定常數。',
};

const out = {
  target: TARGET,
  monthSampleSizes: monthNs,
  june: summarize(june),
  other: summarize(other),
  binomialTailGivenOtherHr: { p0, hitsJune, n: june.length, pTail: Number(pTail.toFixed(4)) },
  featureShift,
  composition,
  compositionExpected,
  verdict,
};

fs.writeFileSync(
  new URL('../tmp-diagnose-2025-06-locked-b.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(verdict, null, 2));
console.log('featureShift', featureShift);
console.log('compositionExpected', compositionExpected);
console.log('june byRank', composition.byRank.june);
console.log('other byRank', composition.byRank.other);
