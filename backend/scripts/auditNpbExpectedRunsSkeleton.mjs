/**
 * NPB：預期得分骨架測試（研究）
 * A) ridge → μ_h/μ_a → 泊松獨贏
 * B) logistic 直接獨贏（現行主看對照）
 * C) 若有 totals 盤：μ_h+μ_a vs 盤口大小；否則只報預測總分 vs 實際 MAE
 *
 * 用法: node scripts/auditNpbExpectedRunsSkeleton.mjs
 * 產物: tmp-npb-expected-runs-skeleton.json
 */
import fs from 'fs';
import { createWalkForwardElo } from '../src/services/BaseballElo.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import { loadAsianCompletedGames } from '../src/services/AsianOpeningFoundation.js';
import {
  appendPitcherHistory,
  loadAsianStarterSnapshotMap,
  summarizePitcherHistory,
} from '../src/services/AsianStarterSnapshots.js';
import {
  ASIAN_MATCHUP_FEATURE_KEYS,
  applyAsianLogisticCalibration,
  exampleFromGameSide,
  matchupVectorFromHomeFeatures,
  poissonHomeWinProb,
  trainAsianRunsLinear,
} from '../src/services/AsianExpectedRunsLite.js';
import { ASIAN_FEATURE_SET_NO_PITCHER } from '../src/services/AsianResearchFreeze.js';

const STAKE = 50;
const LEAGUE = 'NPB';
const LOG_KEYS = [...ASIAN_FEATURE_SET_NO_PITCHER];
const GATES = {
  mid: { minOdds: 1.7, maxOdds: 2.3, minProb: 0.52, minEdge: 0.02, minEv: 0.02 },
  soft: { minOdds: 1.65, maxOdds: 2.4, minProb: 0.5, minEdge: 0.01, minEv: 0.01 },
  direction: { minOdds: 1.5, maxOdds: 3.5, minProb: 0.5, minEdge: -1, minEv: -1 },
};

function bestH2h(bookmakers, home, away) {
  let best = null;
  for (const book of bookmakers || []) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const ho = m.outcomes.find((o) => o.name === home);
    const ao = m.outcomes.find((o) => o.name === away);
    if (!ho?.price || !ao?.price) continue;
    const homeOdds = Number(ho.price);
    const awayOdds = Number(ao.price);
    if (!Number.isFinite(homeOdds) || !Number.isFinite(awayOdds)) continue;
    const vig = 1 / homeOdds + 1 / awayOdds;
    if (!best || vig < best.vig) {
      const fair = removeVig(
        decimalToImpliedProb(homeOdds),
        decimalToImpliedProb(awayOdds)
      );
      best = { homeOdds, awayOdds, fairHome: fair.fairA, fairAway: fair.fairB, vig };
    }
  }
  return best;
}

function bestTotals(bookmakers) {
  let best = null;
  for (const book of bookmakers || []) {
    const m = book.markets?.find((x) => x.key === 'totals');
    if (!m?.outcomes?.length) continue;
    const over = m.outcomes.find((o) => /over/i.test(o.name));
    const under = m.outcomes.find((o) => /under/i.test(o.name));
    const line = Number(over?.point ?? under?.point);
    const oOdds = Number(over?.price);
    const uOdds = Number(under?.price);
    if (!Number.isFinite(line) || !Number.isFinite(oOdds) || !Number.isFinite(uOdds)) continue;
    const vig = 1 / oOdds + 1 / uOdds;
    if (!best || vig < best.vig) {
      const fair = removeVig(decimalToImpliedProb(oOdds), decimalToImpliedProb(uOdds));
      best = {
        line,
        overOdds: oOdds,
        underOdds: uOdds,
        fairOver: fair.fairA,
        fairUnder: fair.fairB,
        vig,
      };
    }
  }
  return best;
}

function summarize(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, roi: null, usd50: 0 };
  let unit = 0;
  let hits = 0;
  for (const b of bets) {
    if (b.push) continue;
    if (b.hit) {
      hits += 1;
      unit += b.odds - 1;
    } else unit -= 1;
  }
  const decided = bets.filter((b) => !b.push).length;
  return {
    bets: bets.length,
    decided,
    hitRate: decided ? Number((hits / decided).toFixed(4)) : null,
    roi: bets.length ? Number((unit / bets.length).toFixed(4)) : null,
    usd50: Math.round(unit * STAKE),
  };
}

