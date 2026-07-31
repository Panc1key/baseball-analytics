/**
 * A′ 增量掃描（B 基準包凍結不動）
 * - B：ev02_max230 + dropR3 + dropR2（賠率≥1.85）
 * - A′：短賠帶候選網格（與 B 賠率帶盡量不重疊）
 * - 合併：同 gameId 優先保留 B；A′ 只加增量
 *
 * 產物：tmp-line-a-prime-on-frozen-b.json
 * 用法: node scripts/auditMlbLineAPrimeOnFrozenB.mjs
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

const B_RULES = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: 2,
};
const DROP_R3_T = Number(B_RULES.dropThirdIfMarginBelow) || 0.5;
const DROP_R2_MAX = Number(B_RULES.dropSecondIfOddsBelow) || 1.95;
const DROP_R2_MIN = Number(B_RULES.dropSecondIfOddsMin) || 1.85;

const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

const SHARED = {
  requireBothPitcherIdentities: true,
  minimumH2hBookmakers: 2,
  minimumEitherSideOdds: 1.2,
  requirePickEarlyExitsNotHigher: true,
  maximumAbsoluteZScore: 3.5,
};

/** A′ 候選：短賠為主；舊 A 一併對照（預期不過） */
const A_VARIANTS = [
  {
    id: 'legacy_a_p55_m1',
    label: '舊A：P≥55% margin≥1（對照，預期不過）',
    minP: 0.55,
    minMargin: 1,
    minEv: null,
    minOdds: 1.4,
    maxOdds: 1.85,
    dailyTopK: 3,
    rankBy: 'margin',
  },
  {
    id: 'a_prime_p58_m1_topk1',
    label: 'A′：P≥58% margin≥1 短賠 Top1/日',
    minP: 0.58,
    minMargin: 1,
    minEv: null,
    minOdds: 1.45,
    maxOdds: 1.849,
    dailyTopK: 1,
    rankBy: 'prob',
  },
  {
    id: 'a_prime_p60_m1_topk1',
    label: 'A′：P≥60% margin≥1 短賠 Top1/日',
    minP: 0.6,
    minMargin: 1,
    minEv: null,
    minOdds: 1.45,
    maxOdds: 1.849,
    dailyTopK: 1,
    rankBy: 'prob',
  },
  {
    id: 'a_prime_p55_m125_topk1',
    label: 'A′：P≥55% margin≥1.25 Top1/日',
    minP: 0.55,
    minMargin: 1.25,
    minEv: null,
    minOdds: 1.45,
    maxOdds: 1.849,
    dailyTopK: 1,
    rankBy: 'margin',
  },
  {
    id: 'a_prime_p55_m1_ev02_topk1',
    label: 'A′：P≥55% margin≥1 且 EV≥2% Top1',
    minP: 0.55,
    minMargin: 1,
    minEv: 0.02,
    minOdds: 1.45,
    maxOdds: 1.849,
    dailyTopK: 1,
    rankBy: 'ev',
  },
  {
    id: 'a_prime_p55_m1_ev03_topk1',
    label: 'A′：P≥55% margin≥1 且 EV≥3% Top1',
    minP: 0.55,
    minMargin: 1,
    minEv: 0.03,
    minOdds: 1.45,
    maxOdds: 1.849,
    dailyTopK: 1,
    rankBy: 'ev',
  },
  {
    id: 'a_prime_edge_buf02_topk1',
    label: 'A′：P≥1/odds+0.02 且 margin≥0.75 Top1',
    minP: null,
    minMargin: 0.75,
    minEv: null,
    edgeBuffer: 0.02,
    minOdds: 1.45,
    maxOdds: 1.849,
    dailyTopK: 1,
    rankBy: 'edge',
  },
  {
    id: 'a_prime_edge_buf03_m1_topk1',
    label: 'A′：P≥1/odds+0.03 且 margin≥1 Top1',
    minP: null,
    minMargin: 1,
    minEv: null,
    edgeBuffer: 0.03,
    minOdds: 1.45,
    maxOdds: 1.849,
    dailyTopK: 1,
    rankBy: 'edge',
  },
  {
    id: 'a_prime_p58_m1_topk2',
    label: 'A′：P≥58% margin≥1 Top2/日',
    minP: 0.58,
    minMargin: 1,
    minEv: null,
    minOdds: 1.45,
    maxOdds: 1.849,
    dailyTopK: 2,
    rankBy: 'prob',
  },
  {
    id: 'a_prime_short_ev02_p55_topk1',
    label: 'A′：短賠 EV≥2% P≥55% margin≥0.5 Top1',
    minP: 0.55,
    minMargin: 0.5,
    minEv: 0.02,
    minOdds: 1.5,
    maxOdds: 1.849,
    dailyTopK: 1,
    rankBy: 'ev',
  },
  {
    id: 'a_prime_p62_m075_topk1',
    label: 'A′：P≥62% margin≥0.75 Top1',
    minP: 0.62,
    minMargin: 0.75,
    minEv: null,
    minOdds: 1.4,
    maxOdds: 1.849,
    dailyTopK: 1,
    rankBy: 'prob',
  },
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
  if (!bets.length) {
    return {
      bets: 0,
      hitRate: null,
      avgOdds: null,
      breakeven: null,
      clearsOwn: false,
      roi: null,
      unitPnl: 0,
      usd50: 0,
    };
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
  const nB = bets.length;
  const avgOdds = odds / nB;
  const hitRate = hits / nB;
  const breakeven = 1 / avgOdds;
  return {
    bets: nB,
    hitRate: Number(hitRate.toFixed(4)),
    avgOdds: Number(avgOdds.toFixed(3)),
    breakeven: Number(breakeven.toFixed(4)),
    clearsOwn: hitRate > breakeven,
    roi: Number((unit / nB).toFixed(4)),
    unitPnl: Number(unit.toFixed(2)),
    usd50: Math.round(unit * 50),
  };
}

function buildUniverse(from, to) {
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
    if (bs.length < SHARED.minimumH2hBookmakers) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
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
    if (
      best.homeOdds < SHARED.minimumEitherSideOdds ||
      best.awayOdds < SHARED.minimumEitherSideOdds ||
      (SHARED.requirePickEarlyExitsNotHigher && pickEarly > oppEarly)
    ) {
      continue;
    }
    // 極寬宇宙：1.40–2.30，供 B／A′ 各自再卡
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;

    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B_RULES
    );
    pool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      window: from.startsWith('2025') ? '2025' : '2026',
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

function passesB(g) {
  return (
    g.ev >= B_RULES.minimumExpectedValue &&
    g.margin >= B_RULES.minimumExpectedRunMargin &&
    g.modelProb >= B_RULES.minimumModelProbability &&
    g.pickOdds >= B_RULES.minimumPickOdds &&
    g.pickOdds <= B_RULES.maximumPickOdds
  );
}

function applyBSlots(sorted) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3_T) slots = slots.slice(0, 2);
  if (
    slots.length >= 2 &&
    slots[1].pickOdds >= DROP_R2_MIN &&
    slots[1].pickOdds < DROP_R2_MAX
  ) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots.map((g) => ({ ...g, line: 'B' }));
}

