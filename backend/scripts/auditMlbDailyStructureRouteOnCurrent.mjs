/**
 * 第二刀：日內結構路由（縮 TopK／跳過毒第 3）
 * 底座：ev02_max230 + ≥2庄；不擋月份、不改正式常數
 * 約束：勝率是否↑；注數 keep≥85%/90%；合併$/雙窗閘
 * 產物：tmp-daily-structure-route-on-current.json
 *
 * 用法: node scripts/auditMlbDailyStructureRouteOnCurrent.mjs
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
const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
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
function pickSigned(diff, pickHome) {
  if (diff == null) return null;
  return pickHome ? diff : -diff;
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
    const advRecentRuns = pickSigned(n(v.recentRunsDiff), pickHome);
    const advPitcherK9 = pickSigned(n(v.pitcherK9Diff), pickHome);
    const score = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      R
    );
    pool.push({
      day: hk(row.commenceTime),
      month: String(row.commenceTime).slice(0, 7),
      window: from.startsWith('2025') ? '2025' : '2026',
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      advRecentRuns,
      advPitcherK9,
      toxicCross:
        advRecentRuns != null &&
        advPitcherK9 != null &&
        advRecentRuns < 0 &&
        advPitcherK9 > 0.3,
      lowOddsBand: pickOdds >= 1.85 && pickOdds < 1.95,
      score,
    });
  }
  return pool;
}

function byDaySorted(pool) {
  const map = new Map();
  for (const g of pool) {
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  for (const [, arr] of map) {
    arr.sort((a, b) => b.score - a.score || b.margin - a.margin);
  }
  return map;
}

/** 日內選注：policy(dayCandidatesSorted) → 取出陣列 */
function selectWithPolicy(pool, policy) {
  const map = byDaySorted(pool);
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const ranked = map.get(day);
    out.push(...policy(ranked));
  }
  return out;
}

