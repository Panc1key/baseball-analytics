/**
 * 連續跟進：price 細網格 + μ(w=0.35) 疊加
 *   node scripts/auditMlbPriceMuFollowup.mjs
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

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const W_MU = MLB_NORMAL_AWAY_MARKET_SHRINK_SPEC.shrinkWeight || 0.35;
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

console.log('[price-mu-followup] build…');
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
    const modelProbRaw = pickHome
      ? +pred.markets?.homeWinProbability
      : +pred.markets?.awayWinProbability;
    if (!Number.isFinite(modelProbRaw)) continue;
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
    const modelProb = applyMu
      ? (1 - W_MU) * modelProbRaw + W_MU * marketP
      : modelProbRaw;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const evRaw = modelProbRaw * (pickOdds - 1) - (1 - modelProbRaw);
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    const bScoreRaw = scoreMlbMoneylineDailyRank(
      { expectedValue: evRaw, modelProbability: modelProbRaw },
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
      evRaw,
      margin,
      modelProb,
      modelProbRaw,
      bScore,
      bScoreRaw,
      type: formal.type,
    });
  }
}

function evalPicks(picks, baselinePicks, baseline) {
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
  return {
    picks: s,
    dUsd,
    dHrPp,
    byYear,
    nReplaced: baselinePicks.filter(
      (b) => !picks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
    ).length,
    gate:
      dUsd >= 50 &&
      (dHrPp ?? -1) >= -0.2 &&
      yearOk(byYear) &&
      true,
  };
}

const baseElig = selectEligible(
  pool.map((g) => ({ ...g, ev: g.evRaw, modelProb: g.modelProbRaw, bScore: g.bScoreRaw }))
);
const basePicks = selectDaily(baseElig, (g) => g.bScoreRaw);
const baseline = summarize(basePicks);

const muElig = selectEligible(pool);
const muPicks = selectDaily(muElig, (g) => g.bScore);
const muOnly = evalPicks(muPicks, basePicks, baseline);

const priceGrid = [];
for (const lam of [0.01, 0.015, 0.02, 0.025, 0.03, 0.04]) {
  const picks = selectDaily(baseElig, (g) => {
    const pen = g.type === 'normal' && !g.pickHome ? lam : 0;
    return g.bScoreRaw - pen;
  });
  priceGrid.push({ id: `price_pen_normal_away_${lam}`, ...evalPicks(picks, basePicks, baseline) });
}
priceGrid.sort((a, b) => (b.dUsd ?? -999) - (a.dUsd ?? -999));

const stackGrid = [];
for (const lam of [0, 0.01, 0.02, 0.03]) {
  const picks = selectDaily(muElig, (g) => {
    const pen = g.type === 'normal' && !g.pickHome ? lam : 0;
    const boost = g.type === 'strong_home' && !g.pickHome ? 0.02 : 0;
    return g.bScore - pen + boost;
  });
  stackGrid.push({
    id: `mu035_plus_pen${lam}_boostStrongAway02`,
    ...evalPicks(picks, basePicks, baseline),
  });
}
stackGrid.sort((a, b) => (b.dUsd ?? -999) - (a.dUsd ?? -999));

const out = {
  experimentId: 'price-mu-followup-2026-08-08',
  baseline,
  muOnly: { id: `mu_normal_away_w${W_MU}`, ...muOnly },
  pricePromote: priceGrid.filter((t) => t.gate),
  priceTop: priceGrid.slice(0, 6),
  stackPromote: stackGrid.filter((t) => t.gate),
  stackTop: stackGrid.slice(0, 6),
};
fs.writeFileSync(
  new URL('../tmp-price-mu-followup.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      baseline,
      muOnly: out.muOnly,
      pricePromote: out.pricePromote.map((t) => ({
        id: t.id,
        dUsd: t.dUsd,
        dHrPp: t.dHrPp,
        byYear: t.byYear,
      })),
      stackPromote: out.stackPromote.map((t) => ({
        id: t.id,
        dUsd: t.dUsd,
        dHrPp: t.dHrPp,
        byYear: t.byYear,
      })),
      bestPrice: priceGrid[0],
      bestStack: stackGrid[0],
    },
    null,
    2
  )
);
