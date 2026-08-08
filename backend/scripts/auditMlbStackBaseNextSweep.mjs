/**
 * 新 apply 疊用底座上連續掃：
 * 1) 端到端確認 stack vs raw
 * 2) 賠率帶／dropR3／TopK 結構
 * 3) 額外 type 微調
 *
 *   node scripts/auditMlbStackBaseNextSweep.mjs
 * 產物: tmp-stack-base-next-sweep.json
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
import { MLB_NORMAL_AWAY_MARKET_SHRINK_SPEC } from '../src/services/MlbNormalAwayMarketShrinkShadow.js';
import { MLB_TYPE_AWARE_RANK_SPEC } from '../src/services/MlbTypeAwareRankShadow.js';

const B0 = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const W_MU = MLB_NORMAL_AWAY_MARKET_SHRINK_SPEC.shrinkWeight || 0.35;
const PEN = MLB_TYPE_AWARE_RANK_SPEC.normalAwayPenalty || 0.01;
const BOOST = MLB_TYPE_AWARE_RANK_SPEC.strongHomeAwayBoost || 0.02;
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
function yearOk(y) {
  return (
    (y?.['2024'] ?? -999) >= -80 &&
    (y?.['2025'] ?? -999) >= -80 &&
    (y?.['2026'] ?? -999) >= -80
  );
}

function applyDrop(sorted, { dropR3 = 0.5, dropR2Min = 1.85, dropR2Max = 1.95, topK = 3 } = {}) {
  let slots = sorted.slice(0, topK);
  if (slots.length >= 3 && dropR3 != null && slots[2].margin < dropR3) {
    slots = slots.slice(0, 2);
  }
  if (
    dropR2Max != null &&
    slots.length >= 2 &&
    slots[1].pickOdds >= dropR2Min &&
    slots[1].pickOdds < dropR2Max
  ) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}

function selectEligible(pool, rules) {
  return pool.filter(
    (g) =>
      g.ev >= rules.minimumExpectedValue &&
      g.margin >= rules.minimumExpectedRunMargin &&
      g.modelProb >= rules.minimumModelProbability &&
      g.pickOdds >= rules.minimumPickOdds &&
      g.pickOdds <= rules.maximumPickOdds
  );
}

function selectDaily(eligible, scoreFn, dropOpts) {
  const map = new Map();
  for (const g of eligible) {
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const arr = [...map.get(day)].sort(
      (a, b) => scoreFn(b) - scoreFn(a) || b.margin - a.margin
    );
    out.push(...applyDrop(arr, dropOpts));
  }
  return out;
}

function scoreRaw(g) {
  return g.bScoreRaw;
}
function scoreStack(g) {
  let s = g.bScoreMu;
  if (g.type === 'normal' && !g.pickHome) s -= PEN;
  if (g.type === 'strong_home' && !g.pickHome) s += BOOST;
  return s;
}

console.log('[stack-base-next] build…');
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
    const pRaw = pickHome
      ? +pred.markets?.homeWinProbability
      : +pred.markets?.awayWinProbability;
    if (!Number.isFinite(pRaw)) continue;
    const pack = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (pack.books.length < 2) continue;
    pack.books.sort((a, b) => a.vig - b.vig);
    const best = pack.books[0];
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
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
    const marketP = 1 / pickOdds;
    const applyMu = formal.type === 'normal' && !pickHome;
    const pMu = applyMu ? (1 - W_MU) * pRaw + W_MU * marketP : pRaw;
    const evRaw = pRaw * (pickOdds - 1) - (1 - pRaw);
    const evMu = pMu * (pickOdds - 1) - (1 - pMu);
    pool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      year: w.key,
      hit: pickHome === hs > as,
      pickHome,
      pickOdds,
      margin,
      type: formal.type,
      pRaw,
      pMu,
      evRaw,
      evMu,
      modelProb: pMu,
      ev: evMu,
      bScoreRaw: scoreMlbMoneylineDailyRank(
        { expectedValue: evRaw, modelProbability: pRaw },
        B0
      ),
      bScoreMu: scoreMlbMoneylineDailyRank(
        { expectedValue: evMu, modelProbability: pMu },
        B0
      ),
    });
  }
}

function runPolicy({
  useStack = true,
  rules = B0,
  dropR3 = 0.5,
  dropR2Min = 1.85,
  dropR2Max = 1.95,
  topK = 3,
  extraScore = null,
} = {}) {
  const mapped = pool.map((g) => ({
    ...g,
    modelProb: useStack ? g.pMu : g.pRaw,
    ev: useStack ? g.evMu : g.evRaw,
  }));
  const elig = selectEligible(mapped, rules);
  const scoreFn = (g) => {
    let s = useStack ? scoreStack(g) : scoreRaw(g);
    if (extraScore) s += extraScore(g);
    return s;
  };
  return selectDaily(elig, scoreFn, { dropR3, dropR2Min, dropR2Max, topK });
}

function evalVs(basePicks, altPicks) {
  const baseline = summarize(basePicks);
  const alt = summarize(altPicks);
  const byYear = Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const b = summarize(basePicks.filter((x) => x.year === y));
      const a = summarize(altPicks.filter((x) => x.year === y));
      return [y, Number((a.usd50 - b.usd50).toFixed(2))];
    })
  );
  const dUsd = Number((alt.usd50 - baseline.usd50).toFixed(2));
  const dHrPp =
    alt.hitRate != null && baseline.hitRate != null
      ? Number(((alt.hitRate - baseline.hitRate) * 100).toFixed(2))
      : null;
  return {
    baseline,
    alt,
    dUsd,
    dHrPp,
    byYear,
    nReplaced: basePicks.filter(
      (b) => !altPicks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
    ).length,
    gate: dUsd >= 50 && (dHrPp ?? -1) >= -0.2 && yearOk(byYear),
  };
}

const rawPicks = runPolicy({ useStack: false });
const stackPicks = runPolicy({ useStack: true });
const e2e = evalVs(rawPicks, stackPicks);

/** 在 stack 底座上掃結構 */
const stackBase = stackPicks;
const structureTrials = [];

