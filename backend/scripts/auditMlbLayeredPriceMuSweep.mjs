/**
 * 分層下一輪連續掃：Price（type 感知排序／日結構）+ μ（按 type 向市場收縮）
 * 底座固定：ev02_max230 TopK + dropR2/R3；類型來自 resolveMlbGameType
 *
 *   node scripts/auditMlbLayeredPriceMuSweep.mjs
 * 產物: tmp-layered-price-mu-sweep.json
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
import { resolveMlbGameType } from '../src/services/MlbLayeredArchitecture.js';
import { buildBinCalibration, applyBinCalibration } from '../src/services/ProbabilityCalibration.js';

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-08-07' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function books(g, c, h, a) {
  const pit = resolvePitOdds(g, c);
  if (!pit?.bookmakers?.length) return { books: [], totalsLine: null, homeOdds: null };
  const out = [];
  let bestTotals = null;
  let homeOdds = null;
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (m?.outcomes?.length) {
      const home =
        m.outcomes.find((o) => o.name === h) ||
        m.outcomes.find((o) => String(o.name).includes(String(h).split(' ').pop()));
      const away =
        m.outcomes.find((o) => o.name === a) ||
        m.outcomes.find((o) => String(o.name).includes(String(a).split(' ').pop()));
      if (home?.price && away?.price) {
        const ho = +home.price;
        const ao = +away.price;
        if (Number.isFinite(ho) && Number.isFinite(ao)) {
          out.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao });
          if (homeOdds == null || ho < homeOdds) homeOdds = ho;
        }
      }
    }
    const tot = book.markets?.find((x) => x.key === 'totals');
    if (!tot) continue;
    for (const over of tot.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = tot.outcomes.find(
        (o) => o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!over.price || !under?.price) continue;
      const oo = +over.price;
      const uo = +under.price;
      if (!Number.isFinite(oo) || !Number.isFinite(uo)) continue;
      const vig = 1 / oo + 1 / uo;
      if (!bestTotals || vig < bestTotals.vig) bestTotals = { line: Number(over.point), vig };
    }
  }
  return { books: out, totalsLine: bestTotals?.line ?? null, homeOdds };
}

function summarize(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, roi: null, usd50: 0 };
  let unit = 0;
  let hits = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * 50 * 100) / 100,
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

function selectEligible(pool) {
  return pool.filter(
    (g) =>
      g.ev >= B.minimumExpectedValue &&
      g.margin >= B.minimumExpectedRunMargin &&
      g.modelProb >= B.minimumModelProbability &&
      g.pickOdds >= B.minimumPickOdds &&
      g.pickOdds <= B.maximumPickOdds
  );
}

function selectDaily(eligible, scoreFn, { maxDuelPerDay = null } = {}) {
  const map = new Map();
  for (const g of eligible) {
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    let arr = [...map.get(day)].sort(
      (a, b) => scoreFn(b) - scoreFn(a) || b.margin - a.margin
    );
    if (maxDuelPerDay != null) {
      let duelKept = 0;
      arr = arr.filter((g) => {
        if (g.type !== 'pitcher_duel') return true;
        if (duelKept < maxDuelPerDay) {
          duelKept += 1;
          return true;
        }
        return false;
      });
    }
    out.push(...applyDrop(arr));
  }
  return out;
}

function yearOk(y) {
  return (
    (y?.['2024'] ?? -999) >= -80 &&
    (y?.['2025'] ?? -999) >= -80 &&
    (y?.['2026'] ?? -999) >= -80
  );
}

function evalVsBase(picks, baselinePicks, baseline) {
  const s = summarize(picks);
  const byYear = Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const bY = summarize(baselinePicks.filter((x) => x.year === y));
      const kY = summarize(picks.filter((x) => x.year === y));
      return [y, Number((kY.usd50 - bY.usd50).toFixed(2))];
    })
  );
  const dUsd = Number((s.usd50 - baseline.usd50).toFixed(2));
  const dHrPp =
    s.hitRate != null && baseline.hitRate != null
      ? Number(((s.hitRate - baseline.hitRate) * 100).toFixed(2))
      : null;
  const nReplaced = baselinePicks.filter(
    (b) => !picks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
  ).length;
  return {
    picks: s,
    dUsd,
    dHrPp,
    byYearDeltaUsd: byYear,
    nReplaced,
    gatePassed:
      dUsd >= 50 &&
      (dHrPp ?? -1) >= -0.2 &&
      yearOk(byYear) &&
      nReplaced >= 5,
  };
}

function implied(odds) {
  return 1 / odds;
}

console.log('[price-mu-sweep] build…');
const validation = getLatestMlbExpectedRunsValidation();
const pool = [];
for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)`
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
    const pack = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (pack.books.length < 2) continue;
    pack.books.sort((a, b) => a.vig - b.vig);
    const best = pack.books[0];
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
    const formal = resolveMlbGameType({
      features,
      totalsLine: pack.totalsLine,
      homeOdds: pack.homeOdds,
    });
    const marketP = implied(pickOdds);
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    pool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      year: w.key,
      hit: pickHome === hs > as,
      pickHome,
      pickOdds,
      ev,
      margin,
      modelProb,
      marketP,
      bScore,
      type: formal.type,
    });
  }
}

const eligibleRaw = selectEligible(pool);
const baselinePicks = selectDaily(eligibleRaw, (g) => g.bScore);
const baseline = summarize(baselinePicks);
console.log('eligible', eligibleRaw.length, 'baseline', baselinePicks.length, baseline);

/** —— Price：type 軟權重 —— */
const priceTrials = [];
const typePenGrid = [
  { id: 'pen_duel_0.05', pen: { pitcher_duel: 0.05 } },
  { id: 'pen_duel_0.08', pen: { pitcher_duel: 0.08 } },
  { id: 'pen_duel_home_0.1', pen: { pitcher_duel_home: 0.1 } },
  { id: 'boost_strong_0.03', boost: { strong_home: 0.03 } },
  { id: 'boost_strong_away_0.05', boost: { strong_home_away: 0.05 } },
  { id: 'pen_normal_away_0.03', pen: { normal_away: 0.03 } },
  { id: 'pen_normal_away_0.05', pen: { normal_away: 0.05 } },
  { id: 'pen_normal_away_0.08', pen: { normal_away: 0.08 } },
  { id: 'max_duel_0', maxDuelPerDay: 0 },
  { id: 'max_duel_1', maxDuelPerDay: 1 },
  {
    id: 'combo_pen_duel_boost_strong',
    pen: { pitcher_duel: 0.05 },
    boost: { strong_home_away: 0.03 },
  },
  {
    id: 'combo_pen_normal_away_boost_strong',
    pen: { normal_away: 0.05 },
    boost: { strong_home_away: 0.03 },
  },
];

