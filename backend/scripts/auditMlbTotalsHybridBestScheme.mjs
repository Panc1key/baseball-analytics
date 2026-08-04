/**
 * Hybrid 最佳方案網格：Over·raw 上限/降注 × 線映射執行
 * 預註冊評分；leave-one-year 選策 + 全樣本對照（標註 peek 風險）
 * 不動 Locked 常數。
 *
 * 用法: node scripts/auditMlbTotalsHybridBestScheme.mjs
 * 產物: tmp-totals-hybrid-best-scheme.json
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
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import {
  MLB_TOTALS_SATELLITE_SPEC,
  MLB_TOTALS_SATELLITE_HYBRID_SPEC,
} from '../src/services/MlbTotalsSatellite.js';

const BASE = MLB_TOTALS_SATELLITE_SPEC.rules;
const HYBRID = MLB_TOTALS_SATELLITE_HYBRID_SPEC;
const STAKE = 50;
const FROZEN_PO = Number(HYBRID.pitcherParkMuMinusLineOffset) || 0.7;
const OVER_GAP = Number(HYBRID.overMinAbsGap) || 0.9;
const UNDER_GAP = Number(BASE.minAbsGap) || 0.6;
const PF_MAX = Number(HYBRID.pitcherParkFactorMax) || 0.97;

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-31' },
];

/** 預註冊：選策評分（先寫死再跑，避免事後改權重） */
const SCORE_SPEC = Object.freeze({
  id: 'hybrid_best_scheme_score_v1',
  requireThreeYearNonNeg: true,
  minBets: 250,
  minMonthPosRate: 0.6,
  /** 相對 baseline 允許的 Δ$ 下限（訓練集） */
  minDeltaUsdVsBaseline: -800,
  weights: Object.freeze({
    usd: 1,
    monthPosRate: 2500,
    roi: 8000,
    betsFloorBonus: 0.15,
  }),
  note: '先過硬閘，再 maximize usd + 月穩 + ROI；禁止用單場 4 分調參',
});

function collectTotalsLines(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return [];
  const byLine = new Map();
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
      if (overOdds < BASE.pickOddsMin || underOdds < BASE.pickOddsMin) continue;
      if (overOdds > BASE.pickOddsMax || underOdds > BASE.pickOddsMax) continue;
      const vig = 1 / overOdds + 1 / underOdds;
      const line = Number(over.point);
      const prev = byLine.get(line);
      if (!prev || vig < prev.vig) {
        const fair = removeVig(
          decimalToImpliedProb(overOdds),
          decimalToImpliedProb(underOdds)
        );
        byLine.set(line, {
          line,
          overOdds,
          underOdds,
          fairOver: fair.fairA,
          fairUnder: fair.fairB,
          vig,
        });
      }
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

function bestLine(lines) {
  if (!lines.length) return null;
  return lines.reduce((a, b) => (a.vig <= b.vig ? a : b));
}

function parkBucket(pf) {
  const x = Number(pf);
  if (x < PF_MAX) return 'pitcher';
  if (x > 1.03) return 'hitter';
  return 'mid';
}

function monthKey(commenceTime) {
  const d = String(commenceTime || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(d) ? d : 'unknown';
}

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hits: 0, hitRate: null, roi: null, usd50: 0 };
  }
  let unit = 0;
  let hits = 0;
  let pnl = 0;
  for (const b of bets) {
    const s = Number.isFinite(b.stakeUsd) ? b.stakeUsd : STAKE;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
      pnl += s * (b.pickOdds - 1);
    } else {
      unit -= 1;
      pnl -= s;
    }
  }
  return {
    bets: bets.length,
    hits,
    hitRate: Number((hits / bets.length).toFixed(4)),
    roi: Number((unit / bets.length).toFixed(4)),
    usd50: Math.round(pnl),
  };
}

function byYear(bets) {
  const o = {};
  for (const y of ['2024', '2025', '2026']) {
    o[y] = summarize(bets.filter((b) => b.year === y));
  }
  return o;
}

