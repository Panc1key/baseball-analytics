/**
 * 第三刀候選 WF：drop R2 if odds∈[1.85,1.95)，底座含 dropR3 margin<0.50
 * 產物：tmp-daily-drop-r2-lowodds-wf.json
 * 用法: node scripts/auditMlbDailyDropR2LowOddsWf.mjs
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
/** null=僅 dropR3；其餘=R2 低賠上界（不含） */
const LOW_ODDS_MAX_GRID = [null, 1.9, 1.92, 1.95, 1.98, 2.0];

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
    return { bets: 0, hitRate: null, avgOdds: null, roi: null, unitPnl: 0, usd50: 0 };
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

function select(pool, { dropR2LowOddsMax = null } = {}) {
  const map = byDaySorted(pool);
  const out = [];
  for (const day of [...map.keys()].sort()) {
    let picks = map.get(day).slice(0, 3);
    if (picks.length >= 3 && picks[2].margin < DROP_R3_T) picks = picks.slice(0, 2);
    if (
      dropR2LowOddsMax != null &&
      picks.length >= 2 &&
      picks[1].pickOdds >= 1.85 &&
      picks[1].pickOdds < dropR2LowOddsMax
    ) {
      picks = [picks[0], ...picks.slice(2)];
    }
    out.push(...picks);
  }
  return out;
}

function pickBest(trainPool) {
  let bestMax = null;
  let bestUsd = -Infinity;
  const scored = [];
  for (const max of LOW_ODDS_MAX_GRID) {
    const s = summarize(select(trainPool, { dropR2LowOddsMax: max }));
    scored.push({ dropR2LowOddsMax: max, ...s });
    if (s.bets < 20) continue;
    if (s.usd50 > bestUsd) {
      bestUsd = s.usd50;
      bestMax = max;
    }
  }
  return { bestMax, bestUsd, scored };
}

console.log('Building…');
const pools = WINDOWS.map((w) => ({ ...w, pool: buildUniverse(w.from, w.to) }));
const combined = pools.flatMap((p) => p.pool);
const months = [...new Set(combined.map((g) => g.month))].sort();

const CAND = 1.95;
const baselineAll = summarize(select(combined, { dropR2LowOddsMax: null }));
const candidateAll = summarize(select(combined, { dropR2LowOddsMax: CAND }));

const fixedByMonth = months.map((m) => {
  const monthPool = combined.filter((g) => g.month === m);
  const base = summarize(select(monthPool, { dropR2LowOddsMax: null }));
  const cand = summarize(select(monthPool, { dropR2LowOddsMax: CAND }));
  return {
    month: m,
    base,
    cand,
    deltaUsd50: cand.usd50 - base.usd50,
    deltaHitRate:
      base.hitRate != null && cand.hitRate != null
        ? Number((cand.hitRate - base.hitRate).toFixed(4))
        : null,
    deltaBets: cand.bets - base.bets,
  };
});

const wfFolds = [];
for (let i = 1; i < months.length; i++) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];
  const trainPool = combined.filter((g) => trainMonths.has(g.month));
  const testPool = combined.filter((g) => g.month === testMonth);
  const { bestMax, bestUsd, scored } = pickBest(trainPool);
  const oos = summarize(select(testPool, { dropR2LowOddsMax: bestMax }));
  const baseOos = summarize(select(testPool, { dropR2LowOddsMax: null }));
  const fixedOos = summarize(select(testPool, { dropR2LowOddsMax: CAND }));
  wfFolds.push({
    testMonth,
    chosenMax: bestMax,
    trainUsd50: bestUsd,
    trainTop3: scored.sort((a, b) => b.usd50 - a.usd50).slice(0, 3),
    oos,
    baseOos,
    fixedOos,
    deltaUsdVsBase: oos.usd50 - baseOos.usd50,
    fixedDeltaUsdVsBase: fixedOos.usd50 - baseOos.usd50,
  });
}

const wfOosAll = wfFolds.flatMap((f) =>
  select(
    combined.filter((g) => g.month === f.testMonth),
    { dropR2LowOddsMax: f.chosenMax }
  )
);
const wfBaseAll = wfFolds.flatMap((f) =>
  select(combined.filter((g) => g.month === f.testMonth), {
    dropR2LowOddsMax: null,
  })
);
const wfFixedAll = wfFolds.flatMap((f) =>
  select(combined.filter((g) => g.month === f.testMonth), {
    dropR2LowOddsMax: CAND,
  })
);