function selectB(pool) {
  const byDay = new Map();
  for (const g of pool) {
    if (!passesB(g)) continue;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    out.push(...applyBSlots(arr));
  }
  return out;
}

function passesA(g, rules) {
  if (g.pickOdds < rules.minOdds || g.pickOdds > rules.maxOdds) return false;
  if (rules.minMargin != null && g.margin < rules.minMargin) return false;
  if (rules.minEv != null && g.ev < rules.minEv) return false;
  if (rules.minP != null && g.modelProb < rules.minP) return false;
  if (rules.edgeBuffer != null) {
    const need = 1 / g.pickOdds + rules.edgeBuffer;
    if (g.modelProb < need) return false;
  }
  return true;
}

function rankValue(g, rankBy) {
  if (rankBy === 'margin') return g.margin;
  if (rankBy === 'ev') return g.ev;
  if (rankBy === 'edge') return g.edgeVsBe;
  return g.modelProb;
}

function selectA(pool, rules) {
  const byDay = new Map();
  for (const g of pool) {
    if (!passesA(g, rules)) continue;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (a, b) =>
        rankValue(b, rules.rankBy) - rankValue(a, rules.rankBy) ||
        b.margin - a.margin
    );
    out.push(
      ...arr.slice(0, rules.dailyTopK).map((g) => ({ ...g, line: 'A' }))
    );
  }
  return out;
}

/** 合併：同 gameId 優先 B */
function mergeBA(bPicks, aPicks) {
  const bIds = new Set(bPicks.map((g) => g.gameId));
  const extraA = aPicks.filter((g) => !bIds.has(g.gameId));
  return [...bPicks, ...extraA];
}

console.log('Building…');
const pools = WINDOWS.map((w) => {
  const pool = buildUniverse(w.from, w.to);
  console.log(`  ${w.key}: ${pool.length}`);
  return { ...w, pool };
});
const combined = pools.flatMap((p) => p.pool);

function evalLine(selectFn) {
  const windows = {};
  const all = [];
  for (const w of pools) {
    const picks = selectFn(w.pool);
    windows[w.key] = summarize(picks);
    all.push(...picks);
  }
  windows.combined = summarize(all);
  return { windows, picks: all };
}

const bEval = evalLine(selectB);
console.log(
  `B locked: n=${bEval.windows.combined.bets} hr=${bEval.windows.combined.hitRate} $50=${bEval.windows.combined.usd50}`
);

