/**
 * 亞聯研究：7 月毒區 → 加硬門檻後重評（不進正式）
 * - 限制 raw 過度自信、edge 上限、長賠上限
 * 用法: node scripts/auditAsianJulyPatch.mjs
 * 產物: tmp-asian-july-patch.json
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
} from '../src/services/AsianResearchFreeze.js';

const STAKE = 50;
const FEATURE_MAP = {
  full: [...ASIAN_MATCHUP_FEATURE_KEYS],
  no_pitcher: [...ASIAN_FEATURE_SET_NO_PITCHER],
  pitcher_core: [...ASIAN_FEATURE_SET_PITCHER_CORE],
};

const CANDS = {
  NPB_volume: {
    league: 'NPB',
    features: 'no_pitcher',
    shrink: 0.55,
    temp: 1.35,
    gate: { minOdds: 1.7, maxOdds: 2.3, minProb: 0.52, minEdge: 0.02, minEv: 0.02 },
  },
  KBO_volume: {
    league: 'KBO',
    features: 'pitcher_core',
    shrink: 0.4,
    temp: 1.15,
    gate: { minOdds: 1.65, maxOdds: 2.4, minProb: 0.5, minEdge: 0.01, minEv: 0.01 },
  },
  KBO_noPitcher: {
    league: 'KBO',
    features: 'no_pitcher',
    shrink: 0.4,
    temp: 1.15,
    gate: { minOdds: 1.65, maxOdds: 2.4, minProb: 0.5, minEdge: 0.01, minEv: 0.01 },
  },
};

const PATCHES = {
  baseline: {},
  capEdge06: { maxEdge: 0.06 },
  capRaw08: { maxRawEdge: 0.08 },
  capGap05: { maxAbsGap: 0.05 },
  noLong225: { maxOddsSoft: 2.25 },
  // 組合：對 KBO 7 月毒區最對症
  kboSafe: { maxEdge: 0.06, maxAbsGap: 0.06, maxOddsSoft: 2.25 },
  // NPB：壓 raw 過度自信
  npbSafe: { maxRawEdge: 0.08, maxEdge: 0.06 },
  bothSafe: { maxEdge: 0.06, maxRawEdge: 0.08, maxAbsGap: 0.06, maxOddsSoft: 2.25 },
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
    z +=
      (model.weights[k] || 0) *
      (((Number(homeFeats[k]) || 0) - model.means[i]) / model.scales[i]);
  }
  return z;
}

function labelLeague(league) {
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
  return { labeled, months };
}

function passPatch(cand, patch) {
  if (patch.maxEdge != null && cand.edge > patch.maxEdge) return false;
  if (patch.maxRawEdge != null && cand.rawEdge > patch.maxRawEdge) return false;
  if (patch.maxAbsGap != null && cand.absGap > patch.maxAbsGap) return false;
  if (patch.maxOddsSoft != null && cand.odds >= patch.maxOddsSoft) return false;
  return true;
}

function evalCand(name, cfg) {
  const { labeled, months } = labelLeague(cfg.league);
  const warmup = new Set(months.slice(0, 2));
  const keys = FEATURE_MAP[cfg.features];
  const byPatch = {};
  for (const pName of Object.keys(PATCHES)) {
    byPatch[pName] = { all: [], byHold: {}, byYear: {} };
  }

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
        shrink: cfg.shrink,
        temp: cfg.temp,
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
      const g = cfg.gate;
      if (odds < g.minOdds || odds > g.maxOdds) continue;
      if (modelProb < g.minProb || edge < g.minEdge || ev < g.minEv) continue;
      const hit = pickHome === (Number(row.g.home_score) > Number(row.g.away_score));
      const cand = { hold, odds, edge, rawEdge, absGap, hit };
      const y = hold.slice(0, 4);
      for (const [pName, patch] of Object.entries(PATCHES)) {
        if (!passPatch(cand, patch)) continue;
        byPatch[pName].all.push(cand);
        if (!byPatch[pName].byHold[hold]) byPatch[pName].byHold[hold] = [];
        if (!byPatch[pName].byYear[y]) byPatch[pName].byYear[y] = [];
        byPatch[pName].byHold[hold].push(cand);
        byPatch[pName].byYear[y].push(cand);
      }
    }
  }

  const summary = {};
  for (const [pName, bag] of Object.entries(byPatch)) {
    summary[pName] = {
      overall: summarize(bag.all),
      byYear: Object.fromEntries(
        Object.entries(bag.byYear).map(([y, xs]) => [y, summarize(xs)])
      ),
      june2026: summarize(bag.byHold['2026-06'] || []),
      july2026: summarize(bag.byHold['2026-07'] || []),
    };
  }
  return { name, cfg, summary, months, warmup: [...warmup] };
}

const out = {
  experimentId: 'asian_july_patch_v1',
  researchOnly: true,
  results: Object.fromEntries(
    Object.entries(CANDS).map(([k, v]) => [k, evalCand(k, v)])
  ),
};

fs.writeFileSync('tmp-asian-july-patch.json', JSON.stringify(out, null, 2));

function compact(block) {
  const rows = Object.entries(block.summary).map(([k, v]) => ({
    patch: k,
    overall: v.overall,
    byYear: v.byYear,
    june2026: v.june2026,
    july2026: v.july2026,
  }));
  rows.sort((a, b) => (b.overall.roi ?? -9) - (a.overall.roi ?? -9));
  return rows.slice(0, 6);
}

console.log(
  JSON.stringify(
    {
      NPB_volume: compact(out.results.NPB_volume),
      KBO_volume: compact(out.results.KBO_volume),
      KBO_noPitcher: compact(out.results.KBO_noPitcher),
    },
    null,
    2
  )
);
console.log('wrote tmp-asian-july-patch.json');
