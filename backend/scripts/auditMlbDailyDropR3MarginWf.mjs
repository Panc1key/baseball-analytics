/**
 * 第二刀候選 walk-forward：drop_r3_if_margin_lt_T
 * 底座：ev02_max230 + ≥2庄；不改正式常數
 *
 * 協議：
 * 1) 固定 T=0.50：按月 OOS vs 基線 Top3（無重選）
 * 2) Expanding：先前月在網格選最佳 T，套到下一月
 * 3) Holdout：2025 選 T → 2026 測；反向僅報告
 *
 * 產物：tmp-daily-drop-r3-margin-wf.json
 * 用法: node scripts/auditMlbDailyDropR3MarginWf.mjs
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
/** null = 基線一律 Top3；其餘 = 第3名 margin < T 則只取前2 */
const THRESHOLD_GRID = [null, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
const CANDIDATE_T = 0.5;

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

function selectWithThreshold(pool, T) {
  const map = byDaySorted(pool);
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const d = map.get(day);
    const top = d.slice(0, 3);
    if (T == null) {
      out.push(...top);
      continue;
    }
    if (top.length >= 3 && top[2].margin < T) out.push(...top.slice(0, 2));
    else out.push(...top);
  }
  return out;
}

function pickBestT(trainPool, grid = THRESHOLD_GRID) {
  let bestT = null;
  let bestUsd = -Infinity;
  let bestRoi = -Infinity;
  const scored = [];
  for (const T of grid) {
    const s = summarize(selectWithThreshold(trainPool, T));
    scored.push({ T, ...s });
    if (s.bets < 20) continue;
    // 主目標：訓練窗 usd50；平手看 ROI
    if (s.usd50 > bestUsd || (s.usd50 === bestUsd && (s.roi ?? -1) > bestRoi)) {
      bestUsd = s.usd50;
      bestRoi = s.roi ?? -1;
      bestT = T;
    }
  }
  return { bestT, bestUsd, bestRoi, scored };
}

console.log('Building…');
const pools = WINDOWS.map((w) => ({ ...w, pool: buildUniverse(w.from, w.to) }));
for (const w of pools) console.log(`  ${w.key}: ${w.pool.length}`);
const combined = pools.flatMap((p) => p.pool);
const months = [...new Set(combined.map((g) => g.month))].sort();

const baselineAll = summarize(selectWithThreshold(combined, null));
const candidateAll = summarize(selectWithThreshold(combined, CANDIDATE_T));

/** 1) 固定 T=0.50 按月 vs 基線 */
const fixedByMonth = months.map((m) => {
  const monthPool = combined.filter((g) => g.month === m);
  const base = summarize(selectWithThreshold(monthPool, null));
  const cand = summarize(selectWithThreshold(monthPool, CANDIDATE_T));
  return {
    month: m,
    base,
    candT050: cand,
    deltaUsd50: cand.usd50 - base.usd50,
    deltaHitRate:
      base.hitRate != null && cand.hitRate != null
        ? Number((cand.hitRate - base.hitRate).toFixed(4))
        : null,
    deltaBets: cand.bets - base.bets,
  };
});

/** 2) Expanding WF */
const wfFolds = [];
for (let i = 1; i < months.length; i++) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];
  const trainPool = combined.filter((g) => trainMonths.has(g.month));
  const testPool = combined.filter((g) => g.month === testMonth);
  const { bestT, bestUsd, scored } = pickBestT(trainPool);
  const oos = summarize(selectWithThreshold(testPool, bestT));
  const baseOos = summarize(selectWithThreshold(testPool, null));
  const fixed050Oos = summarize(selectWithThreshold(testPool, CANDIDATE_T));
  wfFolds.push({
    testMonth,
    trainMonths: [...trainMonths],
    chosenT: bestT,
    trainUsd50: bestUsd,
    trainTop3: scored
      .filter((s) => s.bets >= 20)
      .sort((a, b) => b.usd50 - a.usd50)
      .slice(0, 3),
    oos,
    baseOos,
    fixed050Oos,
    deltaUsdVsBase: oos.usd50 - baseOos.usd50,
    fixed050DeltaUsdVsBase: fixed050Oos.usd50 - baseOos.usd50,
  });
}

