/**
 * 亞聯研究候選多年 expanding OOS（含 patch；不進正式）
 * 用法: node scripts/reportAsianResearchCandidate.mjs
 * 產物: tmp-asian-research-candidate.json
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
import {
  ASIAN_FEATURE_SET_NO_PITCHER,
  ASIAN_FEATURE_SET_PITCHER_CORE,
  ASIAN_RESEARCH_FREEZE,
} from '../src/services/AsianResearchFreeze.js';

const STAKE = 50;
const GATES = {
  soft: { minOdds: 1.65, maxOdds: 2.4, minProb: 0.5, minEdge: 0.01, minEv: 0.01 },
  mid: { minOdds: 1.7, maxOdds: 2.3, minProb: 0.52, minEdge: 0.02, minEv: 0.02 },
};

const FEATURE_MAP = {
  full: [...ASIAN_MATCHUP_FEATURE_KEYS],
  no_pitcher: [...ASIAN_FEATURE_SET_NO_PITCHER],
  pitcher_core: [...ASIAN_FEATURE_SET_PITCHER_CORE],
};

/** 額外對照：歷史年無先發時的 KBO / NPB 安全門檻 */
const EXTRA = {
  KBO_noPitcher_kboSafe: {
    league: 'KBO',
    head: 'logistic_h2h',
    features: 'no_pitcher',
    shrink: 0.4,
    temp: 1.15,
    gate: 'soft',
    patches: { maxEdge: 0.06, maxAbsGap: 0.06, maxOddsSoft: 2.25 },
  },
  NPB_npbSafe: {
    league: 'NPB',
    head: 'logistic_h2h',
    features: 'no_pitcher',
    shrink: 0.55,
    temp: 1.35,
    gate: 'mid',
    patches: { maxRawEdge: 0.08, maxEdge: 0.06 },
  },
  NPB_bothSafe: {
    league: 'NPB',
    head: 'logistic_h2h',
    features: 'no_pitcher',
    shrink: 0.55,
    temp: 1.35,
    gate: 'mid',
    patches: { maxEdge: 0.06, maxRawEdge: 0.08, maxAbsGap: 0.06, maxOddsSoft: 2.25 },
  },
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

function summarize(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, roi: null, usd50: 0, byYear: {}, folds: {} };
  let unit = 0;
  let hits = 0;
  const byHold = {};
  const byYear = {};
  for (const b of bets) {
    const y = String(b.hold).slice(0, 4);
    if (!byHold[b.hold]) byHold[b.hold] = { n: 0, hits: 0, unit: 0 };
    if (!byYear[y]) byYear[y] = { n: 0, hits: 0, unit: 0 };
    byHold[b.hold].n += 1;
    byYear[y].n += 1;
    if (b.hit) {
      hits += 1;
      unit += b.odds - 1;
      byHold[b.hold].hits += 1;
      byHold[b.hold].unit += b.odds - 1;
      byYear[y].hits += 1;
      byYear[y].unit += b.odds - 1;
    } else {
      unit -= 1;
      byHold[b.hold].unit -= 1;
      byYear[y].unit -= 1;
    }
  }
  const folds = {};
  for (const [h, s] of Object.entries(byHold)) {
    folds[h] = {
      bets: s.n,
      hitRate: Number((s.hits / s.n).toFixed(4)),
      roi: Number((s.unit / s.n).toFixed(4)),
      usd50: Math.round(s.unit * STAKE),
    };
  }
  const years = {};
  for (const [y, s] of Object.entries(byYear)) {
    years[y] = {
      bets: s.n,
      hitRate: Number((s.hits / s.n).toFixed(4)),
      roi: Number((s.unit / s.n).toFixed(4)),
      usd50: Math.round(s.unit * STAKE),
    };
  }
  return {
    bets: bets.length,
    hitRate: Number((hits / bets.length).toFixed(4)),
    roi: Number((unit / bets.length).toFixed(4)),
    usd50: Math.round(unit * STAKE),
    byYear: years,
    folds,
  };
}