function trainLogistic(examples) {
  const mapped = examples.map((e) => ({
    x: LOG_KEYS.map((k) => e.xFull[ASIAN_MATCHUP_FEATURE_KEYS.indexOf(k)]),
    y: e.yWin,
  }));
  const dim = LOG_KEYS.length;
  const n = mapped.length;
  if (n < 40) return { ok: false };
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = (xs, m) =>
    Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
  const means = [];
  const scales = [];
  for (let j = 0; j < dim; j += 1) {
    const col = mapped.map((e) => e.x[j]);
    means.push(mean(col));
    scales.push(std(col, means[j]));
  }
  const beta = Array(dim + 1).fill(0);
  for (let step = 0; step < 400; step += 1) {
    const grad = Array(dim + 1).fill(0);
    for (const e of mapped) {
      let z = beta[0];
      for (let j = 0; j < dim; j += 1) z += beta[j + 1] * ((e.x[j] - means[j]) / scales[j]);
      const p = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
      const err = p - e.y;
      grad[0] += err;
      for (let j = 0; j < dim; j += 1) grad[j + 1] += err * ((e.x[j] - means[j]) / scales[j]);
    }
    beta[0] -= (0.08 / n) * grad[0];
    for (let j = 1; j <= dim; j += 1) beta[j] -= (0.08 / n) * (grad[j] + 0.05 * beta[j]);
  }
  return { ok: true, means, scales, intercept: beta[0], weights: beta.slice(1) };
}

function predictLogit(model, homeFeats) {
  let z = model.intercept;
  for (let i = 0; i < LOG_KEYS.length; i += 1) {
    const v = Number(homeFeats[LOG_KEYS[i]]) || 0;
    z += model.weights[i] * ((v - model.means[i]) / model.scales[i]);
  }
  return z;
}

function predictSideRuns(ridge, x) {
  if (!ridge?.ok) return 4.2;
  let y = ridge.intercept;
  for (let i = 0; i < ridge.featureKeys.length; i += 1) {
    const k = ridge.featureKeys[i];
    const z = (Number(x[i]) - ridge.means[i]) / ridge.scales[i];
    y += (ridge.weights[k] || 0) * z;
  }
  return Math.max(1.5, Math.min(9.5, y));
}

function passGate(cand, gate) {
  if (cand.odds < gate.minOdds || cand.odds > gate.maxOdds) return false;
  if (cand.modelProb < gate.minProb) return false;
  if (cand.edge < gate.minEdge) return false;
  if (cand.ev < gate.minEv) return false;
  return true;
}

const games = loadAsianCompletedGames(LEAGUE).filter(
  (g) => Number(g.home_score) !== Number(g.away_score)
);
const months = [...new Set(games.map((g) => String(g.commence_time).slice(0, 7)))].sort();
const warmup = new Set(months.slice(0, 2));
const starterMap = loadAsianStarterSnapshotMap(LEAGUE);
const priorIndex = new Map();
const pitcherHist = new Map();
const elo = createWalkForwardElo(LEAGUE, { seedFromRating: false });
const labeled = [];

