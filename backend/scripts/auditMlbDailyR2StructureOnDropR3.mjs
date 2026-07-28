/**
 * 第三刀：日內 R2 結構（底座＝現行 ev02_max230，含 dropR3 margin<0.50）
 * 動機：第二刀診斷 R2 勝率 ~50.7% 明顯弱於 R1
 * 約束：勝率↑、keep≥85%、合併$/雙窗閘；不擋月份
 * 產物：tmp-daily-r2-structure-on-dropR3.json
 *
 * 用法: node scripts/auditMlbDailyR2StructureOnDropR3.mjs
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
    const score = scoreMlbMoneylineDailyRank(
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
      score,
      lowOddsBand: pickOdds >= 1.85 && pickOdds < 1.95,
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

/** 現行基線：Top3，但第3名 margin < DROP_R3_T → 只取前2 */
function applyDropR3(dayRanked) {
  const top = dayRanked.slice(0, 3);
  if (top.length >= 3 && top[2].margin < DROP_R3_T) return top.slice(0, 2);
  return top;
}

function selectWithPolicy(pool, policyFn) {
  const map = byDaySorted(pool);
  const out = [];
  for (const day of [...map.keys()].sort()) {
    out.push(...policyFn(map.get(day)));
  }
  return out;
}

const POLICIES = [
  {
    id: 'baseline_dropR3',
    label: `現行基線（dropR3 margin<${DROP_R3_T}）`,
    fn: (d) => applyDropR3(d),
  },
  {
    id: 'topk1_only',
    label: '只取 R1',
    fn: (d) => d.slice(0, 1),
  },
  {
    id: 'drop_r2_if_margin_lt_040',
    label: 'R2 margin<0.40 → 跳過 R2（可保留 R3 若過 dropR3）',
    fn: (d) => {
      const base = applyDropR3(d);
      if (base.length < 2) return base;
      if (base[1].margin >= 0.4) return base;
      // 去掉 R2，不把更後面補進來（對齊 dropR3 風格）
      return [base[0], ...base.slice(2)];
    },
  },
  {
    id: 'drop_r2_if_margin_lt_050',
    label: 'R2 margin<0.50 → 去掉 R2',
    fn: (d) => {
      const base = applyDropR3(d);
      if (base.length < 2) return base;
      if (base[1].margin >= 0.5) return base;
      return [base[0], ...base.slice(2)];
    },
  },
  {
    id: 'drop_r2_if_margin_lt_060',
    label: 'R2 margin<0.60 → 去掉 R2',
    fn: (d) => {
      const base = applyDropR3(d);
      if (base.length < 2) return base;
      if (base[1].margin >= 0.6) return base;
      return [base[0], ...base.slice(2)];
    },
  },
  {
    id: 'drop_r2_if_score_gap_lt_002',
    label: 'R1–R2 分差 <0.02 → 去掉 R2',
    fn: (d) => {
      const base = applyDropR3(d);
      if (base.length < 2) return base;
      if (base[0].score - base[1].score >= 0.02) return base;
      return [base[0], ...base.slice(2)];
    },
  },
  {
    id: 'drop_r2_if_score_gap_lt_005',
    label: 'R1–R2 分差 <0.05 → 去掉 R2',
    fn: (d) => {
      const base = applyDropR3(d);
      if (base.length < 2) return base;
      if (base[0].score - base[1].score >= 0.05) return base;
      return [base[0], ...base.slice(2)];
    },
  },
  {
    id: 'drop_r2_if_low_odds',
    label: 'R2 賠率∈[1.85,1.95) → 去掉 R2',
    fn: (d) => {
      const base = applyDropR3(d);
      if (base.length < 2) return base;
      if (!base[1].lowOddsBand) return base;
      return [base[0], ...base.slice(2)];
    },
  },
  {
    id: 'drop_r2_if_ev_lt_003',
    label: 'R2 EV<0.03 → 去掉 R2（相對門檻偏緊）',
    fn: (d) => {
      const base = applyDropR3(d);
      if (base.length < 2) return base;
      if (base[1].ev >= 0.03) return base;
      return [base[0], ...base.slice(2)];
    },
  },
  {
    id: 'drop_r2_if_ev_lt_004',
    label: 'R2 EV<0.04 → 去掉 R2',
    fn: (d) => {
      const base = applyDropR3(d);
      if (base.length < 2) return base;
      if (base[1].ev >= 0.04) return base;
      return [base[0], ...base.slice(2)];
    },
  },
  {
    id: 'require_r2_margin_ge_r3_style',
    label: 'R2 也套 margin≥0.50，否則去掉（與 R3 同門檻）',
    fn: (d) => {
      const base = applyDropR3(d);
      if (base.length < 2) return base;
      if (base[1].margin >= 0.5) return base;
      return [base[0], ...base.slice(2)];
    },
  },
  {
    id: 'promote_r3_over_weak_r2',
    label: 'R2 margin<0.50 且 R3 存在且 margin≥0.50 → 用 R3 替換 R2',
    fn: (d) => {
      const ranked = d.slice(0, 4);
      if (ranked.length < 2) return ranked.slice(0, 1);
      // 先算有效 R3（過 dropR3）
      let r3 = ranked[2] || null;
      if (r3 && r3.margin < DROP_R3_T) r3 = null;
      const r1 = ranked[0];
      const r2 = ranked[1];
      if (r2.margin >= 0.5 || !r3 || r3.margin < 0.5) {
        return applyDropR3(ranked);
      }
      return [r1, r3];
    },
  },
  {
    id: 'soft_sink_weak_r2_l015',
    label: 'R2 margin<0.50 時日內重排：弱單 score-0.15 後再 dropR3',
    fn: (d) => {
      const rescored = d.map((g, i) => {
        // 先依原序標記潛在 R2 不夠穩：對所有 margin<0.5 扣分（除最高分者外）
        return { ...g, score: g.margin < 0.5 ? g.score - 0.15 : g.score };
      });
      rescored.sort((a, b) => b.score - a.score || b.margin - a.margin);
      return applyDropR3(rescored);
    },
  },
  {
    id: 'soft_sink_weak_r2_l030',
    label: '弱 margin 單 score-0.30 後再 dropR3',
    fn: (d) => {
      const rescored = d.map((g) => ({
        ...g,
        score: g.margin < 0.5 ? g.score - 0.3 : g.score,
      }));
      rescored.sort((a, b) => b.score - a.score || b.margin - a.margin);
      return applyDropR3(rescored);
    },
  },
];

