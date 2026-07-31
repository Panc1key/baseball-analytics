/**
 * 診斷：固定候選 A 增量（edge≥2pp + 當日 B&lt;2 + Top1）補場本身
 * 不改規則、不接入；只描述 hit/miss、月貢獻、毒切片與可測過濾假設
 *
 * 產物：tmp-a-fill-diagnose.json
 * 用法: node scripts/auditMlbAFillDiagnose.mjs
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
const DROP_R3 = Number(B.dropThirdIfMarginBelow) || 0.5;
const DROP_R2_MAX = Number(B.dropSecondIfOddsBelow) || 1.95;
const DROP_R2_MIN = Number(B.dropSecondIfOddsMin) || 1.85;
const EDGE = 0.02;
const B_LT = 2;

const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

const ADV_KEYS = [
  'seasonWinPctDiff',
  'venueRecordDiff',
  'last10WinPctDiff',
  'recentRunsDiff',
  'recentRunsAllowedDiff',
  'pitcherEraDiff',
  'pitcherWhipDiff',
  'pitcherK9Diff',
  'pitcherBb9Diff',
  'pitcherKMinusBb9Diff',
  'pitcherRestDaysDiff',
  'pitcherRecentEraDiff',
  'pitcherRecentK9Diff',
  'pitcherRecentBb9Diff',
  'pitcherRecentPitchesDiff',
  'battingObp14Diff',
  'battingSlg14Diff',
  'bullpenPitchesLast3Diff',
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}
function pickSigned(diff, pickHome) {
  if (diff == null) return null;
  return pickHome ? diff : -diff;
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
  if (!bets.length) {
    return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0, unit: 0 };
  }
  let unit = 0;
  let odds = 0;
  let hits = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const nn = bets.length;
  return {
    bets: nn,
    hitRate: Number((hits / nn).toFixed(4)),
    avgOdds: Number((odds / nn).toFixed(3)),
    roi: Number((unit / nn).toFixed(4)),
    usd50: Math.round(unit * 50),
    unit: Number(unit.toFixed(4)),
  };
}
function mean(arr) {
  const xs = arr.filter((x) => x != null && Number.isFinite(x));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function bandOdds(o) {
  if (o < 1.55) return '<1.55';
  if (o < 1.65) return '1.55-1.65';
  if (o < 1.75) return '1.65-1.75';
  if (o < 1.85) return '1.75-1.85';
  return '≥1.85';
}
function bandEdge(e) {
  if (e < 0.025) return '2.0-2.5pp';
  if (e < 0.03) return '2.5-3.0pp';
  if (e < 0.04) return '3.0-4.0pp';
  if (e < 0.05) return '4.0-5.0pp';
  return '≥5.0pp';
}
function bandMargin(m) {
  if (m < 1.25) return '1.00-1.25';
  if (m < 1.5) return '1.25-1.50';
  if (m < 2) return '1.50-2.00';
  return '≥2.00';
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
    const adv = {};
    for (const k of ADV_KEYS) {
      adv[k] = pickSigned(n(features?.[k]), pickHome);
    }
    pool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      window: from.startsWith('2025') ? '2025' : '2026',
      hit: pickHome === hs > as,
      pickHome,
      pickOdds,
      ev,
      margin,
      modelProb,
      bScore,
      edgeVsBe: modelProb - 1 / pickOdds,
      pickEarly,
      oppEarly,
      adv,
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

function selectAFills(pool, bPicks) {
  const bIds = new Set(bPicks.map((g) => g.gameId));
  const bByDay = new Map();
  for (const g of bPicks) bByDay.set(g.day, (bByDay.get(g.day) || 0) + 1);
  const map = new Map();
  for (const g of pool) {
    if (bIds.has(g.gameId)) continue;
    if (g.modelProb < 0.55 || g.margin < 1) continue;
    if (!(g.pickOdds < 1.85 && g.edgeVsBe >= EDGE)) continue;
    const bn = bByDay.get(g.day) || 0;
    if (bn >= B_LT) continue;
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push({ ...g, bCountThatDay: bn });
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

function sliceTable(fills, keyFn) {
  const bags = new Map();
  for (const f of fills) {
    const k = keyFn(f);
    if (!bags.has(k)) bags.set(k, []);
    bags.get(k).push(f);
  }
  return [...bags.entries()]
    .map(([k, xs]) => ({ slice: k, ...summarize(xs) }))
    .sort((a, b) => a.slice.localeCompare(b.slice));
}

function hypoFilter(fills, name, pred) {
  const keep = fills.filter(pred);
  const drop = fills.filter((f) => !pred(f));
  return {
    name,
    keep: summarize(keep),
    dropped: summarize(drop),
    note:
      drop.length && summarize(drop).usd50 < 0
        ? 'dropped_subset_negative_good_candidate'
        : drop.length && summarize(drop).usd50 > 0
          ? 'dropped_subset_positive_avoid'
          : 'small_or_flat',
  };
}

console.log('Building…');
const pools = WINDOWS.map((w) => ({ ...w, pool: build(w.from, w.to) }));
const allFills = [];
const monthly = [];
for (const w of pools) {
  const b = selectB(w.pool);
  const a = selectAFills(w.pool, b);
  allFills.push(...a);
  const months = [...new Set(w.pool.map((g) => g.month))].sort();
  for (const m of months) {
    const poolM = w.pool.filter((g) => g.month === m);
    const bM = selectB(poolM);
    const aM = selectAFills(poolM, bM);
    const sb = summarize(bM);
    const sm = summarize([...bM, ...aM]);
    monthly.push({
      month: m,
      window: w.key,
      a: summarize(aM),
      b: sb,
      merged: sm,
      deltaUsd50: sm.usd50 - sb.usd50,
      deltaHitRate:
        sb.hitRate != null && sm.hitRate != null
          ? Number((sm.hitRate - sb.hitRate).toFixed(4))
          : null,
    });
  }
}

const hits = allFills.filter((f) => f.hit);
const misses = allFills.filter((f) => !f.hit);
const advHitMiss = ADV_KEYS.map((k) => {
  const mh = mean(hits.map((f) => f.adv[k]));
  const mm = mean(misses.map((f) => f.adv[k]));
  return {
    key: k,
    hitMean: mh == null ? null : Number(mh.toFixed(4)),
    missMean: mm == null ? null : Number(mm.toFixed(4)),
    deltaHitMinusMiss:
      mh == null || mm == null ? null : Number((mh - mm).toFixed(4)),
  };
})
  .filter((r) => r.deltaHitMinusMiss != null)
  .sort(
    (a, b) =>
      Math.abs(b.deltaHitMinusMiss) - Math.abs(a.deltaHitMinusMiss)
  );

const hypos = [
  hypoFilter(allFills, 'drop_odds_lt_155', (f) => f.pickOdds >= 1.55),
  hypoFilter(allFills, 'drop_odds_lt_165', (f) => f.pickOdds >= 1.65),
  hypoFilter(allFills, 'keep_odds_165_185', (f) => f.pickOdds >= 1.65 && f.pickOdds < 1.85),
  hypoFilter(allFills, 'only_when_b_eq_0', (f) => f.bCountThatDay === 0),
  hypoFilter(allFills, 'only_when_b_eq_1', (f) => f.bCountThatDay === 1),
  hypoFilter(allFills, 'edge_ge_025', (f) => f.edgeVsBe >= 0.025),
  hypoFilter(allFills, 'edge_ge_03', (f) => f.edgeVsBe >= 0.03),
  hypoFilter(allFills, 'margin_ge_125', (f) => f.margin >= 1.25),
  hypoFilter(allFills, 'margin_ge_15', (f) => f.margin >= 1.5),
  hypoFilter(allFills, 'p_ge_58', (f) => f.modelProb >= 0.58),
  hypoFilter(allFills, 'p_ge_60', (f) => f.modelProb >= 0.6),
  hypoFilter(
    allFills,
    'drop_pick_early_gt_opp',
    (f) => f.pickEarly <= f.oppEarly
  ),
];

// 特徵假設：若 miss 在某 ADV 明顯「假優勢」，試砍假優勢過大
const topAdv = advHitMiss.slice(0, 5);
for (const t of topAdv) {
  // hitMean > missMean 表示該優勢真有助；反之 miss 更「看起來優勢」→ 假訊號，砍高優勢
  if (t.deltaHitMinusMiss < 0) {
    const thr = mean(allFills.map((f) => f.adv[t.key]));
    if (thr != null) {
      hypos.push(
        hypoFilter(
          allFills,
          `drop_high_${t.key}_gt_median`,
          (f) => (f.adv[t.key] ?? -999) <= thr
        )
      );
    }
  }
}

const aOnly = summarize(allFills);
const shortBe = aOnly.avgOdds != null ? 1 / aOnly.avgOdds : null;

const nextSignals = [];
for (const h of hypos) {
  if (
    h.note === 'dropped_subset_negative_good_candidate' &&
    h.keep.bets >= 10 &&
    h.keep.usd50 >= aOnly.usd50 &&
    (h.keep.hitRate ?? 0) >= (aOnly.hitRate ?? 1)
  ) {
    nextSignals.push({
      filter: h.name,
      reason: '砍掉的子集虧錢，保留子集 $ 與勝率不差於全量 A 補場',
      keep: h.keep,
      dropped: h.dropped,
    });
  }
}

const out = {
  experimentId: 'a-fill-diagnose-edge02-bLt2-2026-07-28',
  generatedAt: new Date().toISOString(),
  policy: { edgeBuffer: EDGE, bLt: B_LT, dailyTopK: 1, shortOddsMax: 1.85 },
  aFillOverall: {
    ...aOnly,
    breakevenNeeded: shortBe == null ? null : Number(shortBe.toFixed(4)),
    clearsOwnBreakeven:
      aOnly.hitRate != null && shortBe != null ? aOnly.hitRate > shortBe : false,
  },
  byWindow: {
    '2025': summarize(allFills.filter((f) => f.window === '2025')),
    '2026': summarize(allFills.filter((f) => f.window === '2026')),
  },
  byBCount: sliceTable(allFills, (f) => `b=${f.bCountThatDay}`),
  byOdds: sliceTable(allFills, (f) => bandOdds(f.pickOdds)),
  byEdge: sliceTable(allFills, (f) => bandEdge(f.edgeVsBe)),
  byMargin: sliceTable(allFills, (f) => bandMargin(f.margin)),
  byProb: sliceTable(allFills, (f) =>
    f.modelProb < 0.58 ? 'P55-58' : f.modelProb < 0.6 ? 'P58-60' : 'P≥60'
  ),
  monthlyMergeDelta: monthly,
  advHitVsMissTop: advHitMiss.slice(0, 12),
  filterHypos: hypos,
  nextSignalCandidates: nextSignals,
  verdict: {
    aFillSelfOk: aOnly.usd50 > 0 && aOnly.hitRate != null && shortBe != null
      ? aOnly.hitRate > shortBe
      : false,
    hurtMonths: monthly.filter((m) => m.deltaUsd50 < 0).map((m) => ({
      month: m.month,
      deltaUsd50: m.deltaUsd50,
      a: m.a,
    })),
    helpMonths: monthly.filter((m) => m.deltaUsd50 > 0).map((m) => ({
      month: m.month,
      deltaUsd50: m.deltaUsd50,
      a: m.a,
    })),
  },
};

fs.writeFileSync(
  new URL('../tmp-a-fill-diagnose.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('A fills:', aOnly);
console.log('byOdds', out.byOdds);
console.log('byEdge', out.byEdge);
console.log('byBCount', out.byBCount);
console.log('hurtMonths', out.verdict.hurtMonths);
console.log('advTop5', out.advHitVsMissTop.slice(0, 5));
console.log('nextSignals', nextSignals.map((s) => s.filter));
