/**
 * 第五刀：特徵／失誤模式（底座＝現行 dropR3+dropR2）
 * 1) 基線選注 hit vs miss 特徵均值差
 * 2) 由診斷自動衍生軟罰／輕量硬擋候選（約束 keep≥90%）
 * 產物：tmp-feature-miss-on-current.json
 *
 * 用法: node scripts/auditMlbFeatureMissOnCurrent.mjs
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

const R = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3_T = Number(R.dropThirdIfMarginBelow) || 0.5;
const DROP_R2_MAX = Number(R.dropSecondIfOddsBelow) || 1.95;
const DROP_R2_MIN = Number(R.dropSecondIfOddsMin) || 1.85;
const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

/** 選邊符號後的可解釋特徵（home-away vector → 選邊優勢） */
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
function mean(arr) {
  const xs = arr.filter((x) => x != null && Number.isFinite(x));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function summarize(bets) {
  if (!bets.length) return null;
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
  return {
    bets: nB,
    hitRate: Number((hits / nB).toFixed(4)),
    avgOdds: Number((odds / nB).toFixed(3)),
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
    if (bs.length < 2) continue;
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
      ev < R.minimumExpectedValue ||
      margin < R.minimumExpectedRunMargin ||
      modelProb < R.minimumModelProbability ||
      pickOdds < R.minimumPickOdds ||
      pickOdds > R.maximumPickOdds ||
      best.homeOdds < R.minimumEitherSideOdds ||
      best.awayOdds < R.minimumEitherSideOdds ||
      (R.requirePickEarlyExitsNotHigher && pickEarly > oppEarly)
    ) {
      continue;
    }
    const v = features.vector || {};
    const adv = {};
    for (const key of ADV_KEYS) {
      adv[key] = pickSigned(n(v[key]), pickHome);
    }
    const baseScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      R
    );
    pool.push({
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      window: from.startsWith('2025') ? '2025' : '2026',
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      baseScore,
      adv,
      // 衍生旗標（選邊視角）
      coldOffense: adv.recentRunsDiff != null && adv.recentRunsDiff < 0,
      highK9: adv.pitcherK9Diff != null && adv.pitcherK9Diff > 0.3,
      badEra: adv.pitcherEraDiff != null && adv.pitcherEraDiff < -0.3,
      // ERA diff 定義：away.era - home.era，選邊後「優勢」= 對手 ERA 較高為正
      weakRecentForm: adv.last10WinPctDiff != null && adv.last10WinPctDiff < -0.05,
      restDisadv: adv.pitcherRestDaysDiff != null && adv.pitcherRestDaysDiff < -1,
      overconfident: modelProb >= 0.56 && margin < 0.4,
      thinEdge: ev >= 0.02 && ev < 0.04 && margin < 0.35,
    });
  }
  return pool;
}

function applyHardSlots(sorted) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3_T) slots = slots.slice(0, 2);
  if (
    slots.length >= 2 &&
    slots[1].pickOdds >= DROP_R2_MIN &&
    slots[1].pickOdds < DROP_R2_MAX
  ) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}

function select(pool, { rescore = null, hardBlock = null } = {}) {
  const byDay = new Map();
  for (const g of pool) {
    if (hardBlock && hardBlock(g)) continue;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({ ...g });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = byDay.get(day).map((g) => ({
      ...g,
      score: rescore ? rescore(g) : g.baseScore,
    }));
    arr.sort((a, b) => b.score - a.score || b.margin - a.margin);
    out.push(...applyHardSlots(arr));
  }
  return out;
}

console.log('Building…');
const pools = WINDOWS.map((w) => {
  const pool = buildUniverse(w.from, w.to);
  console.log(`  ${w.key}: ${pool.length}`);
  return { ...w, pool };
});
const combined = pools.flatMap((p) => p.pool);
const baselinePicks = select(combined);
const hits = baselinePicks.filter((g) => g.hit);
const misses = baselinePicks.filter((g) => !g.hit);

/** hit vs miss 特徵差 */
const featureDiag = ADV_KEYS.map((key) => {
  const h = mean(hits.map((g) => g.adv[key]));
  const m = mean(misses.map((g) => g.adv[key]));
  const coverage = baselinePicks.filter((g) => g.adv[key] != null).length;
  return {
    key,
    hitMean: h == null ? null : Number(h.toFixed(4)),
    missMean: m == null ? null : Number(m.toFixed(4)),
    deltaHitMinusMiss:
      h == null || m == null ? null : Number((h - m).toFixed(4)),
    coverage,
    coverageRate: Number((coverage / baselinePicks.length).toFixed(3)),
  };
})
  .filter((r) => r.deltaHitMinusMiss != null && r.coverageRate >= 0.7)
  .sort(
    (a, b) => Math.abs(b.deltaHitMinusMiss) - Math.abs(a.deltaHitMinusMiss)
  );