function monthStab(bets) {
  const byM = new Map();
  for (const b of bets) {
    const k = b.month || 'unknown';
    if (k === 'unknown') continue;
    if (!byM.has(k)) byM.set(k, []);
    byM.get(k).push(b);
  }
  const months = [...byM.entries()].map(([month, arr]) => {
    const s = summarize(arr);
    return { month, ...s, positive: (s.roi ?? -1) >= 0 };
  });
  const n = months.length;
  const pos = months.filter((m) => m.positive).length;
  return {
    months: n,
    positiveMonths: pos,
    positiveRate: n ? Number((pos / n).toFixed(4)) : null,
  };
}

function trySideOnLine(g, adj, sideWanted, minAbsGap, lineObj) {
  const line = lineObj.line;
  const gap = adj.mu - line;
  const side = gap > 0 ? 'over' : gap < 0 ? 'under' : null;
  if (side !== sideWanted) return null;
  if (Math.abs(gap) < minAbsGap) return null;
  if (line > BASE.maxTotalLine) return null;
  const dist = buildMlbScoreDistribution({
    homeMean: adj.homeMu,
    awayMean: adj.awayMu,
    homeDispersion: g.dispersion,
    awayDispersion: g.dispersion,
  });
  const mk = deriveMlbScoreMarkets(dist, { totalLine: line });
  const pushP = Number(mk.total?.pushProbability) || 0;
  const overProb =
    Number(mk.total.overProbability) / Math.max(1e-9, 1 - pushP);
  const underProb =
    Number(mk.total.underProbability) / Math.max(1e-9, 1 - pushP);
  const modelProb = side === 'over' ? overProb : underProb;
  if (modelProb < 0.5 || modelProb < BASE.minimumModelProbability) return null;
  const pickOdds = side === 'over' ? lineObj.overOdds : lineObj.underOdds;
  const fair = side === 'over' ? lineObj.fairOver : lineObj.fairUnder;
  const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
  const edge = modelProb - fair;
  if (ev < BASE.minimumExpectedValue || edge < BASE.minEdgeVsMarket) return null;
  if (pickOdds < BASE.pickOddsMin || pickOdds > BASE.pickOddsMax) return null;
  const actualSide =
    g.actualTotal > line ? 'over' : g.actualTotal < line ? 'under' : 'push';
  if (actualSide === 'push') return null;
  return {
    year: g.year,
    month: g.month,
    side,
    pickOdds,
    hit: side === actualSide,
    absGap: Math.abs(gap),
    line,
    mu: adj.mu,
    muRaw: g.mu,
    parkFactor: g.parkFactor,
    parkBucket: g.parkBucket,
    gameId: g.gameId,
  };
}

function adjPitcher(g) {
  const h = Math.max(0.5, g.homeMu - FROZEN_PO / 2);
  const a = Math.max(0.5, g.awayMu - FROZEN_PO / 2);
  return { homeMu: h, awayMu: a, mu: h + a };
}

function rawAdj(g) {
  return { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu };
}

function classifyOnLine(g, lineObj) {
  const u = trySideOnLine(g, rawAdj(g), 'under', UNDER_GAP, lineObj);
  if (u) return { ...u, hybridPath: 'raw_under' };
  if (g.parkBucket === 'pitcher') {
    const o = trySideOnLine(g, adjPitcher(g), 'over', OVER_GAP, lineObj);
    if (o) return { ...o, hybridPath: 'pitcher_debiased_over' };
  } else {
    const o = trySideOnLine(g, rawAdj(g), 'over', OVER_GAP, lineObj);
    if (o) return { ...o, hybridPath: 'raw_over' };
  }
  return null;
}

console.log('load…');
const model = getLatestMlbExpectedRunsValidation().model;
const dispersion = model.dispersion;
const games = [];

