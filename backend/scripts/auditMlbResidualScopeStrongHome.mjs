/**
 * 殘差作用域剝離：全場 vs 僅強主場(homeWinPct≥0.65) × ab/b × ±shrink
 *
 * 假設：毒單在強主場客選 → 殘差應只在該區生效，減少 a 不穩對弱主場的亂修
 *
 * 用法：node scripts/auditMlbResidualScopeStrongHome.mjs
 * 產物：tmp-b-residual-scope-strong-home.json
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
function selectB(
  pool,
  model,
  { a = 0, b = 0, shrink = false, scope = 'all' } = {}
) {
  const byDay = new Map();
  for (const g of pool) {
    const applyResidual =
      scope === 'all' || (scope === 'strong' && g.homeWinPct >= STRONG);
    const pred =
      !applyResidual || (a === 0 && b === 0)
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
function fitAB(pool, scope) {
  const hX = [];
  const hY = [];
  const aX = [];
  const aY = [];
  for (const g of pool) {
    if (scope === 'strong' && g.homeWinPct < STRONG) continue;
    hX.push(g.xHome);
    hY.push(g.homeScore - g.base.homeExpectedRuns);
    aX.push(g.xHome);
    aY.push(g.awayScore - g.base.awayExpectedRuns);
  }
  if (!hX.length) return { a: 0, b: 0, n: 0 };
  return {
    a: fitRidge(hX, hY, RIDGE),
    b: fitRidge(aX, aY, RIDGE),
    n: hX.length,
  };
}
function coeffs(ab, mode, scale) {
  if (mode === 'ab') return { a: ab.a * scale, b: ab.b * scale };
  if (mode === 'b') return { a: 0, b: ab.b * scale };
  return { a: 0, b: 0 };
}
function pickScale(val, model, ab, mode, scope) {
  const raw = summarize(selectB(val, model, { scope }));
  let best = 0.25;
  let bestD = -Infinity;
  for (const s of SCALES) {
    const c = coeffs(ab, mode, s);
    const opt = summarize(selectB(val, model, { ...c, shrink: false, scope }));
    const d = opt.usd50 - raw.usd50;
    if (d > bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}
function monthBH(opt, raw) {
  const months = new Set([...opt.map((b) => b.month), ...raw.map((b) => b.month)]);
  let beat = 0;
  let hurt = 0;
  let flat = 0;
  for (const m of months) {
    const d =
      summarize(opt.filter((b) => b.month === m)).usd50 -
      summarize(raw.filter((b) => b.month === m)).usd50;
    if (d > 0) beat += 1;
    else if (d < 0) hurt += 1;
    else flat += 1;
  }
  return { beat, hurt, flat };
}
function evalVariant(label, bets, rawAll) {
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
  let winNonNeg = 0;
  for (const y of ['2024', '2025', '2026']) if (byWindow[y].deltaUsd >= 0) winNonNeg += 1;
  return {
    label,
    overall: summarize(bets),
    deltaUsd: summarize(bets).usd50 - summarize(rawAll).usd50,
    byWindow,
    windowsNonNeg: winNonNeg,
    oos: {
      deltaUsd: summarize(oosB).usd50 - summarize(oosR).usd50,
      d2024: byWindow['2024'].deltaUsd,
      d2026: byWindow['2026'].deltaUsd,
    },
    monthOos: monthBH(oosB, oosR),
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

const rawAll = selectB(all, model, {});
const variants = [];

for (const scope of ['all', 'strong']) {
  for (const mode of ['ab', 'b']) {
    const ab = fitAB(fit25, scope === 'strong' ? 'strong' : 'all');
    const scale = pickScale(val25, model, ab, mode, scope);
    const c = coeffs(ab, mode, scale);
    for (const shrink of [false, true]) {
      const bets = selectB(all, model, { ...c, shrink, scope });
      const label = `${scope}_${mode}${shrink ? '+shrink' : ''}`;
      const pack = evalVariant(label, bets, rawAll);
      pack.fit = { ab, scale, coeffs: c, scope, mode };
      variants.push(pack);
    }
  }
}
variants.push(evalVariant('shrink_only', selectB(all, model, { shrink: true }), rawAll));

// Expanding for top candidates
function expanding(scope, mode) {
  const months = [...new Set(all.map((g) => g.month))].sort();
  const rows = [];
  for (const m of months) {
    const prior = all.filter((g) => g.month < m);
    if (prior.length < 200) continue;
    const test = all.filter((g) => g.month === m);
    const fitSplit = Math.floor(prior.length * 0.7);
    const fitP = prior.slice(0, Math.max(50, fitSplit));
    const valP = prior.slice(Math.max(50, fitSplit));
    const ab = fitAB(fitP, scope === 'strong' ? 'strong' : 'all');
    const scale =
      valP.length >= 40 ? pickScale(valP, model, ab, mode, scope) : 1;
    const c = coeffs(ab, mode, scale);
    const raw = selectB(test, model, {});
    const opt = selectB(test, model, { ...c, shrink: true, scope });
    rows.push({
      month: m,
      deltaUsd: summarize(opt).usd50 - summarize(raw).usd50,
      a: Number(c.a.toFixed(4)),
      b: Number(c.b.toFixed(4)),
    });
  }
  return {
    scope,
    mode,
    beat: rows.filter((r) => r.deltaUsd > 0).length,
    hurt: rows.filter((r) => r.deltaUsd < 0).length,
    flat: rows.filter((r) => r.deltaUsd === 0).length,
    sumDeltaUsd: rows.reduce((s, r) => s + r.deltaUsd, 0),
    rows,
  };
}

const expandingWf = [
  expanding('all', 'ab'),
  expanding('all', 'b'),
  expanding('strong', 'ab'),
  expanding('strong', 'b'),
];

const ranked = [...variants].sort(
  (x, y) =>
    Number(y.oos.d2024 >= 0 && y.oos.d2026 >= 0) -
      Number(x.oos.d2024 >= 0 && x.oos.d2026 >= 0) ||
    y.oos.deltaUsd - x.oos.deltaUsd
);

const best = ranked[0];
const baseline = ranked.find((v) => v.label === 'all_ab+shrink');
const out = {
  experimentId: 'b-residual-scope-strong-home-2026-07-29',
  variants,
  rankedByStrictOos: ranked.map((v) => ({
    label: v.label,
    oos: v.oos,
    win: v.windowsNonNeg,
    monthOos: v.monthOos,
    fullDelta: v.deltaUsd,
  })),
  expandingWf,
  recommendation: {
    wireSuggested: false,
    preferredShadow: best.label,
    vsAllAbShrink: baseline
      ? {
          bestLabel: best.label,
          bestOos: best.oos.deltaUsd,
          allAbShrinkOos: baseline.oos.deltaUsd,
          improved: best.oos.deltaUsd > baseline.oos.deltaUsd,
        }
      : null,
    note:
      best.label.startsWith('strong_')
        ? '強主場作用域贏過全場：敘事更對症，升格主影子候選'
        : '強主場作用域未贏全場 ab+shrink：維持全場殘差+shrink',
  },
};

fs.writeFileSync(
  new URL('../tmp-b-residual-scope-strong-home.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\nRANKED OOS:');
for (const r of out.rankedByStrictOos) {
  console.log(
    `${r.label.padEnd(22)} oosΔ$${r.oos.deltaUsd} d24=${r.oos.d2024} d26=${r.oos.d2026} win=${r.win}/3 m ${r.monthOos.beat}/${r.monthOos.hurt}`
  );
}
console.log('\nEXPANDING:');
for (const e of expandingWf) {
  console.log(
    `${e.scope}_${e.mode}+shrink`.padEnd(22),
    `${e.beat}/${e.hurt}/${e.flat} sumΔ$${e.sumDeltaUsd}`
  );
}
console.log('\nREC', out.recommendation);
