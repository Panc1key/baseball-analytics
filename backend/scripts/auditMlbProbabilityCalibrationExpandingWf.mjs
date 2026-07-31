/**
 * 概率校準（分桶） + Expanding WF
 *
 * 做法：
 * 1) 針對切片：pickAway（即 pickHome=false）且主隊 homeWinPct>=0.65
 *    在訓練窗內，使用分桶統計實際命中率，得到 calibrated P
 * 2) OOS 月份重新算 EV（用 calibrated P）-> 再跑鎖定 B（不改閘值常數）
 * 3) 同時疊你的 flip/skip 規則，對比：
 *    - raw：原始 P
 *    - calib：校準後 P
 *
 * 用法：node scripts/auditMlbProbabilityCalibrationExpandingWf.mjs
 * 產物：tmp-mlb-prob-calibration-expanding-wf.json
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

// 分桶：與你之前診斷一致附近範圍
const BUCKETS = [
  { lo: 0.50, hi: 0.53 },
  { lo: 0.53, hi: 0.55 },
  { lo: 0.55, hi: 0.57 },
  { lo: 0.57, hi: 0.60 },
  { lo: 0.60, hi: 1.0 },
];

// Beta(1,1) 平滑，避免小樣本桶亂跳
const PRIOR_ALPHA = 1;
const PRIOR_BETA = 1;

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
  // p==1.0 edge-case
  if (p >= 1.0) return BUCKETS.length - 1;
  return null;
}

function bucketLabel(i) {
  const b = BUCKETS[i];
  const lo = b.lo.toFixed(2);
  const hi = b.hi.toFixed(2);
  return `[${lo},${hi})`;
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
  let unit = 0;
  let oddsSum = 0;
  for (const b of bets) {
    oddsSum += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else {
      unit -= 1;
    }
  }
  const n = bets.length;
  const avgOdds = oddsSum / n;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number(avgOdds.toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE_USD),
  };
}

function scoreDailyRank(ev, modelProb) {
  return scoreMlbMoneylineDailyRank({ expectedValue: ev, modelProbability: modelProb }, B);
}

function applyDrop(sorted) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
  if (slots.length >= 2 && slots[1].pickOdds >= DROP_R2_MIN && slots[1].pickOdds < DROP_R2_MAX) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}

/**
 * 預處理候選集：跨所有月份算出 raw P、odds、特徵 margin、hit outcome 等
 * 避免 Expanding 反覆 predictMlbGameRuns
 */
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

      const evRaw = modelProb * (pickOdds - 1) - (1 - modelProb);
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

        // outcome
        homeWon: hs > as,

        // pick definition
        pickHome,
        modelProbRaw: modelProb,
        pickOdds,
        homeOdds: best.homeOdds,
        awayOdds: best.awayOdds,
        evRaw,
        margin,
        homeWinPct: +features?.home?.homeWinPct || null,
      });
    }
  }
  return candidates;
}

