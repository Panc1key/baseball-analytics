/**
 * 細掃 away_cut_vs_strong + 可選疊加 shrink_p55@0.45
 * 用法：node scripts/auditMlbAwayCutVsStrongFine.mjs
 * 產物：tmp-b-away-cut-vs-strong-fine.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
  calibrateMlbScoreMarkets,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
} from '../src/services/MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const STRONG = 0.65;
const STAKE = 50;
const WARMUP = 3;
const D_GRID = [0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.12];
const SHRINK_W = 0.45;
const SHRINK_THR = 0.55;

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function ym(iso) {
  return hk(iso).slice(0, 7);
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

function rebuild(model, base, homeWinPct, d) {
  let homeMean = base.homeExpectedRuns;
  let awayMean = base.awayExpectedRuns;
  if ((homeWinPct ?? 0) >= STRONG && d > 0) {
    awayMean = Math.max(1.5, awayMean * (1 - d));
  }
  const distribution = buildMlbScoreDistribution({
    homeMean,
    awayMean,
    homeDispersion: model.dispersion,
    awayDispersion: model.dispersion,
  });
  const rawMarkets = deriveMlbScoreMarkets(distribution, { totalLine: 8.5 });
  const markets = calibrateMlbScoreMarkets(rawMarkets, model.moneylineTemperature);
  return { homeExpectedRuns: homeMean, awayExpectedRuns: awayMean, markets };
}

function buildPool(model) {
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
      const hs = +row.homeScore;
      const as = +row.awayScore;
      if (hs === as) continue;
      const base = predictMlbGameRuns(model, features, { totalLine: 8.5 });
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
      const sig = buildPregameRegimeSignals(features);
      pool.push({
        window: w.key,
        day: hk(row.commenceTime),
        month: ym(row.commenceTime),
        homeWon: hs > as,
        homeOdds: best.homeOdds,
        awayOdds: best.awayOdds,
        homeWinPct: +features?.home?.homeWinPct || null,
        base,
        homeEarly: +sig.homeEarlyExitsLast3 || 0,
        awayEarly: +sig.awayEarlyExitsLast3 || 0,
      });
    }
  }
  return pool;
}

function selectB(pool, model, d, withShrink) {
  const byDay = new Map();
  for (const g of pool) {
    const pred = d > 0 ? rebuild(model, g.base, g.homeWinPct, d) : {
      homeExpectedRuns: g.base.homeExpectedRuns,
      awayExpectedRuns: g.base.awayExpectedRuns,
      markets: g.base.markets,
    };
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? g.homeOdds : g.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    const pickEarly = pickHome ? g.homeEarly : g.awayEarly;
    const oppEarly = pickHome ? g.awayEarly : g.homeEarly;
    if (pickEarly > oppEarly) continue;

    // optional shrink on toxic high-P away
    const toxicAway = !pickHome && (g.homeWinPct ?? 0) >= STRONG;
    if (withShrink && toxicAway && modelProb >= SHRINK_THR) {
      const market = 1 / pickOdds;
      modelProb = modelProb * (1 - SHRINK_W) + market * SHRINK_W;
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
      window: g.window,
      day: g.day,
      month: g.month,
      pickHome,
      pickOdds,
      modelProb,
      ev,
      margin,
      bScore,
      homeWinPct: g.homeWinPct,
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

function evalOne(pool, model, rawBets, d, withShrink) {
  const bets = selectB(pool, model, d, withShrink);
  const s = summarize(bets);
  const raw = summarize(rawBets);
  const byWindow = {};
  let winNonNeg = 0;
  for (const w of WINDOWS) {
    const bs = summarize(bets.filter((x) => x.window === w.key));
    const rs = summarize(rawBets.filter((x) => x.window === w.key));
    byWindow[w.key] = { deltaUsd: bs.usd50 - rs.usd50, ...bs };
    if (bs.usd50 - rs.usd50 >= 0) winNonNeg += 1;
  }
  const months = [...new Set(pool.map((x) => x.month))].sort().slice(WARMUP);
  let beat = 0;
  let hurt = 0;
  let flat = 0;
  let sumDelta = 0;
  for (const m of months) {
    const mp = pool.filter((x) => x.month === m);
    const rawM = summarize(selectB(mp, model, 0, false));
    const optM = summarize(selectB(mp, model, d, withShrink));
    const delta = optM.usd50 - rawM.usd50;
    sumDelta += delta;
    if (delta > 0) beat += 1;
    else if (delta < 0) hurt += 1;
    else flat += 1;
  }
  const toxicR1 = bets.filter(
    (b) => b.rank === 1 && !b.pickHome && (b.homeWinPct ?? 0) >= STRONG
  );
  return {
    d,
    withShrink,
    kept: s,
    deltaUsd: s.usd50 - raw.usd50,
    byWindow,
    windowsNonNeg: winNonNeg,
    oosMonth: { beat, hurt, flat, sumDeltaUsd: sumDelta },
    toxicRank1N: toxicR1.length,
    toxicRank1: summarize(toxicR1),
    passGates: winNonNeg === 3 && beat >= hurt && s.usd50 > raw.usd50,
  };
}

const validation = getLatestMlbExpectedRunsValidation();
const model = validation.model;
console.log('Building pool…');
const pool = buildPool(model);
const rawBets = selectB(pool, model, 0, false);
const trials = [];
for (const d of [0, ...D_GRID]) {
  trials.push(evalOne(pool, model, rawBets, d, false));
  if (d > 0) trials.push(evalOne(pool, model, rawBets, d, true));
}
// shrink only baseline
trials.push(evalOne(pool, model, rawBets, 0, true));

trials.sort(
  (a, b) =>
    Number(b.passGates) - Number(a.passGates) ||
    b.windowsNonNeg - a.windowsNonNeg ||
    b.oosMonth.beat - b.oosMonth.hurt - (a.oosMonth.beat - a.oosMonth.hurt) ||
    b.deltaUsd - a.deltaUsd
);

const bestPass = trials.find((t) => t.passGates && !(t.d === 0 && !t.withShrink));
const out = {
  experimentId: 'b-away-cut-vs-strong-fine-2026-07-29',
  baseline: summarize(rawBets),
  trials,
  bestPassing: bestPass || null,
  shrinkOnly: trials.find((t) => t.d === 0 && t.withShrink) || null,
  recommendation: {
    wireSuggested: false,
    note: bestPass
      ? '找到過閘組合：可升影子'
      : '細掃仍無三窗+月穩健全過；away_cut 月級好看但傷單年；維持 shrink_p55 影子，重訓納入主場強度',
  },
};

fs.writeFileSync(
  new URL('../tmp-b-away-cut-vs-strong-fine.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('BASE', out.baseline);
for (const t of trials.slice(0, 12)) {
  console.log(
    `d=${t.d} shrink=${t.withShrink} Δ$=${t.deltaUsd} win=${t.windowsNonNeg}/3 month ${t.oosMonth.beat}/${t.oosMonth.hurt}/${t.oosMonth.flat} toxicR1=${t.toxicRank1N} pass=${t.passGates}`
  );
  console.log(
    `  24:${t.byWindow['2024'].deltaUsd} 25:${t.byWindow['2025'].deltaUsd} 26:${t.byWindow['2026'].deltaUsd}`
  );
}
console.log('BEST PASS', bestPass);
console.log('SHRINK ONLY', out.shrinkOnly && {
  deltaUsd: out.shrinkOnly.deltaUsd,
  win: out.shrinkOnly.windowsNonNeg,
  month: out.shrinkOnly.oosMonth,
});
console.log('REC', out.recommendation.note);
