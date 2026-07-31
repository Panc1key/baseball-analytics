/**
 * 凍結係數決策：影子上線會 freeze，不會每月重擬合
 * 比較 freeze(2025) 的 ab+shrink vs b+shrink
 * - 全月 beat/hurt（含/不含 2025）
 * - 安慰劑（翻 b 號、洗牌）
 * - 機制（丟/增注 ROI）
 *
 * 用法：node scripts/auditMlbFrozenShadowBvsAb.mjs
 * 產物：tmp-b-frozen-shadow-b-vs-ab.json
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
function pickScale(val, model, ab, mode) {
  const raw = summarize(selectB(val, model, {}));
  let best = 0.25;
  let bestD = -Infinity;
  for (const s of SCALES) {
    const c =
      mode === 'ab'
        ? { a: ab.a * s, b: ab.b * s }
        : { a: 0, b: ab.b * s };
    const d = summarize(selectB(val, model, { ...c, shrink: false })).usd50 - raw.usd50;
    if (d > bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}
function monthStats(opt, raw) {
  const months = [...new Set([...opt, ...raw].map((b) => b.month))].sort();
  const rows = months.map((m) => {
    const o = summarize(opt.filter((b) => b.month === m));
    const r = summarize(raw.filter((b) => b.month === m));
    return { month: m, deltaUsd: o.usd50 - r.usd50, rawUsd: r.usd50, optUsd: o.usd50 };
  });
  return {
    rows,
    beat: rows.filter((r) => r.deltaUsd > 0).length,
    hurt: rows.filter((r) => r.deltaUsd < 0).length,
    flat: rows.filter((r) => r.deltaUsd === 0).length,
    sum: rows.reduce((s, r) => s + r.deltaUsd, 0),
  };
}
function mech(raw, opt) {
  const rk = new Set(raw.map((b) => `${b.day}|${b.gameId}|${b.pickHome ? 'H' : 'A'}`));
  const ok = new Set(opt.map((b) => `${b.day}|${b.gameId}|${b.pickHome ? 'H' : 'A'}`));
  const rawMap = new Map(raw.map((b) => [`${b.day}|${b.gameId}|${b.pickHome ? 'H' : 'A'}`, b]));
  const optMap = new Map(opt.map((b) => [`${b.day}|${b.gameId}|${b.pickHome ? 'H' : 'A'}`, b]));
  const dropped = [...rk].filter((k) => !ok.has(k)).map((k) => rawMap.get(k));
  const added = [...ok].filter((k) => !rk.has(k)).map((k) => optMap.get(k));
  return {
    dropped: summarize(dropped),
    added: summarize(added),
    droppedN: dropped.length,
    addedN: added.length,
  };
}
function mulberry32(a) {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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
const ab = fitAB(p2025.slice(0, split));
const scaleAb = pickScale(p2025.slice(split), model, ab, 'ab');
const scaleB = pickScale(p2025.slice(split), model, ab, 'b');
const coeffAb = { a: ab.a * scaleAb, b: ab.b * scaleAb };
const coeffB = { a: 0, b: ab.b * scaleB };

const raw = selectB(all, model, {});
const abStack = selectB(all, model, { ...coeffAb, shrink: true });
const bStack = selectB(all, model, { ...coeffB, shrink: true });

function score(name, bets, coeffs) {
  const oos = bets.filter((x) => x.window !== '2025');
  const rawOos = raw.filter((x) => x.window !== '2025');
  const byW = {};
  for (const y of ['2024', '2025', '2026']) {
    byW[y] = {
      deltaUsd:
        summarize(bets.filter((b) => b.window === y)).usd50 -
        summarize(raw.filter((b) => b.window === y)).usd50,
    };
  }
  const mAll = monthStats(bets, raw);
  const mOos = monthStats(oos, rawOos);
  return {
    name,
    coeffs,
    fullDelta: summarize(bets).usd50 - summarize(raw).usd50,
    oosDelta: summarize(oos).usd50 - summarize(rawOos).usd50,
    byWindow: byW,
    monthAll: { beat: mAll.beat, hurt: mAll.hurt, flat: mAll.flat, sum: mAll.sum },
    monthOos: { beat: mOos.beat, hurt: mOos.hurt, flat: mOos.flat, sum: mOos.sum },
    monthRowsOos: mOos.rows,
    mechanism: mech(raw, bets),
  };
}

const abScore = score('frozen_ab+shrink', abStack, coeffAb);
const bScore = score('frozen_b+shrink', bStack, coeffB);

// Placebo on OOS for b+shrink
const oosPool = [...pools['2024'], ...pools['2026']];
const rawOos = selectB(oosPool, model, {});
const trueB = selectB(oosPool, model, { ...coeffB, shrink: true });
const flipB = selectB(oosPool, model, { a: 0, b: -coeffB.b, shrink: true });
const shuffles = [1, 2, 3, 4, 5].map((seed) => {
  const sh = shuffleX(oosPool, seed);
  // keep same frozen |b| but on shuffled x
  const opt = selectB(sh, model, { a: 0, b: coeffB.b, shrink: true });
  const r = selectB(sh, model, {});
  return summarize(opt).usd50 - summarize(r).usd50;
});
const placebo = {
  trueDelta: summarize(trueB).usd50 - summarize(rawOos).usd50,
  flipDelta: summarize(flipB).usd50 - summarize(rawOos).usd50,
  shuffleMean: Number((shuffles.reduce((s, x) => s + x, 0) / shuffles.length).toFixed(1)),
  shuffles,
  beatsFlip: summarize(trueB).usd50 - summarize(rawOos).usd50 > summarize(flipB).usd50 - summarize(rawOos).usd50,
  beatsShuffles: shuffles.every(
    (d) => summarize(trueB).usd50 - summarize(rawOos).usd50 > d
  ),
};

const preferB =
  bScore.oosDelta >= abScore.oosDelta &&
  bScore.monthOos.hurt <= abScore.monthOos.hurt &&
  bScore.byWindow['2024'].deltaUsd >= 0 &&
  bScore.byWindow['2026'].deltaUsd >= 0 &&
  placebo.beatsFlip &&
  placebo.beatsShuffles;

const out = {
  experimentId: 'b-frozen-shadow-b-vs-ab-2026-07-29',
  freezeProtocol: 'fit 2025 70/30 select scale; freeze forever; + shrink_p55@0.45',
  coeffAb,
  coeffB,
  scaleAb,
  scaleB,
  abHat: ab,
  abScore,
  bScore,
  placeboB: placebo,
  decision: {
    preferredFrozenShadow: preferB ? 'frozen_b+shrink' : 'frozen_ab+shrink',
    wireSuggested: false,
    reasons: preferB
      ? [
          '凍結前提下 b+shrink OOS ≥ ab+shrink',
          'OOS 月 hurt 不更差',
          'b 跨年符號穩定（先前檢驗），關掉不穩 a',
          '安慰劑翻號/洗牌敗給真規則',
        ]
      : [
          '凍結下 ab 仍優或 b 未同時過安慰劑/月級',
          '維持 ab+shrink，但持續標記 a 不穩',
        ],
  },
};

fs.writeFileSync(
  new URL('../tmp-b-frozen-shadow-b-vs-ab.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('AB', {
  oos: abScore.oosDelta,
  byW: abScore.byWindow,
  monthOos: abScore.monthOos,
  mech: abScore.mechanism,
});
console.log('B ', {
  oos: bScore.oosDelta,
  byW: bScore.byWindow,
  monthOos: bScore.monthOos,
  mech: bScore.mechanism,
});
console.log('PLACEBO B', placebo);
console.log('DECISION', out.decision);
