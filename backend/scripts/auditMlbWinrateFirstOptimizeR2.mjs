/**
 * 勝率優先第二輪：提高 P 門檻、限賠率、edgeVsBe 底線
 * 產物：tmp-winrate-first-optimize-r2.json
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
import {
  applyFormalLockedBResidual,
  applyFormalToxicAwayShrink,
} from '../src/services/MlbFrozenBShadow.js';

const B = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: 2,
};
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

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
function applyDrop(sorted, topK = 3) {
  let slots = sorted.slice(0, topK);
  if (topK >= 3 && slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
  if (
    topK >= 2 &&
    slots.length >= 2 &&
    slots[1].pickOdds >= DROP_R2_MIN &&
    slots[1].pickOdds < DROP_R2_MAX
  ) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}
function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hitRate: null, avgOdds: null, beHr: null, edgeVsBePp: null, usd50: 0 };
  }
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
  const avgOdds = odds / n;
  const hr = hits / n;
  return {
    bets: n,
    hitRate: Number(hr.toFixed(4)),
    avgOdds: Number(avgOdds.toFixed(3)),
    beHr: Number((1 / avgOdds).toFixed(4)),
    edgeVsBePp: Number(((hr - 1 / avgOdds) * 100).toFixed(2)),
    usd50: Math.round(unit * 50),
  };
}
function parlay(bets) {
  const byDay = new Map();
  for (const b of bets) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  }
  let unit = 0;
  let tickets = 0;
  let hits = 0;
  for (const [, list] of byDay) {
    const s = [...list].sort((a, b) => a.rank - b.rank);
    if (s.length < 2) continue;
    tickets += 1;
    if (s[0].hit && s[1].hit) {
      hits += 1;
      unit += s[0].pickOdds * s[1].pickOdds - 1;
    } else unit -= 1;
  }
  return {
    tickets,
    hitRate: tickets ? Number((hits / tickets).toFixed(4)) : null,
    usd25: Math.round(unit * 25),
  };
}

const model = getLatestMlbExpectedRunsValidation()?.model;
const candsByDay = new Map();
for (const w of WINDOWS) {
  console.log('load', w.key);
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS hs, g.away_score AS ascore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
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
    const hs = +row.hs;
    const as = +row.ascore;
    if (hs === as) continue;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    )
      continue;
    const homeWinPct = Number(features?.home?.homeWinPct);
    if (!Number.isFinite(homeWinPct)) continue;
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) continue;
    let pred = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    pred = applyFormalLockedBResidual(model, pred, features, { totalLine: 8.5 });
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    const sig = buildPregameRegimeSignals(features);
    if (
      (pickHome ? sig.homeEarlyExitsLast3 : sig.awayEarlyExitsLast3) >
      (pickHome ? sig.awayEarlyExitsLast3 : sig.homeEarlyExitsLast3)
    )
      continue;
    modelProb = applyFormalToxicAwayShrink(modelProb, pickOdds, {
      pickHome,
      homeWinPct,
    });
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue) continue;
    if (margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (pickOdds < B.minimumPickOdds || pickOdds > B.maximumPickOdds) continue;
    const evRankScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    const day = `${w.key}:${hk(row.commenceTime)}`;
    if (!candsByDay.has(day)) candsByDay.set(day, []);
    candsByDay.get(day).push({
      window: w.key,
      pickHome,
      pickOdds,
      homeWinPct,
      ev,
      modelProb,
      margin,
      evRankScore,
      edgeVsBe: modelProb - 1 / pickOdds,
      hit: pickHome ? hs > as : as > hs,
      marketFavHome: best.homeOdds <= best.awayOdds,
    });
  }
}

function select(policy) {
  const out = [];
  for (const [day, cands] of candsByDay) {
    let pool = cands.filter((c) => {
      if (policy.minP != null && c.modelProb < policy.minP) return false;
      if (policy.maxOdds != null && c.pickOdds > policy.maxOdds) return false;
      if (policy.minEdgeVsBe != null && c.edgeVsBe < policy.minEdgeVsBe) return false;
      if (policy.banStrongAway && !c.pickHome && c.homeWinPct >= (policy.hwpMin || 0.62))
        return false;
      if (
        policy.onlyMarketFav &&
        ((c.pickHome && !c.marketFavHome) || (!c.pickHome && c.marketFavHome))
      )
        return false;
      return true;
    });
    const sorted = [...pool].sort((a, b) => {
      if (policy.rankBy === 'modelProb')
        return b.modelProb - a.modelProb || b.edgeVsBe - a.edgeVsBe;
      if (policy.rankBy === 'edgeVsBe')
        return b.edgeVsBe - a.edgeVsBe || b.modelProb - a.modelProb;
      return b.evRankScore - a.evRankScore || b.margin - a.margin;
    });
    applyDrop(sorted, policy.topK ?? 3).forEach((b, i) =>
      out.push({ ...b, day, rank: i + 1 })
    );
  }
  return out;
}

const policies = [
  { id: 'official', rankBy: 'ev' },
  { id: 'minP55_ev', rankBy: 'ev', minP: 0.55 },
  { id: 'minP56_ev', rankBy: 'ev', minP: 0.56 },
  { id: 'minP55_edgeRank', rankBy: 'edgeVsBe', minP: 0.55 },
  { id: 'minP55_probRank', rankBy: 'modelProb', minP: 0.55 },
  { id: 'minEdge04_ev', rankBy: 'ev', minEdgeVsBe: 0.04 },
  { id: 'minEdge05_ev', rankBy: 'ev', minEdgeVsBe: 0.05 },
  { id: 'maxOdds205_ev', rankBy: 'ev', maxOdds: 2.05 },
  { id: 'maxOdds210_minP55', rankBy: 'modelProb', maxOdds: 2.1, minP: 0.55 },
  {
    id: 'minP55_ban062',
    rankBy: 'modelProb',
    minP: 0.55,
    banStrongAway: true,
    hwpMin: 0.62,
  },
  {
    id: 'minP55_max210_ban062',
    rankBy: 'modelProb',
    minP: 0.55,
    maxOdds: 2.1,
    banStrongAway: true,
    hwpMin: 0.62,
  },
  {
    id: 'minEdge04_ban062_probRank',
    rankBy: 'modelProb',
    minEdgeVsBe: 0.04,
    banStrongAway: true,
    hwpMin: 0.62,
  },
  { id: 'top1_minP55', rankBy: 'modelProb', minP: 0.55, topK: 1 },
  { id: 'top1_edge', rankBy: 'edgeVsBe', topK: 1 },
  {
    id: 'top2_minP55_ban062',
    rankBy: 'modelProb',
    minP: 0.55,
    banStrongAway: true,
    hwpMin: 0.62,
    topK: 2,
  },
  { id: 'onlyFav_minP54', rankBy: 'modelProb', onlyMarketFav: true, minP: 0.54 },
];

const base = select(policies[0]);
const baseL = summarize(base);
const baseP = parlay(base);

const results = policies.map((p) => {
  const bets = select(p);
  const ledger = summarize(bets);
  const par = parlay(bets);
  return {
    id: p.id,
    ledger,
    parlay: par,
    deltaHrPp:
      ledger.hitRate != null && baseL.hitRate != null
        ? Number(((ledger.hitRate - baseL.hitRate) * 100).toFixed(2))
        : null,
    deltaUsd: ledger.usd50 - baseL.usd50,
    deltaParlay: par.usd25 - baseP.usd25,
    awayShare: bets.length
      ? Number((bets.filter((b) => !b.pickHome).length / bets.length).toFixed(3))
      : null,
  };
});

results.sort((a, b) => {
  // 勝率優先，且相對打平 edge 不惡化，注數不要少到沒意義（>=150）
  const aThin = (a.ledger.bets || 0) < 150;
  const bThin = (b.ledger.bets || 0) < 150;
  if (aThin !== bThin) return aThin ? 1 : -1;
  const aScore =
    (a.deltaHrPp ?? -99) * 10 +
    (a.ledger.edgeVsBePp ?? -99) +
    Math.min(0, (a.deltaUsd ?? 0) / 1000);
  const bScore =
    (b.deltaHrPp ?? -99) * 10 +
    (b.ledger.edgeVsBePp ?? -99) +
    Math.min(0, (b.deltaUsd ?? 0) / 1000);
  return bScore - aScore;
});

const recommend = results.find(
  (r) =>
    (r.ledger.bets || 0) >= 200 &&
    (r.deltaHrPp ?? 0) >= 1 &&
    (r.ledger.edgeVsBePp ?? -99) >= (baseL.edgeVsBePp ?? 0) - 1
) || results.find((r) => (r.deltaHrPp ?? 0) >= 1.5 && (r.ledger.bets || 0) >= 150) || results[0];

const report = {
  experimentId: 'winrate-first-optimize-r2-2026-08-07',
  baseline: { ledger: baseL, parlay: baseP },
  ranked: results,
  recommend,
};
fs.writeFileSync(
  new URL('../tmp-winrate-first-optimize-r2.json', import.meta.url),
  JSON.stringify(report, null, 2)
);
console.log('BASE', baseL);
console.log(
  'TOP10',
  results.slice(0, 10).map((r) => ({
    id: r.id,
    n: r.ledger.bets,
    hr: r.ledger.hitRate,
    dHr: r.deltaHrPp,
    edge: r.ledger.edgeVsBePp,
    usd: r.ledger.usd50,
    dUsd: r.deltaUsd,
    parHr: r.parlay.hitRate,
    away: r.awayShare,
  }))
);
console.log('RECOMMEND', recommend);
