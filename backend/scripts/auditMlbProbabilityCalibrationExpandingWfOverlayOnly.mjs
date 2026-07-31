/**
 * 概率校準只用在 Overlay skip/flip 決策（不改 B 選注集合）
 *
 * 做法：
 * - 用 raw P 跑出原始 B（locked B）候選
 * - 在訓練窗內，只對切片（pickAway && homeWinPct>=0.65）做分桶校準，得到 calibrated P
 * - OOS 月份對同一批 rawB bets：
 *     - 如果是 strongAway：
 *         calibrated P >= 0.55 => skip
 *         calibrated P <  0.55 => flip 到主場
 *
 * 目標：隔離「校準影響選注集合」這個干擾源。
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
const STRONG_HOME = 0.65;
const AWAY_PROB_THRESHOLD = 0.55;
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const STAKE_USD = 50;

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

const BUCKETS = [
  { lo: 0.50, hi: 0.53 },
  { lo: 0.53, hi: 0.55 },
  { lo: 0.55, hi: 0.57 },
  { lo: 0.57, hi: 0.60 },
  { lo: 0.60, hi: 1.0 },
];

const PRIOR_ALPHA = 1;
const PRIOR_BETA = 1;

const warmupMonths = 3;

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function ym(iso) {
  return hk(iso).slice(0, 7);
}

function bucketIndex(p) {
  if (!Number.isFinite(p)) return null;
  for (let i = 0; i < BUCKETS.length; i += 1) {
    const b = BUCKETS[i];
    if (p >= b.lo && p < b.hi) return i;
  }
  if (p >= 1.0) return BUCKETS.length - 1;
  return null;
}
function bucketLabel(i) {
  const b = BUCKETS[i];
  return `[${b.lo.toFixed(2)},${b.hi.toFixed(2)})`;
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
  if (!bets.length) return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0 };
  let hits = 0;
  let oddsSum = 0;
  let unit = 0;
  for (const b of bets) {
    oddsSum += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((oddsSum / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * (STAKE_USD / STAKE_USD)), // keep unit->usd50 with stake=50 below
  };
}

function summarizeUsd50(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0 };
  let hits = 0;
  let oddsSum = 0;
  let unit = 0;
  for (const b of bets) {
    oddsSum += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((oddsSum / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}

function applyDrop(sorted) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
  if (slots.length >= 2 && slots[1].pickOdds >= DROP_R2_MIN && slots[1].pickOdds < DROP_R2_MAX) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}

function buildAllCandidates() {
  const validation = getLatestMlbExpectedRunsValidation();
  const candidates = [];
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
      const hs = +row.homeScore;
      const as = +row.awayScore;
      if (hs === as) continue;

      const pred = predictMlbGameRuns(validation.model, features, { totalLine: 8.5 });
      const ph = +pred.homeExpectedRuns;
      const pa = +pred.awayExpectedRuns;
      if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;

      const pickHome = ph >= pa;
      const modelProbRaw = pickHome ? +pred.markets?.homeWinProbability : +pred.markets?.awayWinProbability;
      if (!Number.isFinite(modelProbRaw)) continue;

      const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
      if (bs.length < 2) continue;
      bs.sort((a, b) => a.vig - b.vig);
      const best = bs[0];

      const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
      if (pickOdds < 1.4 || pickOdds > 2.3) continue;

      const evRaw = modelProbRaw * (pickOdds - 1) - (1 - modelProbRaw);
      const margin = Math.abs(ph - pa);

      const sig = buildPregameRegimeSignals(features);
      const pickEarly = pickHome ? +sig.homeEarlyExitsLast3 || 0 : +sig.awayEarlyExitsLast3 || 0;
      const oppEarly = pickHome ? +sig.awayEarlyExitsLast3 || 0 : +sig.homeEarlyExitsLast3 || 0;

      const pitchers = features?.pitchers || {};
      if (
        (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
        (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
      ) {
        continue;
      }
      if (best.homeOdds < 1.2 || best.awayOdds < 1.2 || pickEarly > oppEarly) continue;

      candidates.push({
        gameId: row.gameId,
        day: hk(row.commenceTime),
        month: ym(row.commenceTime),
        window: w.key,

        homeWon: hs > as,
        pickHome,
        modelProbRaw,
        pickOdds,
        homeOdds: best.homeOdds,
        awayOdds: best.awayOdds,
        evRaw,
        margin,
        homeWinPct: +features?.home?.homeWinPct || 0,
      });
    }
  }
  return candidates;
}

function selectBRaw(candidates) {
  const byDay = new Map();
  for (const c of candidates) {
    const modelProb = c.modelProbRaw;
    const ev = c.evRaw;
    if (ev < B.minimumExpectedValue) continue;
    if (c.margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (c.pickOdds < B.minimumPickOdds || c.pickOdds > B.maximumPickOdds) continue;

    const bScore = scoreMlbMoneylineDailyRank({ expectedValue: ev, modelProbability: modelProb }, B);
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day).push({
      ...c,
      modelProb,
      ev,
      bScore,
      hit: c.pickHome ? c.homeWon : !c.homeWon,
    });
  }

  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort((a, b) => b.bScore - a.bScore || b.margin - a.margin);
    const slots = applyDrop(arr);
    slots.forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

function fitCalibrationMap(trainBetsRaw) {
  // 只看你關心的切片：pickAway && homeWinPct>=0.65
  const strongAway = trainBetsRaw.filter((b) => b.pickHome === false && b.homeWinPct >= STRONG_HOME);
  const totalN = strongAway.length;
  const totalHits = strongAway.filter((b) => !b.homeWon).length; // pickAway hit => away wins => !homeWon
  const globalP = (totalHits + PRIOR_ALPHA) / (totalN + PRIOR_ALPHA + PRIOR_BETA);

  const stats = BUCKETS.map(() => ({ n: 0, hits: 0 }));
  for (const b of strongAway) {
    const idx = bucketIndex(b.modelProb);
    if (idx == null) continue;
    stats[idx].n += 1;
    if (!b.homeWon) stats[idx].hits += 1;
  }

  const map = {};
  for (let i = 0; i < BUCKETS.length; i += 1) {
    const { n, hits } = stats[i];
    map[i] = n === 0 ? globalP : (hits + PRIOR_ALPHA) / (n + PRIOR_ALPHA + PRIOR_BETA);
  }

  return { globalP, map, stats };
}

function calibProbFn(calib) {
  return (rawP) => {
    const idx = bucketIndex(rawP);
    return idx == null ? calib.globalP : calib.map[idx];
  };
}

function applyOverlayWithCalibDecisions(betsBSelected, calibFn) {
  const kept = [];
  for (const b of betsBSelected) {
    const isStrongAway = b.pickHome === false && b.homeWinPct >= STRONG_HOME;
    if (!isStrongAway) {
      kept.push({ ...b, pickOdds: b.pickOdds });
      continue;
    }

    const cp = calibFn(b.modelProb);
    if (cp >= AWAY_PROB_THRESHOLD) {
      // skip
      continue;
    }

    // flip to home
    kept.push({
      ...b,
      pickHome: true,
      pickOdds: b.homeOdds,
      hit: b.homeWon,
      flipped: true,
    });
  }
  return kept;
}

const candidates = buildAllCandidates();
const months = [...new Set(candidates.map((x) => x.month))].sort();
const testMonths = months.slice(warmupMonths);

const allRawB = selectBRaw(candidates);
const byMonthRawB = {};
for (const m of testMonths) {
  byMonthRawB[m] = allRawB.filter((b) => b.month === m);
}

const wfRows = [];
let aggRawB = [];
let aggOverlayRaw = [];
let aggOverlayCalib = [];

for (let i = warmupMonths; i < months.length; i += 1) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];

  const trainB = allRawB.filter((b) => trainMonths.has(b.month));
  const testB = byMonthRawB[testMonth];
  if (!trainB.length || !testB.length) continue;

  const calib = fitCalibrationMap(trainB);
  const calibFn = calibProbFn(calib);

  // raw overlay decisions (no calibration)
  const rawOverlay = [];
  for (const b of testB) {
    const isStrongAway = b.pickHome === false && b.homeWinPct >= STRONG_HOME;
    if (!isStrongAway) {
      rawOverlay.push(b);
      continue;
    }
    if (b.modelProb >= AWAY_PROB_THRESHOLD) continue;
    rawOverlay.push({
      ...b,
      pickHome: true,
      pickOdds: b.homeOdds,
      hit: b.homeWon,
      flipped: true,
    });
  }

  const calibOverlay = applyOverlayWithCalibDecisions(testB, calibFn);

  const baseStats = summarizeUsd50(testB);
  const rawOverlayStats = summarizeUsd50(rawOverlay);
  const calibOverlayStats = summarizeUsd50(calibOverlay);

  wfRows.push({
    month: testMonth,
    calib: {
      globalP: Number(calib.globalP.toFixed(4)),
      buckets: BUCKETS.map((_, idx) => ({
        label: bucketLabel(idx),
        n: calib.stats[idx].n,
        hits: calib.stats[idx].hits,
        p: Number(calib.map[idx].toFixed(4)),
      })),
    },
    rawB: baseStats,
    rawOverlay: rawOverlayStats,
    calibOverlay: calibOverlayStats,
    deltaOverlayUsd50: calibOverlayStats.usd50 - rawOverlayStats.usd50,
  });

  aggRawB = aggRawB.concat(testB);
  aggOverlayRaw = aggOverlayRaw.concat(rawOverlay);
  aggOverlayCalib = aggOverlayCalib.concat(calibOverlay);
}

const out = {
  experimentId: 'mlb-prob-calibration-overlay-only-expanding-wf-2026-07-29',
  rule: {
    strongHome: STRONG_HOME,
    awayProbThreshold: AWAY_PROB_THRESHOLD,
    action: 'skip if cp>=thr else flip to home',
    calibrationSlice: 'pickAway && homeWinPct>=0.65',
    buckets: BUCKETS.map((b, idx) => ({ idx, label: bucketLabel(idx), lo: b.lo, hi: b.hi })),
    prior: { alpha: PRIOR_ALPHA, beta: PRIOR_BETA },
  },
  aggregate: {
    rawB: summarizeUsd50(aggRawB),
    rawOverlay: summarizeUsd50(aggOverlayRaw),
    calibOverlay: summarizeUsd50(aggOverlayCalib),
    deltaCalibVsRawOverlay: summarizeUsd50(aggOverlayCalib).usd50 - summarizeUsd50(aggOverlayRaw).usd50,
  },
  wfRows,
};

fs.writeFileSync(new URL('../tmp-mlb-prob-calibration-overlay-only-expanding-wf.json', import.meta.url), JSON.stringify(out, null, 2));

console.log('AGG rawB', out.aggregate.rawB);
console.log('AGG rawOverlay', out.aggregate.rawOverlay);
console.log('AGG calibOverlay', out.aggregate.calibOverlay);
console.log('DELTA calib - rawOverlay usd50', out.aggregate.deltaCalibVsRawOverlay);

