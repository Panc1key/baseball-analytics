/**
 * NPB 研究影子 OOS（對齊 MLB shadow 紀律）
 * 凍結基線 logistic mid vs 影子 ridge_poisson（raw / 同校準）
 *
 * 用法: node scripts/auditNpbResearchShadow.mjs
 * 產物: tmp-npb-research-shadow.json
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
import {
  NPB_RESEARCH_SHADOW_SPEC,
  npbShadowPromoteVerdict,
} from '../src/services/AsianNpbResearchShadow.js';

const STAKE = NPB_RESEARCH_SHADOW_SPEC.stakeUsd;
const LEAGUE = 'NPB';
const LOG_KEYS = [...ASIAN_FEATURE_SET_NO_PITCHER];
const GATE = NPB_RESEARCH_SHADOW_SPEC.gates.mid;
const BASE = NPB_RESEARCH_SHADOW_SPEC.baseline;

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

function summarize(bets) {
  if (!bets.length) return { bets: 0, decided: 0, hitRate: null, roi: null, usd50: 0 };
  let unit = 0;
  let hits = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.odds - 1;
    } else unit -= 1;
  }
  return {
    bets: bets.length,
    decided: bets.length,
    hitRate: Number((hits / bets.length).toFixed(4)),
    roi: Number((unit / bets.length).toFixed(4)),
    usd50: Math.round(unit * STAKE),
  };
}

function byYearSummary(bets) {
  const map = {};
  for (const b of bets) {
    const y = String(b.hold).slice(0, 4);
    if (!map[y]) map[y] = [];
    map[y].push(b);
  }
  const out = {};
  for (const [y, arr] of Object.entries(map).sort()) out[y] = summarize(arr);
  return out;
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

function passGate(cand) {
  if (cand.odds < GATE.minOdds || cand.odds > GATE.maxOdds) return false;
  if (cand.modelProb < GATE.minProb) return false;
  if (cand.edge < GATE.minEdge) return false;
  if (cand.ev < GATE.minEv) return false;
  return true;
}

function toCand(pHome, row) {
  const pickHome = pHome >= 0.5;
  const modelProb = pickHome ? pHome : 1 - pHome;
  const odds = pickHome ? row.mkt.homeOdds : row.mkt.awayOdds;
  const fair = pickHome ? row.mkt.fairHome : row.mkt.fairAway;
  const edge = modelProb - fair;
  const ev = modelProb * (odds - 1) - (1 - modelProb);
  const hit = pickHome === (row.yWin === 1);
  return { odds, modelProb, edge, ev, hit, hold: row.month, pickHome };
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
    xHome: homeEx.x,
    xAway: awayEx.x,
    xFull: matchupVectorFromHomeFeatures(homeEx.features),
    yHomeRuns: Number(g.home_score),
    yAwayRuns: Number(g.away_score),
    yWin: Number(g.home_score) > Number(g.away_score) ? 1 : 0,
    mkt: bestH2h(books, g.home_team, g.away_team),
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
  baseline: [],
  ridge_poisson_raw: [],
  ridge_poisson_cal_same: [],
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

    if (ridge.ok) {
      const homeMu = predictSideRuns(ridge, row.xHome);
      const awayMu = predictSideRuns(ridge, row.xAway);
      const predTotal = homeMu + awayMu;
      const actualTotal = row.yHomeRuns + row.yAwayRuns;
      errAbs.push(Math.abs(predTotal - actualTotal));
      errSq.push((predTotal - actualTotal) ** 2);

      const rawP = poissonHomeWinProb(homeMu, awayMu).homeWinProb;
      const rawCand = toCand(rawP, row);
      if (passGate(rawCand)) bags.ridge_poisson_raw.push(rawCand);

      const calP = applyAsianLogisticCalibration(rawP, {
        fromLogit: false,
        shrink: BASE.shrink,
        temp: BASE.temp,
        fairHome: row.mkt.fairHome,
      });
      const calCand = toCand(calP, row);
      if (passGate(calCand)) bags.ridge_poisson_cal_same.push(calCand);
    }

    if (logistic.ok) {
      const z = predictLogit(logistic, row.homeFeats);
      const pHome = applyAsianLogisticCalibration(z, {
        fromLogit: true,
        shrink: BASE.shrink,
        temp: BASE.temp,
        fairHome: row.mkt.fairHome,
      });
      const cand = toCand(pHome, row);
      if (passGate(cand)) bags.baseline.push(cand);
    }
  }
}

const baseline = summarize(bags.baseline);
const baselineByYear = byYearSummary(bags.baseline);
const shadows = {};
for (const spec of NPB_RESEARCH_SHADOW_SPEC.openShadows) {
  const bets = bags[spec.id] || [];
  const overall = summarize(bets);
  const byYear = byYearSummary(bets);
  const yearDelta = {};
  for (const y of new Set([...Object.keys(baselineByYear), ...Object.keys(byYear)])) {
    yearDelta[y] = {
      baselineUsd50: baselineByYear[y]?.usd50 ?? 0,
      shadowUsd50: byYear[y]?.usd50 ?? 0,
      deltaUsd50: (byYear[y]?.usd50 ?? 0) - (baselineByYear[y]?.usd50 ?? 0),
      baselineBets: baselineByYear[y]?.bets ?? 0,
      shadowBets: byYear[y]?.bets ?? 0,
    };
  }
  shadows[spec.id] = {
    spec,
    overall,
    byYear,
    yearDelta,
    deltaUsd50: overall.usd50 - baseline.usd50,
    verdict: npbShadowPromoteVerdict({
      baseline,
      shadow: overall,
      byYear: yearDelta,
    }),
  };
}

const n = errAbs.length;
const out = {
  researchOnly: true,
  wiredToFormal: false,
  protocol: NPB_RESEARCH_SHADOW_SPEC,
  months: months.length,
  warmup: [...warmup],
  gate: GATE,
  predictionQuality: n
    ? {
        n,
        maeTotal: Number((errAbs.reduce((a, b) => a + b, 0) / n).toFixed(3)),
        rmseTotal: Number(Math.sqrt(errSq.reduce((a, b) => a + b, 0) / n).toFixed(3)),
      }
    : null,
  baseline: {
    id: BASE.id,
    overall: baseline,
    byYear: baselineByYear,
  },
  shadows,
  decision: {
    keepBaseline: true,
    bestShadow:
      Object.entries(shadows).sort((a, b) => b[1].deltaUsd50 - a[1].deltaUsd50)[0]?.[0] ||
      null,
    note: '基線保持 NPB_primary；影子未升格前不改 freeze 常數',
  },
};

const path = new URL('../tmp-npb-research-shadow.json', import.meta.url);
fs.writeFileSync(path, JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  baseline: out.baseline.overall,
  shadows: Object.fromEntries(
    Object.entries(shadows).map(([k, v]) => [
      k,
      {
        bets: v.overall.bets,
        hitRate: v.overall.hitRate,
        roi: v.overall.roi,
        usd50: v.overall.usd50,
        deltaUsd50: v.deltaUsd50,
        status: v.verdict.status,
        reason: v.verdict.reason,
      },
    ])
  ),
  decision: out.decision,
  predictionQuality: out.predictionQuality,
}, null, 2));
console.log('wrote tmp-npb-research-shadow.json');