/** 校準：modelProb 桶 */
const probBuckets = [
  [0.5, 0.52],
  [0.52, 0.55],
  [0.55, 0.58],
  [0.58, 0.62],
  [0.62, 0.7],
].map(([lo, hi]) => {
  const slice = baselinePicks.filter((g) => g.modelProb >= lo && g.modelProb < hi);
  return { band: `[${lo},${hi})`, ...summarize(slice), avgModelProb: mean(slice.map((g) => g.modelProb)) };
});

console.log('\nTop feature deltas (hit-miss):');
for (const f of featureDiag.slice(0, 8)) {
  console.log(`  ${f.key}: Δ=${f.deltaHitMinusMiss} hit=${f.hitMean} miss=${f.missMean}`);
}

const POLICIES = [
  { id: 'baseline', label: '現行 dropR3+dropR2', opts: {} },
  // 校準／結構旗標軟罰
  {
    id: 'soft_overconfident_l015',
    label: '軟沉：過自信(P≥0.56且margin<0.40) λ=0.15',
    opts: { rescore: (g) => g.baseScore - (g.overconfident ? 0.15 : 0) },
  },
  {
    id: 'soft_overconfident_l030',
    label: '軟沉：過自信 λ=0.30',
    opts: { rescore: (g) => g.baseScore - (g.overconfident ? 0.3 : 0) },
  },
  {
    id: 'soft_thin_edge_l015',
    label: '軟沉：薄邊(EV<0.04且margin<0.35) λ=0.15',
    opts: { rescore: (g) => g.baseScore - (g.thinEdge ? 0.15 : 0) },
  },
  {
    id: 'soft_weak_form_l015',
    label: '軟沉：近10場勝率劣勢<-0.05 λ=0.15',
    opts: { rescore: (g) => g.baseScore - (g.weakRecentForm ? 0.15 : 0) },
  },
  {
    id: 'soft_cold_offense_l015',
    label: '軟沉：近期得分劣勢 λ=0.15（非硬擋）',
    opts: { rescore: (g) => g.baseScore - (g.coldOffense ? 0.15 : 0) },
  },
  {
    id: 'soft_cold_x_highk9_l015',
    label: '軟沉：攻冷×高K9 λ=0.15',
    opts: {
      rescore: (g) => g.baseScore - (g.coldOffense && g.highK9 ? 0.15 : 0),
    },
  },
  {
    id: 'soft_cold_x_highk9_l030',
    label: '軟沉：攻冷×高K9 λ=0.30',
    opts: {
      rescore: (g) => g.baseScore - (g.coldOffense && g.highK9 ? 0.3 : 0),
    },
  },
  {
    id: 'soft_rest_disadv_l015',
    label: '軟沉：休息日劣勢<-1 λ=0.15',
    opts: { rescore: (g) => g.baseScore - (g.restDisadv ? 0.15 : 0) },
  },
  // 依診斷 Top 特徵：miss 側明顯較「優勢」的反向軟罰
  // pitcherK9Diff：若 miss 均值更高 → 選邊高 K9 優勢可能有毒
  {
    id: 'soft_sink_high_adv_k9_l015',
    label: '軟沉：選邊 K9 優勢>0.5 λ=0.15',
    opts: {
      rescore: (g) =>
        g.baseScore - (g.adv.pitcherK9Diff != null && g.adv.pitcherK9Diff > 0.5 ? 0.15 : 0),
    },
  },
  {
    id: 'soft_sink_high_adv_k9_l030',
    label: '軟沉：選邊 K9 優勢>0.5 λ=0.30',
    opts: {
      rescore: (g) =>
        g.baseScore - (g.adv.pitcherK9Diff != null && g.adv.pitcherK9Diff > 0.5 ? 0.3 : 0),
    },
  },
  {
    id: 'soft_require_offense_or_not_high_k9',
    label: '軟：無得分優勢且 K9>0.3 扣 0.20',
    opts: {
      rescore: (g) =>
        g.baseScore -
        (g.adv.recentRunsDiff != null &&
        g.adv.pitcherK9Diff != null &&
        g.adv.recentRunsDiff <= 0 &&
        g.adv.pitcherK9Diff > 0.3
          ? 0.2
          : 0),
    },
  },
  // 輕量硬擋（僅當 keep 可能≥90%）
  {
    id: 'hard_block_overconfident',
    label: '硬擋過自信',
    opts: { hardBlock: (g) => g.overconfident },
  },
  {
    id: 'hard_block_thin_edge',
    label: '硬擋薄邊',
    opts: { hardBlock: (g) => g.thinEdge },
  },
  {
    id: 'hard_block_k9_gt_080',
    label: '硬擋選邊 K9 優勢>0.8',
    opts: {
      hardBlock: (g) => g.adv.pitcherK9Diff != null && g.adv.pitcherK9Diff > 0.8,
    },
  },
];

