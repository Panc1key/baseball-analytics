/**
 * B 主力 + A 增量（非生搬硬套）
 * - B 基準包原樣不動
 * - A 候選池：P≥55% + margin≥1，且 gameId 不在當日 B 選中集合
 * - 掃「怎樣挑一部分 A」才能讓合併：注數↑、總$≥B、勝率≥B（盡量）
 *
 * 產物：tmp-b-plus-a-incremental.json
 * 用法: node scripts/auditMlbBPlusAIncremental.mjs
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
  if (!bets.length) {
    return {
      bets: 0,
      hitRate: null,
      avgOdds: null,
      breakeven: null,
      clearsOwn: false,
      roi: null,
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
  const n = bets.length;
  const avg = odds / n;
  const hr = hits / n;
  const be = 1 / avg;
  return {
    bets: n,
    hitRate: Number(hr.toFixed(4)),
    avgOdds: Number(avg.toFixed(3)),
    breakeven: Number(be.toFixed(4)),
    clearsOwn: hr > be,
    roi: Number((unit / n).toFixed(4)),
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
  return slots.map((g) => ({ ...g, line: 'B' }));
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

/** A 增量池：A 門檻 + 不在 B 已選 gameId */
function aCandidatePool(pool, bPicks, extraFilter) {
  const bIds = new Set(bPicks.map((g) => g.gameId));
  return pool.filter((g) => {
    if (bIds.has(g.gameId)) return false;
    if (g.modelProb < 0.55 || g.margin < 1) return false;
    return extraFilter ? extraFilter(g) : true;
  });
}

function pickADaily(cands, { dailyTopK, rankBy }) {
  const map = new Map();
  for (const g of cands) {
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const arr = [...map.get(day)].sort((a, b) => {
      if (rankBy === 'edge') return b.edgeVsBe - a.edgeVsBe || b.margin - a.margin;
      if (rankBy === 'margin') return b.margin - a.margin || b.modelProb - a.modelProb;
      if (rankBy === 'ev') return b.ev - a.ev || b.margin - a.margin;
      return b.modelProb - a.modelProb || b.margin - a.margin;
    });
    out.push(...arr.slice(0, dailyTopK).map((g) => ({ ...g, line: 'A' })));
  }
  return out;
}

/** 僅在當日 B 注數 < need 時補 A */
function pickAFillWhenBThin(pool, bPicks, { dailyTopK, minBToSkip, extraFilter, rankBy }) {
  const bByDay = new Map();
  for (const g of bPicks) {
    bByDay.set(g.day, (bByDay.get(g.day) || 0) + 1);
  }
  const cands = aCandidatePool(pool, bPicks, (g) => {
    if (extraFilter && !extraFilter(g)) return false;
    const bn = bByDay.get(g.day) || 0;
    return bn < minBToSkip;
  });
  return pickADaily(cands, { dailyTopK, rankBy });
}

