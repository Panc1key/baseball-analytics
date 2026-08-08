/**
 * 下一刀：在 μ+price+minEv1.5% 正式疊用底座上，掃再增益
 * （含 μ w 重建、score 微調、結構硬切）
 *   node scripts/auditMlbPostStackNextKnife.mjs
 * 產物: tmp-post-stack-next-knife.json
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
function stackScore(g) {
  let s = g.bScore;
  if (g.type === 'normal' && !g.pickHome) s -= PEN;
  if (g.type === 'strong_home' && !g.pickHome) s += BOOST;
  return s;
}

console.log('[post-stack-next] build…');
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
    const pRaw = p;
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
      hit: pickHome === hs > as,
      pickHome,
      pickOdds,
      ev,
      margin,
      modelProb: p,
      pRaw,
      bScore,
      type: formal.type,
      edge: p - 1 / pickOdds,
    });
  }
}

const elig = selectEligible(pool);
const basePicks = selectDaily(elig, stackScore);
const baseline = summarize(basePicks);

function evalFn(scoreFn, filterFn = null) {
  const e = filterFn ? elig.filter(filterFn) : elig;
  // filter removes from eligible entirely
  const pool2 = filterFn
    ? selectEligible(pool.filter(filterFn))
    : elig;
  const picks = selectDaily(filterFn ? pool2 : elig, scoreFn || stackScore);
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
  return {
    picks: s,
    dUsd,
    dHrPp,
    byYear,
    nReplaced: basePicks.filter(
      (b) => !picks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
    ).length,
    gate: dUsd >= 50 && (dHrPp ?? -1) >= -0.2 && yearOk(byYear),
  };
}

const trials = [];

function rebuildWithMuWeight(wMu) {
  return pool.map((g) => {
    let p = g.pRaw;
    if (g.type === 'normal' && !g.pickHome) {
      p = (1 - wMu) * g.pRaw + wMu * (1 / g.pickOdds);
    }
    const ev = p * (g.pickOdds - 1) - (1 - p);
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: p },
      B
    );
    return {
      ...g,
      modelProb: p,
      ev,
      bScore,
      edge: p - 1 / g.pickOdds,
    };
  });
}

function evalRebuiltPool(rebuilt, scoreFn = null) {
  const elig2 = selectEligible(rebuilt);
  const sf = scoreFn || ((g) => {
    let s = g.bScore;
    if (g.type === 'normal' && !g.pickHome) s -= PEN;
    if (g.type === 'strong_home' && !g.pickHome) s += BOOST;
    return s;
  });
  const picks = selectDaily(elig2, sf);
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
  return {
    picks: s,
    dUsd,
    dHrPp,
    byYear,
    nReplaced: basePicks.filter(
      (b) => !picks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
    ).length,
    gate: dUsd >= 50 && (dHrPp ?? -1) >= -0.2 && yearOk(byYear),
  };
}

// 1) μ w 相對底座 0.35
for (const w of [0.25, 0.3, 0.4, 0.45, 0.5]) {
  trials.push({
    id: `mu_w_${w}`,
    ...evalRebuiltPool(rebuildWithMuWeight(w)),
  });
}

// score-only next knives on stack base
for (const lam of [0.02, 0.03, 0.05]) {
  trials.push({
    id: `extra_pen_duel_${lam}`,
    ...evalFn((g) => stackScore(g) - (g.type === 'pitcher_duel' ? lam : 0)),
  });
}
for (const lam of [0.02, 0.04, 0.06]) {
  trials.push({
    id: `extra_pen_normal_home_${lam}`,
    ...evalFn((g) => stackScore(g) - (g.type === 'normal' && g.pickHome ? lam : 0)),
  });
}
for (const boost of [0.01, 0.03, 0.05]) {
  trials.push({
    id: `extra_boost_strong_away_${boost}`,
    ...evalFn(
      (g) =>
        stackScore(g) +
        (g.type === 'strong_home' && !g.pickHome ? boost : 0)
    ),
  });
}
// edge soft: demote thin edge
for (const t of [0.02, 0.03, 0.04]) {
  trials.push({
    id: `pen_thin_edge_lt_${t}`,
    ...evalFn((g) => stackScore(g) - (g.edge < t ? 0.05 : 0)),
  });
}
// hard skip duel from TopK
trials.push({
  id: 'hard_skip_duel',
  ...evalFn(stackScore, (g) => g.type !== 'pitcher_duel'),
});
// dropR3 tighter 0.6
trials.push({
  id: 'dropR3_margin_0.6',
  ...(() => {
    const map = new Map();
    for (const g of elig) {
      if (!map.has(g.day)) map.set(g.day, []);
      map.get(g.day).push(g);
    }
    const picks = [];
    for (const day of [...map.keys()].sort()) {
      let arr = [...map.get(day)].sort(
        (a, b) => stackScore(b) - stackScore(a) || b.margin - a.margin
      );
      let slots = arr.slice(0, 3);
      if (slots.length >= 3 && slots[2].margin < 0.6) slots = slots.slice(0, 2);
      if (
        slots.length >= 2 &&
        slots[1].pickOdds >= DROP_R2_MIN &&
        slots[1].pickOdds < DROP_R2_MAX
      ) {
        slots = [slots[0], ...slots.slice(2)];
      }
      picks.push(...slots);
    }
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
    return {
      picks: s,
      dUsd,
      dHrPp,
      byYear,
      nReplaced: basePicks.filter(
        (b) => !picks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
      ).length,
      gate: dUsd >= 50 && (dHrPp ?? -1) >= -0.2 && yearOk(byYear),
    };
  })(),
});

trials.sort((a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999));
const promote = trials.filter((t) => t.gate);

const out = {
  experimentId: 'post-stack-minEv015-next-knife-2026-08-08',
  note: 'baseline = μ w0.35 + type-aware price + minEv0.015 Locked B',
  stackBaseline: baseline,
  promote,
  top: trials.slice(0, 12),
  verdict: promote.length ? 'FOUND_NEXT_COMPARE' : 'NO_NEXT_KNIFE_ON_STACK',
};
fs.writeFileSync(
  new URL('../tmp-post-stack-next-knife.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      stackBaseline: baseline,
      promote: promote.map((t) => ({
        id: t.id,
        dUsd: t.dUsd,
        dHrPp: t.dHrPp,
        byYear: t.byYear,
        nReplaced: t.nReplaced,
      })),
      bestEvenIfFail: trials[0]
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
