/**
 * 診斷：為什麼有些天場次很少／為什麼某些單特別容易輸
 * 底座：現行鎖定 B（ev02_max230 + frozen_b+shrink + early軟罰 + dropR3/R2 + Top3）
 * 只分析、不改規則。產物：tmp-why-thin-days-and-toxic-bets.json
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
import {
  applyFrozenResidualToPrediction,
  applyFrozenToxicShrink,
  MLB_FROZEN_B_SHADOW_SPEC,
} from '../src/services/MlbFrozenBShadow.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const RULES = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: 2,
};
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const STRONG = MLB_FROZEN_B_SHADOW_SPEC.shrink.strongHomeWinPct;
const SHRINK_W = MLB_FROZEN_B_SHADOW_SPEC.shrink.w;
const SHRINK_THR = MLB_FROZEN_B_SHADOW_SPEC.shrink.modelProbMin;

const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-28' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function books(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return [];
  const out = [];
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const home =
      m.outcomes.find((o) => o.name === homeTeam) ||
      m.outcomes.find((o) => String(o.name).includes(String(homeTeam).split(' ').pop()));
    const away =
      m.outcomes.find((o) => o.name === awayTeam) ||
      m.outcomes.find((o) => String(o.name).includes(String(awayTeam).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const ho = Number(home.price);
    const ao = Number(away.price);
    if (!Number.isFinite(ho) || !Number.isFinite(ao)) continue;
    out.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao });
  }
  return out;
}

function summarize(bets) {
  if (!bets.length) {
    return { n: 0, hr: null, usd50: 0, unit: 0 };
  }
  let hits = 0;
  let unit = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  return {
    n: bets.length,
    hr: Number((hits / bets.length).toFixed(4)),
    usd50: Math.round(unit * 50),
    unit: Number(unit.toFixed(2)),
  };
}

function sliceTable(bets, keyFn, { minN = 15 } = {}) {
  const map = new Map();
  for (const b of bets) {
    const k = keyFn(b);
    if (k == null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(b);
  }
  return [...map.entries()]
    .map(([key, arr]) => ({ key, ...summarize(arr) }))
    .filter((r) => r.n >= minN)
    .sort((a, b) => (a.hr ?? 1) - (b.hr ?? 1));
}

console.log('[diagnose] loading…');
const validation = getLatestMlbExpectedRunsValidation();
const model = validation.model;

const funnelCounts = {};
const bump = (k) => {
  funnelCounts[k] = (funnelCounts[k] || 0) + 1;
};

const dayStats = new Map(); // day -> { mlbGames, withOdds, pool, picked, dropR3, dropR2 }
const poolByDay = new Map();
const allPicks = [];

for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ?
         AND g.completed = 1
         AND g.home_score IS NOT NULL
         AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?)
         AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);

  for (const row of rows) {
    const day = hk(row.commenceTime);
    if (!dayStats.has(day)) {
      dayStats.set(day, {
        day,
        window: w.key,
        mlbGames: 0,
        withOdds: 0,
        pool: 0,
        picked: 0,
        dropR3: 0,
        dropR2: 0,
      });
    }
    const ds = dayStats.get(day);
    ds.mlbGames += 1;
    bump('mlb_games');

    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      bump('bad_features_json');
      continue;
    }

    const hs = Number(row.homeScore);
    const as = Number(row.awayScore);
    if (hs === as) {
      bump('tie_skip');
      continue;
    }

    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) {
      bump('books_lt_2');
      continue;
    }
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) {
      bump('either_side_too_short');
      continue;
    }
    ds.withOdds += 1;

    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      bump('no_pitcher_id');
      continue;
    }

    const homeWinPct = Number(features?.home?.homeWinPct);
    if (!Number.isFinite(homeWinPct)) {
      bump('no_homeWinPct');
      continue;
    }

    const base = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const adj = applyFrozenResidualToPrediction(model, base, homeWinPct - 0.5, {
      totalLine: 8.5,
    });
    const ph = adj.homeExpectedRuns;
    const pa = adj.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? Number(adj.markets?.homeWinProbability)
      : Number(adj.markets?.awayWinProbability);
    if (!Number.isFinite(modelProb)) {
      bump('no_model_prob');
      continue;
    }

    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < RULES.minimumPickOdds) {
      bump('odds_below_185');
      continue;
    }
    if (pickOdds > RULES.maximumPickOdds) {
      bump('odds_above_230');
      continue;
    }

    modelProb = applyFrozenToxicShrink(modelProb, pickOdds, {
      pickHome,
      homeWinPct,
    });

    const margin = Math.abs(ph - pa);
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);

    if (modelProb < RULES.minimumModelProbability) {
      bump('prob_below_50');
      continue;
    }
    if (margin < RULES.minimumExpectedRunMargin) {
      bump('margin_below_025');
      continue;
    }
    if (ev < RULES.minimumExpectedValue) {
      bump('ev_below_02');
      continue;
    }

    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? Number(sig.homeEarlyExitsLast3) || 0
      : Number(sig.awayEarlyExitsLast3) || 0;
    const oppEarly = pickHome
      ? Number(sig.awayEarlyExitsLast3) || 0
      : Number(sig.homeEarlyExitsLast3) || 0;
    const pickEarlyExitsHigher = pickEarly > oppEarly;

    const score = scoreMlbMoneylineDailyRank(
      {
        expectedValue: ev,
        modelProbability: modelProb,
        pickEarlyExitsHigher,
      },
      RULES
    );

    bump('entered_pool');
    ds.pool += 1;

    const cand = {
      day,
      window: w.key,
      month: day.slice(0, 7),
      pickHome,
      pickOdds,
      margin,
      ev,
      modelProb,
      homeWinPct,
      score,
      hit: pickHome === hs > as,
      toxicAway: !pickHome && homeWinPct >= STRONG,
      toxicAwayP55: !pickHome && homeWinPct >= STRONG && modelProb >= SHRINK_THR,
      earlyHigher: pickEarlyExitsHigher,
      rank: null,
    };
    if (!poolByDay.has(day)) poolByDay.set(day, []);
    poolByDay.get(day).push(cand);
  }
}

// daily Top3 + drops
let dropR3Count = 0;
let dropR2Count = 0;
for (const day of [...poolByDay.keys()].sort()) {
  const ds = dayStats.get(day);
  let slots = [...poolByDay.get(day)].sort(
    (a, b) => b.score - a.score || b.margin - a.margin
  );
  const before = slots.length;
  slots = slots.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3) {
    slots = slots.slice(0, 2);
    dropR3Count += 1;
    if (ds) ds.dropR3 = 1;
  }
  if (
    slots.length >= 2 &&
    slots[1].pickOdds >= DROP_R2_MIN &&
    slots[1].pickOdds < DROP_R2_MAX
  ) {
    slots = [slots[0], ...slots.slice(2)];
    dropR2Count += 1;
    if (ds) ds.dropR2 = 1;
  }
  slots.forEach((s, i) => {
    s.rank = i + 1;
    allPicks.push(s);
  });
  if (ds) {
    ds.picked = slots.length;
    ds.poolBeforeTopK = before;
  }
}

const days = [...dayStats.values()].sort((a, b) => a.day.localeCompare(b.day));
const mlbDays = days.filter((d) => d.mlbGames > 0);
const pickDist = { 0: 0, 1: 0, 2: 0, 3: 0 };
for (const d of mlbDays) {
  const k = Math.min(3, d.picked);
  pickDist[k] = (pickDist[k] || 0) + 1;
}

const emptyDays = mlbDays.filter((d) => d.picked === 0);
const thinDays = mlbDays.filter((d) => d.picked <= 1);
const fullDays = mlbDays.filter((d) => d.picked >= 3);

function avg(arr, fn) {
  if (!arr.length) return null;
  return Number((arr.reduce((s, x) => s + fn(x), 0) / arr.length).toFixed(2));
}

const dayCompare = {
  emptyOrZero: {
    n: emptyDays.length,
    avgMlbGames: avg(emptyDays, (d) => d.mlbGames),
    avgWithOdds: avg(emptyDays, (d) => d.withOdds),
    avgPool: avg(emptyDays, (d) => d.pool),
  },
  onePick: {
    n: mlbDays.filter((d) => d.picked === 1).length,
    avgMlbGames: avg(
      mlbDays.filter((d) => d.picked === 1),
      (d) => d.mlbGames
    ),
    avgWithOdds: avg(
      mlbDays.filter((d) => d.picked === 1),
      (d) => d.withOdds
    ),
    avgPool: avg(
      mlbDays.filter((d) => d.picked === 1),
      (d) => d.pool
    ),
  },
  fullTop3: {
    n: fullDays.length,
    avgMlbGames: avg(fullDays, (d) => d.mlbGames),
    avgWithOdds: avg(fullDays, (d) => d.withOdds),
    avgPool: avg(fullDays, (d) => d.pool),
  },
};

// Why empty: on empty days, what blocked most games?
const emptyDaySet = new Set(emptyDays.map((d) => d.day));
// Re-approximate: among empty days, pool was 0 — so gates ate everything.
// Compare funnel share overall is enough; also pool=0 vs mlb games.

const overall = summarize(allPicks);
const misses = allPicks.filter((b) => !b.hit);
const hits = allPicks.filter((b) => b.hit);

const toxicSlices = [
  {
    name: '客隊 + 強主場(hw≥65%)',
    ...summarize(allPicks.filter((b) => b.toxicAway)),
  },
  {
    name: '客隊 + 強主場 + P≥55%（毒收縮區）',
    ...summarize(allPicks.filter((b) => b.toxicAwayP55)),
  },
  {
    name: '主隊選邊',
    ...summarize(allPicks.filter((b) => b.pickHome)),
  },
  {
    name: '客隊選邊',
    ...summarize(allPicks.filter((b) => !b.pickHome)),
  },
  {
    name: 'earlyExits 偏高（軟罰對象）',
    ...summarize(allPicks.filter((b) => b.earlyHigher)),
  },
  {
    name: 'Rank1',
    ...summarize(allPicks.filter((b) => b.rank === 1)),
  },
  {
    name: 'Rank2',
    ...summarize(allPicks.filter((b) => b.rank === 2)),
  },
  {
    name: 'Rank3',
    ...summarize(allPicks.filter((b) => b.rank === 3)),
  },
];

const byOdds = sliceTable(
  allPicks,
  (b) => {
    if (b.pickOdds < 1.95) return '1.85–1.95';
    if (b.pickOdds < 2.05) return '1.95–2.05';
    if (b.pickOdds < 2.15) return '2.05–2.15';
    return '2.15–2.30';
  },
  { minN: 20 }
);

const byEv = sliceTable(
  allPicks,
  (b) => {
    if (b.ev < 0.04) return 'EV 2–4%';
    if (b.ev < 0.08) return 'EV 4–8%';
    if (b.ev < 0.12) return 'EV 8–12%';
    return 'EV ≥12%';
  },
  { minN: 20 }
);

const byMargin = sliceTable(
  allPicks,
  (b) => {
    if (b.margin < 0.5) return 'margin <0.5';
    if (b.margin < 1.0) return 'margin 0.5–1.0';
    if (b.margin < 1.5) return 'margin 1.0–1.5';
    return 'margin ≥1.5';
  },
  { minN: 20 }
);

const byMonth = sliceTable(allPicks, (b) => b.month, { minN: 20 });

const worstMonths = [...byMonth].sort((a, b) => a.usd50 - b.usd50).slice(0, 5);
const bestMonths = [...byMonth].sort((a, b) => b.usd50 - a.usd50).slice(0, 5);

// funnel as % of mlb games
const mlbN = funnelCounts.mlb_games || 1;
const funnelPct = Object.fromEntries(
  Object.entries(funnelCounts)
    .map(([k, v]) => [k, { n: v, pctOfMlb: Number(((v / mlbN) * 100).toFixed(1)) }])
    .sort((a, b) => b[1].n - a[1].n)
);

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'diagnose_only',
  baseline: 'locked B = ev02_max230 + frozen_b+shrink + earlySoft + dropR3/R2 + Top3',
  windows: WINDOWS,
  funnel: funnelPct,
  daily: {
    mlbDays: mlbDays.length,
    pickDist,
    pickDistPct: Object.fromEntries(
      Object.entries(pickDist).map(([k, v]) => [
        k,
        Number(((v / mlbDays.length) * 100).toFixed(1)),
      ])
    ),
    meanPicks: avg(mlbDays, (d) => d.picked),
    dropR3Days: dropR3Count,
    dropR2Days: dropR2Count,
    dayCompare,
    sampleEmptyDays: emptyDays.slice(0, 8).map((d) => ({
      day: d.day,
      mlbGames: d.mlbGames,
      withOdds: d.withOdds,
      pool: d.pool,
    })),
  },
  picks: {
    overall,
    toxicSlices,
    byOdds,
    byEv,
    byMargin,
    worstMonths,
    bestMonths,
  },
};

fs.writeFileSync(
  new URL('../tmp-why-thin-days-and-toxic-bets.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);

console.log('\n=== 漏斗（相對全部已完賽 MLB 場）===');
for (const [k, v] of Object.entries(funnelPct).slice(0, 16)) {
  console.log(`  ${k}: ${v.n} (${v.pctOfMlb}%)`);
}
console.log('\n=== 日場次數 ===');
console.log('days', mlbDays.length, 'dist', pickDist, 'mean', payload.daily.meanPicks);
console.log('dropR3 days', dropR3Count, 'dropR2 days', dropR2Count);
console.log('dayCompare', JSON.stringify(dayCompare));
console.log('\n=== 整體選注 ===');
console.log(overall);
console.log('\n毒／結構切片:');
for (const s of toxicSlices) {
  console.log(
    `  ${s.name}: n=${s.n} hr=${s.hr != null ? (s.hr * 100).toFixed(1) + '%' : '-'} $=${s.usd50}`
  );
}
console.log('\n賠率帶:');
for (const s of byOdds) {
  console.log(`  ${s.key}: n=${s.n} hr=${(s.hr * 100).toFixed(1)}% $=${s.usd50}`);
}
console.log('\nEV帶:');
for (const s of byEv) {
  console.log(`  ${s.key}: n=${s.n} hr=${(s.hr * 100).toFixed(1)}% $=${s.usd50}`);
}
console.log('\n最差月:');
for (const s of worstMonths) {
  console.log(`  ${s.key}: n=${s.n} hr=${(s.hr * 100).toFixed(1)}% $=${s.usd50}`);
}
console.log('\nwrote tmp-why-thin-days-and-toxic-bets.json');