const POLICIES = [
  {
    id: 'b_only',
    label: '純B（對照）',
    pickA: () => [],
  },
  {
    id: 'inc_a_all_topk1',
    label: '增量：A全池每日Top1（短長不限）',
    pickA: (pool, b) =>
      pickADaily(aCandidatePool(pool, b), { dailyTopK: 1, rankBy: 'prob' }),
  },
  {
    id: 'inc_a_short_lt185_topk1',
    label: '增量：僅短賠<1.85 的A，每日Top1',
    pickA: (pool, b) =>
      pickADaily(aCandidatePool(pool, b, (g) => g.pickOdds < 1.85), {
        dailyTopK: 1,
        rankBy: 'prob',
      }),
  },
  {
    id: 'inc_a_short_lt185_edge02_topk1',
    label: '增量：短賠A且 edge≥2pp，每日Top1',
    pickA: (pool, b) =>
      pickADaily(
        aCandidatePool(pool, b, (g) => g.pickOdds < 1.85 && g.edgeVsBe >= 0.02),
        { dailyTopK: 1, rankBy: 'edge' }
      ),
  },
  {
    id: 'inc_a_short_lt185_edge03_topk1',
    label: '增量：短賠A且 edge≥3pp，每日Top1',
    pickA: (pool, b) =>
      pickADaily(
        aCandidatePool(pool, b, (g) => g.pickOdds < 1.85 && g.edgeVsBe >= 0.03),
        { dailyTopK: 1, rankBy: 'edge' }
      ),
  },
  {
    id: 'inc_a_short_p58_topk1',
    label: '增量：短賠A且P≥58%，每日Top1',
    pickA: (pool, b) =>
      pickADaily(
        aCandidatePool(pool, b, (g) => g.pickOdds < 1.85 && g.modelProb >= 0.58),
        { dailyTopK: 1, rankBy: 'prob' }
      ),
  },
  {
    id: 'inc_a_short_p60_topk1',
    label: '增量：短賠A且P≥60%，每日Top1',
    pickA: (pool, b) =>
      pickADaily(
        aCandidatePool(pool, b, (g) => g.pickOdds < 1.85 && g.modelProb >= 0.6),
        { dailyTopK: 1, rankBy: 'prob' }
      ),
  },
  {
    id: 'inc_a_170_185_edge02_topk1',
    label: '增量：A∈[1.70,1.85)且edge≥2pp Top1',
    pickA: (pool, b) =>
      pickADaily(
        aCandidatePool(
          pool,
          b,
          (g) => g.pickOdds >= 1.7 && g.pickOdds < 1.85 && g.edgeVsBe >= 0.02
        ),
        { dailyTopK: 1, rankBy: 'edge' }
      ),
  },
  {
    id: 'inc_a_fill_when_b_lt2',
    label: '增量：當日B<2場才補短賠A Top1',
    pickA: (pool, b) =>
      pickAFillWhenBThin(pool, b, {
        dailyTopK: 1,
        minBToSkip: 2,
        extraFilter: (g) => g.pickOdds < 1.85,
        rankBy: 'prob',
      }),
  },
  {
    id: 'inc_a_fill_when_b_lt2_edge02',
    label: '增量：B<2場才補短賠A且edge≥2pp',
    pickA: (pool, b) =>
      pickAFillWhenBThin(pool, b, {
        dailyTopK: 1,
        minBToSkip: 2,
        extraFilter: (g) => g.pickOdds < 1.85 && g.edgeVsBe >= 0.02,
        rankBy: 'edge',
      }),
  },
  {
    id: 'inc_a_fill_when_b_eq0',
    label: '增量：當日B=0才補短賠A Top1',
    pickA: (pool, b) =>
      pickAFillWhenBThin(pool, b, {
        dailyTopK: 1,
        minBToSkip: 1,
        extraFilter: (g) => g.pickOdds < 1.85,
        rankBy: 'prob',
      }),
  },
  {
    id: 'inc_a_long_ge185_not_in_b',
    label: '增量：A門檻且賠率≥1.85但不在B（漏網長賠）Top1',
    pickA: (pool, b) =>
      pickADaily(
        aCandidatePool(pool, b, (g) => g.pickOdds >= 1.85 && g.pickOdds <= 2.3),
        { dailyTopK: 1, rankBy: 'prob' }
      ),
  },
];

console.log('Building…');
const pools = WINDOWS.map((w) => {
  const pool = build(w.from, w.to);
  console.log(`  ${w.key}: ${pool.length}`);
  return { ...w, pool };
});

function runPolicy(policy) {
  const windows = {};
  const allMerged = [];
  const allA = [];
  for (const w of pools) {
    const b = selectB(w.pool);
    const a = policy.pickA(w.pool, b);
    const merged = [...b, ...a];
    windows[w.key] = {
      merged: summarize(merged),
      aOnly: summarize(a),
      bOnly: summarize(b),
    };
    allMerged.push(...merged);
    allA.push(...a);
  }
  windows.combined = {
    merged: summarize(allMerged),
    aOnly: summarize(allA),
    bOnly: summarize(selectB(pools.flatMap((p) => p.pool))),
  };
  return windows;
}

