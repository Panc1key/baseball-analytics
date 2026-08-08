/**
 * 正式 maxOdds=2.5 已落地；審計曾硬截 2.3。
 * 本腳：
 *  1) LOY / 月合計加壓「保留 2.5 vs 回退 2.3」
 *  2) 在真實 2.5 底座上再掃 score／結構下一刀
 *   node scripts/auditMlbStackTrue25Next.mjs
 * 產物: tmp-stack-true25-next.json
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
const DROP_R3 = Number(B.dropThirdIfMarginBelow) || 0.5;
const DROP_R2_MAX = Number(B.dropSecondIfOddsBelow) || 1.95;
const DROP_R2_MIN = Number(B.dropSecondIfOddsMin) || 1.85;
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
function applyDrop(sorted, dropR3 = DROP_R3) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < dropR3) slots = slots.slice(0, 2);
  if (
    slots.length >= 2 &&
    slots[1].pickOdds >= DROP_R2_MIN &&
    slots[1].pickOdds < DROP_R2_MAX
  ) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}
function selectEligible(pool, { maxOdds = B.maximumPickOdds, minEv = B.minimumExpectedValue } = {}) {
  return pool.filter(
    (g) =>
      g.ev >= minEv &&
      g.margin >= B.minimumExpectedRunMargin &&
      g.modelProb >= B.minimumModelProbability &&
      g.pickOdds >= B.minimumPickOdds &&
      g.pickOdds <= maxOdds
  );
}
function stackScore(g, { pen = PEN, boost = BOOST, duelPen = 0, thinEdge = null } = {}) {
  let s = g.bScore;
  if (g.type === 'normal' && !g.pickHome) s -= pen;
  if (g.type === 'strong_home' && !g.pickHome) s += boost;
  if (g.type === 'pitcher_duel') s -= duelPen;
  if (thinEdge != null && g.edge < thinEdge) s -= 0.05;
  if (g.pickOdds > 2.3) s -= 0; // placeholder
  return s;
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
function yearOk(y) {
  return (
    (y?.['2024'] ?? -999) >= -80 &&
    (y?.['2025'] ?? -999) >= -80 &&
    (y?.['2026'] ?? -999) >= -80
  );
}

console.log('[true25-next] build…');
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
    if (pack.books.length < 2) continue;
    pack.books.sort((a, b) => a.vig - b.vig);
    const best = pack.books[0];
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.5) continue;
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
    if (formal.type === 'normal' && !pickHome) {
      p = (1 - W_MU) * p + W_MU * (1 / pickOdds);
    }
    const ev = p * (pickOdds - 1) - (1 - p);
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: p },
      B
    );
    pool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      year: w.key,
      month: hk(row.commenceTime).slice(0, 7),
      hit: pickHome === hs > as,
      pickHome,
      pickOdds,
      ev,
      margin,
      modelProb: p,
      bScore,
      type: formal.type,
      edge: p - 1 / pickOdds,
    });
  }
}

const elig25 = selectEligible(pool, { maxOdds: 2.5 });
const basePicks = selectDaily(elig25, (g) => stackScore(g));
const baseline = summarize(basePicks);

const elig23 = selectEligible(pool, { maxOdds: 2.3 });
const picks23 = selectDaily(elig23, (g) => stackScore(g));
const s23 = summarize(picks23);

function deltaVs(picksAlt, picksBase = basePicks) {
  const s = summarize(picksAlt);
  const b = summarize(picksBase);
  const byYear = Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const bY = summarize(picksBase.filter((x) => x.year === y));
      const kY = summarize(picksAlt.filter((x) => x.year === y));
      return [y, Number((kY.usd50 - bY.usd50).toFixed(2))];
    })
  );
  const dUsd = Number((s.usd50 - b.usd50).toFixed(2));
  const dHrPp =
    s.hitRate != null && b.hitRate != null
      ? Number(((s.hitRate - b.hitRate) * 100).toFixed(2))
      : null;
  return {
    picks: s,
    dUsd,
    dHrPp,
    byYear,
    nReplaced: picksBase.filter(
      (b0) => !picksAlt.some((p) => p.gameId === b0.gameId && p.pickHome === b0.pickHome)
    ).length,
    gate: dUsd >= 50 && (dHrPp ?? -1) >= -0.2 && yearOk(byYear),
  };
}

// 25 vs 23：保留 2.5 相對「若回退 2.3」的增量
const keep25Vs23 = (() => {
  const s = summarize(basePicks);
  const b = summarize(picks23);
  const byYear = Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const bY = summarize(picks23.filter((x) => x.year === y));
      const kY = summarize(basePicks.filter((x) => x.year === y));
      return [y, Number((kY.usd50 - bY.usd50).toFixed(2))];
    })
  );
  const dUsd = Number((s.usd50 - b.usd50).toFixed(2));
  const dHrPp =
    s.hitRate != null && b.hitRate != null
      ? Number(((s.hitRate - b.hitRate) * 100).toFixed(2))
      : null;
  const loy = {};
  for (const leave of ['2024', '2025', '2026']) {
    const keep = ['2024', '2025', '2026'].filter((y) => y !== leave);
    const a = summarize(basePicks.filter((x) => keep.includes(x.year)));
    const c = summarize(picks23.filter((x) => keep.includes(x.year)));
    loy[leave] = Number((a.usd50 - c.usd50).toFixed(2));
  }
  const months = [...new Set(pool.map((g) => g.month))].sort();
  let monthSum = 0;
  let monthPos = 0;
  for (const m of months) {
    const a = summarize(basePicks.filter((x) => x.month === m));
    const c = summarize(picks23.filter((x) => x.month === m));
    const d = a.usd50 - c.usd50;
    monthSum += d;
    if (d > 0) monthPos += 1;
  }
  return {
    cap25: s,
    cap23: b,
    dUsd,
    dHrPp,
    byYear,
    loy,
    monthSum: Number(monthSum.toFixed(2)),
    monthPos,
    monthN: months.length,
    stressPass:
      dUsd >= 50 &&
      (dHrPp ?? -1) >= -0.2 &&
      yearOk(byYear) &&
      Object.values(loy).every((v) => v >= 0) &&
      monthSum >= 0,
  };
})();

const trials = [];
// soft demote odds>2.3 on true 2.5 base
for (const lam of [0.02, 0.04, 0.06, 0.08]) {
  trials.push({
    id: `pen_odds_gt23_${lam}`,
    ...deltaVs(
      selectDaily(elig25, (g) => stackScore(g) - (g.pickOdds > 2.3 ? lam : 0))
    ),
  });
}
for (const lam of [0.02, 0.03, 0.05]) {
  trials.push({
    id: `extra_pen_duel_${lam}`,
    ...deltaVs(selectDaily(elig25, (g) => stackScore(g, { duelPen: lam }))),
  });
}
for (const t of [0.02, 0.03, 0.04]) {
  trials.push({
    id: `pen_thin_edge_lt_${t}`,
    ...deltaVs(selectDaily(elig25, (g) => stackScore(g, { thinEdge: t }))),
  });
}
// hard cut odds>2.3 (= rollback) already in keep25Vs23 as negative of keep
trials.push({
  id: 'hard_maxOdds_2.3_rollback',
  ...deltaVs(picks23),
});
// minEv back to 0.02 on 2.5 base
trials.push({
  id: 'minEv_0.02',
  ...deltaVs(selectDaily(selectEligible(pool, { maxOdds: 2.5, minEv: 0.02 }), (g) => stackScore(g))),
});
// topK 4
trials.push({
  id: 'topK_4',
  ...(() => {
    const map = new Map();
    for (const g of elig25) {
      if (!map.has(g.day)) map.set(g.day, []);
      map.get(g.day).push(g);
    }
    const picks = [];
    for (const day of [...map.keys()].sort()) {
      let arr = [...map.get(day)].sort(
        (a, b) => stackScore(b) - stackScore(a) || b.margin - a.margin
      );
      let slots = arr.slice(0, 4);
      if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
      if (
        slots.length >= 2 &&
        slots[1].pickOdds >= DROP_R2_MIN &&
        slots[1].pickOdds < DROP_R2_MAX
      ) {
        slots = [slots[0], ...slots.slice(2)];
      }
      picks.push(...slots);
    }
    return deltaVs(picks);
  })(),
});

trials.sort((a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999));
const promote = trials.filter((t) => t.gate);

const out = {
  experimentId: 'stack-true25-next-2026-08-08',
  trueBaseline25: baseline,
  keep25VsRollback23: {
    ...keep25Vs23,
  },
  promote,
  top: trials.slice(0, 12),
  verdict: {
    keep25Stress: keep25Vs23.stressPass
      ? 'KEEP_MAXODDS_25_STRESS_PASS'
      : 'KEEP_MAXODDS_25_STRESS_WEAK_MOSTLY_2024',
    nextKnife: promote.length ? 'FOUND_NEXT_COMPARE' : 'NO_NEXT_ON_TRUE25',
  },
};
fs.writeFileSync(
  new URL('../tmp-stack-true25-next.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      trueBaseline25: baseline,
      keep25Vs23: {
        dUsd: keep25Vs23.dUsd,
        dHrPp: keep25Vs23.dHrPp,
        byYear: keep25Vs23.byYear,
        loy: keep25Vs23.loy,
        monthSum: keep25Vs23.monthSum,
        stressPass: keep25Vs23.stressPass,
      },
      promote: promote.map((t) => ({
        id: t.id,
        dUsd: t.dUsd,
        dHrPp: t.dHrPp,
        byYear: t.byYear,
      })),
      bestFail: trials[0]
        ? {
            id: trials[0].id,
            dUsd: trials[0].dUsd,
            dHrPp: trials[0].dHrPp,
            byYear: trials[0].byYear,
            gate: trials[0].gate,
          }
        : null,
      verdict: out.verdict,
    },
    null,
    2
  )
);