function typeAdj(g, pen = {}, boost = {}) {
  let a = 0;
  if (g.type === 'pitcher_duel') a -= pen.pitcher_duel || 0;
  if (g.type === 'pitcher_duel' && g.pickHome) a -= pen.pitcher_duel_home || 0;
  if (g.type === 'strong_home') a += boost.strong_home || 0;
  if (g.type === 'strong_home' && !g.pickHome) a += boost.strong_home_away || 0;
  if (g.type === 'normal' && !g.pickHome) a -= pen.normal_away || 0;
  return a;
}

for (const t of typePenGrid) {
  const picks = selectDaily(
    eligibleRaw,
    (g) => g.bScore + typeAdj(g, t.pen, t.boost),
    { maxDuelPerDay: t.maxDuelPerDay ?? null }
  );
  priceTrials.push({
    layer: 'price',
    id: t.id,
    ...evalVsBase(picks, baselinePicks, baseline),
  });
}
priceTrials.sort((a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999));

/** —— μ：按 type 向市場收縮 P' = (1-w)*P + w*marketP，再重算 EV／eligible／排序 —— */
const muTrials = [];
const shrinkGrid = [
  { id: 'shrink_all_0.15', w: { normal: 0.15, strong_home: 0.15, pitcher_duel: 0.15 } },
  { id: 'shrink_all_0.25', w: { normal: 0.25, strong_home: 0.25, pitcher_duel: 0.25 } },
  { id: 'shrink_normal_0.2', w: { normal: 0.2 } },
  { id: 'shrink_normal_0.35', w: { normal: 0.35 } },
  { id: 'shrink_duel_0.3', w: { pitcher_duel: 0.3 } },
  { id: 'shrink_duel_0.5', w: { pitcher_duel: 0.5 } },
  { id: 'shrink_strong_0.1', w: { strong_home: 0.1 } },
  { id: 'shrink_strong_0.25', w: { strong_home: 0.25 } },
  {
    id: 'shrink_normal_0.25_duel_0.4',
    w: { normal: 0.25, pitcher_duel: 0.4 },
  },
  {
    id: 'shrink_normal_away_0.3',
    wAwayOnly: { normal: 0.3 },
  },
  {
    id: 'shrink_normal_away_0.45',
    wAwayOnly: { normal: 0.45 },
  },
];

function rebuildEligible(shrinkW = {}, wAwayOnly = {}) {
  const rebuilt = [];
  for (const g of pool) {
    let w = shrinkW[g.type] || 0;
    if (wAwayOnly[g.type] && !g.pickHome) w = wAwayOnly[g.type];
    const p =
      w > 0 ? (1 - w) * g.modelProb + w * g.marketP : g.modelProb;
    const ev = p * (g.pickOdds - 1) - (1 - p);
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: p },
      B
    );
    rebuilt.push({ ...g, modelProb: p, ev, bScore });
  }
  return selectEligible(rebuilt);
}

