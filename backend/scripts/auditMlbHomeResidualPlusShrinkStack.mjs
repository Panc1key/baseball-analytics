/**
 * 雙影子疊加：主場殘差修正 + shrink_p55@0.45
 *
 * 協定（與 holdout 一致）：
 * - 用 2025 前 70% 擬合 a,b；後 30% 選 scale
 * - 疊加：先殘差改均值→重算 P/EV，再對毒切片 P>=55% 做市場收縮
 *
 * 用法：node scripts/auditMlbHomeResidualPlusShrinkStack.mjs
 * 產物：tmp-b-home-residual-plus-shrink-stack.json
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

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
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
      window: from.slice(0, 4),
      day: hk(row.commenceTime),
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
  return { a: fitRidge(hX, hY, RIDGE), b: fitRidge(aX, aY, RIDGE) };
}
function pack(label, bets, rawBets) {
  const byWindow = {};
  for (const w of WINDOWS) {
    const key = w.key;
    const b = bets.filter((x) => x.window === key);
    const r = rawBets.filter((x) => x.window === key);
    byWindow[key] = {
      ...summarize(b),
      deltaUsd: summarize(b).usd50 - summarize(r).usd50,
    };
  }
  const s = summarize(bets);
  const r = summarize(rawBets);
  let winNonNeg = 0;
  for (const w of WINDOWS) if (byWindow[w.key].deltaUsd >= 0) winNonNeg += 1;
  return {
    label,
    overall: s,
    deltaUsd: s.usd50 - r.usd50,
    byWindow,
    windowsNonNeg: winNonNeg,
  };
}

const validation = getLatestMlbExpectedRunsValidation();
const model = validation.model;

console.log('Loading pools…');
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

let bestScale = 0.25;
let bestValDelta = -Infinity;
const rawVal = summarize(selectB(val25, model, {}));
for (const s of SCALES) {
  const opt = summarize(
    selectB(val25, model, { a: ab.a * s, b: ab.b * s, shrink: false })
  );
  const d = opt.usd50 - rawVal.usd50;
  if (d > bestValDelta) {
    bestValDelta = d;
    bestScale = s;
  }
}
const a = ab.a * bestScale;
const b = ab.b * bestScale;
console.log('coeffs', { ab, bestScale, a, b });

const rawAll = selectB(all, model, {});
const residualOnly = selectB(all, model, { a, b, shrink: false });
const shrinkOnly = selectB(all, model, { shrink: true });
const stack = selectB(all, model, { a, b, shrink: true });

const variants = [
  pack('raw_locked_b', rawAll, rawAll),
  pack('residual_only', residualOnly, rawAll),
  pack('shrink_only', shrinkOnly, rawAll),
  pack('residual_plus_shrink', stack, rawAll),
];

// 嚴格 OOS：只用 2024+2026（參數來自 2025）
function oosPair(bets) {
  const sub = bets.filter((x) => x.window === '2024' || x.window === '2026');
  const rawSub = rawAll.filter((x) => x.window === '2024' || x.window === '2026');
  return {
    ...summarize(sub),
    deltaUsd: summarize(sub).usd50 - summarize(rawSub).usd50,
    d2024:
      summarize(bets.filter((x) => x.window === '2024')).usd50 -
      summarize(rawAll.filter((x) => x.window === '2024')).usd50,
    d2026:
      summarize(bets.filter((x) => x.window === '2026')).usd50 -
      summarize(rawAll.filter((x) => x.window === '2026')).usd50,
  };
}

const oos = {
  residual_only: oosPair(residualOnly),
  shrink_only: oosPair(shrinkOnly),
  residual_plus_shrink: oosPair(stack),
};

const ranked = ['residual_only', 'shrink_only', 'residual_plus_shrink']
  .map((id) => ({
    id,
    oos: oos[id],
    full: variants.find((v) => v.label === id),
  }))
  .sort(
    (x, y) =>
      Number(y.oos.d2024 >= 0 && y.oos.d2026 >= 0) -
        Number(x.oos.d2024 >= 0 && x.oos.d2026 >= 0) ||
      y.oos.deltaUsd - x.oos.deltaUsd
  );

const winner = ranked[0];
const out = {
  experimentId: 'b-home-residual-plus-shrink-stack-2026-07-29',
  coeffs: { aHat: ab.a, bHat: ab.b, scale: bestScale, a, b },
  variants,
  oos2024and2026: oos,
  rankedByStrictOos: ranked,
  recommendation: {
    wireSuggested: false,
    preferredShadow: winner.id,
    note:
      winner.id === 'residual_plus_shrink'
        ? '疊加在 24+26 OOS 最好：雙影子可合併為一條觀察規則'
        : `疊加未贏；嚴格 OOS 首選仍是 ${winner.id}`,
  },
};

fs.writeFileSync(
  new URL('../tmp-b-home-residual-plus-shrink-stack.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\nFULL:');
for (const v of variants) {
  console.log(
    `${v.label.padEnd(22)} Δ$=${v.deltaUsd} win=${v.windowsNonNeg}/3 | 24:${v.byWindow['2024'].deltaUsd} 25:${v.byWindow['2025'].deltaUsd} 26:${v.byWindow['2026'].deltaUsd}`
  );
}
console.log('\nSTRICT OOS 24+26:');
for (const r of ranked) {
  console.log(
    `${r.id.padEnd(22)} oosΔ$=${r.oos.deltaUsd} d24=${r.oos.d2024} d26=${r.oos.d2026}`
  );
}
console.log('\nREC', out.recommendation);
