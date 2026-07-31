/**
 * 殘差係數剝離：a-only / b-only / a+b × ±shrink
 * 目標：a 符號不穩 → 看「只修 b」是否更健康、OOS 是否仍接近全量殘差
 *
 * 協定：係數一律用 2025 前 70% 擬合 + 後 30% 選 scale（與主影子一致）
 *
 * 用法：node scripts/auditMlbResidualAbComponentAblation.mjs
 * 產物：tmp-b-residual-ab-component-ablation.json
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
function selectB(pool, model, { a = 0, b = 0, shrink = false } = {}) {
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
      window: g.window,
      day: g.day,
      month: g.month,
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
  return {
    a: fitRidge(hX, hY, RIDGE),
    b: fitRidge(aX, aY, RIDGE),
    n: hX.length,
  };
}
function pickScale(valPool, model, ab, mode) {
  // mode: ab | a | b — scale applies to the active coeffs
  const rawVal = summarize(selectB(valPool, model, {}));
  let bestScale = 0.25;
  let bestDelta = -Infinity;
  for (const s of SCALES) {
    const coeff = coeffsFor(ab, mode, s);
    const opt = summarize(selectB(valPool, model, { ...coeff, shrink: false }));
    const d = opt.usd50 - rawVal.usd50;
    if (d > bestDelta) {
      bestDelta = d;
      bestScale = s;
    }
  }
  return { scale: bestScale, valDelta: bestDelta };
}
function coeffsFor(ab, mode, scale) {
  if (mode === 'ab') return { a: ab.a * scale, b: ab.b * scale };
  if (mode === 'a') return { a: ab.a * scale, b: 0 };
  if (mode === 'b') return { a: 0, b: ab.b * scale };
  return { a: 0, b: 0 };
}
function byMonth(opt, raw) {
  const months = new Set([...opt.map((b) => b.month), ...raw.map((b) => b.month)]);
  let beat = 0;
  let hurt = 0;
  let flat = 0;
  let sum = 0;
  for (const m of months) {
    const d =
      summarize(opt.filter((b) => b.month === m)).usd50 -
      summarize(raw.filter((b) => b.month === m)).usd50;
    sum += d;
    if (d > 0) beat += 1;
    else if (d < 0) hurt += 1;
    else flat += 1;
  }
  return { beat, hurt, flat, sumDelta: sum };
}
function pack(label, bets, rawAll, mode, scale, ab) {
  const byWindow = {};
  for (const y of ['2024', '2025', '2026']) {
    const b = bets.filter((x) => x.window === y);
    const r = rawAll.filter((x) => x.window === y);
    byWindow[y] = {
      ...summarize(b),
      deltaUsd: summarize(b).usd50 - summarize(r).usd50,
    };
  }
  const oosB = bets.filter((x) => x.window === '2024' || x.window === '2026');
  const oosR = rawAll.filter((x) => x.window === '2024' || x.window === '2026');
  const month = byMonth(bets, rawAll);
  const monthOos = byMonth(oosB, oosR);
  const s = summarize(bets);
  const r = summarize(rawAll);
  let winNonNeg = 0;
  for (const y of ['2024', '2025', '2026']) if (byWindow[y].deltaUsd >= 0) winNonNeg += 1;
  return {
    label,
    mode,
    scale,
    coeffs: coeffsFor(ab, mode, scale),
    overall: s,
    deltaUsd: s.usd50 - r.usd50,
    byWindow,
    windowsNonNeg: winNonNeg,
    oos2426: {
      ...summarize(oosB),
      deltaUsd: summarize(oosB).usd50 - summarize(oosR).usd50,
      d2024: byWindow['2024'].deltaUsd,
      d2026: byWindow['2026'].deltaUsd,
    },
    monthAll: month,
    monthOos,
  };
}

const model = getLatestMlbExpectedRunsValidation().model;
console.log('Loading…');
const pools = {
  '2024': loadPool('2024-04-01', '2024-09-30', model).map((x) => ({ ...x, window: '2024' })),
  '2025': loadPool('2025-04-01', '2025-09-30', model).map((x) => ({ ...x, window: '2025' })),
  '2026': loadPool('2026-04-01', '2026-07-22', model).map((x) => ({ ...x, window: '2026' })),
};
const all = [...pools['2024'], ...pools['2025'], ...pools['2026']];
const p2025 = pools['2025'];
const split = Math.floor(p2025.length * 0.7);
const fit25 = p2025.slice(0, split);
const val25 = p2025.slice(split);
const ab = fitAB(fit25);

const scales = {};
for (const mode of ['ab', 'a', 'b']) {
  scales[mode] = pickScale(val25, model, ab, mode);
}
console.log('scales', scales, 'ab', ab);

const rawAll = selectB(all, model, {});
const variants = [];

for (const mode of ['ab', 'a', 'b', 'none']) {
  for (const shrink of [false, true]) {
    if (mode === 'none' && !shrink) {
      variants.push(pack('raw_locked_b', rawAll, rawAll, 'none', 0, ab));
      continue;
    }
    if (mode === 'none') {
      const bets = selectB(all, model, { shrink: true });
      variants.push(pack('shrink_only', bets, rawAll, 'none', 0, ab));
      continue;
    }
    const sc = scales[mode].scale;
    const c = coeffsFor(ab, mode, sc);
    const bets = selectB(all, model, { ...c, shrink });
    const label = `${mode}${shrink ? '+shrink' : '_only'}`;
    variants.push(pack(label, bets, rawAll, mode, sc, ab));
  }
}

// Expanding WF for b+shrink vs ab+shrink
function expanding(mode) {
  const months = [...new Set(all.map((g) => g.month))].sort();
  const rows = [];
  for (const m of months) {
    const prior = all.filter((g) => g.month < m);
    if (prior.length < 200) continue;
    const test = all.filter((g) => g.month === m);
    if (!test.length) continue;
    const fitSplit = Math.floor(prior.length * 0.7);
    const fitP = prior.slice(0, Math.max(50, fitSplit));
    const valP = prior.slice(Math.max(50, fitSplit));
    const abP = fitAB(fitP);
    const sc =
      valP.length >= 40 ? pickScale(valP, model, abP, mode).scale : 1;
    const c = coeffsFor(abP, mode, sc);
    const raw = selectB(test, model, {});
    const opt = selectB(test, model, { ...c, shrink: true });
    const d = summarize(opt).usd50 - summarize(raw).usd50;
    rows.push({
      month: m,
      a: Number(c.a.toFixed(4)),
      b: Number(c.b.toFixed(4)),
      scale: sc,
      deltaUsd: d,
      aSign: Math.sign(abP.a),
      bSign: Math.sign(abP.b),
    });
  }
  return {
    mode,
    months: rows.length,
    beat: rows.filter((r) => r.deltaUsd > 0).length,
    hurt: rows.filter((r) => r.deltaUsd < 0).length,
    flat: rows.filter((r) => r.deltaUsd === 0).length,
    sumDeltaUsd: rows.reduce((s, r) => s + r.deltaUsd, 0),
    bSignNegShare: Number(
      (rows.filter((r) => r.bSign < 0).length / Math.max(1, rows.length)).toFixed(3)
    ),
    aSignNegShare: Number(
      (rows.filter((r) => r.aSign < 0).length / Math.max(1, rows.length)).toFixed(3)
    ),
    rows,
  };
}

const expandingWf = {
  ab_shrink: expanding('ab'),
  b_shrink: expanding('b'),
  a_shrink: expanding('a'),
};

// Cross-fit: fit24 → test26 for b vs ab
function cross(fitYear, testYear, mode) {
  const fitPool = pools[fitYear];
  const splitF = Math.floor(fitPool.length * 0.7);
  const abF = fitAB(fitPool.slice(0, splitF));
  const sc = pickScale(fitPool.slice(splitF), model, abF, mode).scale;
  const c = coeffsFor(abF, mode, sc);
  const raw = selectB(pools[testYear], model, {});
  const opt = selectB(pools[testYear], model, { ...c, shrink: true });
  return {
    label: `fit${fitYear}→${testYear} ${mode}+shrink`,
    coeffs: c,
    scale: sc,
    deltaUsd: summarize(opt).usd50 - summarize(raw).usd50,
    month: byMonth(opt, raw),
  };
}

const crossFits = [
  cross('2025', '2024', 'ab'),
  cross('2025', '2024', 'b'),
  cross('2025', '2026', 'ab'),
  cross('2025', '2026', 'b'),
  cross('2024', '2026', 'ab'),
  cross('2024', '2026', 'b'),
  cross('2024', '2025', 'ab'),
  cross('2024', '2025', 'b'),
];

const ranked = variants
  .filter((v) => v.label !== 'raw_locked_b')
  .map((v) => ({
    label: v.label,
    oosDelta: v.oos2426.deltaUsd,
    d24: v.oos2426.d2024,
    d26: v.oos2426.d2026,
    winNonNeg: v.windowsNonNeg,
    monthOos: v.monthOos,
    fullDelta: v.deltaUsd,
  }))
  .sort(
    (x, y) =>
      Number(y.d24 >= 0 && y.d26 >= 0) - Number(x.d24 >= 0 && x.d26 >= 0) ||
      y.oosDelta - x.oosDelta
  );

const bPlus = variants.find((v) => v.label === 'b+shrink');
const abPlus = variants.find((v) => v.label === 'ab+shrink');
const bExp = expandingWf.b_shrink;
const abExp = expandingWf.ab_shrink;

const recommendation = {
  prefer:
    bPlus &&
    abPlus &&
    bPlus.oos2426.deltaUsd >= abPlus.oos2426.deltaUsd * 0.85 &&
    bExp.hurt <= abExp.hurt &&
    bExp.bSignNegShare >= 0.8
      ? 'b+shrink'
      : 'ab+shrink',
  reason: null,
  wireSuggested: false,
};
recommendation.reason =
  recommendation.prefer === 'b+shrink'
    ? 'b+shrink OOS 接近全量、Expanding 不更差、b 符號穩 → 改主影子為 b+shrink（關掉不穩 a）'
    : '全量 ab+shrink 仍明顯優於只修 b → 維持 ab+shrink，但標記 a 不穩風險';

const out = {
  experimentId: 'b-residual-ab-component-ablation-2026-07-29',
  abHat: ab,
  scales,
  variants,
  rankedByStrictOos: ranked,
  expandingWf,
  crossFits,
  recommendation,
};

fs.writeFileSync(
  new URL('../tmp-b-residual-ab-component-ablation.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\nVARIANTS (strict OOS 24+26):');
for (const r of ranked) {
  console.log(
    `${r.label.padEnd(14)} oosΔ$${String(r.oosDelta).padStart(4)} d24=${r.d24} d26=${r.d26} win=${r.winNonNeg}/3 monthOos ${r.monthOos.beat}/${r.monthOos.hurt}`
  );
}
console.log('\nEXPANDING:');
for (const [k, v] of Object.entries(expandingWf)) {
  console.log(
    `${k.padEnd(12)} ${v.beat}/${v.hurt}/${v.flat} sumΔ$${v.sumDeltaUsd} bNeg=${v.bSignNegShare} aNeg=${v.aSignNegShare}`
  );
}
console.log('\nCROSS:');
for (const c of crossFits) {
  console.log(
    `${c.label.padEnd(28)} Δ$${c.deltaUsd} month ${c.month.beat}/${c.month.hurt}`
  );
}
console.log('\nREC', recommendation);