const wfOosAll = wfFolds.flatMap((f) => {
  const testPool = combined.filter((g) => g.month === f.testMonth);
  return selectWithThreshold(testPool, f.chosenT);
});
const wfBaseOosAll = wfFolds.flatMap((f) => {
  const testPool = combined.filter((g) => g.month === f.testMonth);
  return selectWithThreshold(testPool, null);
});
const wfFixed050OosAll = wfFolds.flatMap((f) => {
  const testPool = combined.filter((g) => g.month === f.testMonth);
  return selectWithThreshold(testPool, CANDIDATE_T);
});

/** 3) Holdout 2025 → 2026 */
const pool2025 = combined.filter((g) => g.window === '2025');
const pool2026 = combined.filter((g) => g.window === '2026');
const holdoutTune = pickBestT(pool2025);
const holdout2026 = {
  tunedOn2025: holdoutTune.bestT,
  train2025: summarize(selectWithThreshold(pool2025, holdoutTune.bestT)),
  base2026: summarize(selectWithThreshold(pool2026, null)),
  oos2026_tuned: summarize(selectWithThreshold(pool2026, holdoutTune.bestT)),
  oos2026_fixed050: summarize(selectWithThreshold(pool2026, CANDIDATE_T)),
};
holdout2026.tunedDeltaUsd =
  holdout2026.oos2026_tuned.usd50 - holdout2026.base2026.usd50;
holdout2026.fixed050DeltaUsd =
  holdout2026.oos2026_fixed050.usd50 - holdout2026.base2026.usd50;
holdout2026.tunedDeltaHr =
  holdout2026.oos2026_tuned.hitRate != null && holdout2026.base2026.hitRate != null
    ? Number(
        (holdout2026.oos2026_tuned.hitRate - holdout2026.base2026.hitRate).toFixed(4)
      )
    : null;
holdout2026.fixed050DeltaHr =
  holdout2026.oos2026_fixed050.hitRate != null && holdout2026.base2026.hitRate != null
    ? Number(
        (
          holdout2026.oos2026_fixed050.hitRate - holdout2026.base2026.hitRate
        ).toFixed(4)
      )
    : null;

const wfSum = summarize(wfOosAll);
const wfBaseSum = summarize(wfBaseOosAll);
const wfFixedSum = summarize(wfFixed050OosAll);

const monthsPositiveFixed =
  fixedByMonth.filter((m) => m.deltaUsd50 > 0).length;
const monthsNegativeFixed =
  fixedByMonth.filter((m) => m.deltaUsd50 < 0).length;
const foldsWfBeatBase = wfFolds.filter((f) => f.deltaUsdVsBase > 0).length;
const foldsFixedBeatBase = wfFolds.filter((f) => f.fixed050DeltaUsdVsBase > 0).length;

/** 晉升閘：固定 0.50 的真實 OOS（非全窗重掃）必須同時 */
const passFixed050 =
  wfFixedSum.usd50 > wfBaseSum.usd50 &&
  (wfFixedSum.hitRate ?? 0) >= (wfBaseSum.hitRate ?? 0) &&
  holdout2026.fixed050DeltaUsd > 0 &&
  (holdout2026.fixed050DeltaHr ?? -1) >= 0 &&
  monthsPositiveFixed >= monthsNegativeFixed;

const passExpanding =
  wfSum.usd50 > wfBaseSum.usd50 &&
  (wfSum.hitRate ?? 0) >= (wfBaseSum.hitRate ?? 0) &&
  foldsWfBeatBase >= Math.ceil(wfFolds.length / 2);