function selectB(candidates, calibFn) {
  const byDay = new Map();

  for (const c of candidates) {
    const isStrongAway = c.pickHome === false && (c.homeWinPct ?? 0) >= STRONG_HOME;

    const modelProb = isStrongAway ? calibFn(c.modelProbRaw, c) : c.modelProbRaw;
    if (!Number.isFinite(modelProb)) continue;

    const ev = modelProb * (c.pickOdds - 1) - (1 - modelProb);

    if (ev < B.minimumExpectedValue) continue;
    if (c.margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (c.pickOdds < B.minimumPickOdds || c.pickOdds > B.maximumPickOdds) continue;

    const bScore = scoreDailyRank(ev, modelProb);
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day).push({
      ...c,
      ev,
      modelProb,
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

function applyOverlayFlipSkip(bets) {
  const kept = [];
  for (const b of bets) {
    const isStrongAway = b.pickHome === false && (b.homeWinPct ?? 0) >= STRONG_HOME;
    if (!isStrongAway) {
      kept.push({ ...b, pickOdds: b.pickOdds, hit: b.hit });
      continue;
    }

    // 只針對客勝切片動作
    if (b.modelProb >= AWAY_PROB_THRESHOLD) {
      // modelProb 高 -> 你原規則：不下
      continue;
    }

    // modelProb 低 -> 反手主場
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

function fitCalibrationMap(trainCandidates) {
  const strongAway = trainCandidates.filter(
    (c) => c.pickHome === false && (c.homeWinPct ?? 0) >= STRONG_HOME
  );
  const total = strongAway.length;
  const totalHits = strongAway.filter((c) => !c.homeWon).length; // pickAway => hit when away wins => !homeWon

  const globalP = (totalHits + PRIOR_ALPHA) / (total + PRIOR_ALPHA + PRIOR_BETA);

  const bucketStats = BUCKETS.map(() => ({ n: 0, hits: 0 }));
  for (const c of strongAway) {
    // 只用「原始」P 決策篩出跟 B gating 對齊的樣本，讓校準更貼近實際生效區域
    const modelProbRaw = c.modelProbRaw;
    const evRaw = modelProbRaw * (c.pickOdds - 1) - (1 - modelProbRaw);
    if (evRaw < B.minimumExpectedValue) continue;
    if (c.margin < B.minimumExpectedRunMargin) continue;
    if (modelProbRaw < B.minimumModelProbability) continue;

    const idx = bucketIndex(modelProbRaw);
    if (idx == null) continue;
    bucketStats[idx].n += 1;
    if (!c.homeWon) bucketStats[idx].hits += 1;
  }

  const map = {};
  for (let i = 0; i < BUCKETS.length; i += 1) {
    const { n, hits } = bucketStats[i];
    if (n === 0) {
      map[i] = globalP;
      continue;
    }
    map[i] = (hits + PRIOR_ALPHA) / (n + PRIOR_ALPHA + PRIOR_BETA);
  }
  return { map, globalP, bucketStats };
}

function calibFnFactory(calib) {
  return (rawP) => {
    const idx = bucketIndex(rawP);
    if (idx == null) return calib.globalP;
    return calib.map[idx] ?? calib.globalP;
  };
}

const candidates = buildAllCandidates();
const months = [...new Set(candidates.map((x) => x.month))].sort();
const warmupMonths = 3;

const wfRows = [];
const byMonthBets = {
  rawB: {},
  calibB: {},
  rawOverlay: {},
  calibOverlay: {},
};

for (let i = warmupMonths; i < months.length; i += 1) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];

  const train = candidates.filter((x) => trainMonths.has(x.month));
  const test = candidates.filter((x) => x.month === testMonth);
  if (!train.length || !test.length) continue;

  const calib = fitCalibrationMap(train);
  const calibFn = calibFnFactory(calib);

  // B selection
  const rawB = selectB(test, (p) => p);
  const calibB = selectB(test, calibFn);

  // Overlay
  const rawOverlay = applyOverlayFlipSkip(rawB);
  const calibOverlay = applyOverlayFlipSkip(calibB);

  byMonthBets.rawB[testMonth] = rawB;
  byMonthBets.calibB[testMonth] = calibB;
  byMonthBets.rawOverlay[testMonth] = rawOverlay;
  byMonthBets.calibOverlay[testMonth] = calibOverlay;

  wfRows.push({
    month: testMonth,
    calib: {
      globalP: Number(calib.globalP.toFixed(4)),
      bucket: BUCKETS.map((b, idx) => ({
        idx,
        label: bucketLabel(idx),
        n: calib.bucketStats[idx].n,
        hits: calib.bucketStats[idx].hits,
        p: Number(calib.map[idx].toFixed(4)),
      })),
    },
    rawB: summarize(rawB),
    calibB: summarize(calibB),
    rawOverlay: summarize(rawOverlay),
    calibOverlay: summarize(calibOverlay),
    delta: {
      bUsd50: summarize(calibB).usd50 - summarize(rawB).usd50,
      bHitRatePp:
        summarize(calibB).hitRate != null && summarize(rawB).hitRate != null
          ? Number(((summarize(calibB).hitRate - summarize(rawB).hitRate) * 100).toFixed(2))
          : null,
      overlayUsd50: summarize(calibOverlay).usd50 - summarize(rawOverlay).usd50,
      overlayHitRatePp:
        summarize(calibOverlay).hitRate != null && summarize(rawOverlay).hitRate != null
          ? Number(((summarize(calibOverlay).hitRate - summarize(rawOverlay).hitRate) * 100).toFixed(2))
          : null,
    },
  });
}

function aggFromRows(rows, key) {
  const all = [];
  for (const r of rows) {
    if (key === 'rawB') all.push(...byMonthBets.rawB[r.month]);
    if (key === 'calibB') all.push(...byMonthBets.calibB[r.month]);
    if (key === 'rawOverlay') all.push(...byMonthBets.rawOverlay[r.month]);
    if (key === 'calibOverlay') all.push(...byMonthBets.calibOverlay[r.month]);
  }
  return summarize(all);
}

const aggRawB = aggFromRows(wfRows, 'rawB');
const aggCalibB = aggFromRows(wfRows, 'calibB');
const aggRawOverlay = aggFromRows(wfRows, 'rawOverlay');
const aggCalibOverlay = aggFromRows(wfRows, 'calibOverlay');

const out = {
  experimentId: 'mlb-prob-calibration-expanding-wf-2026-07-29',
  rule: {
    slice: `pickAway && homeWinPct>=${STRONG_HOME}`,
    buckets: BUCKETS.map((b) => bucketLabel(BUCKETS.indexOf(b))),
    awayProbThreshold: AWAY_PROB_THRESHOLD,
  },
  params: {
    priorAlpha: PRIOR_ALPHA,
    priorBeta: PRIOR_BETA,
    warmupMonths,
  },
  months: months.slice(warmupMonths),
  wfRows,
  aggregate: {
    rawB: aggRawB,
    calibB: aggCalibB,
    deltaB: {
      usd50: aggCalibB.usd50 - aggRawB.usd50,
      hitRatePp:
        aggCalibB.hitRate != null && aggRawB.hitRate != null
          ? Number(((aggCalibB.hitRate - aggRawB.hitRate) * 100).toFixed(2))
          : null,
    },
    rawOverlay: aggRawOverlay,
    calibOverlay: aggCalibOverlay,
    deltaOverlay: {
      usd50: aggCalibOverlay.usd50 - aggRawOverlay.usd50,
      hitRatePp:
        aggCalibOverlay.hitRate != null && aggRawOverlay.hitRate != null
          ? Number(((aggCalibOverlay.hitRate - aggRawOverlay.hitRate) * 100).toFixed(2))
          : null,
    },
  },
};

fs.writeFileSync(
  new URL('../tmp-mlb-prob-calibration-expanding-wf.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('AGG rawB', out.aggregate.rawB);
console.log('AGG calibB', out.aggregate.calibB);
console.log('AGG rawOverlay', out.aggregate.rawOverlay);
console.log('AGG calibOverlay', out.aggregate.calibOverlay);
console.log('DELTA B usd50', out.aggregate.deltaB.usd50, 'hitRatePp', out.aggregate.deltaB.hitRatePp);
console.log(
  'DELTA overlay usd50',
  out.aggregate.deltaOverlay.usd50,
  'hitRatePp',
  out.aggregate.deltaOverlay.hitRatePp
);

