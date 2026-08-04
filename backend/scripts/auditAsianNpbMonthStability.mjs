/**
 * NPB 研究：月穩定性切片（不進正式）
 * 用法: node scripts/auditAsianNpbMonthStability.mjs
 * 產物: tmp-asian-npb-month-stability.json
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
} from '../src/services/AsianExpectedRunsLite.js';
import { ASIAN_FEATURE_SET_NO_PITCHER } from '../src/services/AsianResearchFreeze.js';

const STAKE = 50;
const GATE = { minOdds: 1.7, maxOdds: 2.3, minProb: 0.52, minEdge: 0.02, minEv: 0.02 };
const KEYS = [...ASIAN_FEATURE_SET_NO_PITCHER];

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

function trainOnKeys(examples) {
  const mapped = examples.map((e) => ({
    x: KEYS.map((k) => e.xFull[ASIAN_MATCHUP_FEATURE_KEYS.indexOf(k)]),
    y: e.y,
  }));
  const dim = KEYS.length;
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

function predictZ(model, homeFeats) {
  let z = model.intercept;
  for (let i = 0; i < KEYS.length; i += 1) {
    const v = Number(homeFeats[KEYS[i]]) || 0;
    z += model.weights[i] * ((v - model.means[i]) / model.scales[i]);
  }
  return z;
}

function summarize(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, roi: null, usd50: 0 };
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
    hitRate: Number((hits / bets.length).toFixed(4)),
    roi: Number((unit / bets.length).toFixed(4)),
    usd50: Math.round(unit * STAKE),
  };
}

const games = loadAsianCompletedGames('NPB').filter(
  (g) => Number(g.home_score) !== Number(g.away_score)
);
const months = [...new Set(games.map((g) => String(g.commence_time).slice(0, 7)))].sort();
const warmup = new Set(months.slice(0, 2));
const starterMap = loadAsianStarterSnapshotMap('NPB');
const priorIndex = new Map();
const pitcherHist = new Map();
const elo = createWalkForwardElo('NPB', { seedFromRating: false });
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
    ready: homeEx.ready,
    homeFeats: homeEx.features,
    mkt: bestH2h(books, g.home_team, g.away_team),
    xFull: matchupVectorFromHomeFeatures(homeEx.features),
  });
  for (const team of [g.home_team, g.away_team]) {
    if (!priorIndex.has(team)) priorIndex.set(team, []);
    priorIndex.get(team).push(g);
  }
  elo.applyGame(g.home_team, g.away_team, g.home_score, g.away_score);
  appendPitcherHistory(pitcherHist, homeKey, g.commence_time, g.away_score);
  appendPitcherHistory(pitcherHist, awayKey, g.commence_time, g.home_score);
}

const bets = [];
const slices = {
  highEdge: [],
  longOdds: [],
  bigGap: [],
  homePick: [],
  awayPick: [],
};

for (const hold of months.filter((m) => !warmup.has(m))) {
  const train = labeled
    .filter((r) => r.month < hold && r.ready)
    .map((r) => ({
      xFull: r.xFull,
      y: Number(r.g.home_score) > Number(r.g.away_score) ? 1 : 0,
    }));
  const model = trainOnKeys(train);
  if (!model.ok) continue;
  for (const row of labeled) {
    if (row.month !== hold || !row.ready || !row.mkt) continue;
    const z = predictZ(model, row.homeFeats);
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
    const absGap = Math.abs(pHome - row.mkt.fairHome);
    const ev = modelProb * (odds - 1) - (1 - modelProb);
    if (odds < GATE.minOdds || odds > GATE.maxOdds) continue;
    if (modelProb < GATE.minProb || edge < GATE.minEdge || ev < GATE.minEv) continue;
    const hit = pickHome === (Number(row.g.home_score) > Number(row.g.away_score));
    const b = { hold, odds, edge, absGap, pickHome, hit };
    bets.push(b);
    if (edge > 0.06) slices.highEdge.push(b);
    if (odds >= 2.1) slices.longOdds.push(b);
    if (absGap > 0.08) slices.bigGap.push(b);
    if (pickHome) slices.homePick.push(b);
    else slices.awayPick.push(b);
  }
}

const byMonth = {};
for (const b of bets) {
  if (!byMonth[b.hold]) byMonth[b.hold] = [];
  byMonth[b.hold].push(b);
}

const monthRows = Object.entries(byMonth)
  .map(([m, xs]) => ({ month: m, ...summarize(xs) }))
  .sort((a, b) => a.month.localeCompare(b.month));

const out = {
  researchOnly: true,
  overall: summarize(bets),
  byMonth: monthRows,
  weakMonths: monthRows.filter((r) => (r.roi ?? 0) < 0),
  strongMonths: monthRows.filter((r) => (r.roi ?? 0) > 0),
  slices: Object.fromEntries(
    Object.entries(slices).map(([k, xs]) => [k, summarize(xs)])
  ),
};

fs.writeFileSync('tmp-asian-npb-month-stability.json', JSON.stringify(out, null, 2));
console.log(
  JSON.stringify(
    {
      overall: out.overall,
      posMonths: out.strongMonths.length,
      negMonths: out.weakMonths.length,
      weakMonths: out.weakMonths,
      slices: out.slices,
    },
    null,
    2
  )
);
console.log('wrote tmp-asian-npb-month-stability.json');