for (const g of games) {
  const snap = starterMap.get(g.id) || null;
  const homeKey = snap?.home?.key || null;
  const awayKey = snap?.away?.key || null;
  const opts = {
    priorIndex,
    eloLookup: (t) => elo.get(t),
    homePitcherHist: summarizePitcherHistory(pitcherHist.get(homeKey), g.commence_time),
    awayPitcherHist: summarizePitcherHistory(pitcherHist.get(awayKey), g.commence_time),
  };
  const homeEx = exampleFromGameSide(g, 'home', opts);
  const awayEx = exampleFromGameSide(g, 'away', opts);
  const pit = resolvePitOdds(g.id, g.commence_time);
  let books = pit?.bookmakers;
  if (!books?.length) {
    try {
      books = JSON.parse(g.raw_odds || '[]');
    } catch {
      books = [];
    }
  }
  labeled.push({
    g,
    month: String(g.commence_time).slice(0, 7),
    ready: homeEx.ready && awayEx.ready,
    homeFeats: homeEx.features,
    awayFeats: awayEx.features,
    xHome: homeEx.x,
    xAway: awayEx.x,
    xFull: matchupVectorFromHomeFeatures(homeEx.features),
    yHomeRuns: Number(g.home_score),
    yAwayRuns: Number(g.away_score),
    yWin: Number(g.home_score) > Number(g.away_score) ? 1 : 0,
    mkt: bestH2h(books, g.home_team, g.away_team),
    totals: bestTotals(books),
  });
  for (const team of [g.home_team, g.away_team]) {
    if (!priorIndex.has(team)) priorIndex.set(team, []);
    priorIndex.get(team).push(g);
  }
  elo.applyGame(g.home_team, g.away_team, g.home_score, g.away_score);
  appendPitcherHistory(pitcherHist, homeKey, g.commence_time, g.away_score);
  appendPitcherHistory(pitcherHist, awayKey, g.commence_time, g.home_score);
}

const bags = {
  ridge_mid: [],
  ridge_soft: [],
  ridge_direction: [],
  logistic_mid: [],
  logistic_soft: [],
  logistic_direction: [],
  totals_market: [],
  totals_direction_vs_line: [],
};
const errAbs = [];
const errSq = [];

for (const hold of months.filter((m) => !warmup.has(m))) {
  const trainRows = labeled.filter((r) => r.month < hold && r.ready);
  const ridge = trainAsianRunsLinear(
    trainRows.flatMap((r) => [
      { x: r.xHome, y: r.yHomeRuns },
      { x: r.xAway, y: r.yAwayRuns },
    ])
  );
  const logistic = trainLogistic(
    trainRows.map((r) => ({ xFull: r.xFull, yWin: r.yWin }))
  );
  if (!ridge.ok && !logistic.ok) continue;

  for (const row of labeled) {
    if (row.month !== hold || !row.ready || !row.mkt) continue;

    const homeMu = predictSideRuns(ridge, row.xHome);
    const awayMu = predictSideRuns(ridge, row.xAway);
    const predTotal = homeMu + awayMu;
    const actualTotal = row.yHomeRuns + row.yAwayRuns;
    errAbs.push(Math.abs(predTotal - actualTotal));
    errSq.push((predTotal - actualTotal) ** 2);

    // ---- ridge → poisson ML ----
    if (ridge.ok) {
      const win = poissonHomeWinProb(homeMu, awayMu);
      const pHome = win.homeWinProb;
      const pickHome = pHome >= 0.5;
      const modelProb = pickHome ? pHome : 1 - pHome;
      const odds = pickHome ? row.mkt.homeOdds : row.mkt.awayOdds;
      const fair = pickHome ? row.mkt.fairHome : row.mkt.fairAway;
      const edge = modelProb - fair;
      const ev = modelProb * (odds - 1) - (1 - modelProb);
      const hit = pickHome === (row.yWin === 1);
      const cand = { odds, modelProb, edge, ev, hit, hold: row.month };
      if (passGate(cand, GATES.mid)) bags.ridge_mid.push(cand);
      if (passGate(cand, GATES.soft)) bags.ridge_soft.push(cand);
      if (passGate(cand, GATES.direction)) bags.ridge_direction.push(cand);
    }

    // ---- logistic ML ----
    if (logistic.ok) {
      const z = predictLogit(logistic, row.homeFeats);
      const pHome = applyAsianLogisticCalibration(z, {
        fromLogit: true,
        shrink: 0.55,
        temp: 1.35,
        fairHome: row.mkt.fairHome,
      });
      const pickHome = pHome >= 0.5;
      const modelProb = pickHome ? pHome : 1 - pHome;
      const odds = pickHome ? row.mkt.homeOdds : row.mkt.awayOdds;
      const fair = pickHome ? row.mkt.fairHome : row.mkt.fairAway;
      const edge = modelProb - fair;
      const ev = modelProb * (odds - 1) - (1 - modelProb);
      const hit = pickHome === (row.yWin === 1);
      const cand = { odds, modelProb, edge, ev, hit, hold: row.month };
      if (passGate(cand, GATES.mid)) bags.logistic_mid.push(cand);
      if (passGate(cand, GATES.soft)) bags.logistic_soft.push(cand);
      if (passGate(cand, GATES.direction)) bags.logistic_direction.push(cand);
    }

    // ---- totals ----
    if (ridge.ok && row.totals) {
      const line = row.totals.line;
      const pickOver = predTotal > line;
      const modelSideProb = pickOver ? 0.55 : 0.55; // placeholder; use poisson later if needed
      // simple: bet when |pred-line| >= 0.35
      const gap = Math.abs(predTotal - line);
      const odds = pickOver ? row.totals.overOdds : row.totals.underOdds;
      const fair = pickOver ? row.totals.fairOver : row.totals.fairUnder;
      // crude model prob from gap
      const modelProb = Math.min(0.72, 0.5 + gap * 0.08);
      const edge = modelProb - fair;
      const ev = modelProb * (odds - 1) - (1 - modelProb);
      const actualOver = actualTotal > line;
      const push = actualTotal === line;
      const hit = !push && pickOver === actualOver;
      bags.totals_direction_vs_line.push({
        hold: row.month,
        line,
        predTotal,
        actualTotal,
        pickOver,
        gap,
        hit: push ? null : hit,
        push,
      });
      if (!push && gap >= 0.35 && odds >= 1.7 && odds <= 2.2 && edge >= 0.02 && ev >= 0.02) {
        bags.totals_market.push({ odds, modelProb, edge, ev, hit, hold: row.month });
      }
    } else if (ridge.ok) {
      // no market: still track direction vs actual median-ish 7.5 proxy? skip
    }
  }
}

