/**
 * μ(w=0.35) + price(pen0.01 + boostStrongAway0.02) 固定參數加壓
 * expanding WF（不重選參）+ leave-one-year + 月度固定
 *
 *   node scripts/auditMlbMuPriceStackStress.mjs
 * 產物: tmp-mu-price-stack-stress.json
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

function selectEligible(pool, useMu) {
  return pool.filter((g) => {
    const ev = useMu ? g.evMu : g.evRaw;
    const p = useMu ? g.pMu : g.pRaw;
    return (
      ev >= B.minimumExpectedValue &&
      g.margin >= B.minimumExpectedRunMargin &&
      p >= B.minimumModelProbability &&
      g.pickOdds >= B.minimumPickOdds &&
      g.pickOdds <= B.maximumPickOdds
    );
  });
}

function selectDaily(eligible, scoreFn) {
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
    out.push(...applyDrop(arr));
  }
  return out;
}

function scoreBase(g) {
  return g.bScoreRaw;
}

function scoreStack(g) {
  let s = g.bScoreMu;
  if (g.type === 'normal' && !g.pickHome) s -= PEN;
  if (g.type === 'strong_home' && !g.pickHome) s += BOOST;
  return s;
}

console.log('[mu-price-stack-stress] build…');
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
      bScoreRaw: scoreMlbMoneylineDailyRank(
        { expectedValue: evRaw, modelProbability: pRaw },
        B
      ),
      bScoreMu: scoreMlbMoneylineDailyRank(
        { expectedValue: evMu, modelProbability: pMu },
        B
      ),
    });
  }
}

const basePicks = selectDaily(selectEligible(pool, false), scoreBase);
const stackPicks = selectDaily(selectEligible(pool, true), scoreStack);
const baseline = summarize(basePicks);
const stacked = summarize(stackPicks);

function byYearDelta(baseArr, altArr) {
  return Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const b = summarize(baseArr.filter((x) => x.year === y));
      const a = summarize(altArr.filter((x) => x.year === y));
      return [y, Number((a.usd50 - b.usd50).toFixed(2))];
    })
  );
}

const fixed = {
  dUsd: Number((stacked.usd50 - baseline.usd50).toFixed(2)),
  dHrPp:
    stacked.hitRate != null && baseline.hitRate != null
      ? Number(((stacked.hitRate - baseline.hitRate) * 100).toFixed(2))
      : null,
  byYear: byYearDelta(basePicks, stackPicks),
  baseline,
  stacked,
  nReplaced: basePicks.filter(
    (b) => !stackPicks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
  ).length,
};

const months = [...new Set(pool.map((g) => g.month))].sort().filter((m) => m >= '2024-05');
const monthly = [];
for (const m of months) {
  const sub = pool.filter((g) => g.month === m);
  const b = selectDaily(selectEligible(sub, false), scoreBase);
  const s = selectDaily(selectEligible(sub, true), scoreStack);
  const bs = summarize(b);
  const ss = summarize(s);
  monthly.push({
    month: m,
    dUsd: Number((ss.usd50 - bs.usd50).toFixed(2)),
    dHrPp:
      ss.hitRate != null && bs.hitRate != null
        ? Number(((ss.hitRate - bs.hitRate) * 100).toFixed(2))
        : null,
    baseN: bs.bets,
    stackN: ss.bets,
  });
}
const monthlyPos = monthly.filter((r) => (r.dUsd || 0) > 0).length;
const monthlyNeg = monthly.filter((r) => (r.dUsd || 0) < 0).length;
const monthlySum = Number(monthly.reduce((s, r) => s + (r.dUsd || 0), 0).toFixed(2));

/** Expanding：固定參數，不重選；累計 OOS 月 */
const wf = monthly.filter((r) => r.month >= '2024-06');
const wfDelta = Number(wf.reduce((s, r) => s + (r.dUsd || 0), 0).toFixed(2));
const wfBeat = wf.filter((r) => (r.dUsd || 0) > 0).length;
const wfHurt = wf.filter((r) => (r.dUsd || 0) < 0).length;

const loy = [];
for (const hold of ['2024', '2025', '2026']) {
  const test = pool.filter((g) => g.year === hold);
  const b = selectDaily(selectEligible(test, false), scoreBase);
  const s = selectDaily(selectEligible(test, true), scoreStack);
  const bs = summarize(b);
  const ss = summarize(s);
  loy.push({
    holdYear: hold,
    dUsd: Number((ss.usd50 - bs.usd50).toFixed(2)),
    dHrPp:
      ss.hitRate != null && bs.hitRate != null
        ? Number(((ss.hitRate - bs.hitRate) * 100).toFixed(2))
        : null,
  });
}

const stressGates = {
  fixedPositive:
    fixed.dUsd >= 50 &&
    (fixed.dHrPp ?? -1) >= 0 &&
    (fixed.byYear['2024'] ?? -999) >= -80 &&
    (fixed.byYear['2025'] ?? -999) >= -80 &&
    (fixed.byYear['2026'] ?? -999) >= -80,
  monthlyBeatGeHurt: monthlyPos >= monthlyNeg,
  expandingFixedNonNeg: wfDelta >= 0 && wfBeat >= wfHurt,
  leaveOneYearAllPos: loy.every((r) => (r.dUsd ?? -1) >= 0),
};
const allPass = Object.values(stressGates).every(Boolean);

const out = {
  experimentId: 'mu-price-stack-stress-2026-08-08',
  params: { wMu: W_MU, penNormalAway: PEN, boostStrongAway: BOOST },
  fixed,
  monthly: { rows: monthly, pos: monthlyPos, neg: monthlyNeg, sumDUsd: monthlySum },
  expandingFixed: { rows: wf, deltaUsd: wfDelta, beat: wfBeat, hurt: wfHurt },
  leaveOneYear: loy,
  stressGates,
  allPass,
  promoteApply: allPass,
  verdict: allPass ? 'PASS_STRESS_MAY_APPLY' : 'FAIL_STRESS_KEEP_COMPARE',
};

fs.writeFileSync(
  new URL('../tmp-mu-price-stack-stress.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      params: out.params,
      fixed: {
        dUsd: fixed.dUsd,
        dHrPp: fixed.dHrPp,
        byYear: fixed.byYear,
        nReplaced: fixed.nReplaced,
      },
      monthly: { pos: monthlyPos, neg: monthlyNeg, sum: monthlySum },
      expandingFixed: { deltaUsd: wfDelta, beatHurt: `${wfBeat}/${wfHurt}` },
      leaveOneYear: loy,
      stressGates,
      allPass,
      verdict: out.verdict,
    },
    null,
    2
  )
);