const POLICIES = [
  {
    id: 'baseline_topk3',
    label: '現行 TopK=3',
    fn: (d) => d.slice(0, 3),
  },
  {
    id: 'topk2_always',
    label: '一律 TopK=2',
    fn: (d) => d.slice(0, 2),
  },
  {
    id: 'topk1_always',
    label: '一律 TopK=1',
    fn: (d) => d.slice(0, 1),
  },
  {
    id: 'skip_r3_low_odds',
    label: '第3名若賠率∈[1.85,1.95) 則跳過（可補第4）',
    fn: (d) => {
      const out = [];
      for (const g of d) {
        if (out.length >= 3) break;
        if (out.length === 2 && g.lowOddsBand) continue;
        out.push(g);
      }
      return out;
    },
  },
  {
    id: 'skip_r3_toxic',
    label: '第3名若攻冷×高K9 則跳過（可補第4）',
    fn: (d) => {
      const out = [];
      for (const g of d) {
        if (out.length >= 3) break;
        if (out.length === 2 && g.toxicCross) continue;
        out.push(g);
      }
      return out;
    },
  },
  {
    id: 'skip_r3_low_or_toxic',
    label: '第3名若低賠或攻K毒 則跳過（可補第4）',
    fn: (d) => {
      const out = [];
      for (const g of d) {
        if (out.length >= 3) break;
        if (out.length === 2 && (g.lowOddsBand || g.toxicCross)) continue;
        out.push(g);
      }
      return out;
    },
  },
  {
    id: 'drop_r3_if_low_odds',
    label: '第3名低賠則當日只取前2（不補第4）',
    fn: (d) => {
      const top = d.slice(0, 3);
      if (top.length >= 3 && top[2].lowOddsBand) return top.slice(0, 2);
      return top;
    },
  },
  {
    id: 'drop_r3_if_toxic',
    label: '第3名攻K毒則當日只取前2',
    fn: (d) => {
      const top = d.slice(0, 3);
      if (top.length >= 3 && top[2].toxicCross) return top.slice(0, 2);
      return top;
    },
  },
  {
    id: 'drop_r3_if_margin_lt_040',
    label: '第3名 margin<0.40 則只取前2',
    fn: (d) => {
      const top = d.slice(0, 3);
      if (top.length >= 3 && top[2].margin < 0.4) return top.slice(0, 2);
      return top;
    },
  },
  {
    id: 'drop_r3_if_margin_lt_050',
    label: '第3名 margin<0.50 則只取前2',
    fn: (d) => {
      const top = d.slice(0, 3);
      if (top.length >= 3 && top[2].margin < 0.5) return top.slice(0, 2);
      return top;
    },
  },
  {
    id: 'drop_r3_if_score_gap_lt_002',
    label: '第1–3分差 <0.02 則只取前2',
    fn: (d) => {
      const top = d.slice(0, 3);
      if (top.length >= 3 && top[0].score - top[2].score < 0.02) return top.slice(0, 2);
      return top;
    },
  },
  {
    id: 'drop_r3_if_score_gap_lt_005',
    label: '第1–3分差 <0.05 則只取前2',
    fn: (d) => {
      const top = d.slice(0, 3);
      if (top.length >= 3 && top[0].score - top[2].score < 0.05) return top.slice(0, 2);
      return top;
    },
  },
  {
    id: 'adaptive_weak_day_topk2',
    label: '當日合格池≤3 或均分差小 → Top2，否則 Top3',
    fn: (d) => {
      if (d.length <= 3) return d.slice(0, 2);
      const gap = d[0].score - (d[2]?.score ?? d[0].score);
      if (gap < 0.03) return d.slice(0, 2);
      return d.slice(0, 3);
    },
  },
  {
    id: 'adaptive_toxic_share_topk2',
    label: '當日毒單佔比≥50% → Top2，否則 Top3',
    fn: (d) => {
      const toxicShare = d.filter((g) => g.toxicCross || g.lowOddsBand).length / Math.max(d.length, 1);
      return d.slice(0, toxicShare >= 0.5 ? 2 : 3);
    },
  },
  {
    id: 'never_take_r3_low_odds',
    label: '任一順位若低賠帶則跳過（保 Top3 名額可補）',
    fn: (d) => {
      const out = [];
      for (const g of d) {
        if (out.length >= 3) break;
        if (g.lowOddsBand) continue;
        out.push(g);
      }
      return out;
    },
  },
];

console.log('Building…');
const pools = WINDOWS.map((w) => {
  const pool = buildUniverse(w.from, w.to);
  console.log(`  ${w.key}: ${pool.length}`);
  return { ...w, pool };
});
const combined = pools.flatMap((p) => p.pool);

/** 診斷：現行 Top3 各順位勝率 */
const basePicks = selectWithPolicy(combined, POLICIES[0].fn);
const rankDiag = { r1: [], r2: [], r3: [] };
{
  const map = byDaySorted(combined);
  for (const day of map.keys()) {
    const d = map.get(day).slice(0, 3);
    if (d[0]) rankDiag.r1.push(d[0]);
    if (d[1]) rankDiag.r2.push(d[1]);
    if (d[2]) rankDiag.r3.push(d[2]);
  }
}
const byRank = {
  r1: summarize(rankDiag.r1),
  r2: summarize(rankDiag.r2),
  r3: summarize(rankDiag.r3),
  r3_lowOdds: summarize(rankDiag.r3.filter((g) => g.lowOddsBand)),
  r3_toxic: summarize(rankDiag.r3.filter((g) => g.toxicCross)),
  r3_ok: summarize(rankDiag.r3.filter((g) => !g.lowOddsBand && !g.toxicCross)),
};
console.log('rankDiag', JSON.stringify(byRank, null, 2));

const results = [];
for (const p of POLICIES) {
  const row = { id: p.id, label: p.label, windows: {} };
  for (const w of pools) {
    row.windows[w.key] = summarize(selectWithPolicy(w.pool, p.fn));
  }
  const picks = selectWithPolicy(combined, p.fn);
  row.windows.combined = summarize(picks);
  row.june2025 = summarize(picks.filter((g) => g.month === '2025-06'));
  results.push(row);
  const c = row.windows.combined;
  console.log(
    `${p.id.padEnd(30)} n=${String(c?.bets ?? 0).padStart(3)} hr=${c?.hitRate} $50=${c?.usd50} jun=${row.june2025?.usd50}`
  );
}

