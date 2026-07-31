/**
 * β：主場強度後處理（不改鎖定 B 常數、不寫入正式模型）
 *
 * 在 v4.5 預測均值上加主場調整，重算勝率後再跑鎖定 B：
 * - home_add_hw: homeMean += a * (homeWinPct - 0.5)
 * - home_add_strong: homeMean += b * max(0, homeWinPct - 0.65)
 * - home_flat_boost: homeMean += c（一律主場加分，模擬加大 isHome）
 * - away_cut_vs_strong: 若 homeWinPct>=0.65，awayMean *= (1-d)
 *
 * 用法：node scripts/auditMlbHomeStrengthPostHoc.mjs
 * 產物：tmp-b-home-strength-posthoc.json
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

function adjustMeans(base, homeWinPct, cfg) {
  let homeMean = base.homeExpectedRuns;
  let awayMean = base.awayExpectedRuns;
  const hw = homeWinPct ?? 0.5;

  if (cfg.kind === 'home_add_hw') {
    homeMean += cfg.a * (hw - 0.5);
  } else if (cfg.kind === 'home_add_strong') {
    homeMean += cfg.b * Math.max(0, hw - STRONG);
  } else if (cfg.kind === 'home_flat_boost') {
    homeMean += cfg.c;
  } else if (cfg.kind === 'away_cut_vs_strong') {
    if (hw >= STRONG) awayMean *= 1 - cfg.d;
  } else if (cfg.kind === 'combo_strong') {
    homeMean += cfg.b * Math.max(0, hw - STRONG);
    if (hw >= STRONG) awayMean *= 1 - cfg.d;
  }

  homeMean = Math.max(1.5, homeMean);
  awayMean = Math.max(1.5, awayMean);
  return { homeMean, awayMean };
}

function rebuildPrediction(model, base, homeWinPct, cfg) {
  if (cfg.kind === 'raw') {
    return {
      homeExpectedRuns: base.homeExpectedRuns,
      awayExpectedRuns: base.awayExpectedRuns,
      markets: base.markets,
    };
  }
  const { homeMean, awayMean } = adjustMeans(base, homeWinPct, cfg);
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

function buildPool(validation) {
  const model = validation.model;
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
      const homeWinPct = +features?.home?.homeWinPct || null;

      pool.push({
        window: w.key,
        day: hk(row.commenceTime),
        month: ym(row.commenceTime),
        gameId: row.gameId,
        homeTeam: row.homeTeam,
        awayTeam: row.awayTeam,
        homeWon: hs > as,
        homeOdds: best.homeOdds,
        awayOdds: best.awayOdds,
        homeWinPct,
        base,
        // early-exit gate uses pick-dependent side; compute both
        homeEarly: +sig.homeEarlyExitsLast3 || 0,
        awayEarly: +sig.awayEarlyExitsLast3 || 0,
      });
    }
  }
  return pool;
}

function selectBFromPool(pool, model, cfg) {
  const byDay = new Map();
  for (const g of pool) {
    const pred = rebuildPrediction(model, g.base, g.homeWinPct, cfg);
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    const modelProb = pickHome
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? g.homeOdds : g.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;

    const pickEarly = pickHome ? g.homeEarly : g.awayEarly;
    const oppEarly = pickHome ? g.awayEarly : g.homeEarly;
    if (pickEarly > oppEarly) continue;

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
      gameId: g.gameId,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      homeWinPct: g.homeWinPct,
      pickHome,
      pickOdds,
      modelProb,
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

function isToxicAway(b) {
  return b.pickHome === false && (b.homeWinPct ?? 0) >= STRONG;
}

function evalCfg(pool, model, cfg, rawBets) {
  const bets = selectBFromPool(pool, model, cfg);
  const s = summarize(bets);
  const raw = summarize(rawBets);
  const byWindow = {};
  let winNonNeg = 0;
  for (const w of WINDOWS) {
    const bs = summarize(bets.filter((x) => x.window === w.key));
    const rs = summarize(rawBets.filter((x) => x.window === w.key));
    byWindow[w.key] = { ...bs, deltaUsd: bs.usd50 - rs.usd50 };
    if (bs.usd50 - rs.usd50 >= 0) winNonNeg += 1;
  }

  const months = [...new Set(pool.map((x) => x.month))].sort().slice(WARMUP);
  let beat = 0;
  let hurt = 0;
  let flat = 0;
  let sumDelta = 0;
  for (const m of months) {
    const monthPool = pool.filter((x) => x.month === m);
    const rawM = summarize(selectBFromPool(monthPool, model, { kind: 'raw' }));
    const optM = summarize(selectBFromPool(monthPool, model, cfg));
    const d = optM.usd50 - rawM.usd50;
    sumDelta += d;
    if (d > 0) beat += 1;
    else if (d < 0) hurt += 1;
    else flat += 1;
  }

  const toxicR1 = bets.filter((b) => b.rank === 1 && isToxicAway(b));
  const toxicR1HighEv = toxicR1.filter((b) => b.ev >= 0.1);

  return {
    cfg,
    kept: s,
    deltaUsd: s.usd50 - raw.usd50,
    deltaHrPp:
      s.hitRate != null && raw.hitRate != null
        ? Number(((s.hitRate - raw.hitRate) * 100).toFixed(2))
        : null,
    byWindow,
    windowsNonNeg: winNonNeg,
    oosMonth: { beat, hurt, flat, sumDeltaUsd: sumDelta },
    toxicRank1: summarize(toxicR1),
    toxicRank1HighEv: summarize(toxicR1HighEv),
    toxicRank1N: toxicR1.length,
    toxicRank1HighEvN: toxicR1HighEv.length,
    passGates:
      winNonNeg === 3 &&
      beat >= hurt &&
      s.usd50 - raw.usd50 > 0,
  };
}

const CFGS = [{ kind: 'raw' }];
for (const a of [0.5, 1, 1.5, 2, 2.5]) CFGS.push({ kind: 'home_add_hw', a });
for (const b of [1, 2, 3, 4, 5]) CFGS.push({ kind: 'home_add_strong', b });
for (const c of [0.1, 0.2, 0.3, 0.4]) CFGS.push({ kind: 'home_flat_boost', c });
for (const d of [0.03, 0.05, 0.08, 0.1]) CFGS.push({ kind: 'away_cut_vs_strong', d });
for (const b of [2, 3]) {
  for (const d of [0.03, 0.05]) CFGS.push({ kind: 'combo_strong', b, d });
}

console.log('Building pool…');
const validation = getLatestMlbExpectedRunsValidation();
const pool = buildPool(validation);
const model = validation.model;
const rawBets = selectBFromPool(pool, model, { kind: 'raw' });
const rawSum = summarize(rawBets);

console.log('Evaluating', CFGS.length, 'configs on', pool.length, 'games…');
const results = CFGS.map((cfg) => evalCfg(pool, model, cfg, rawBets));
results.sort(
  (a, b) =>
    Number(b.passGates) - Number(a.passGates) ||
    b.windowsNonNeg - a.windowsNonNeg ||
    b.oosMonth.beat - b.oosMonth.hurt - (a.oosMonth.beat - a.oosMonth.hurt) ||
    b.deltaUsd - a.deltaUsd
);

const bestPass = results.find((r) => r.passGates && r.cfg.kind !== 'raw') || null;
const bestAny = results.find((r) => r.cfg.kind !== 'raw') || null;

const out = {
  experimentId: 'b-home-strength-posthoc-2026-07-29',
  plainLanguage:
    '在現有模型算完預期得分後，給主場／強主場加分或削弱客隊，看鎖定 B 會不會更穩更賺',
  baseline: rawSum,
  top15: results.filter((r) => r.cfg.kind !== 'raw').slice(0, 15),
  bestPassingGates: bestPass,
  bestOverall: bestAny,
  recommendation: {
    wireSuggested: false,
    note: bestPass
      ? '出現過閘後處理：可進影子，並作為下一輪重訓特徵候選（homeWinPct／強主場）'
      : '後處理未過三窗+月穩健閘：主場訊號方向可能對，但幅度／形式還不夠；下一步應把 homeWinPct 納入重訓特徵而非只後處理',
  },
};

fs.writeFileSync(
  new URL('../tmp-b-home-strength-posthoc.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('BASELINE', rawSum);
console.log('\nTOP 10:');
for (const r of out.top15.slice(0, 10)) {
  console.log(
    `${JSON.stringify(r.cfg).padEnd(45)} Δ$=${r.deltaUsd} win=${r.windowsNonNeg}/3 month ${r.oosMonth.beat}/${r.oosMonth.hurt}/${r.oosMonth.flat} toxicR1=${r.toxicRank1N} hiEvR1=${r.toxicRank1HighEvN} pass=${r.passGates}`
  );
}
console.log('\nBEST PASS', bestPass?.cfg, bestPass?.deltaUsd);
console.log('REC', out.recommendation.note);
