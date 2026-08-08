/**
 * 在 stack apply 底座上：minEv 0.015 放量加壓 + books≥3 / 其他門檻
 *   node scripts/auditMlbStackMinEvStress.mjs
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
  if (!pit?.bookmakers?.length) return { list: [], totalsLine: null, homeOdds: null };
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
  return { list: out, totalsLine: bestTotals?.line ?? null, homeOdds };
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
  if (slots.length >= 3 && slots[2].margin < 0.5) slots = slots.slice(0, 2);
  if (slots.length >= 2 && slots[1].pickOdds >= 1.85 && slots[1].pickOdds < 1.95) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
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
function scoreStack(g) {
  let s = g.bScore;
  if (g.type === 'normal' && !g.pickHome) s -= PEN;
  if (g.type === 'strong_home' && !g.pickHome) s += BOOST;
  return s;
}

console.log('[stack-minEv] build…');
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
    let p = pickHome
      ? +pred.markets?.homeWinProbability
      : +pred.markets?.awayWinProbability;
    if (!Number.isFinite(p)) continue;
    const pack = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    const bs = pack.list;
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
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
      homeOdds: pack.homeOdds ?? best.homeOdds,
    });
    if (formal.type === 'normal' && !pickHome) {
      p = (1 - W_MU) * p + W_MU * (1 / pickOdds);
    }
    const ev = p * (pickOdds - 1) - (1 - p);
    pool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      year: w.key,
      hit: pickHome === hs > as,
      pickHome,
      pickOdds,
      ev,
      margin,
      modelProb: p,
      bookCount: bs.length,
      type: formal.type,
      bScore: scoreMlbMoneylineDailyRank(
        { expectedValue: ev, modelProbability: p },
        B
      ),
    });
  }
}

function elig(minEv, minBooks = 2) {
  return pool.filter(
    (g) =>
      g.bookCount >= minBooks &&
      g.ev >= minEv &&
      g.margin >= B.minimumExpectedRunMargin &&
      g.modelProb >= B.minimumModelProbability &&
      g.pickOdds >= B.minimumPickOdds &&
      g.pickOdds <= B.maximumPickOdds
  );
}

const basePicks = selectDaily(elig(0.02), scoreStack);
const baseline = summarize(basePicks);
const alt015 = selectDaily(elig(0.015), scoreStack);
const altBooks3 = selectDaily(elig(0.02, 3), scoreStack);
const alt015books3 = selectDaily(elig(0.015, 3), scoreStack);

function pack(label, picks) {
  const s = summarize(picks);
  const byYear = Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const b = summarize(basePicks.filter((x) => x.year === y));
      const a = summarize(picks.filter((x) => x.year === y));
      return [y, Number((a.usd50 - b.usd50).toFixed(2))];
    })
  );
  return {
    id: label,
    picks: s,
    dUsd: Number((s.usd50 - baseline.usd50).toFixed(2)),
    dHrPp:
      s.hitRate != null && baseline.hitRate != null
        ? Number(((s.hitRate - baseline.hitRate) * 100).toFixed(2))
        : null,
    byYear,
  };
}

const fixed = [
  pack('minEv_0.015', alt015),
  pack('books_ge3', altBooks3),
  pack('minEv_0.015_books3', alt015books3),
];

const months = [...new Set(pool.map((g) => g.month))].sort().filter((m) => m >= '2024-05');
const monthly = [];
for (const m of months) {
  const sub = pool.filter((g) => g.month === m);
  const b = selectDaily(
    sub.filter(
      (g) =>
        g.bookCount >= 2 &&
        g.ev >= 0.02 &&
        g.margin >= B.minimumExpectedRunMargin &&
        g.modelProb >= B.minimumModelProbability &&
        g.pickOdds >= B.minimumPickOdds &&
        g.pickOdds <= B.maximumPickOdds
    ),
    scoreStack
  );
  const a = selectDaily(
    sub.filter(
      (g) =>
        g.bookCount >= 2 &&
        g.ev >= 0.015 &&
        g.margin >= B.minimumExpectedRunMargin &&
        g.modelProb >= B.minimumModelProbability &&
        g.pickOdds >= B.minimumPickOdds &&
        g.pickOdds <= B.maximumPickOdds
    ),
    scoreStack
  );
  const bs = summarize(b);
  const as = summarize(a);
  monthly.push({
    month: m,
    dUsd: Number((as.usd50 - bs.usd50).toFixed(2)),
    baseN: bs.bets,
    altN: as.bets,
  });
}
const mPos = monthly.filter((r) => (r.dUsd || 0) > 0).length;
const mNeg = monthly.filter((r) => (r.dUsd || 0) < 0).length;
const mSum = Number(monthly.reduce((s, r) => s + (r.dUsd || 0), 0).toFixed(2));

const loy = ['2024', '2025', '2026'].map((hold) => {
  const sub = pool.filter((g) => g.year === hold);
  const b = selectDaily(
    sub.filter(
      (g) =>
        g.ev >= 0.02 &&
        g.bookCount >= 2 &&
        g.margin >= B.minimumExpectedRunMargin &&
        g.modelProb >= B.minimumModelProbability &&
        g.pickOdds >= B.minimumPickOdds &&
        g.pickOdds <= B.maximumPickOdds
    ),
    scoreStack
  );
  const a = selectDaily(
    sub.filter(
      (g) =>
        g.ev >= 0.015 &&
        g.bookCount >= 2 &&
        g.margin >= B.minimumExpectedRunMargin &&
        g.modelProb >= B.minimumModelProbability &&
        g.pickOdds >= B.minimumPickOdds &&
        g.pickOdds <= B.maximumPickOdds
    ),
    scoreStack
  );
  return {
    holdYear: hold,
    dUsd: Number((summarize(a).usd50 - summarize(b).usd50).toFixed(2)),
  };
});

const cand = fixed.find((f) => f.id === 'minEv_0.015');
const stress = {
  fixedOk: (cand?.dUsd ?? -1) >= 40 && (cand?.dHrPp ?? -1) >= -0.2,
  monthlyOk: mPos >= mNeg && mSum >= 0,
  loyOk: loy.every((r) => (r.dUsd ?? -1) >= -40),
  loyAllPos: loy.every((r) => (r.dUsd ?? -1) >= 0),
};
const allPass = stress.fixedOk && stress.monthlyOk && stress.loyOk;

const out = {
  experimentId: 'stack-minEv-stress-2026-08-08',
  baseline,
  fixed,
  monthly: { rows: monthly, pos: mPos, neg: mNeg, sum: mSum },
  leaveOneYear: loy,
  stress,
  allPass,
  verdict: allPass
    ? stress.loyAllPos
      ? 'PASS_MAY_APPLY_MINEV_015'
      : 'PASS_COMPARE_MINEV_015'
    : 'FAIL_KEEP_MINEV_02',
};
fs.writeFileSync(
  new URL('../tmp-stack-minEv-stress.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