const base = results.find((r) => r.id === 'baseline_topk3');
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
    june2025: r.june2025,
    keepRate,
    deltaBets: c && bc ? c.bets - bc.bets : null,
    deltaUsd50: c && bc ? c.usd50 - bc.usd50 : null,
    deltaHitRate: c && bc ? Number((c.hitRate - bc.hitRate).toFixed(4)) : null,
    deltaJuneUsd50: (r.june2025?.usd50 ?? 0) - (base.june2025?.usd50 ?? 0),
    dualPositive: (y25?.usd50 ?? -1) > 0 && (y26?.usd50 ?? -1) > 0,
    beatsBase: (c?.usd50 ?? -Infinity) > (bc?.usd50 ?? 0),
    notWorseBoth:
      (y25?.usd50 ?? -Infinity) >= (b25?.usd50 ?? 0) &&
      (y26?.usd50 ?? -Infinity) >= (b26?.usd50 ?? 0),
    hit55: (c?.hitRate ?? 0) >= 0.55,
    keep85: keepRate != null && keepRate >= 0.85,
    keep90: keepRate != null && keepRate >= 0.9,
    passGate:
      Boolean(c) &&
      (c.usd50 ?? -Infinity) > bc.usd50 &&
      (y25?.usd50 ?? -1) > 0 &&
      (y26?.usd50 ?? -1) > 0,
    passStrict:
      Boolean(c) &&
      (c.usd50 ?? -Infinity) > bc.usd50 &&
      (y25?.usd50 ?? -1) > 0 &&
      (y26?.usd50 ?? -1) > 0 &&
      (y25?.usd50 ?? -Infinity) >= b25.usd50 &&
      (y26?.usd50 ?? -Infinity) >= b26.usd50,
    fitsUserGoal:
      Boolean(c) &&
      (y25?.usd50 ?? -1) > 0 &&
      (y26?.usd50 ?? -1) > 0 &&
      (c.hitRate ?? 0) > bc.hitRate &&
      keepRate >= 0.85 &&
      (c.usd50 ?? 0) >= bc.usd50 * 0.95,
  };
});

evaluated.sort((a, b) => (b.deltaHitRate ?? -1) - (a.deltaHitRate ?? -1));

const goal = evaluated.filter((e) => e.fitsUserGoal && e.id !== 'baseline_topk3');
const strict = evaluated.filter((e) => e.passStrict && e.id !== 'baseline_topk3');

const out = {
  experimentId: 'daily-structure-route-on-current-2026-07-28',
  generatedAt: new Date().toISOString(),
  goal: '日內結構抬勝率；注數 keep≥85%；不擋月份；不改正式常數',
  byRankDiagnostic: byRank,
  baseline: evaluated.find((e) => e.id === 'baseline_topk3'),
  fitsUserGoal: goal,
  passStrictGate: strict,
  rankedByHitRateLift: evaluated,
  recommendation: strict[0]
    ? {
        action: 'consider_exp_policy',
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
          note: '勝率升且保量，但未過嚴格美元雙窗閘',
        }
      : {
          action: 'no_daily_route_meets_wr_volume_gate',
          note: '第二刀未找到同時抬勝率、保量、過閘的日內路由；維持 TopK=3',
        },
};

fs.writeFileSync(
  new URL('../tmp-daily-structure-route-on-current.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\n=== fitsUserGoal ===');
for (const e of goal) {
  console.log(
    `${e.id}: hr=${e.combined.hitRate} keep=${e.keepRate} d$=${e.deltaUsd50} junΔ=${e.deltaJuneUsd50} strict=${e.passStrict}`
  );
}
console.log('\n=== passStrict ===');
for (const e of strict) {
  console.log(`${e.id}: hr=${e.combined.hitRate} keep=${e.keepRate} d$=${e.deltaUsd50}`);
}
console.log('\nrecommendation:', out.recommendation);
