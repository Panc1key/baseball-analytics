/**
 * 在正式 μ(normal×away w=0.35)+price+minEv1.5%+maxOdds2.5 底座上，
 * 試「鄰近 μ 細胞」是否仍正面可加：duel shrink／normal-home shrink／strong shrink。
 *   node scripts/auditMlbMuAdjacentOnStack.mjs
 * 產物: tmp-mu-adjacent-on-stack.json
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

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const W0 = MLB_NORMAL_AWAY_MARKET_SHRINK_SPEC.shrinkWeight || 0.35;
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
function stackScore(g) {
  let s = g.bScore;
  if (g.type === 'normal' && !g.pickHome) s -= PEN;
  if (g.type === 'strong_home' && !g.pickHome) s += BOOST;
  return s;
}
function selectDaily(eligible) {
  const map = new Map();
  for (const g of eligible) {
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const arr = [...map.get(day)].sort(
      (a, b) => stackScore(b) - stackScore(a) || b.margin - a.margin
    );
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

/**
 * shrinkPlan: { normalAway, normalHome, duel, duelAwayOnly, strongAway, strongHome }
 * values are weights; undefined/0 = no extra shrink (normalAway always has W0 in base)
 */
function rebuild(rawPool, plan) {
  return rawPool.map((g) => {
    let p = g.pRaw;
    const mkt = 1 / g.pickOdds;
    // base formal
    if (g.type === 'normal' && !g.pickHome) {
      p = (1 - W0) * g.pRaw + W0 * mkt;
    }
    // adjacent extras (applied on top of already-shrunk p, or from raw for non-base cells)
    const apply = (w) => {
      if (!w) return;
      p = (1 - w) * p + w * mkt;
    };
    if (g.type === 'normal' && g.pickHome) apply(plan.normalHome);
    if (g.type === 'pitcher_duel') {
      if (plan.duelAwayOnly) {
        if (!g.pickHome) apply(plan.duelAwayOnly);
      } else apply(plan.duel);
    }
    if (g.type === 'strong_home' && !g.pickHome) apply(plan.strongAway);
    if (g.type === 'strong_home' && g.pickHome) apply(plan.strongHome);
    // optional: raise normalAway beyond W0
    if (g.type === 'normal' && !g.pickHome && plan.normalAwayExtra) {
      // reinterpret: target weight = W0 + extra toward market from current
      apply(plan.normalAwayExtra);
    }
    const ev = p * (g.pickOdds - 1) - (1 - p);
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: p },
      B
    );
    return { ...g, modelProb: p, ev, bScore, edge: p - mkt };
  });
}

console.log('[mu-adjacent] build raw…');
const validation = getLatestMlbExpectedRunsValidation();
const rawPool = [];
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
    if (pickOdds < 1.4 || pickOdds > B.maximumPickOdds) continue;
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
    rawPool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      year: w.key,
      month: hk(row.commenceTime).slice(0, 7),
      hit: pickHome === hs > as,
      pickHome,
      pickOdds,
      margin,
      pRaw,
      type: formal.type,
    });
  }
}

const basePool = rebuild(rawPool, {});
const basePicks = selectDaily(selectEligible(basePool));
const baseline = summarize(basePicks);

