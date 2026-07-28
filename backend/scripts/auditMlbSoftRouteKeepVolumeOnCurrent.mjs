/**
 * 第四刀：保量軟路由（底座＝現行 ev02_max230：dropR3 + dropR2低賠）
 * 約束：注數 keep≥90%（相對現行基線）；勝率／$ 力爭↑；不擋月份
 * 產物：tmp-soft-route-keep-volume-on-current.json
 *
 * 用法: node scripts/auditMlbSoftRouteKeepVolumeOnCurrent.mjs
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
      lowOddsBand: pickOdds >= DROP_R2_MIN && pickOdds < DROP_R2_MAX,
      highMargin: margin >= 0.5,
      midEvBand: ev >= 0.04 && ev < 0.06,
    });
  }
  return pool;
}

/** 現行硬規則截斷（在已排序陣列上） */
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

function select(pool, rescoreFn = null) {
  const byDay = new Map();
  for (const g of pool) {
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({ ...g });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = byDay.get(day).map((g) => {
      const score = rescoreFn ? rescoreFn(g) : g.baseScore;
      return { ...g, score };
    });
    arr.sort((a, b) => b.score - a.score || b.margin - a.margin);
    out.push(...applyHardSlots(arr));
  }
  return out;
}

const POLICIES = [
  { id: 'baseline', label: '現行（dropR3+dropR2低賠）', rescore: null },
  // —— 軟罰：高 margin R2 毒區（診斷：R2 margin≥0.50 差）——
  {
    id: 'soft_sink_high_margin_l010',
    label: '軟沉：margin≥0.50 扣 0.10（全池排序）',
    rescore: (g) => g.baseScore - (g.highMargin ? 0.1 : 0),
  },
  {
    id: 'soft_sink_high_margin_l015',
    label: '軟沉：margin≥0.50 扣 0.15',
    rescore: (g) => g.baseScore - (g.highMargin ? 0.15 : 0),
  },
  {
    id: 'soft_sink_high_margin_l030',
    label: '軟沉：margin≥0.50 扣 0.30',
    rescore: (g) => g.baseScore - (g.highMargin ? 0.3 : 0),
  },
  // —— 軟加：低 margin（診斷裡 R2 小分差反而好；全池輕推）——
  {
    id: 'soft_boost_low_margin_b005',
    label: '軟加：margin<0.50 加 0.05',
    rescore: (g) => g.baseScore + (g.margin < 0.5 ? 0.05 : 0),
  },
  {
    id: 'soft_boost_low_margin_b010',
    label: '軟加：margin<0.50 加 0.10',
    rescore: (g) => g.baseScore + (g.margin < 0.5 ? 0.1 : 0),
  },
  // —— 軟罰：中段 EV 毒帶（失敗切片）——
  {
    id: 'soft_sink_mid_ev_l010',
    label: '軟沉：EV∈[0.04,0.06) 扣 0.10',
    rescore: (g) => g.baseScore - (g.midEvBand ? 0.1 : 0),
  },
  {
    id: 'soft_sink_mid_ev_l015',
    label: '軟沉：EV∈[0.04,0.06) 扣 0.15',
    rescore: (g) => g.baseScore - (g.midEvBand ? 0.15 : 0),
  },
  // —— 軟偏好甜區賠率（不硬切；第一刀硬切已否決）——
  {
    id: 'soft_prefer_odds_195_215_l010',
    label: '軟偏好賠率 1.95–2.15（帶外扣 0.10）',
    rescore: (g) =>
      g.baseScore - (g.pickOdds >= 1.95 && g.pickOdds <= 2.15 ? 0 : 0.1),
  },
  {
    id: 'soft_prefer_odds_195_215_l015',
    label: '軟偏好賠率 1.95–2.15（帶外扣 0.15）',
    rescore: (g) =>
      g.baseScore - (g.pickOdds >= 1.95 && g.pickOdds <= 2.15 ? 0 : 0.15),
  },
  {
    id: 'soft_prefer_odds_200_220_l010',
    label: '軟偏好賠率 2.00–2.20（帶外扣 0.10）',
    rescore: (g) =>
      g.baseScore - (g.pickOdds >= 2.0 && g.pickOdds <= 2.2 ? 0 : 0.1),
  },
  // —— 軟沉剩餘低賠（R1/R3 仍可能留下的 1.85–1.95）——
  {
    id: 'soft_sink_low_odds_l010',
    label: '軟沉：低賠帶扣 0.10（硬砍 R2 之外再輕壓）',
    rescore: (g) => g.baseScore - (g.lowOddsBand ? 0.1 : 0),
  },
  {
    id: 'soft_sink_low_odds_l015',
    label: '軟沉：低賠帶扣 0.15',
    rescore: (g) => g.baseScore - (g.lowOddsBand ? 0.15 : 0),
  },
  // —— 組合輕量 ——
  {
    id: 'combo_sink_highm_and_lowodds_l010',
    label: '組合：高margin與低賠各扣 0.10',
    rescore: (g) =>
      g.baseScore - (g.highMargin ? 0.1 : 0) - (g.lowOddsBand ? 0.1 : 0),
  },
  {
    id: 'combo_boost_lowm_sink_lowodds',
    label: '組合：低margin+0.05、低賠-0.10',
    rescore: (g) =>
      g.baseScore + (g.margin < 0.5 ? 0.05 : 0) - (g.lowOddsBand ? 0.1 : 0),
  },
];

console.log('Building…');
const pools = WINDOWS.map((w) => {
  const pool = buildUniverse(w.from, w.to);
  console.log(`  ${w.key}: ${pool.length}`);
  return { ...w, pool };
});
const combined = pools.flatMap((p) => p.pool);

const results = [];
for (const p of POLICIES) {
  const row = { id: p.id, label: p.label, windows: {} };
  for (const w of pools) row.windows[w.key] = summarize(select(w.pool, p.rescore));
  row.windows.combined = summarize(select(combined, p.rescore));
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
    dualPositive: (y25?.usd50 ?? -1) > 0 && (y26?.usd50 ?? -1) > 0,
    keep90: keepRate != null && keepRate >= 0.9,
    keep95: keepRate != null && keepRate >= 0.95,
    hitUp: (c?.hitRate ?? 0) > (bc?.hitRate ?? 1),
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
      (c.hitRate ?? 0) >= bc.hitRate &&
      (c.usd50 ?? 0) >= bc.usd50 * 0.98,
  };
});

evaluated.sort((a, b) => (b.deltaHitRate ?? -1) - (a.deltaHitRate ?? -1));
const goal = evaluated.filter((e) => e.fitsUserGoal && e.id !== 'baseline');
const strict = evaluated.filter((e) => e.passStrict && e.id !== 'baseline');

const out = {
  experimentId: 'soft-route-keep-volume-on-current-2026-07-28',
  generatedAt: new Date().toISOString(),
  goal: 'B線保量軟路由：keep≥90%、勝率/$不降反升；不接再硬砍',
  baseline: evaluated.find((e) => e.id === 'baseline'),
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
          action: 'no_soft_route_beats_baseline_with_volume',
          note: '第四刀未找到 keep≥90% 且嚴格過閘的軟路由；維持現行 dropR3+dropR2',
        },
};

fs.writeFileSync(
  new URL('../tmp-soft-route-keep-volume-on-current.json', import.meta.url),
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