const results = [];
for (const p of POLICIES) {
  const windows = runPolicy(p);
  results.push({ id: p.id, label: p.label, windows });
  const m = windows.combined.merged;
  const a = windows.combined.aOnly;
  const b = windows.combined.bOnly;
  console.log(
    `${p.id.padEnd(34)} merge n=${String(m.bets).padStart(3)} hr=${m.hitRate} $=${m.usd50} | A+${a.bets} A$=${a.usd50} | Δn=${m.bets - b.bets} Δ$=${m.usd50 - b.usd50} Δhr=${(m.hitRate - b.hitRate).toFixed(4)}`
  );
}

const base = results.find((r) => r.id === 'b_only');
const bC = base.windows.combined.merged;
const b25 = base.windows['2025'].merged;
const b26 = base.windows['2026'].merged;

const evaluated = results.map((r) => {
  const m = r.windows.combined.merged;
  const m25 = r.windows['2025'].merged;
  const m26 = r.windows['2026'].merged;
  const a = r.windows.combined.aOnly;
  return {
    id: r.id,
    label: r.label,
    merged: m,
    aOnly: a,
    y2025: m25,
    y2026: m26,
    deltaBets: m.bets - bC.bets,
    deltaUsd50: m.usd50 - bC.usd50,
    deltaHitRate: Number((m.hitRate - bC.hitRate).toFixed(4)),
    // 用戶目標：場次↑、總利≥B、勝率盡量↑，且雙窗不差於B
    fitsUserGoal:
      r.id !== 'b_only' &&
      m.bets > bC.bets &&
      m.usd50 >= bC.usd50 &&
      m.hitRate >= bC.hitRate &&
      m25.usd50 >= b25.usd50 &&
      m26.usd50 >= b26.usd50,
    fitsLoose:
      r.id !== 'b_only' &&
      m.bets > bC.bets &&
      m.usd50 >= bC.usd50 &&
      m25.usd50 > 0 &&
      m26.usd50 > 0,
  };
});

evaluated.sort((a, b) => (b.deltaUsd50 ?? -999) - (a.deltaUsd50 ?? -999));
const fits = evaluated.filter((e) => e.fitsUserGoal);
const loose = evaluated.filter((e) => e.fitsLoose);

const out = {
  experimentId: 'b-plus-a-incremental-2026-07-28',
  goal: 'B主力 + 部分A增量：場次↑、總$≥B、勝率≥B（雙窗不傷B）',
  bBaseline: { combined: bC, y2025: b25, y2026: b26 },
  fitsUserGoal: fits,
  fitsLooseVolumeAndProfit: loose,
  rankedByMergeUsdLift: evaluated,
  recommendation: fits[0]
    ? {
        action: 'wire_incremental_a',
        id: fits[0].id,
        label: fits[0].label,
        deltaBets: fits[0].deltaBets,
        deltaUsd50: fits[0].deltaUsd50,
        deltaHitRate: fits[0].deltaHitRate,
      }
    : loose[0]
      ? {
          action: 'weak_incremental',
          id: loose[0].id,
          label: loose[0].label,
          note: '能加場且總$不低於B，但勝率或雙窗未同時達標',
          deltaBets: loose[0].deltaBets,
          deltaUsd50: loose[0].deltaUsd50,
          deltaHitRate: loose[0].deltaHitRate,
        }
      : {
          action: 'no_incremental_a_yet',
          note: '目前A增量子集加進去會傷總利或勝率；B繼續獨跑，A需換訊號',
        },
};

fs.writeFileSync(
  new URL('../tmp-b-plus-a-incremental.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\n=== fitsUserGoal (場次↑ $≥B 勝率≥B 雙窗≥B) ===');
for (const e of fits) {
  console.log(
    `${e.id}: Δn=${e.deltaBets} Δ$=${e.deltaUsd50} Δhr=${e.deltaHitRate} A$=${e.aOnly.usd50}`
  );
}
console.log('\n=== loose ===');
for (const e of loose) {
  console.log(
    `${e.id}: Δn=${e.deltaBets} Δ$=${e.deltaUsd50} Δhr=${e.deltaHitRate}`
  );
}
console.log('\nrecommendation:', out.recommendation);