const recommendation = passFixed050
  ? {
      action: 'promote_fixed_050_after_wf',
      note: '固定 T=0.50 在 expanding OOS 與 2025→2026 holdout 皆優於基線；可接實驗規則',
    }
  : passExpanding
    ? {
        action: 'wf_retune_helps_but_fixed_050_weak',
        note: 'Expanding 重選 T 整體優於基線，但固定 0.50 未穩；暫不接固定常數，或改接動態 T（複雜，暫不建議）',
      }
    : {
        action: 'keep_baseline_topk3',
        note: 'WF／holdout 未穩定優於基線；維持 TopK=3，不接 drop_r3 margin',
      };

const out = {
  experimentId: 'daily-drop-r3-margin-wf-2026-07-28',
  generatedAt: new Date().toISOString(),
  protocol: {
    fixed: 'T=0.50 不重選，按月／expanding 月 OOS 對照基線',
    expanding: '先前月選最佳 T∈grid，套下一月',
    holdout: '2025 選 T → 2026 測；並報告固定 0.50',
    grid: THRESHOLD_GRID,
  },
  inSampleFullWindow: {
    baseline: baselineAll,
    candidateT050: candidateAll,
    deltaUsd50: candidateAll.usd50 - baselineAll.usd50,
    note: '全窗同樣本＝先前掃描；僅作對照，不作晉升依據',
  },
  fixedT050ByMonth: fixedByMonth,
  fixedT050MonthCounts: { positive: monthsPositiveFixed, negative: monthsNegativeFixed },
  walkForwardExpanding: {
    folds: wfFolds,
    oosCombined: wfSum,
    baseOosCombined: wfBaseSum,
    fixed050OosCombined: wfFixedSum,
    deltaUsdVsBase: wfSum.usd50 - wfBaseSum.usd50,
    fixed050DeltaUsdVsBase: wfFixedSum.usd50 - wfBaseSum.usd50,
    deltaHitRateVsBase:
      wfSum.hitRate != null && wfBaseSum.hitRate != null
        ? Number((wfSum.hitRate - wfBaseSum.hitRate).toFixed(4))
        : null,
    fixed050DeltaHitRateVsBase:
      wfFixedSum.hitRate != null && wfBaseSum.hitRate != null
        ? Number((wfFixedSum.hitRate - wfBaseSum.hitRate).toFixed(4))
        : null,
    foldsBeatBase: foldsWfBeatBase,
    foldsFixed050BeatBase: foldsFixedBeatBase,
    foldCount: wfFolds.length,
  },
  holdout2025to2026: holdout2026,
  gates: {
    passFixed050,
    passExpanding,
  },
  recommendation,
};

fs.writeFileSync(
  new URL('../tmp-daily-drop-r3-margin-wf.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\n=== Fixed T=0.50 by month Δ$ ===');
for (const m of fixedByMonth) {
  console.log(
    `${m.month} base$${m.base.usd50} cand$${m.candT050.usd50} Δ$${m.deltaUsd50} Δhr=${m.deltaHitRate} Δn=${m.deltaBets}`
  );
}
console.log('\n=== Expanding WF folds ===');
for (const f of wfFolds) {
  console.log(
    `${f.testMonth} chosenT=${f.chosenT} oos$${f.oos.usd50} base$${f.baseOos.usd50} Δ$${f.deltaUsdVsBase} fixed050Δ$${f.fixed050DeltaUsdVsBase}`
  );
}
console.log('\nWF OOS combined:', wfSum, 'base:', wfBaseSum, 'fixed050:', wfFixedSum);
console.log('Holdout 2026:', {
  tunedT: holdout2026.tunedOn2025,
  tunedΔ$: holdout2026.tunedDeltaUsd,
  tunedΔhr: holdout2026.tunedDeltaHr,
  fixed050Δ$: holdout2026.fixed050DeltaUsd,
  fixed050Δhr: holdout2026.fixed050DeltaHr,
});
console.log('\ngates:', out.gates);
console.log('recommendation:', recommendation);