for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.home_score AS hs, g.away_score AS ascore
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
    const actualTotal = Number(row.hs) + Number(row.ascore);
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
    const lines = collectTotalsLines(row.gameId, row.commenceTime);
    const best = bestLine(lines);
    if (!best || actualTotal === best.line) continue;
    const pred = predictMlbGameRuns(model, features, { totalLine: best.line });
    const pf = Number(features.parkFactor) || 1;
    games.push({
      year: w.key,
      month: monthKey(row.commenceTime),
      gameId: row.gameId,
      homeMu: Number(pred.homeExpectedRuns),
      awayMu: Number(pred.awayExpectedRuns),
      mu: Number(pred.expectedTotal),
      dispersion,
      parkFactor: pf,
      parkBucket: parkBucket(pf),
      actualTotal,
      best,
      lines,
    });
  }
}
console.log('games', games.length);

const MAX_GAPS = [null, 1.15, 1.25, 1.35, 1.45, 1.55, 1.7];
const RAW_STAKES = [50, 25, 0];
const DROP_HITTER = [false, true];
const EXEC_MODES = [
  'stay_best',
  'map_nearest_reclassify',
  'reject_if_no_alt',
  'synth_pm05_keep',
];

function policyId(p) {
  const cap = p.rawOverMaxAbsGap == null ? 'nocap' : `cap${p.rawOverMaxAbsGap}`;
  return `${p.exec}|rawStake${p.rawOverStake}|${cap}|hitter${p.dropHitterRaw ? 'drop' : 'keep'}`;
}

function buildPolicies() {
  const out = [];
  for (const exec of EXEC_MODES) {
    for (const rawOverStake of RAW_STAKES) {
      for (const rawOverMaxAbsGap of MAX_GAPS) {
        for (const dropHitterRaw of DROP_HITTER) {
          // stake0 already drops all raw; cap/hitter redundant but keep for clarity — skip noop dupes
          if (rawOverStake === 0 && (rawOverMaxAbsGap != null || dropHitterRaw)) {
            continue;
          }
          out.push({
            exec,
            rawOverStake,
            rawOverMaxAbsGap,
            dropHitterRaw,
          });
        }
      }
    }
  }
  return out;
}

function pickExecCandidate(g, exec) {
  const bestPick = classifyOnLine(g, g.best);
  if (!bestPick) return null;

  if (exec === 'stay_best') {
    return { ...bestPick, fromLine: g.best.line, mapNote: 'stay' };
  }

  const L = g.best.line;
  const lineM = g.lines.find((x) => Math.abs(x.line - (L - 0.5)) < 1e-9);
  const lineP = g.lines.find((x) => Math.abs(x.line - (L + 0.5)) < 1e-9);
  const hasAlt = Boolean(lineM || lineP);

  if (exec === 'reject_if_no_alt') {
    if (!hasAlt) return null;
    return { ...bestPick, fromLine: L, mapNote: 'has_alt_keep_best' };
  }

  if (exec === 'map_nearest_reclassify') {
    let mapped = null;
    if (bestPick.side === 'over') mapped = lineM || lineP || null;
    else mapped = lineP || lineM || null;
    if (!mapped || Math.abs(mapped.line - L) < 1e-9) {
      return { ...bestPick, fromLine: L, mapNote: 'no_alt_stay' };
    }
    const remapped = classifyOnLine(g, mapped);
    if (!remapped || remapped.side !== bestPick.side) return null;
    // keep same hybridPath family if possible
    return {
      ...remapped,
      hybridPath: remapped.hybridPath,
      fromLine: L,
      mapNote: 'mapped',
    };
  }

  if (exec === 'synth_pm05_keep') {
    const order =
      bestPick.side === 'over' ? [L - 0.5, L + 0.5] : [L + 0.5, L - 0.5];
    for (const t of order) {
      if (t > BASE.maxTotalLine) continue;
      const existing = g.lines.find((x) => Math.abs(x.line - t) < 1e-9);
      const synth = existing || {
        line: t,
        overOdds: g.best.overOdds,
        underOdds: g.best.underOdds,
        fairOver: g.best.fairOver,
        fairUnder: g.best.fairUnder,
        vig: g.best.vig,
      };
      const remapped = classifyOnLine(g, synth);
      if (remapped && remapped.side === bestPick.side) {
        return {
          ...remapped,
          fromLine: L,
          mapNote: existing ? 'real_alt' : 'synth',
        };
      }
    }
    return null;
  }

  return bestPick;
}