const results = [];
for (const v of A_VARIANTS) {
  const aAlone = evalLine((pool) => selectA(pool, v));
  const merged = evalLine((pool) => {
    const b = selectB(pool);
    const a = selectA(pool, v);
    return mergeBA(b, a);
  });
  const aOnlyIncremental = merged.picks.filter((g) => g.line === 'A');
  const row = {
    id: v.id,
    label: v.label,
    rules: v,
    aAlone: aAlone.windows,
    merged: merged.windows,
    aIncremental: summarize(aOnlyIncremental),
    collisionDropped: aAlone.windows.combined.bets - aOnlyIncremental.length,
  };
  results.push(row);
  const a = aAlone.windows.combined;
  const m = merged.windows.combined;
  console.log(
    `${v.id.padEnd(32)} A:n=${String(a.bets).padStart(3)} hr=${a.hitRate} clear=${a.clearsOwn} $=${a.usd50} | merge:n=${m.bets} hr=${m.hitRate} $=${m.usd50} ΔB$=${m.usd50 - bEval.windows.combined.usd50}`
  );
}

const bC = bEval.windows.combined;
const b25 = bEval.windows['2025'];
const b26 = bEval.windows['2026'];

const evaluated = results.map((r) => {
  const a = r.aAlone.combined;
  const m = r.merged.combined;
  const m25 = r.merged['2025'];
  const m26 = r.merged['2026'];
  const a25 = r.aAlone['2025'];
  const a26 = r.aAlone['2026'];
  const aClears =
    Boolean(a.clearsOwn) && (a.usd50 ?? 0) > 0 && (a25?.usd50 ?? -1) > 0 && (a26?.usd50 ?? -1) > 0;
  const mergeBeatsB =
    (m.usd50 ?? -Infinity) > bC.usd50 &&
    (m25?.usd50 ?? -Infinity) >= b25.usd50 &&
    (m26?.usd50 ?? -Infinity) >= b26.usd50 &&
    (m.hitRate ?? 0) >= bC.hitRate;
  const mergeAddsVolume =
    m.bets > bC.bets && (m.usd50 ?? 0) >= bC.usd50 * 0.98 && (m25?.usd50 ?? 0) > 0 && (m26?.usd50 ?? 0) > 0;
  return {
    id: r.id,
    label: r.label,
    aAlone: a,
    a2025: a25,
    a2026: a26,
    merged: m,
    merged2025: m25,
    merged2026: m26,
    aIncremental: r.aIncremental,
    collisionDropped: r.collisionDropped,
    deltaMergeUsd50VsB: m.usd50 - bC.usd50,
    deltaMergeHitRateVsB: Number((m.hitRate - bC.hitRate).toFixed(4)),
    deltaMergeBetsVsB: m.bets - bC.bets,
    aClearsOwnAndDualPositive: aClears,
    mergeBeatsBStrict: mergeBeatsB,
    mergeUsefulVolume: mergeAddsVolume && (m.usd50 ?? 0) >= bC.usd50,
    passPromoteA:
      aClears &&
      mergeBeatsB &&
      r.aIncremental.bets >= 20,
  };
});

evaluated.sort((a, b) => (b.deltaMergeUsd50VsB ?? -999) - (a.deltaMergeUsd50VsB ?? -999));
const promote = evaluated.filter((e) => e.passPromoteA);
const useful = evaluated.filter(
  (e) => e.aClearsOwnAndDualPositive || e.mergeBeatsBStrict || e.mergeUsefulVolume
);

const out = {
  experimentId: 'line-a-prime-on-frozen-b-2026-07-28',
  generatedAt: new Date().toISOString(),
  bBaselineLocked: {
    note: 'B 常數零改動',
    combined: bC,
    y2025: b25,
    y2026: b26,
  },
  promoteCandidates: promote,
  usefulButNotStrict: useful.filter((e) => !e.passPromoteA),
  rankedByMergeUsdLift: evaluated,
  recommendation: promote[0]
    ? {
        action: 'wire_a_prime_profile',
        id: promote[0].id,
        label: promote[0].label,
        aBets: promote[0].aIncremental.bets,
        mergeDeltaUsd50: promote[0].deltaMergeUsd50VsB,
        mergeHitRate: promote[0].merged.hitRate,
      }
    : useful[0]
      ? {
          action: 'weak_a_prime_needs_redesign',
          id: useful[0].id,
          label: useful[0].label,
          note: '有局部亮點但未同時滿足 A′ 自身平衡 + 合併嚴格優於 B；先不接入正式',
        }
      : {
          action: 'no_a_prime_yet',
          note: '短賠 A′ 網格未找到可安全掛載方案；B 維持獨跑，A 需重新設計',
        },
};

fs.writeFileSync(
  new URL('../tmp-line-a-prime-on-frozen-b.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\n=== promote ===');
for (const e of promote) {
  console.log(
    `${e.id}: A+${e.aIncremental.bets} mergeΔ$=${e.deltaMergeUsd50VsB} mergeHr=${e.merged.hitRate}`
  );
}
console.log('\nrecommendation:', out.recommendation);