console.log(`Building… (baseline dropR3 T=${DROP_R3_T})`);
const pools = WINDOWS.map((w) => {
  const pool = buildUniverse(w.from, w.to);
  console.log(`  ${w.key}: ${pool.length}`);
  return { ...w, pool };
});
const combined = pools.flatMap((p) => p.pool);

/** 診斷：基線選注後各順位 */
const basePicks = selectWithPolicy(combined, POLICIES[0].fn);
const byRank = { r1: [], r2: [], r3: [] };
{
  const map = byDaySorted(combined);
  for (const day of map.keys()) {
    const picks = applyDropR3(map.get(day));
    if (picks[0]) byRank.r1.push(picks[0]);
    if (picks[1]) byRank.r2.push(picks[1]);
    if (picks[2]) byRank.r3.push(picks[2]);
  }
}
const rankDiag = {
  r1: summarize(byRank.r1),
  r2: summarize(byRank.r2),
  r3: summarize(byRank.r3),
  r2_margin_lt_050: summarize(byRank.r2.filter((g) => g.margin < 0.5)),
  r2_margin_ge_050: summarize(byRank.r2.filter((g) => g.margin >= 0.5)),
  r2_lowOdds: summarize(byRank.r2.filter((g) => g.lowOddsBand)),
};
console.log('rankDiag', JSON.stringify(rankDiag, null, 2));

const results = [];
for (const p of POLICIES) {
  const row = { id: p.id, label: p.label, windows: {} };
  for (const w of pools) {
    row.windows[w.key] = summarize(selectWithPolicy(w.pool, p.fn));
  }
  const picks = selectWithPolicy(combined, p.fn);
  row.windows.combined = summarize(picks);
  results.push(row);
  const c = row.windows.combined;
  console.log(
    `${p.id.padEnd(32)} n=${String(c?.bets ?? 0).padStart(3)} hr=${c?.hitRate} $50=${c?.usd50}`
  );
}

const base = results.find((r) => r.id === 'baseline_dropR3');
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
    beatsBase: (c?.usd50 ?? -Infinity) > (bc?.usd50 ?? 0),
    notWorseBoth:
      (y25?.usd50 ?? -Infinity) >= (b25?.usd50 ?? 0) &&
      (y26?.usd50 ?? -Infinity) >= (b26?.usd50 ?? 0),
    hit55: (c?.hitRate ?? 0) >= 0.55,
    hit56: (c?.hitRate ?? 0) >= 0.56,
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
const goal = evaluated.filter((e) => e.fitsUserGoal && e.id !== 'baseline_dropR3');
const strict = evaluated.filter((e) => e.passStrict && e.id !== 'baseline_dropR3');

const out = {
  experimentId: 'daily-r2-structure-on-dropR3-2026-07-28',
  generatedAt: new Date().toISOString(),
  baselineNote: `ev02_max230 + dropThirdIfMarginBelow=${DROP_R3_T}`,
  rankDiag,
  baseline: evaluated.find((e) => e.id === 'baseline_dropR3'),
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
          action: 'no_r2_route_meets_gate',
          note: '第三刀未找到同時抬勝率、保量、過閘的 R2 路由；維持 dropR3 基線',
        },
};

fs.writeFileSync(
  new URL('../tmp-daily-r2-structure-on-dropR3.json', import.meta.url),
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