function applyRawPolicy(pick, policy) {
  if (!pick) return null;
  if (pick.hybridPath !== 'raw_over') {
    return { ...pick, stakeUsd: STAKE };
  }
  if (policy.rawOverStake === 0) return null;
  if (policy.dropHitterRaw && pick.parkBucket === 'hitter') return null;
  if (
    policy.rawOverMaxAbsGap != null &&
    pick.absGap > policy.rawOverMaxAbsGap
  ) {
    return null;
  }
  return { ...pick, stakeUsd: policy.rawOverStake };
}

function runPolicy(policy, gameList) {
  const bets = [];
  for (const g of gameList) {
    const cand = pickExecCandidate(g, policy.exec);
    const bet = applyRawPolicy(cand, policy);
    if (bet) bets.push(bet);
  }
  return bets;
}

function evaluate(bets, baselineUsd = null) {
  const both = summarize(bets);
  const years = byYear(bets);
  const ms = monthStab(bets);
  const threePos = ['2024', '2025', '2026'].every(
    (y) => (years[y].roi ?? -1) >= 0 || years[y].bets === 0
  );
  const threePosStrict = ['2024', '2025', '2026'].every(
    (y) => years[y].bets > 0 && (years[y].roi ?? -1) >= 0
  );
  const over = summarize(bets.filter((b) => b.side === 'over'));
  const under = summarize(bets.filter((b) => b.side === 'under'));
  const rawOver = summarize(bets.filter((b) => b.hybridPath === 'raw_over'));
  return {
    both,
    over,
    under,
    rawOver,
    byYear: years,
    monthStab: ms,
    threePos,
    threePosStrict,
    deltaUsdVsBaseline:
      baselineUsd == null ? null : both.usd50 - baselineUsd,
  };
}

function hardPass(ev, baselineUsd, baselineBets) {
  if (SCORE_SPEC.requireThreeYearNonNeg && !ev.threePosStrict) return false;
  if (ev.both.bets < SCORE_SPEC.minBets) return false;
  if ((ev.monthStab.positiveRate ?? 0) < SCORE_SPEC.minMonthPosRate) return false;
  if (
    baselineUsd != null &&
    ev.both.usd50 - baselineUsd < SCORE_SPEC.minDeltaUsdVsBaseline
  ) {
    return false;
  }
  // 不允許量崩到 baseline 40% 以下（除非 rawStake=0 類極簡包另議：仍用 minBets）
  if (baselineBets && ev.both.bets < baselineBets * 0.35) return false;
  return true;
}

function score(ev, baselineUsd, baselineBets) {
  if (!hardPass(ev, baselineUsd, baselineBets)) {
    return { pass: false, score: -1e12, reason: 'hard_fail' };
  }
  const w = SCORE_SPEC.weights;
  const volBonus =
    baselineBets > 0
      ? Math.min(1, ev.both.bets / baselineBets) * w.betsFloorBonus * baselineUsd
      : 0;
  const s =
    ev.both.usd50 * w.usd +
    (ev.monthStab.positiveRate || 0) * w.monthPosRate +
    (ev.both.roi || 0) * w.roi +
    volBonus;
  return { pass: true, score: Number(s.toFixed(2)), reason: 'ok' };
}

const policies = buildPolicies();
console.log('policies', policies.length);

const baselinePolicy = {
  exec: 'stay_best',
  rawOverStake: 50,
  rawOverMaxAbsGap: null,
  dropHitterRaw: false,
};
const baselineBetsAll = runPolicy(baselinePolicy, games);
const baselineEvAll = evaluate(baselineBetsAll);
const baselineUsd = baselineEvAll.both.usd50;
const baselineN = baselineEvAll.both.bets;
console.log('baseline', baselineEvAll.both);

console.log('full-sample grid…');
const board = [];
for (const p of policies) {
  const bets = runPolicy(p, games);
  const ev = evaluate(bets, baselineUsd);
  const sc = score(ev, baselineUsd, baselineN);
  board.push({
    id: policyId(p),
    policy: p,
    ...ev,
    ...sc,
  });
}
board.sort((a, b) => b.score - a.score);
const passers = board.filter((b) => b.pass);