for (const dropR3 of [0.4, 0.5, 0.6, 0.7, 0.8]) {
  const picks = runPolicy({ useStack: true, dropR3 });
  structureTrials.push({ id: `dropR3_${dropR3}`, ...evalVs(stackBase, picks) });
}
for (const topK of [2, 3, 4]) {
  const picks = runPolicy({ useStack: true, topK });
  structureTrials.push({ id: `topK_${topK}`, ...evalVs(stackBase, picks) });
}
for (const maxOdds of [2.1, 2.2, 2.3, 2.4]) {
  const rules = { ...B0, maximumPickOdds: maxOdds };
  const picks = runPolicy({ useStack: true, rules });
  structureTrials.push({ id: `maxOdds_${maxOdds}`, ...evalVs(stackBase, picks) });
}
for (const minOdds of [1.5, 1.6, 1.7, 1.75]) {
  const rules = { ...B0, minimumPickOdds: minOdds };
  const picks = runPolicy({ useStack: true, rules });
  structureTrials.push({ id: `minOdds_${minOdds}`, ...evalVs(stackBase, picks) });
}
for (const minEv of [0.015, 0.02, 0.025, 0.03]) {
  const rules = { ...B0, minimumExpectedValue: minEv };
  const picks = runPolicy({ useStack: true, rules });
  structureTrials.push({ id: `minEv_${minEv}`, ...evalVs(stackBase, picks) });
}
// dropR2 band variants
for (const band of [
  { min: 1.85, max: 1.95 },
  { min: 1.8, max: 1.9 },
  { min: 1.9, max: 2.0 },
  { min: 0, max: 0 }, // off
]) {
  const picks = runPolicy({
    useStack: true,
    dropR2Min: band.min,
    dropR2Max: band.max === 0 ? null : band.max,
  });
  structureTrials.push({
    id: band.max === 0 ? 'dropR2_off' : `dropR2_${band.min}_${band.max}`,
    ...evalVs(stackBase, picks),
  });
}

structureTrials.sort((a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999));
const structurePromote = structureTrials.filter((t) => t.gate && t.nReplaced >= 3);

/** 額外微調（相對 stack） */
const micro = [];
for (const boost of [0.01, 0.02, 0.03]) {
  const picks = runPolicy({
    useStack: true,
    extraScore: (g) => (g.type === 'strong_home' && g.pickHome ? boost : 0),
  });
  micro.push({ id: `boost_strong_home_${boost}`, ...evalVs(stackBase, picks) });
}
for (const pen of [0.02, 0.04]) {
  const picks = runPolicy({
    useStack: true,
    extraScore: (g) => (g.type === 'pitcher_duel' && g.pickHome ? -pen : 0),
  });
  micro.push({ id: `pen_duel_home_${pen}`, ...evalVs(stackBase, picks) });
}
for (const pen of [0.02, 0.03]) {
  const picks = runPolicy({
    useStack: true,
    extraScore: (g) => (g.margin < 0.75 ? -pen : 0),
  });
  micro.push({ id: `pen_thin_margin_${pen}`, ...evalVs(stackBase, picks) });
}
micro.sort((a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999));
const microPromote = micro.filter((t) => t.gate && t.nReplaced >= 3);

const out = {
  experimentId: 'stack-base-next-sweep-2026-08-08',
  e2eConfirm: {
    plain: 'raw Locked B → μ+price stack apply',
    ...e2e,
    confirmed: e2e.dUsd >= 500 && yearOk(e2e.byYear),
  },
  structurePromote,
  structureTop: structureTrials.slice(0, 12),
  microPromote,
  microTop: micro.slice(0, 8),
  verdict: {
    e2eOk: e2e.dUsd >= 500,
    nextStructure: structurePromote[0]?.id || null,
    nextMicro: microPromote[0]?.id || null,
  },
};

fs.writeFileSync(
  new URL('../tmp-stack-base-next-sweep.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      e2e: {
        dUsd: e2e.dUsd,
        dHrPp: e2e.dHrPp,
        byYear: e2e.byYear,
        raw: e2e.baseline,
        stack: e2e.alt,
        confirmed: out.e2eConfirm.confirmed,
      },
      structurePromote: structurePromote.map((t) => ({
        id: t.id,
        dUsd: t.dUsd,
        dHrPp: t.dHrPp,
        byYear: t.byYear,
        nReplaced: t.nReplaced,
      })),
      microPromote: microPromote.map((t) => ({
        id: t.id,
        dUsd: t.dUsd,
        dHrPp: t.dHrPp,
        byYear: t.byYear,
      })),
      bestStructureEvenFail: structureTrials[0]
        ? {
            id: structureTrials[0].id,
            dUsd: structureTrials[0].dUsd,
            byYear: structureTrials[0].byYear,
            gate: structureTrials[0].gate,
          }
        : null,
      bestMicroEvenFail: micro[0]
        ? { id: micro[0].id, dUsd: micro[0].dUsd, byYear: micro[0].byYear, gate: micro[0].gate }
        : null,
    },
    null,
    2
  )
);