const pool2025 = combined.filter((g) => g.window === '2025');
const pool2026 = combined.filter((g) => g.window === '2026');
const holdoutTune = pickBest(pool2025);
const holdout = {
  tunedOn2025: holdoutTune.bestMax,
  base2026: summarize(select(pool2026, { dropR2LowOddsMax: null })),
  oos2026_tuned: summarize(
    select(pool2026, { dropR2LowOddsMax: holdoutTune.bestMax })
  ),
  oos2026_fixed195: summarize(select(pool2026, { dropR2LowOddsMax: CAND })),
};
holdout.tunedDeltaUsd = holdout.oos2026_tuned.usd50 - holdout.base2026.usd50;
holdout.fixedDeltaUsd = holdout.oos2026_fixed195.usd50 - holdout.base2026.usd50;
holdout.tunedDeltaHr =
  holdout.oos2026_tuned.hitRate != null && holdout.base2026.hitRate != null
    ? Number((holdout.oos2026_tuned.hitRate - holdout.base2026.hitRate).toFixed(4))
    : null;
holdout.fixedDeltaHr =
  holdout.oos2026_fixed195.hitRate != null && holdout.base2026.hitRate != null
    ? Number(
        (holdout.oos2026_fixed195.hitRate - holdout.base2026.hitRate).toFixed(4)
      )
    : null;

const wfSum = summarize(wfOosAll);
const wfBaseSum = summarize(wfBaseAll);
const wfFixedSum = summarize(wfFixedAll);
const monthsPos = fixedByMonth.filter((m) => m.deltaUsd50 > 0).length;
const monthsNeg = fixedByMonth.filter((m) => m.deltaUsd50 < 0).length;

const passFixed =
  wfFixedSum.usd50 > wfBaseSum.usd50 &&
  (wfFixedSum.hitRate ?? 0) >= (wfBaseSum.hitRate ?? 0) &&
  holdout.fixedDeltaUsd > 0 &&
  (holdout.fixedDeltaHr ?? -1) >= 0 &&
  monthsPos >= monthsNeg;

const passExpanding =
  wfSum.usd50 > wfBaseSum.usd50 &&
  (wfSum.hitRate ?? 0) >= (wfBaseSum.hitRate ?? 0);

const recommendation = passFixed
  ? {
      action: 'promote_drop_r2_lowodds_195',
      note: '固定 R2 低賠<1.95 在 WF OOS 與 2025→2026 holdout 皆優於 dropR3 基線',
    }
  : passExpanding
    ? {
        action: 'wf_retune_only',
        note: 'Expanding 有增益但固定 1.95 不穩；暫不接',
      }
    : {
        action: 'keep_dropR3_baseline',
        note: 'WF 未穩；維持僅 dropR3',
      };

const out = {
  experimentId: 'daily-drop-r2-lowodds-wf-2026-07-28',
  generatedAt: new Date().toISOString(),
  baseline: 'ev02_max230 + dropR3 margin<0.50',
  candidate: 'additionally drop R2 if pickOdds∈[1.85,1.95)',
  inSample: {
    baseline: baselineAll,
    candidate: candidateAll,
    deltaUsd50: candidateAll.usd50 - baselineAll.usd50,
  },
  fixedByMonth,
  fixedMonthCounts: { positive: monthsPos, negative: monthsNeg },
  walkForward: {
    folds: wfFolds,
    oosCombined: wfSum,
    baseOosCombined: wfBaseSum,
    fixedOosCombined: wfFixedSum,
    deltaUsdVsBase: wfSum.usd50 - wfBaseSum.usd50,
    fixedDeltaUsdVsBase: wfFixedSum.usd50 - wfBaseSum.usd50,
    fixedDeltaHitRateVsBase:
      wfFixedSum.hitRate != null && wfBaseSum.hitRate != null
        ? Number((wfFixedSum.hitRate - wfBaseSum.hitRate).toFixed(4))
        : null,
  },
  holdout2025to2026: holdout,
  gates: { passFixed, passExpanding },
  recommendation,
};

fs.writeFileSync(
  new URL('../tmp-daily-drop-r2-lowodds-wf.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\n=== Fixed by month ===');
for (const m of fixedByMonth) {
  console.log(
    `${m.month} Δ$${m.deltaUsd50} Δhr=${m.deltaHitRate} Δn=${m.deltaBets}`
  );
}
console.log('\n=== WF folds ===');
for (const f of wfFolds) {
  console.log(
    `${f.testMonth} chosen=${f.chosenMax} Δ$${f.deltaUsdVsBase} fixedΔ$${f.fixedDeltaUsdVsBase}`
  );
}
console.log('WF OOS', { wf: wfSum, base: wfBaseSum, fixed: wfFixedSum });
console.log('Holdout', holdout);
console.log('gates', out.gates);
console.log('recommendation', recommendation);