console.log('leave-one-year…');
const oosFolds = [];
for (const hold of ['2024', '2025', '2026']) {
  const trainGames = games.filter((g) => g.year !== hold);
  const testGames = games.filter((g) => g.year === hold);
  const baseTrain = evaluate(runPolicy(baselinePolicy, trainGames));
  const foldBoard = [];
  for (const p of policies) {
    const evTrain = evaluate(
      runPolicy(p, trainGames),
      baseTrain.both.usd50
    );
    // hold 年硬閘改：訓練集三年中剩兩年都非負
    const trainYears = ['2024', '2025', '2026'].filter((y) => y !== hold);
    const trainTwoPos = trainYears.every(
      (y) =>
        (evTrain.byYear[y].bets || 0) > 0 &&
        (evTrain.byYear[y].roi ?? -1) >= 0
    );
    const trainPass =
      trainTwoPos &&
      evTrain.both.bets >= Math.floor(SCORE_SPEC.minBets * 0.55) &&
      (evTrain.monthStab.positiveRate ?? 0) >= SCORE_SPEC.minMonthPosRate - 0.05 &&
      evTrain.both.usd50 - baseTrain.both.usd50 >=
        SCORE_SPEC.minDeltaUsdVsBaseline;
    const w = SCORE_SPEC.weights;
    const s = trainPass
      ? evTrain.both.usd50 * w.usd +
        (evTrain.monthStab.positiveRate || 0) * w.monthPosRate +
        (evTrain.both.roi || 0) * w.roi
      : -1e12;
    foldBoard.push({
      id: policyId(p),
      policy: p,
      trainPass,
      trainScore: s,
      train: evTrain,
    });
  }
  foldBoard.sort((a, b) => b.trainScore - a.trainScore);
  const winner = foldBoard.find((x) => x.trainPass) || foldBoard[0];
  const testEv = evaluate(runPolicy(winner.policy, testGames));
  const baseTest = evaluate(runPolicy(baselinePolicy, testGames));
  oosFolds.push({
    hold,
    chosen: winner.id,
    chosenPolicy: winner.policy,
    trainPass: winner.trainPass,
    trainScore: winner.trainScore,
    test: testEv.both,
    testByPathish: {
      over: testEv.over,
      under: testEv.under,
      rawOver: testEv.rawOver,
    },
    baselineTest: baseTest.both,
    deltaUsdVsBaselineHold: testEv.both.usd50 - baseTest.both.usd50,
    beatBaselineHold: testEv.both.usd50 >= baseTest.both.usd50,
  });
}

const oosWins = oosFolds.filter((f) => f.beatBaselineHold).length;
const oosDeltaSum = oosFolds.reduce((s, f) => s + f.deltaUsdVsBaselineHold, 0);

/** Pareto：全樣本 passers 前 15；另列「最大 Δ$」「最高 ROI」「最高月穩」 */
const topByScore = passers.slice(0, 15).map(slim);
const topByUsd = [...passers]
  .sort((a, b) => b.both.usd50 - a.both.usd50)
  .slice(0, 10)
  .map(slim);
const topByRoi = [...passers]
  .sort((a, b) => (b.both.roi || 0) - (a.both.roi || 0))
  .slice(0, 10)
  .map(slim);
const topByMonth = [...passers]
  .sort(
    (a, b) =>
      (b.monthStab.positiveRate || 0) - (a.monthStab.positiveRate || 0) ||
      b.both.usd50 - a.both.usd50
  )
  .slice(0, 10)
  .map(slim);

function slim(row) {
  return {
    id: row.id,
    policy: row.policy,
    score: row.score,
    bets: row.both.bets,
    hitRate: row.both.hitRate,
    roi: row.both.roi,
    usd50: row.both.usd50,
    deltaUsd: row.deltaUsdVsBaseline,
    monthPosRate: row.monthStab.positiveRate,
    threePosStrict: row.threePosStrict,
    rawOverBets: row.rawOver.bets,
    rawOverRoi: row.rawOver.roi,
    byYear: row.byYear,
  };
}