const mae = errAbs.length ? errAbs.reduce((a, b) => a + b, 0) / errAbs.length : null;
const rmse = errSq.length
  ? Math.sqrt(errSq.reduce((a, b) => a + b, 0) / errSq.length)
  : null;

const totalsDir = bags.totals_direction_vs_line.filter((x) => x.hit != null);
const totalsDirHit =
  totalsDir.length > 0
    ? totalsDir.filter((x) => x.hit).length / totalsDir.length
    : null;

const out = {
  researchOnly: true,
  league: LEAGUE,
  question: 'NPB 是否用兩隊預期得分→預測；效果 vs logistic 主看',
  months: months.length,
  warmup: [...warmup],
  runPredictionQuality: {
    n: errAbs.length,
    maeTotal: mae != null ? Number(mae.toFixed(3)) : null,
    rmseTotal: rmse != null ? Number(rmse.toFixed(3)) : null,
  },
  moneyline: {
    ridge_poisson: {
      mid: summarize(bags.ridge_mid),
      soft: summarize(bags.ridge_soft),
      direction: summarize(bags.ridge_direction),
    },
    logistic_h2h: {
      mid: summarize(bags.logistic_mid),
      soft: summarize(bags.logistic_soft),
      direction: summarize(bags.logistic_direction),
    },
  },
  totals: {
    marketRowsAvailable: bags.totals_direction_vs_line.length,
    directionHitRateVsLine: totalsDirHit != null ? Number(totalsDirHit.toFixed(4)) : null,
    gatedBets: summarize(bags.totals_market),
    note:
      bags.totals_direction_vs_line.length === 0
        ? '庫內 NPB 幾乎無 totals 盤，無法做真金大小 OOS'
        : '有 totals 盤時：用 μh+μa 對線方向／簡易門檻下注',
  },
  verdict: null,
};

const ridgeRoi = out.moneyline.ridge_poisson.mid.roi;
const logRoi = out.moneyline.logistic_h2h.mid.roi;
out.verdict = {
  betterMlHead:
    (ridgeRoi ?? -9) > (logRoi ?? -9)
      ? 'ridge_poisson'
      : (logRoi ?? -9) > (ridgeRoi ?? -9)
        ? 'logistic_h2h'
        : 'tie_or_insufficient',
  keepPrimary: 'logistic_h2h_unless_ridge_clearly_better',
  totalsReady: bags.totals_direction_vs_line.length > 50,
};

fs.writeFileSync('tmp-npb-expected-runs-skeleton.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log('wrote tmp-npb-expected-runs-skeleton.json');
