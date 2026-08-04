/**
 * 總分 μ 偏高診斷：雙方得分、盤口、實際；Under 是否為偏高校準幻覺
 * 不改模型／不改選注
 *
 * 用法: node scripts/auditMlbTotalsMuBiasRootCause.mjs
 * 產物: tmp-totals-mu-bias-root-cause.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import { getCachedMlbGameWeather } from '../src/services/MlbGameWeatherService.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { MLB_TOTALS_SATELLITE_SPEC } from '../src/services/MlbTotalsSatellite.js';

const R = MLB_TOTALS_SATELLITE_SPEC.rules;
const STAKE = 50;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function bestTotals(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'totals');
    if (!market) continue;
    for (const over of market.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = market.outcomes.find(
        (o) => o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!over.price || !under?.price) continue;
      const overOdds = Number(over.price);
      const underOdds = Number(under.price);
      if (overOdds < R.pickOddsMin || underOdds < R.pickOddsMin) continue;
      if (overOdds > R.pickOddsMax || underOdds > R.pickOddsMax) continue;
      const vig = 1 / overOdds + 1 / underOdds;
      if (!best || vig < best.vig) {
        const fair = removeVig(
          decimalToImpliedProb(overOdds),
          decimalToImpliedProb(underOdds)
        );
        best = {
          line: Number(over.point),
          overOdds,
          underOdds,
          fairOver: fair.fairA,
          fairUnder: fair.fairB,
          vig,
        };
      }
    }
  }
  return best;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function summarizeBets(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, roi: null, usd50: 0 };
  let unit = 0;
  let hits = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  return {
    bets: bets.length,
    hitRate: Number((hits / bets.length).toFixed(4)),
    roi: Number((unit / bets.length).toFixed(4)),
    usd50: Math.round(unit * STAKE),
  };
}

function passGates({ absGap, ev, edge, modelProb, line, sideProbOk }) {
  if (!sideProbOk) return false;
  if (absGap < R.minAbsGap) return false;
  if (ev < R.minimumExpectedValue) return false;
  if (edge < R.minEdgeVsMarket) return false;
  if (modelProb < R.minimumModelProbability) return false;
  if (line > R.maxTotalLine) return false;
  return true;
}

/** 用調整後 μ 粗估 over/under 機率：相對原 μ 的位移，用 logistic 近似繞開重算 NB */
function shiftSideProbs(pred, muAdj, line) {
  const mu0 = pred.expectedTotal;
  const pushP = Number(pred.markets?.total?.pushProbability) || 0;
  let over0 =
    Number(pred.markets?.total?.overProbability) / Math.max(1e-9, 1 - pushP);
  let under0 =
    Number(pred.markets?.total?.underProbability) / Math.max(1e-9, 1 - pushP);
  // 簡化：用 gap 變化線性微調（僅診斷用）；主結論仍靠 sign(μ-line)
  const d = muAdj - mu0;
  // 經驗：總分每移 1 跑，over 機率約移 ~0.12（粗）
  const k = 0.12;
  over0 = Math.min(0.95, Math.max(0.05, over0 + d * k));
  under0 = 1 - over0;
  const gap = muAdj - line;
  return { overProb: over0, underProb: under0, gap, expectedTotal: muAdj };
}

console.log('Loading model & scanning…');
const model = getLatestMlbExpectedRunsValidation().model;
const rowsOut = [];