function trainOnKeys(examples, keys) {
  const mapped = examples.map((e) => ({
    x: keys.map((k) => e.xFull[ASIAN_MATCHUP_FEATURE_KEYS.indexOf(k)]),
    y: e.y,
  }));
  const dim = keys.length;
  const n = mapped.length;
  if (n < 40) return { ok: false };
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = (xs, m) =>
    Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
  const means = [];
  const scales = [];
  for (let j = 0; j < dim; j += 1) {
    const col = mapped.map((e) => e.x[j]);
    const m = mean(col);
    means.push(m);
    scales.push(std(col, m));
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
  return {
    ok: true,
    keys,
    means,
    scales,
    intercept: beta[0],
    weights: Object.fromEntries(keys.map((k, i) => [k, beta[i + 1]])),
  };
}

function predictZ(model, homeFeats) {
  let z = model.intercept;
  for (let i = 0; i < model.keys.length; i += 1) {
    const k = model.keys[i];
    const v = Number(homeFeats[k]) || 0;
    z += (model.weights[k] || 0) * ((v - model.means[i]) / model.scales[i]);
  }
  return z;
}

function passPatch(cand, patch = {}) {
  if (patch.maxEdge != null && cand.edge > patch.maxEdge) return false;
  if (patch.maxRawEdge != null && cand.rawEdge > patch.maxRawEdge) return false;
  if (patch.maxAbsGap != null && cand.absGap > patch.maxAbsGap) return false;
  if (patch.maxOddsSoft != null && cand.odds >= patch.maxOddsSoft) return false;
  return true;
}

const labeledCache = new Map();

function labelLeague(league) {
  if (labeledCache.has(league)) return labeledCache.get(league);
  const games = loadAsianCompletedGames(league).filter(
    (g) => Number(g.home_score) !== Number(g.away_score)
  );
  const months = [...new Set(games.map((g) => String(g.commence_time).slice(0, 7)))].sort();
  const starterMap = loadAsianStarterSnapshotMap(league);
  const priorIndex = new Map();
  const pitcherHist = new Map();
  const elo = createWalkForwardElo(league, { seedFromRating: false });
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
      y: Number(g.home_score) > Number(g.away_score) ? 1 : 0,
    });
    for (const team of [g.home_team, g.away_team]) {
      if (!priorIndex.has(team)) priorIndex.set(team, []);
      priorIndex.get(team).push(g);
    }
    elo.applyGame(g.home_team, g.away_team, g.home_score, g.away_score);
    appendPitcherHistory(pitcherHist, homeKey, g.commence_time, g.away_score);
    appendPitcherHistory(pitcherHist, awayKey, g.commence_time, g.home_score);
  }
  const out = { labeled, months, gameCount: games.length };
  labeledCache.set(league, out);
  return out;
}

function evalCandidate(name, league, cand) {
  const keys = FEATURE_MAP[cand.features];
  const gate = GATES[cand.gate];
  const patch = cand.patches || {};
  const { labeled, months, gameCount } = labelLeague(league);
  const warmup = new Set(months.slice(0, 2));
  const bets = [];

  for (const hold of months.filter((m) => !warmup.has(m))) {
    const train = labeled
      .filter((r) => r.month < hold && r.ready)
      .map((r) => ({ xFull: r.xFull, y: r.y }));
    const model = trainOnKeys(train, keys);
    if (!model.ok) continue;
    for (const row of labeled) {
      if (row.month !== hold || !row.ready || !row.mkt) continue;
      const z = predictZ(model, row.homeFeats);
      const pRawHome = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
      const pHome = applyAsianLogisticCalibration(z, {
        fromLogit: true,
        shrink: cand.shrink,
        temp: cand.temp,
        fairHome: row.mkt.fairHome,
      });
      const pickHome = pHome >= 0.5;
      const modelProb = pickHome ? pHome : 1 - pHome;
      const pRaw = pickHome ? pRawHome : 1 - pRawHome;
      const odds = pickHome ? row.mkt.homeOdds : row.mkt.awayOdds;
      const fair = pickHome ? row.mkt.fairHome : row.mkt.fairAway;
      const edge = modelProb - fair;
      const rawEdge = pRaw - fair;
      const absGap = Math.abs(pHome - row.mkt.fairHome);
      const ev = modelProb * (odds - 1) - (1 - modelProb);
      if (odds < gate.minOdds || odds > gate.maxOdds) continue;
      if (modelProb < gate.minProb || edge < gate.minEdge || ev < gate.minEv) continue;
      const hit = pickHome === (Number(row.g.home_score) > Number(row.g.away_score));
      const rowCand = { hold, odds, edge, rawEdge, absGap, hit };
      if (!passPatch(rowCand, patch)) continue;
      bets.push(rowCand);
    }
  }
  return {
    name,
    league,
    cand,
    gameCount,
    months: months.length,
    warmup: [...warmup],
    ...summarize(bets),
  };
}

const jobs = [];
for (const [name, cand] of Object.entries(ASIAN_RESEARCH_FREEZE.candidates)) {
  const league = name.startsWith('KBO') ? 'KBO' : 'NPB';
  jobs.push([name, league, cand]);
}
for (const [name, cand] of Object.entries(EXTRA)) {
  jobs.push([name, cand.league, cand]);
}

const results = {
  freezeId: ASIAN_RESEARCH_FREEZE.id,
  researchOnly: true,
  wiredToFormal: false,
  note: '2024/2025 尚無先發快照；KBO pitcher_core 在歷史年等同缺先發特徵',
  candidates: {},
};

for (const [name, league, cand] of jobs) {
  process.stdout.write(`\reval ${name}...`.padEnd(40));
  results.candidates[name] = evalCandidate(name, league, cand);
}
process.stdout.write('\n');

fs.writeFileSync('tmp-asian-research-candidate.json', JSON.stringify(results, null, 2));

const compact = {};
for (const [k, v] of Object.entries(results.candidates)) {
  compact[k] = {
    bets: v.bets,
    hitRate: v.hitRate,
    roi: v.roi,
    usd50: v.usd50,
    byYear: v.byYear,
  };
}
console.log(JSON.stringify(compact, null, 2));
console.log('wrote tmp-asian-research-candidate.json');
