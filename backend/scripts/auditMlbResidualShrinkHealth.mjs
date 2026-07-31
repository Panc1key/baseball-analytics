/**
 * residual+shrink 影子健康度（防幻覺）
 *
 * 檢查：
 * 1. 固定參數（2025 擬合）月級 beat/hurt
 * 2. Expanding 月 WF：只用過去資料擬合 a,b+scale，測下一個月
 * 3. 跨年 holdout：24→25+26、24+25→26、25→24、25→26
 * 4. 係數符號／量級跨年穩定
 * 5. 損益集中度（是否靠 1–2 個幸運月）
 * 6. 安慰劑：符號翻轉、xHome 洗牌
 * 7. 機制：改動注 vs 毒 Rank1；疊加是否只是雙算同一效應
 *
 * 用法：node scripts/auditMlbResidualShrinkHealth.mjs
 * 產物：tmp-b-residual-shrink-health.json
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
const STAKE = 50;
const STRONG = 0.65;
const RIDGE = 50;
const SHRINK_W = 0.45;
const SHRINK_THR = 0.55;
const SCALES = [0.25, 0.5, 0.75, 1, 1.25];

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
function fitRidge(xs, ys, ridge) {
  let num = 0;
  let den = ridge;
  for (let i = 0; i < xs.length; i += 1) {
    num += xs[i] * ys[i];
    den += xs[i] * xs[i];
  }
  return num / den;
}
function loadPool(from, to, model) {
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
    const homeWinPct = Number(features?.home?.homeWinPct);
    if (!Number.isFinite(homeWinPct)) continue;
    const sig = buildPregameRegimeSignals(features);
    out.push({
      gameId: row.gameId,
      window: from.slice(0, 4),
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      homeWon: hs > as,
      homeScore: hs,
      awayScore: as,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      homeWinPct,
      xHome: homeWinPct - 0.5,
      base,
      homeEarly: +sig.homeEarlyExitsLast3 || 0,
      awayEarly: +sig.awayEarlyExitsLast3 || 0,
    });
  }
  return out;
}
function rebuild(model, base, x, a, b) {
  const homeMean = Math.max(1.5, base.homeExpectedRuns + a * x);
  const awayMean = Math.max(1.5, base.awayExpectedRuns + b * x);
  const distribution = buildMlbScoreDistribution({
    homeMean,
    awayMean,
    homeDispersion: model.dispersion,
    awayDispersion: model.dispersion,
  });
  const rawMarkets = deriveMlbScoreMarkets(distribution, { totalLine: 8.5 });
  return {
    homeExpectedRuns: homeMean,
    awayExpectedRuns: awayMean,
    markets: calibrateMlbScoreMarkets(rawMarkets, model.moneylineTemperature),
  };
}
function selectB(pool, model, { a = 0, b = 0, shrink = false, tag = 'opt' } = {}) {
  const byDay = new Map();
  for (const g of pool) {
    const pred =
      a === 0 && b === 0
        ? {
            homeExpectedRuns: g.base.homeExpectedRuns,
            awayExpectedRuns: g.base.awayExpectedRuns,
            markets: g.base.markets,
          }
        : rebuild(model, g.base, g.xHome, a, b);
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
    const toxicAway = !pickHome && (g.homeWinPct ?? 0) >= STRONG;
    if (shrink && toxicAway && modelProb >= SHRINK_THR) {
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
      gameId: g.gameId,
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
      toxicAway,
      hit: pickHome ? g.homeWon : !g.homeWon,
      tag,
    });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (x, y) => y.bScore - x.bScore || y.margin - x.margin
    );
    applyDrop(arr).forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}
function fitAB(pool) {
  const hX = [];
  const hY = [];
  const aX = [];
  const aY = [];
  for (const g of pool) {
    hX.push(g.xHome);
    hY.push(g.homeScore - g.base.homeExpectedRuns);
    aX.push(g.xHome);
    aY.push(g.awayScore - g.base.awayExpectedRuns);
  }
  if (!hX.length) return { a: 0, b: 0, n: 0 };
  return { a: fitRidge(hX, hY, RIDGE), b: fitRidge(aX, aY, RIDGE), n: hX.length };
}
function pickScale(fitPool, valPool, model, ab) {
  const rawVal = summarize(selectB(valPool, model, {}));
  let bestScale = 0.25;
  let bestDelta = -Infinity;
  for (const s of SCALES) {
    const opt = summarize(
      selectB(valPool, model, { a: ab.a * s, b: ab.b * s, shrink: false })
    );
    const d = opt.usd50 - rawVal.usd50;
    if (d > bestDelta) {
      bestDelta = d;
      bestScale = s;
    }
  }
  return { scale: bestScale, valDelta: bestDelta, fitN: fitPool.length, valN: valPool.length };
}
function fitScaleOnPool(pool, model) {
  if (pool.length < 80) {
    const ab = fitAB(pool);
    return { ab, scale: 1, a: ab.a, b: ab.b, note: 'too_small_use_scale1' };
  }
  const split = Math.floor(pool.length * 0.7);
  const fit = pool.slice(0, split);
  const val = pool.slice(split);
  const ab = fitAB(fit);
  const ps = pickScale(fit, val, model, ab);
  return {
    ab,
    scale: ps.scale,
    a: ab.a * ps.scale,
    b: ab.b * ps.scale,
    valDelta: ps.valDelta,
  };
}
function byMonthDelta(optBets, rawBets) {
  const months = new Set([
    ...optBets.map((b) => b.month),
    ...rawBets.map((b) => b.month),
  ]);
  const rows = [];
  let beat = 0;
  let hurt = 0;
  let flat = 0;
  for (const m of [...months].sort()) {
    const o = summarize(optBets.filter((b) => b.month === m));
    const r = summarize(rawBets.filter((b) => b.month === m));
    const d = o.usd50 - r.usd50;
    rows.push({ month: m, rawUsd: r.usd50, optUsd: o.usd50, deltaUsd: d, rawN: r.bets, optN: o.bets });
    if (d > 0) beat += 1;
    else if (d < 0) hurt += 1;
    else flat += 1;
  }
  return { rows, beat, hurt, flat, sumDelta: rows.reduce((s, x) => s + x.deltaUsd, 0) };
}
function concentration(monthRows) {
  const pos = monthRows.filter((r) => r.deltaUsd > 0).sort((a, b) => b.deltaUsd - a.deltaUsd);
  const neg = monthRows.filter((r) => r.deltaUsd < 0).sort((a, b) => a.deltaUsd - b.deltaUsd);
  const posSum = pos.reduce((s, r) => s + r.deltaUsd, 0);
  const top2 = pos.slice(0, 2).reduce((s, r) => s + r.deltaUsd, 0);
  return {
    positiveMonths: pos.length,
    negativeMonths: neg.length,
    top2PositiveShare: posSum > 0 ? Number((top2 / posSum).toFixed(3)) : null,
    top2Months: pos.slice(0, 2).map((r) => ({ month: r.month, deltaUsd: r.deltaUsd })),
    worst2: neg.slice(0, 2).map((r) => ({ month: r.month, deltaUsd: r.deltaUsd })),
  };
}
function toxicR1(bets) {
  return bets.filter((b) => b.rank === 1 && b.toxicAway);
}
function keyset(bets) {
  return new Set(bets.map((b) => `${b.day}|${b.gameId}|${b.pickHome ? 'H' : 'A'}`));
}
function mechanism(raw, stack) {
  const rk = keyset(raw);
  const sk = keyset(stack);
  const dropped = [...rk].filter((k) => !sk.has(k));
  const added = [...sk].filter((k) => !rk.has(k));
  const rawByKey = new Map(raw.map((b) => [`${b.day}|${b.gameId}|${b.pickHome ? 'H' : 'A'}`, b]));
  const stackByKey = new Map(
    stack.map((b) => [`${b.day}|${b.gameId}|${b.pickHome ? 'H' : 'A'}`, b])
  );
  const droppedBets = dropped.map((k) => rawByKey.get(k)).filter(Boolean);
  const addedBets = added.map((k) => stackByKey.get(k)).filter(Boolean);
  return {
    rawN: raw.length,
    stackN: stack.length,
    droppedN: droppedBets.length,
    addedN: addedBets.length,
    dropped: summarize(droppedBets),
    added: summarize(addedBets),
    toxicR1: {
      raw: { n: toxicR1(raw).length, ...summarize(toxicR1(raw)) },
      stack: { n: toxicR1(stack).length, ...summarize(toxicR1(stack)) },
    },
  };
}
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleX(pool, seed) {
  const rnd = mulberry32(seed);
  const xs = pool.map((g) => g.xHome);
  for (let i = xs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return pool.map((g, i) => ({ ...g, xHome: xs[i], homeWinPct: xs[i] + 0.5 }));
}

const validation = getLatestMlbExpectedRunsValidation();
const model = validation.model;

console.log('Loading…');
const pools = {
  '2024': loadPool('2024-04-01', '2024-09-30', model).map((x) => ({ ...x, window: '2024' })),
  '2025': loadPool('2025-04-01', '2025-09-30', model).map((x) => ({ ...x, window: '2025' })),
  '2026': loadPool('2026-04-01', '2026-07-22', model).map((x) => ({ ...x, window: '2026' })),
};
const all = [...pools['2024'], ...pools['2025'], ...pools['2026']];

// Canonical coeffs (same protocol as stack): fit 2025 70/30
const p2025 = pools['2025'];
const split25 = Math.floor(p2025.length * 0.7);
const canon = fitScaleOnPool(p2025, model);
console.log('canonical coeffs', canon);

const rawAll = selectB(all, model, {});
const residualAll = selectB(all, model, { a: canon.a, b: canon.b, shrink: false });
const shrinkAll = selectB(all, model, { shrink: true });
const stackAll = selectB(all, model, { a: canon.a, b: canon.b, shrink: true });

const fixedMonth = byMonthDelta(stackAll, rawAll);
const conc = concentration(fixedMonth.rows);

// Additive check on full (incl 2025 in-sample for residual)
const dRes = summarize(residualAll).usd50 - summarize(rawAll).usd50;
const dShr = summarize(shrinkAll).usd50 - summarize(rawAll).usd50;
const dStack = summarize(stackAll).usd50 - summarize(rawAll).usd50;
const additive = {
  residualDelta: dRes,
  shrinkDelta: dShr,
  sumComponents: dRes + dShr,
  stackDelta: dStack,
  synergy: dStack - (dRes + dShr),
  note:
    dStack > dRes + dShr + 20
      ? '疊加有正向交互'
      : dStack < dRes + dShr - 50
        ? '明顯重疊／互相抵消'
        : '大致可加（略重疊正常）',
};

// Strict OOS additive (24+26 only)
function oosDelta(bets) {
  const sub = bets.filter((x) => x.window === '2024' || x.window === '2026');
  const raw = rawAll.filter((x) => x.window === '2024' || x.window === '2026');
  return summarize(sub).usd50 - summarize(raw).usd50;
}
const additiveOos = {
  residualDelta: oosDelta(residualAll),
  shrinkDelta: oosDelta(shrinkAll),
  sumComponents: oosDelta(residualAll) + oosDelta(shrinkAll),
  stackDelta: oosDelta(stackAll),
  synergy: oosDelta(stackAll) - (oosDelta(residualAll) + oosDelta(shrinkAll)),
};

// Cross-year holdouts for residual coeffs + fixed shrink
function holdout(fitKey, testKeys, label) {
  const fitPool = Array.isArray(fitKey)
    ? fitKey.flatMap((k) => pools[k])
    : pools[fitKey];
  const testPool = testKeys.flatMap((k) => pools[k]);
  const fitted = fitScaleOnPool(fitPool, model);
  const raw = selectB(testPool, model, {});
  const stack = selectB(testPool, model, {
    a: fitted.a,
    b: fitted.b,
    shrink: true,
  });
  const residual = selectB(testPool, model, {
    a: fitted.a,
    b: fitted.b,
    shrink: false,
  });
  const month = byMonthDelta(stack, raw);
  return {
    label,
    fit: fitted,
    test: {
      raw: summarize(raw),
      residual: summarize(residual),
      stack: summarize(stack),
      residualDelta: summarize(residual).usd50 - summarize(raw).usd50,
      stackDelta: summarize(stack).usd50 - summarize(raw).usd50,
    },
    monthBeatHurt: { beat: month.beat, hurt: month.hurt, flat: month.flat },
  };
}

const holdouts = [
  holdout('2025', ['2024'], 'fit25→test24'),
  holdout('2025', ['2026'], 'fit25→test26'),
  holdout('2024', ['2025'], 'fit24→test25'),
  holdout('2024', ['2026'], 'fit24→test26'),
  holdout(['2024', '2025'], ['2026'], 'fit24+25→test26'),
  holdout('2024', ['2025', '2026'], 'fit24→test25+26'),
];

// Expanding monthly WF: after having ≥1 prior year month block, fit on all prior games
const monthsSorted = [...new Set(all.map((g) => g.month))].sort();
const expanding = [];
for (let i = 0; i < monthsSorted.length; i += 1) {
  const m = monthsSorted[i];
  // need prior data: at least 200 games
  const prior = all.filter((g) => g.month < m);
  if (prior.length < 200) continue;
  const testPool = all.filter((g) => g.month === m);
  if (!testPool.length) continue;
  const fitted = fitScaleOnPool(prior, model);
  const raw = selectB(testPool, model, {});
  const stack = selectB(testPool, model, {
    a: fitted.a,
    b: fitted.b,
    shrink: true,
  });
  const d = summarize(stack).usd50 - summarize(raw).usd50;
  expanding.push({
    month: m,
    priorN: prior.length,
    a: Number(fitted.a.toFixed(4)),
    b: Number(fitted.b.toFixed(4)),
    scale: fitted.scale,
    rawUsd: summarize(raw).usd50,
    stackUsd: summarize(stack).usd50,
    deltaUsd: d,
  });
}
const expAgg = {
  months: expanding.length,
  beat: expanding.filter((r) => r.deltaUsd > 0).length,
  hurt: expanding.filter((r) => r.deltaUsd < 0).length,
  flat: expanding.filter((r) => r.deltaUsd === 0).length,
  sumDeltaUsd: expanding.reduce((s, r) => s + r.deltaUsd, 0),
};

// Coefficient stability by year
const coeffByYear = {};
for (const y of ['2024', '2025', '2026']) {
  const ab = fitAB(pools[y]);
  coeffByYear[y] = {
    a: Number(ab.a.toFixed(4)),
    b: Number(ab.b.toFixed(4)),
    n: ab.n,
    aSign: Math.sign(ab.a),
    bSign: Math.sign(ab.b),
  };
}
const signStable =
  coeffByYear['2024'].aSign === coeffByYear['2025'].aSign &&
  coeffByYear['2025'].aSign === coeffByYear['2026'].aSign &&
  coeffByYear['2024'].bSign === coeffByYear['2025'].bSign &&
  coeffByYear['2025'].bSign === coeffByYear['2026'].bSign;

// Placebos on OOS 24+26 with canon coeffs
const oosPool = [...pools['2024'], ...pools['2026']];
const rawOos = selectB(oosPool, model, {});
const trueStackOos = selectB(oosPool, model, {
  a: canon.a,
  b: canon.b,
  shrink: true,
});
const flipStackOos = selectB(oosPool, model, {
  a: -canon.a,
  b: -canon.b,
  shrink: true,
});
const shuffleSeeds = [1, 2, 3, 4, 5];
const shuffleDeltas = shuffleSeeds.map((seed) => {
  const shuffled = shuffleX(oosPool, seed);
  // re-fit on shuffled 2025? For fair placebo: apply SAME a,b but shuffled x on OOS
  // Better: fit a,b on shuffled 2025, apply to shuffled OOS
  const sh25 = shuffleX(pools['2025'], seed);
  const fitted = fitScaleOnPool(sh25, model);
  const shOos = shuffleX(oosPool, seed + 100);
  const raw = selectB(shOos, model, {});
  const stack = selectB(shOos, model, {
    a: fitted.a,
    b: fitted.b,
    shrink: true,
  });
  return {
    seed,
    deltaUsd: summarize(stack).usd50 - summarize(raw).usd50,
    a: Number(fitted.a.toFixed(4)),
    b: Number(fitted.b.toFixed(4)),
  };
});
const placebo = {
  trueOosDelta: summarize(trueStackOos).usd50 - summarize(rawOos).usd50,
  flippedSignOosDelta: summarize(flipStackOos).usd50 - summarize(rawOos).usd50,
  shuffleOosDeltas: shuffleDeltas,
  shuffleMean: Number(
    (
      shuffleDeltas.reduce((s, x) => s + x.deltaUsd, 0) / shuffleDeltas.length
    ).toFixed(1)
  ),
  trueBeatsAllShuffles: shuffleDeltas.every(
    (x) => summarize(trueStackOos).usd50 - summarize(rawOos).usd50 > x.deltaUsd
  ),
};

const mech = mechanism(rawAll, stackAll);

// Health scorecard
const checks = [
  {
    id: 'strict_oos_both_years_nonneg',
    pass:
      holdouts.find((h) => h.label === 'fit25→test24')?.test.stackDelta >= 0 &&
      holdouts.find((h) => h.label === 'fit25→test26')?.test.stackDelta >= 0,
    detail: 'fit2025→24 與 →26 疊加 Δ$ 皆≥0',
  },
  {
    id: 'expanding_beat_ge_hurt',
    pass: expAgg.beat >= expAgg.hurt && expAgg.sumDeltaUsd > 0,
    detail: `Expanding ${expAgg.beat}/${expAgg.hurt}/${expAgg.flat} sumΔ$${expAgg.sumDeltaUsd}`,
  },
  {
    id: 'fixed_month_beat_ge_hurt',
    pass: fixedMonth.beat >= fixedMonth.hurt && fixedMonth.sumDelta > 0,
    detail: `固定參數月 ${fixedMonth.beat}/${fixedMonth.hurt}/${fixedMonth.flat} sumΔ$${fixedMonth.sumDelta}`,
  },
  {
    id: 'not_over_concentrated',
    pass: conc.top2PositiveShare == null || conc.top2PositiveShare < 0.7,
    detail: `正增益 top2 佔比 ${conc.top2PositiveShare}`,
  },
  {
    id: 'coeff_sign_stable',
    pass: signStable && coeffByYear['2025'].aSign !== 0,
    detail: `a,b 符號跨年一致=${signStable} · ${JSON.stringify(coeffByYear)}`,
  },
  {
    id: 'beats_placebo_flip',
    pass: placebo.trueOosDelta > placebo.flippedSignOosDelta,
    detail: `真 Δ$${placebo.trueOosDelta} vs 翻號 Δ$${placebo.flippedSignOosDelta}`,
  },
  {
    id: 'beats_shuffle_placebo',
    pass: placebo.trueBeatsAllShuffles && placebo.trueOosDelta > placebo.shuffleMean + 100,
    detail: `真 Δ$${placebo.trueOosDelta} vs shuffle 均值 Δ$${placebo.shuffleMean}`,
  },
  {
    id: 'mechanism_drops_losing_more',
    pass:
      mech.dropped.bets > 0 &&
      (mech.dropped.roi == null || mech.dropped.roi < (mech.added.roi ?? 0)),
    detail: `丟掉 ${mech.dropped.n ?? mech.dropped.bets} 注 ROI=${mech.dropped.roi}；新增 ${mech.added.bets} ROI=${mech.added.roi}`,
  },
  {
    id: 'cross_fit24_still_nonneg_26',
    pass: holdouts.find((h) => h.label === 'fit24→test26')?.test.stackDelta >= 0,
    detail: `fit24→26 stackΔ$=${holdouts.find((h) => h.label === 'fit24→test26')?.test.stackDelta}`,
  },
];

const passN = checks.filter((c) => c.pass).length;
const verdict =
  passN >= 7
    ? 'healthy_shadow'
    : passN >= 5
      ? 'mixed_keep_shadow_no_wire'
      : 'likely_hallucination_downgrade';

const out = {
  experimentId: 'b-residual-shrink-health-2026-07-29',
  canonical: {
    a: canon.a,
    b: canon.b,
    scale: canon.scale,
    shrinkW: SHRINK_W,
    shrinkThr: SHRINK_THR,
  },
  fullWindow: {
    raw: summarize(rawAll),
    residual: summarize(residualAll),
    shrink: summarize(shrinkAll),
    stack: summarize(stackAll),
    additive,
    additiveOos,
  },
  fixedParamsMonthly: { ...fixedMonth, concentration: conc },
  expandingMonthlyWf: { aggregate: expAgg, rows: expanding },
  holdouts,
  coeffByYear,
  signStable,
  placebo,
  mechanism: mech,
  checks,
  passN,
  passTotal: checks.length,
  verdict,
  recommendation: {
    wireSuggested: false,
    keepAsPrimaryShadow: verdict !== 'likely_hallucination_downgrade',
    note:
      verdict === 'healthy_shadow'
        ? '多項 OOS／安慰劑通過：可當主影子持續觀察，仍不接入正式'
        : verdict === 'mixed_keep_shadow_no_wire'
          ? '部分通過：保留影子但視為不穩，禁止接入'
          : '偏幻覺：降級或丟棄，勿當優化方向',
  },
};

fs.writeFileSync(
  new URL('../tmp-b-residual-shrink-health.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\n=== CHECKS ===');
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.id}: ${c.detail}`);
}
console.log(`\nSCORE ${passN}/${checks.length} → ${verdict}`);
console.log('EXPANDING', expAgg);
console.log('FIXED MONTH', {
  beat: fixedMonth.beat,
  hurt: fixedMonth.hurt,
  flat: fixedMonth.flat,
  sum: fixedMonth.sumDelta,
  conc,
});
console.log('PLACEBO', {
  true: placebo.trueOosDelta,
  flip: placebo.flippedSignOosDelta,
  shuffleMean: placebo.shuffleMean,
});
console.log('HOLDOUTS');
for (const h of holdouts) {
  console.log(
    `${h.label} stackΔ$${h.test.stackDelta} resΔ$${h.test.residualDelta} month ${h.monthBeatHurt.beat}/${h.monthBeatHurt.hurt}`
  );
}
console.log('REC', out.recommendation);