for (const t of shrinkGrid) {
  const elig = rebuildEligible(t.w || {}, t.wAwayOnly || {});
  const picks = selectDaily(elig, (g) => g.bScore);
  muTrials.push({
    layer: 'mu',
    id: t.id,
    eligibleN: elig.length,
    ...evalVsBase(picks, baselinePicks, baseline),
  });
}

/** —— μ：按 type 分箱校準（用 2024+2025 擬合，測全窗／分年） —— */
const trainPointsByType = {
  normal: [],
  strong_home: [],
  pitcher_duel: [],
};
for (const g of eligibleRaw) {
  if (g.year === '2026') continue;
  if (!trainPointsByType[g.type]) continue;
  trainPointsByType[g.type].push({ p: g.modelProb, y: g.hit ? 1 : 0 });
}
const calTables = {};
for (const [type, pts] of Object.entries(trainPointsByType)) {
  calTables[type] = buildBinCalibration(pts, 0.05);
}

const calPool = pool.map((g) => {
  const table = calTables[g.type];
  const p = table ? applyBinCalibration(g.modelProb, table) : g.modelProb;
  const ev = p * (g.pickOdds - 1) - (1 - p);
  const bScore = scoreMlbMoneylineDailyRank(
    { expectedValue: ev, modelProbability: p },
    B
  );
  return { ...g, modelProb: p, ev, bScore };
});
const calElig = selectEligible(calPool);
const calPicks = selectDaily(calElig, (g) => g.bScore);
muTrials.push({
  layer: 'mu',
  id: 'bin_cal_by_type_train2425',
  eligibleN: calElig.length,
  trainN: Object.fromEntries(
    Object.entries(trainPointsByType).map(([k, v]) => [k, v.length])
  ),
  ...evalVsBase(calPicks, baselinePicks, baseline),
});

muTrials.sort((a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999));

/** —— 疊加：最佳 price + 最佳 μ（若各自過閘） —— */
const bestPrice = priceTrials.find((t) => t.gatePassed) || null;
const bestMu = muTrials.find((t) => t.gatePassed) || null;
let stack = null;
if (bestPrice && bestMu) {
  // 簡化：先 μ 重建 eligible，再套 price 分數調整
  const shrinkMatch = shrinkGrid.find((t) => t.id === bestMu.id);
  let elig = eligibleRaw;
  if (shrinkMatch) {
    elig = rebuildEligible(shrinkMatch.w || {}, shrinkMatch.wAwayOnly || {});
  } else if (bestMu.id === 'bin_cal_by_type_train2425') {
    elig = calElig;
  }
  const priceCfg = typePenGrid.find((t) => t.id === bestPrice.id);
  const picks = selectDaily(
    elig,
    (g) => g.bScore + typeAdj(g, priceCfg?.pen, priceCfg?.boost),
    { maxDuelPerDay: priceCfg?.maxDuelPerDay ?? null }
  );
  stack = {
    id: `stack_${bestPrice.id}__${bestMu.id}`,
    ...evalVsBase(picks, baselinePicks, baseline),
  };
}

const out = {
  experimentId: 'layered-price-mu-sweep-2026-08-08',
  baseline,
  priceTop: priceTrials.slice(0, 10),
  muTop: muTrials.slice(0, 10),
  pricePromote: priceTrials.filter((t) => t.gatePassed),
  muPromote: muTrials.filter((t) => t.gatePassed),
  stack,
  verdict: {
    price: priceTrials.some((t) => t.gatePassed)
      ? 'PRICE_PROMOTE_COMPARE'
      : 'PRICE_NO_PASS',
    mu: muTrials.some((t) => t.gatePassed) ? 'MU_PROMOTE_COMPARE' : 'MU_NO_PASS',
    bestPriceEvenIfFail: priceTrials[0]
      ? {
          id: priceTrials[0].id,
          dUsd: priceTrials[0].dUsd,
          dHrPp: priceTrials[0].dHrPp,
          byYear: priceTrials[0].byYearDeltaUsd,
          passed: priceTrials[0].gatePassed,
        }
      : null,
    bestMuEvenIfFail: muTrials[0]
      ? {
          id: muTrials[0].id,
          dUsd: muTrials[0].dUsd,
          dHrPp: muTrials[0].dHrPp,
          byYear: muTrials[0].byYearDeltaUsd,
          passed: muTrials[0].gatePassed,
        }
      : null,
  },
};

fs.writeFileSync(
  new URL('../tmp-layered-price-mu-sweep.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out.verdict, null, 2));
console.log(
  'pricePromote',
  out.pricePromote.map((t) => ({ id: t.id, dUsd: t.dUsd, dHr: t.dHrPp, y: t.byYearDeltaUsd }))
);
console.log(
  'muPromote',
  out.muPromote.map((t) => ({ id: t.id, dUsd: t.dUsd, dHr: t.dHrPp, y: t.byYearDeltaUsd }))
);
console.log('stack', stack);
console.log('wrote tmp-layered-price-mu-sweep.json');
