/**
 * 診斷後：對 A 補場加嚴過濾做固定參數 OOS（不接入）
 * 底座：edge≥2pp + B&lt;2 + Top1
 * 產物：tmp-a-fill-tighten-oos.json
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

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const WINDOWS = [
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
function summarize(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, usd50: 0 };
  let unit = 0;
  let hits = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  return {
    bets: bets.length,
    hitRate: Number((hits / bets.length).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}
function build(from, to) {
  const validation = getLatestMlbExpectedRunsValidation();
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
  const pool = [];
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
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
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
    const homeId = pitchers.homeIdentity?.id ?? pitchers.home?.id ?? null;
    const awayId = pitchers.awayIdentity?.id ?? pitchers.away?.id ?? null;
    if (homeId == null || awayId == null) continue;
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2 || pickEarly > oppEarly) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    pool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      bScore,
      edgeVsBe: modelProb - 1 / pickOdds,
    });
  }
  return pool;
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
function selectB(pool) {
  const map = new Map();
  for (const g of pool) {
    if (
      g.ev < B.minimumExpectedValue ||
      g.margin < B.minimumExpectedRunMargin ||
      g.modelProb < B.minimumModelProbability ||
      g.pickOdds < B.minimumPickOdds ||
      g.pickOdds > B.maximumPickOdds
    ) {
      continue;
    }
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const arr = [...map.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    out.push(...applyDrop(arr));
  }
  return out;
}
function selectA(pool, bPicks, extraPred) {
  const bIds = new Set(bPicks.map((g) => g.gameId));
  const bByDay = new Map();
  for (const g of bPicks) bByDay.set(g.day, (bByDay.get(g.day) || 0) + 1);
  const map = new Map();
  for (const g of pool) {
    if (bIds.has(g.gameId)) continue;
    if (g.modelProb < 0.55 || g.margin < 1) continue;
    if (!(g.pickOdds < 1.85 && g.edgeVsBe >= 0.02)) continue;
    const bn = bByDay.get(g.day) || 0;
    if (bn >= 2) continue;
    if (extraPred && !extraPred(g, bn)) continue;
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const top = [...map.get(day)].sort(
      (a, b) => b.edgeVsBe - a.edgeVsBe || b.margin - a.margin
    )[0];
    if (top) out.push(top);
  }
  return out;
}

console.log('Building…');
const combined = WINDOWS.flatMap((w) => build(w.from, w.to));
const months = [...new Set(combined.map((g) => g.month))].sort();

const POLICIES = [
  { id: 'base_edge02_bLt2', pred: null },
  { id: 'plus_margin_ge_125', pred: (g) => g.margin >= 1.25 },
  { id: 'plus_margin_ge_150', pred: (g) => g.margin >= 1.5 },
  { id: 'plus_odds_lt_175', pred: (g) => g.pickOdds < 1.75 },
  { id: 'plus_odds_165_175', pred: (g) => g.pickOdds >= 1.65 && g.pickOdds < 1.75 },
  { id: 'plus_only_b0', pred: (_g, bn) => bn === 0 },
  {
    id: 'plus_m125_odds_lt_175',
    pred: (g) => g.margin >= 1.25 && g.pickOdds < 1.75,
  },
];

const results = [];
for (const p of POLICIES) {
  const folds = [];
  for (let i = 1; i < months.length; i++) {
    const testMonth = months[i];
    const testPool = combined.filter((g) => g.month === testMonth);
    const b = selectB(testPool);
    const a = selectA(testPool, b, p.pred);
    const sb = summarize(b);
    const sm = summarize([...b, ...a]);
    folds.push({
      testMonth,
      aN: a.length,
      deltaUsd50: sm.usd50 - sb.usd50,
      deltaHr:
        sb.hitRate != null && sm.hitRate != null
          ? Number((sm.hitRate - sb.hitRate).toFixed(4))
          : null,
    });
  }
  const bAll = folds.flatMap((f) =>
    selectB(combined.filter((g) => g.month === f.testMonth))
  );
  const mAll = folds.flatMap((f) => {
    const pool = combined.filter((g) => g.month === f.testMonth);
    const b = selectB(pool);
    return [...b, ...selectA(pool, b, p.pred)];
  });
  const sb = summarize(bAll);
  const sm = summarize(mAll);
  const yearDelta = (yy) => {
    const bb = bAll.filter((g) => g.month.startsWith(yy));
    const mm = mAll.filter((g) => g.month.startsWith(yy));
    return summarize(mm).usd50 - summarize(bb).usd50;
  };
  const y25 = yearDelta('2025');
  const y26 = yearDelta('2026');
  const beat = folds.filter((f) => f.deltaUsd50 > 0).length;
  const hurt = folds.filter((f) => f.deltaUsd50 < 0).length;
  const row = {
    id: p.id,
    deltaBets: sm.bets - sb.bets,
    deltaHr: Number((sm.hitRate - sb.hitRate).toFixed(4)),
    deltaUsd50: sm.usd50 - sb.usd50,
    beat,
    hurt,
    y25,
    y26,
    passStrict:
      sm.bets > sb.bets &&
      sm.usd50 >= sb.usd50 &&
      (sm.hitRate ?? 0) >= (sb.hitRate ?? 1) &&
      y25 >= 0 &&
      y26 >= 0 &&
      beat >= hurt,
    folds,
  };
  results.push(row);
  console.log(
    `${p.id.padEnd(24)} Δn=${String(row.deltaBets).padStart(3)} Δhr=${row.deltaHr} Δ$=${row.deltaUsd50} y25/26=${y25}/${y26} ${beat}/${hurt} strict=${row.passStrict}`
  );
}

const out = {
  experimentId: 'a-fill-tighten-oos-2026-07-28',
  generatedAt: new Date().toISOString(),
  note: '仍不接入；診斷毒切片後的加嚴過濾 OOS',
  results,
  recommendation: results.some((r) => r.id !== 'base_edge02_bLt2' && r.passStrict)
    ? {
        action: 'hold_for_review',
        best: results
          .filter((r) => r.id !== 'base_edge02_bLt2' && r.passStrict)
          .sort((a, b) => b.deltaUsd50 - a.deltaUsd50)[0]?.id,
      }
    : { action: 'no_tighter_filter_yet', note: '加嚴後未穩過嚴格閘，或不如基線' },
};

fs.writeFileSync(
  new URL('../tmp-a-fill-tighten-oos.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log('recommendation', out.recommendation);