for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS hs, g.away_score AS ascore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);

  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const hs = Number(row.hs);
    const ascore = Number(row.ascore);
    const actualTotal = hs + ascore;
    features.parkFactor = resolveMlbParkFactor({
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    features.weather = getCachedMlbGameWeather({
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    const market = bestTotals(row.gameId, row.commenceTime);
    if (!market) continue;
    if (actualTotal === market.line) continue;

    const pred = predictMlbGameRuns(model, features, { totalLine: market.line });
    const mu = Number(pred.expectedTotal);
    const homeMu = Number(pred.homeExpectedRuns);
    const awayMu = Number(pred.awayExpectedRuns);

    // top contribution keys from explanation (signed)
    const homeContrib = pred.explanation?.home?.contributions || [];
    const awayContrib = pred.explanation?.away?.contributions || [];
    const sumAbs = (arr) =>
      arr.reduce((s, c) => s + Math.abs(Number(c.linearContribution) || 0), 0);

    rowsOut.push({
      year: w.key,
      line: market.line,
      actualTotal,
      actualHome: hs,
      actualAway: ascore,
      mu,
      homeMu,
      awayMu,
      errTotal: mu - actualTotal,
      errHome: homeMu - hs,
      errAway: awayMu - ascore,
      muMinusLine: mu - market.line,
      actualMinusLine: actualTotal - market.line,
      lean: mu > market.line ? 'over' : mu < market.line ? 'under' : 'zero',
      actualSide: actualTotal > market.line ? 'over' : 'under',
      parkFactor: Number(features.parkFactor) || 1,
      overOdds: market.overOdds,
      underOdds: market.underOdds,
      fairOver: market.fairOver,
      fairUnder: market.fairUnder,
      homeBaseline: Number(pred.explanation?.home?.baselineExpectedRuns) || null,
      awayBaseline: Number(pred.explanation?.away?.baselineExpectedRuns) || null,
      homeAbsContrib: sumAbs(homeContrib),
      awayAbsContrib: sumAbs(awayContrib),
      // keep raw for counterfactual
      pred,
      market,
    });
  }
}

const n = rowsOut.length;
const meanMu = mean(rowsOut.map((r) => r.mu));
const meanLine = mean(rowsOut.map((r) => r.line));
const meanActual = mean(rowsOut.map((r) => r.actualTotal));
const meanHomeMu = mean(rowsOut.map((r) => r.homeMu));
const meanAwayMu = mean(rowsOut.map((r) => r.awayMu));
const meanHomeAct = mean(rowsOut.map((r) => r.actualHome));
const meanAwayAct = mean(rowsOut.map((r) => r.actualAway));

const biasVsActual = meanMu - meanActual;
const biasVsLine = meanMu - meanLine;
const lineVsActual = meanLine - meanActual;

// quintiles of parkFactor
function bucketMean(rows, keyFn, valFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(valFn(r));
  }
  return Object.fromEntries(
    [...m.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([k, vals]) => [k, Number(mean(vals).toFixed(3))])
  );
}

const parkBuckets = rowsOut.map((r) => {
  const pf = r.parkFactor;
  let b = 'mid';
  if (pf < 0.97) b = 'pitcher_park';
  else if (pf > 1.03) b = 'hitter_park';
  return { ...r, parkBucket: b };
});

// contribution: which side drives over-lean
const leanOver = rowsOut.filter((r) => r.lean === 'over');
const leanUnder = rowsOut.filter((r) => r.lean === 'under');

function sideErr(arr) {
  return {
    n: arr.length,
    meanMuMinusLine: Number(mean(arr.map((r) => r.muMinusLine)).toFixed(3)),
    meanErrTotal: Number(mean(arr.map((r) => r.errTotal)).toFixed(3)),
    meanHomeErr: Number(mean(arr.map((r) => r.errHome)).toFixed(3)),
    meanAwayErr: Number(mean(arr.map((r) => r.errAway)).toFixed(3)),
    leanHitRate: Number(
      (arr.filter((r) => r.lean === r.actualSide).length / arr.length).toFixed(4)
    ),
  };
}

// —— 幻覺檢驗 1：條件化在「真實是 Under 場」時模型仍常 lean Over？
const trueUnderGames = rowsOut.filter((r) => r.actualSide === 'under');
const trueOverGames = rowsOut.filter((r) => r.actualSide === 'over');
const illusion1 = {
  whenActualUnder_modelStillLeanOver: Number(
    (
      trueUnderGames.filter((r) => r.lean === 'over').length /
      trueUnderGames.length
    ).toFixed(4)
  ),
  whenActualOver_modelLeanOver: Number(
    (
      trueOverGames.filter((r) => r.lean === 'over').length / trueOverGames.length
    ).toFixed(4)
  ),
  note: '若真實小分場仍有大半被模型判大 → 水平偏高確認',
};

// —— 幻覺檢驗 2：Under 過閘注，是否只是「μ 離線夠遠才敢說小」的倖存者？
function buildPick(r, lean, muOverride = null) {
  const mu = muOverride ?? r.mu;
  const gap = mu - r.line;
  const side = gap > 0 ? 'over' : 'under';
  if (lean && side !== lean) return null;
  const pushP = Number(r.pred.markets?.total?.pushProbability) || 0;
  let overProb =
    Number(r.pred.markets?.total?.overProbability) / Math.max(1e-9, 1 - pushP);
  let underProb =
    Number(r.pred.markets?.total?.underProbability) / Math.max(1e-9, 1 - pushP);
  if (muOverride != null) {
    const shifted = shiftSideProbs(r.pred, muOverride, r.line);
    overProb = shifted.overProb;
    underProb = shifted.underProb;
  }
  const modelProb = side === 'over' ? overProb : underProb;
  const pickOdds = side === 'over' ? r.overOdds : r.underOdds;
  const fair = side === 'over' ? r.fairOver : r.fairUnder;
  const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
  const edge = modelProb - fair;
  const absGap = Math.abs(gap);
  const ok = passGates({
    absGap,
    ev,
    edge,
    modelProb,
    line: r.line,
    sideProbOk: modelProb >= 0.5,
  });
  if (!ok) return null;
  return {
    side,
    pickOdds,
    hit: side === r.actualSide,
    absGap,
    muMinusLine: gap,
    errTotal: (muOverride ?? r.mu) - r.actualTotal,
  };
}

const baseOverPicks = rowsOut.map((r) => buildPick(r, 'over')).filter(Boolean);
const baseUnderPicks = rowsOut.map((r) => buildPick(r, 'under')).filter(Boolean);

// —— 幻覺檢驗 3：全局下修 μ（扣 mean(μ−actual) 或 mean(μ−line)）後，Under 優勢是否消失？
const offsets = {
  none: 0,
  subtractBiasVsActual: -biasVsActual,
  subtractBiasVsLine: -biasVsLine,
  subtractHalfBiasVsActual: -biasVsActual / 2,
};

const counterfactual = {};
for (const [name, off] of Object.entries(offsets)) {
  const overP = [];
  const underP = [];
  let leanO = 0;
  let leanU = 0;
  for (const r of rowsOut) {
    const muAdj = r.mu + off;
    if (muAdj > r.line) leanO += 1;
    else if (muAdj < r.line) leanU += 1;
    const o = buildPick(r, 'over', muAdj);
    const u = buildPick(r, 'under', muAdj);
    if (o) overP.push(o);
    if (u) underP.push(u);
  }
  counterfactual[name] = {
    offsetApplied: Number(off.toFixed(3)),
    leanOverShare: Number((leanO / (leanO + leanU)).toFixed(4)),
    leanUnderShare: Number((leanU / (leanO + leanU)).toFixed(4)),
    overPicks: summarizeBets(overP),
    underPicks: summarizeBets(underP),
    underMinusOverRoi:
      underP.length && overP.length
        ? Number(
            (
              summarizeBets(underP).roi - summarizeBets(overP).roi
            ).toFixed(4)
          )
        : null,
  };
}

// —— 幻覺檢驗 4：在「模型誤差」分層——μ 越偏高，Under 過閘是否越賺？
const underWithErr = baseUnderPicks.map((p) => ({
  ...p,
  // find matching row err — rebuild from picks is lossy; recompute
}));
// recompute under picks with err from rows
const underDetailed = [];
const overDetailed = [];
for (const r of rowsOut) {
  const u = buildPick(r, 'under');
  const o = buildPick(r, 'over');
  if (u) underDetailed.push({ ...u, errTotal: r.errTotal, muMinusLine: r.muMinusLine });
  if (o) overDetailed.push({ ...o, errTotal: r.errTotal, muMinusLine: r.muMinusLine });
}

function errTertileRoi(picks) {
  if (picks.length < 30) return null;
  const sorted = [...picks].sort((a, b) => a.errTotal - b.errTotal);
  const t = Math.floor(sorted.length / 3);
  const bins = [
    { id: 'low_err_or_underpredict', rows: sorted.slice(0, t) },
    { id: 'mid_err', rows: sorted.slice(t, 2 * t) },
    { id: 'high_overpredict', rows: sorted.slice(2 * t) },
  ];
  return bins.map((b) => ({
    id: b.id,
    meanErr: Number(mean(b.rows.map((x) => x.errTotal)).toFixed(3)),
    ...summarizeBets(b.rows),
  }));
}

// feature-level: baseline vs actual contribution of intercept
const meanHomeBaseline = mean(
  rowsOut.map((r) => r.homeBaseline).filter((x) => x != null)
);
const meanAwayBaseline = mean(
  rowsOut.map((r) => r.awayBaseline).filter((x) => x != null)
);

// by year bias
const byYear = {};
for (const y of ['2024', '2025', '2026']) {
  const sub = rowsOut.filter((r) => r.year === y);
  byYear[y] = {
    n: sub.length,
    meanMu: Number(mean(sub.map((r) => r.mu)).toFixed(3)),
    meanLine: Number(mean(sub.map((r) => r.line)).toFixed(3)),
    meanActual: Number(mean(sub.map((r) => r.actualTotal)).toFixed(3)),
    muMinusActual: Number(
      (mean(sub.map((r) => r.mu)) - mean(sub.map((r) => r.actualTotal))).toFixed(3)
    ),
    muMinusLine: Number(
      (mean(sub.map((r) => r.mu)) - mean(sub.map((r) => r.line))).toFixed(3)
    ),
    leanOverShare: Number(
      (sub.filter((r) => r.lean === 'over').length / sub.length).toFixed(4)
    ),
  };
}

const out = {
  experimentId: 'totals_mu_bias_root_cause',
  n,
  levelComparison: {
    meanExpectedTotal: Number(meanMu.toFixed(3)),
    meanMarketLine: Number(meanLine.toFixed(3)),
    meanActualTotal: Number(meanActual.toFixed(3)),
    muMinusActual: Number(biasVsActual.toFixed(3)),
    muMinusLine: Number(biasVsLine.toFixed(3)),
    lineMinusActual: Number(lineVsActual.toFixed(3)),
    home: {
      meanMu: Number(meanHomeMu.toFixed(3)),
      meanActual: Number(meanHomeAct.toFixed(3)),
      bias: Number((meanHomeMu - meanHomeAct).toFixed(3)),
      meanBaselineFromIntercept: Number(meanHomeBaseline?.toFixed(3)),
    },
    away: {
      meanMu: Number(meanAwayMu.toFixed(3)),
      meanActual: Number(meanAwayAct.toFixed(3)),
      bias: Number((meanAwayMu - meanAwayAct).toFixed(3)),
      meanBaselineFromIntercept: Number(meanAwayBaseline?.toFixed(3)),
    },
    note: '若 μ>line≈actual 且雙方都偏高 → 水平校準問題，不是單邊賽果',
  },
  byYear,
  parkBucketBias: {
    muMinusActual: bucketMean(
      parkBuckets,
      (r) => r.parkBucket,
      (r) => r.errTotal
    ),
    muMinusLine: bucketMean(
      parkBuckets,
      (r) => r.parkBucket,
      (r) => r.muMinusLine
    ),
  },
  leanQuality: {
    leanOver: sideErr(leanOver),
    leanUnder: sideErr(leanUnder),
  },
  illusionTests: {
    actualUnderButModelLeanOver: illusion1,
    baselinePicks: {
      over: summarizeBets(overDetailed),
      under: summarizeBets(underDetailed),
      underMeanAbsGap: Number(
        mean(underDetailed.map((p) => p.absGap)).toFixed(3)
      ),
      overMeanAbsGap: Number(mean(overDetailed.map((p) => p.absGap)).toFixed(3)),
      underMeanErr: Number(mean(underDetailed.map((p) => p.errTotal)).toFixed(3)),
      overMeanErr: Number(mean(overDetailed.map((p) => p.errTotal)).toFixed(3)),
    },
    underRoiByModelErrorTertile: errTertileRoi(underDetailed),
    overRoiByModelErrorTertile: errTertileRoi(overDetailed),
    counterfactualGlobalShrinkMu: counterfactual,
  },
  optimizationPlan: null,
};

// verdict logic
const shrink = counterfactual.subtractBiasVsActual;
const underStillBetter =
  shrink?.underPicks?.roi != null &&
  shrink?.overPicks?.roi != null &&
  shrink.underPicks.roi > shrink.overPicks.roi + 0.02;

out.verdict = {
  scoringExpectationTooHigh: biasVsActual > 0.15,
  biasPrimarilyVsLine: biasVsLine > 0.25,
  bothSidesHigh:
    meanHomeMu - meanHomeAct > 0.05 && meanAwayMu - meanAwayAct > 0.05,
  underEdgeLikelyPartiallyIllusory:
    illusion1.whenActualUnder_modelStillLeanOver > 0.55,
  underEdgeSurvivesAfterDebias: underStillBetter,
  plain: null,
};

out.verdict.plain = [
  biasVsActual > 0.15
    ? `μ 相對實際平均偏高約 ${biasVsActual.toFixed(2)} 分（相對盤口偏高約 ${biasVsLine.toFixed(2)}）。`
    : 'μ 相對實際偏差不大。',
  illusion1.whenActualUnder_modelStillLeanOver > 0.55
    ? `真實小分場仍有 ${(illusion1.whenActualUnder_modelStillLeanOver * 100).toFixed(0)}% 被模型判大 → 水平偏高成立。`
    : '',
  underStillBetter
    ? '全局扣掉 μ−actual 偏差後，Under 過閘 ROI 仍明顯高於 Over → Under 不完全是幻覺，但仍需把校準當第一刀。'
    : '全局去偏後 Under 優勢明顯縮小／消失 → Under 盈利有相當比例來自「偏高 μ 的倖存者選擇」。',
].filter(Boolean).join(' ');

out.optimizationPlan = {
  doNotTouchYet: ['locked_B_constants', 'totals_sat_under_primary_stake'],
  diagnoseNext: [
    '1) 全局／分年 intercept 或 total-level affine 校準（μ\'=a·μ+b），目標 mean(μ)=mean(actual) 且 lean 近 50/50',
    '2) 分開看 home/away 偏差是否一側主導（若雙側都高→共享 intercept／特徵尺度）',
    '3) 去偏後重跑 totals 衛星：both / under / over 三窗 ROI——Under 若仍肥才升格信心',
    '4) 特徵層：offenseRecentRpg、park、starter IP 對 μ 的平均貢獻是否系統性正偏',
  ],
  successGates: [
    'lean Over 占比降至 45–55%',
    'mean(μ−actual) 絕對值 <0.1',
    '去偏後 under-only 三窗 ROI 仍≥0 且不靠注數崩盤',
    'over-only 2024 不再接近打平／轉正或明確放棄',
  ],
  risk: '若只靠「敢說小才準」，去偏後 Under 量增、單注 edge 變薄是預期現象，要用 $ 與 ROI 雙看。',
};

// strip heavy pred from memory before write — already not in out
fs.writeFileSync(
  new URL('../tmp-totals-mu-bias-root-cause.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
console.log('wrote tmp-totals-mu-bias-root-cause.json');