const results = [];
for (const p of POLICIES) {
  const row = { id: p.id, label: p.label, windows: {} };
  for (const w of pools) row.windows[w.key] = summarize(select(w.pool, p.opts));
  row.windows.combined = summarize(select(combined, p.opts));
  results.push(row);
  const c = row.windows.combined;
  console.log(
    `${p.id.padEnd(36)} n=${String(c?.bets ?? 0).padStart(3)} hr=${c?.hitRate} $50=${c?.usd50}`
  );
}

const base = results.find((r) => r.id === 'baseline');
const bc = base.windows.combined;
const b25 = base.windows['2025'];
const b26 = base.windows['2026'];

const evaluated = results.map((r) => {
  const c = r.windows.combined;
  const y25 = r.windows['2025'];
  const y26 = r.windows['2026'];
  const keepRate = c && bc ? Number((c.bets / bc.bets).toFixed(3)) : null;
  return {
    id: r.id,
    label: r.label,
    combined: c,
    y2025: y25,
    y2026: y26,
    keepRate,
    deltaBets: c && bc ? c.bets - bc.bets : null,
    deltaUsd50: c && bc ? c.usd50 - bc.usd50 : null,
    deltaHitRate: c && bc ? Number((c.hitRate - bc.hitRate).toFixed(4)) : null,
    keep90: keepRate != null && keepRate >= 0.9,
    passStrict:
      Boolean(c) &&
      (c.usd50 ?? -Infinity) > bc.usd50 &&
      (y25?.usd50 ?? -1) > 0 &&
      (y26?.usd50 ?? -1) > 0 &&
      (y25?.usd50 ?? -Infinity) >= b25.usd50 &&
      (y26?.usd50 ?? -Infinity) >= b26.usd50 &&
      keepRate >= 0.9,
    fitsUserGoal:
      Boolean(c) &&
      (y25?.usd50 ?? -1) > 0 &&
      (y26?.usd50 ?? -1) > 0 &&
      keepRate >= 0.9 &&
      (c.hitRate ?? 0) > bc.hitRate &&
      (c.usd50 ?? 0) >= bc.usd50 * 0.98,
  };
});
evaluated.sort((a, b) => (b.deltaHitRate ?? -1) - (a.deltaHitRate ?? -1));
const goal = evaluated.filter((e) => e.fitsUserGoal && e.id !== 'baseline');
const strict = evaluated.filter((e) => e.passStrict && e.id !== 'baseline');

const out = {
  experimentId: 'feature-miss-on-current-2026-07-28',
  generatedAt: new Date().toISOString(),
  baselineNote: 'ev02_max230 + dropR3 + dropR2 lowodds',
  baselineSummary: summarize(baselinePicks),
  hitMissCounts: { hits: hits.length, misses: misses.length },
  featureDiagTop: featureDiag.slice(0, 12),
  featureDiagAll: featureDiag,
  calibrationProbBuckets: probBuckets,
  fitsUserGoal: goal,
  passStrictGate: strict,
  rankedByHitRateLift: evaluated,
  recommendation: strict[0]
    ? {
        action: 'run_wf_then_promote',
        id: strict[0].id,
        label: strict[0].label,
        hitRate: strict[0].combined.hitRate,
        keepRate: strict[0].keepRate,
        deltaUsd50: strict[0].deltaUsd50,
      }
    : goal[0]
      ? {
          action: 'weak_candidate',
          id: goal[0].id,
          label: goal[0].label,
          hitRate: goal[0].combined.hitRate,
          keepRate: goal[0].keepRate,
          deltaUsd50: goal[0].deltaUsd50,
        }
      : {
          action: 'no_feature_signal_beats_baseline',
          note: '第五刀特徵／校準訊號未過保量+嚴格閘；選注規則可先凍結',
        },
};

fs.writeFileSync(
  new URL('../tmp-feature-miss-on-current.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\n=== fitsUserGoal ===');
for (const e of goal) {
  console.log(
    `${e.id}: hr=${e.combined.hitRate} keep=${e.keepRate} d$=${e.deltaUsd50} strict=${e.passStrict}`
  );
}
console.log('\n=== passStrict ===');
for (const e of strict) {
  console.log(`${e.id}: hr=${e.combined.hitRate} keep=${e.keepRate} d$=${e.deltaUsd50}`);
}
console.log('\nrecommendation:', out.recommendation);