/** 穩健推薦：OOS 折疊常勝政策 + 全樣本 top 交集 */
const chosenCounts = {};
for (const f of oosFolds) {
  chosenCounts[f.chosen] = (chosenCounts[f.chosen] || 0) + 1;
}
const oosPopular = Object.entries(chosenCounts).sort((a, b) => b[1] - a[1]);

const baselineRow = board.find((b) => b.id === policyId(baselinePolicy));

/** 若 OOS 合計打不過 baseline，推薦維持 + 只加執行規格影子 */
let recommendation;
if (oosWins >= 2 && oosDeltaSum > 0 && passers[0]) {
  recommendation = {
    action: 'shadow_promote_candidate',
    primary: passers[0].id,
    policy: passers[0].policy,
    reason: `全樣本榜首且 OOS ${oosWins}/3 折打贏 baseline、ΣΔ$=${oosDeltaSum}`,
  };
} else if (oosPopular[0] && oosPopular[0][1] >= 2) {
  const id = oosPopular[0][0];
  const row = board.find((b) => b.id === id);
  recommendation = {
    action: row?.pass ? 'shadow_candidate_oos_stable' : 'research_only_oos_pick_failed_full_gates',
    primary: id,
    policy: row?.policy || oosFolds.find((f) => f.chosen === id)?.chosenPolicy,
    reason: `leave-one-year 有 ${oosPopular[0][1]} 折選中同一政策；OOS wins=${oosWins} ΣΔ$=${oosDeltaSum}`,
  };
} else {
  recommendation = {
    action: 'keep_baseline_add_exec_spec_only',
    primary: policyId(baselinePolicy),
    policy: baselinePolicy,
    reason: `OOS 無法穩定打贏 baseline（wins=${oosWins} ΣΔ$=${oosDeltaSum}）；選邊常數不動，線映射另做執行規格`,
  };
}

const out = {
  experimentId: 'hybrid_best_scheme_v1',
  scoreSpec: SCORE_SPEC,
  frozen: { FROZEN_PO, OVER_GAP, UNDER_GAP, STAKE, WINDOWS },
  nGames: games.length,
  nPolicies: policies.length,
  baseline: {
    id: policyId(baselinePolicy),
    ...slim({
      ...baselineRow,
      policy: baselinePolicy,
      score: baselineRow?.score,
      pass: baselineRow?.pass,
    }),
  },
  nPassers: passers.length,
  topByScore,
  topByUsd,
  topByRoi,
  topByMonth,
  leaveOneYear: {
    folds: oosFolds,
    winsVsBaseline: oosWins,
    sumDeltaUsd: oosDeltaSum,
    chosenCounts,
  },
  recommendation,
  doNot: [
    'global_mu_offset_to_line',
    'raise_overMinAbsGap_from_one_game',
    'mix_into_locked_b_topk',
    'promote_without_shadow',
  ],
};

fs.writeFileSync(
  'tmp-totals-hybrid-best-scheme.json',
  JSON.stringify(out, null, 2)
);

console.log('\n=== baseline ===');
console.log(out.baseline);
console.log('\n=== topByScore ===');
for (const r of topByScore.slice(0, 8)) {
  console.log(
    r.id,
    `n=${r.bets}`,
    `roi=${r.roi}`,
    `$=${r.usd50}`,
    `Δ=${r.deltaUsd}`,
    `m+=${r.monthPosRate}`,
    `sc=${r.score}`
  );
}
console.log('\n=== leave-one-year ===');
for (const f of oosFolds) {
  console.log(
    f.hold,
    'chose',
    f.chosen,
    'test$',
    f.test.usd50,
    'base$',
    f.baselineTest.usd50,
    'Δ',
    f.deltaUsdVsBaselineHold
  );
}
console.log('\nRECOMMEND', JSON.stringify(recommendation, null, 2));
console.log('wrote tmp-totals-hybrid-best-scheme.json');