function evalPlan(id, plan) {
  const pool = rebuild(rawPool, plan);
  const picks = selectDaily(selectEligible(pool));
  const s = summarize(picks);
  const byYear = Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const bY = summarize(basePicks.filter((x) => x.year === y));
      const kY = summarize(picks.filter((x) => x.year === y));
      return [y, Number((kY.usd50 - bY.usd50).toFixed(2))];
    })
  );
  const dUsd = Number((s.usd50 - baseline.usd50).toFixed(2));
  const dHrPp =
    s.hitRate != null && baseline.hitRate != null
      ? Number(((s.hitRate - baseline.hitRate) * 100).toFixed(2))
      : null;
  const loy = {};
  for (const leave of ['2024', '2025', '2026']) {
    const keep = ['2024', '2025', '2026'].filter((y) => y !== leave);
    const a = summarize(picks.filter((x) => keep.includes(x.year)));
    const b = summarize(basePicks.filter((x) => keep.includes(x.year)));
    loy[leave] = Number((a.usd50 - b.usd50).toFixed(2));
  }
  const months = [...new Set(rawPool.map((g) => g.month))].sort();
  let monthSum = 0;
  for (const m of months) {
    const a = summarize(picks.filter((x) => x.month === m));
    const b = summarize(basePicks.filter((x) => x.month === m));
    monthSum += a.usd50 - b.usd50;
  }
  const warmup = 3;
  let expUsd = 0;
  const expByYear = { '2024': 0, '2025': 0, '2026': 0 };
  for (let i = warmup; i < months.length; i++) {
    const m = months[i];
    const a = summarize(picks.filter((x) => x.month === m));
    const b = summarize(basePicks.filter((x) => x.month === m));
    const d = a.usd50 - b.usd50;
    expUsd += d;
    const y = m.slice(0, 4);
    if (expByYear[y] != null) expByYear[y] += d;
  }
  const fixedPass =
    dUsd >= 50 && (dHrPp ?? -1) >= -0.2 && yearOk(byYear);
  const stressPass =
    fixedPass &&
    Object.values(loy).every((v) => v >= 0) &&
    monthSum >= 0 &&
    expUsd >= 0 &&
    (expByYear['2024'] ?? -999) >= -80 &&
    (expByYear['2025'] ?? -999) >= -80 &&
    (expByYear['2026'] ?? -999) >= -80;
  return {
    id,
    plan,
    picks: s,
    dUsd,
    dHrPp,
    byYear,
    loy,
    monthSum: Number(monthSum.toFixed(2)),
    expanding: {
      dUsd: Math.round(expUsd * 100) / 100,
      byYear: Object.fromEntries(
        Object.entries(expByYear).map(([k, v]) => [k, Number(v.toFixed(2))])
      ),
    },
    nReplaced: basePicks.filter(
      (b) => !picks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
    ).length,
    gateFixed: fixedPass,
    gateStress: stressPass,
  };
}

const trials = [];
for (const w of [0.2, 0.3, 0.4, 0.5]) {
  trials.push(evalPlan(`duel_shrink_${w}`, { duel: w }));
  trials.push(evalPlan(`duel_away_shrink_${w}`, { duelAwayOnly: w }));
}
for (const w of [0.1, 0.2, 0.3]) {
  trials.push(evalPlan(`normal_home_shrink_${w}`, { normalHome: w }));
}
for (const w of [0.1, 0.2, 0.3]) {
  trials.push(evalPlan(`strong_away_shrink_${w}`, { strongAway: w }));
}
for (const w of [0.05, 0.1, 0.15]) {
  trials.push(evalPlan(`normal_away_extra_${w}`, { normalAwayExtra: w }));
}

trials.sort((a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999));
const promote = trials.filter((t) => t.gateStress);
const fixedOnly = trials.filter((t) => t.gateFixed && !t.gateStress);

const out = {
  experimentId: 'mu-adjacent-on-stack-2026-08-08',
  note: '底座含 normal×away w=0.35 + type-aware price + minEv0.015 + maxOdds2.5',
  baseline,
  promote,
  fixedOnlyTop: fixedOnly.slice(0, 5),
  top: trials.slice(0, 12),
  verdict: promote.length
    ? 'FOUND_MU_ADJACENT_MAY_APPLY'
    : fixedOnly.length
      ? 'FIXED_ONLY_KEEP_COMPARE'
      : 'NO_MU_ADJACENT',
};
fs.writeFileSync(
  new URL('../tmp-mu-adjacent-on-stack.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      baseline,
      promote: promote.map((t) => ({
        id: t.id,
        dUsd: t.dUsd,
        dHrPp: t.dHrPp,
        byYear: t.byYear,
        loy: t.loy,
        monthSum: t.monthSum,
        expanding: t.expanding,
      })),
      fixedOnlyTop: fixedOnly.slice(0, 3).map((t) => ({
        id: t.id,
        dUsd: t.dUsd,
        dHrPp: t.dHrPp,
        byYear: t.byYear,
        loy: t.loy,
      })),
      best: trials[0]
        ? {
            id: trials[0].id,
            dUsd: trials[0].dUsd,
            dHrPp: trials[0].dHrPp,
            byYear: trials[0].byYear,
            loy: trials[0].loy,
            gateFixed: trials[0].gateFixed,
            gateStress: trials[0].gateStress,
          }
        : null,
      verdict: out.verdict,
    },
    null,
    2
  )
);
