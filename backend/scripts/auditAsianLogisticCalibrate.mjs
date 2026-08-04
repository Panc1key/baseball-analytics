/**
 * 亞聯研究：logistic + 先發特徵的 shrink / 溫度 / 門檻網格（不進正式）
 * 用法: node scripts/auditAsianLogisticCalibrate.mjs
 * 產物: tmp-asian-logistic-calibrate.json
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
  exampleFromGameSide,
  matchupVectorFromHomeFeatures,
} from '../src/services/AsianExpectedRunsLite.js';

const STAKE = 50;

const GATES = {
  soft: { minOdds: 1.65, maxOdds: 2.4, minProb: 0.5, minEdge: 0.01, minEv: 0.01 },
  mid: { minOdds: 1.7, maxOdds: 2.3, minProb: 0.52, minEdge: 0.02, minEv: 0.02 },
  tight: { minOdds: 1.75, maxOdds: 2.2, minProb: 0.54, minEdge: 0.03, minEv: 0.03 },
  direction: { minOdds: 1.5, maxOdds: 3.5, minProb: 0.5, minEdge: -1, minEv: -1 },
};

const SHRINKS = [0, 0.25, 0.4, 0.55, 0.7];
const TEMPS = [0.85, 1.0, 1.15, 1.35]; // >1 = 壓平自信

const FEATURE_SETS = {
  full: [...ASIAN_MATCHUP_FEATURE_KEYS],
  no_pitcher: ASIAN_MATCHUP_FEATURE_KEYS.filter((k) => !k.toLowerCase().includes('pitcher')),
  pitcher_core: [
    'eloDiff',
    'eloStrength',
    'pythWinPct',
    'opponentPythWinPct',
    'runDiffPerGame',
    'opponentRunDiffPerGame',
    'pitcherKnown',
    'opponentPitcherKnown',
    'pitcherRaDiff',
    'pitcherRestDays',
    'opponentPitcherRestDays',
    'pitcherStarts',
    'opponentPitcherStarts',
  ],
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
  let decided = 0;
  for (const b of bets) {
    decided += 1;
    if (b.hit) {
      hits += 1;
      unit += b.odds - 1;
    } else unit -= 1;
  }
  return {
    bets: bets.length,
    decided,
    hitRate: decided ? Number((hits / decided).toFixed(4)) : null,
    roi: bets.length ? Number((unit / bets.length).toFixed(4)) : null,
    usd50: Math.round(unit * STAKE),
  };
}

function passGate(cand, gate) {
  if (cand.odds < gate.minOdds || cand.odds > gate.maxOdds) return false;
  if (cand.modelProb < gate.minProb) return false;
  if (cand.edge < gate.minEdge) return false;
  if (cand.ev < gate.minEv) return false;
  return true;
}

function trainOnKeys(examples, keys) {
  const mapped = examples.map((e) => ({
    x: keys.map((k) => {
      const i = ASIAN_MATCHUP_FEATURE_KEYS.indexOf(k);
      return e.xFull[i];
    }),
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
  const ridge = 0.05;
  const lr = 0.08;
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
    beta[0] -= (lr / n) * grad[0];
    for (let j = 1; j <= dim; j += 1) beta[j] -= (lr / n) * (grad[j] + ridge * beta[j]);
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

function predictRaw(model, homeFeats) {
  if (!model?.ok) return 0.5;
  let z = model.intercept;
  for (let i = 0; i < model.keys.length; i += 1) {
    const k = model.keys[i];
    const v = Number(homeFeats[k]) || 0;
    z += (model.weights[k] || 0) * ((v - model.means[i]) / model.scales[i]);
  }
  return { z, p: 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z)))) };
}

function applyCalib(pRaw, z, { shrink, temp, fairHome }) {
  // temperature on logit
  const zt = z / Math.max(0.5, temp);
  let p = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, zt))));
  p = Math.max(0.05, Math.min(0.95, p));
  if (shrink > 0) p = (1 - shrink) * p + shrink * fairHome;
  return Math.max(0.05, Math.min(0.95, p));
}

function labelLeague(league) {
  const games = loadAsianCompletedGames(league).filter(
    (g) => Number(g.home_score) !== Number(g.away_score)
  );
  const months = [...new Set(games.map((g) => String(g.commence_time).slice(0, 7)))].sort();
  const warmup = new Set(months.slice(0, 2));
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
      hasStarter: Boolean(homeKey || awayKey),
    });
    for (const team of [g.home_team, g.away_team]) {
      if (!priorIndex.has(team)) priorIndex.set(team, []);
      priorIndex.get(team).push(g);
    }
    elo.applyGame(g.home_team, g.away_team, g.home_score, g.away_score);
    appendPitcherHistory(pitcherHist, homeKey, g.commence_time, g.away_score);
    appendPitcherHistory(pitcherHist, awayKey, g.commence_time, g.home_score);
  }

  return { labeled, months, warmup, nGames: games.length };
}

function runLeague(league) {
  const { labeled, months, warmup, nGames } = labelLeague(league);
  const holdMonths = months.filter((m) => !warmup.has(m));
  const variants = [];

  for (const [featName, keys] of Object.entries(FEATURE_SETS)) {
    for (const shrink of SHRINKS) {
      for (const temp of TEMPS) {
        const bags = {};
        for (const g of Object.keys(GATES)) bags[g] = [];

        for (const hold of holdMonths) {
          const train = labeled
            .filter((r) => r.month < hold && r.ready)
            .map((r) => ({ xFull: r.xFull, y: r.y }));
          const model = trainOnKeys(train, keys);
          if (!model.ok) continue;

          for (const row of labeled) {
            if (row.month !== hold || !row.ready || !row.mkt) continue;
            const { z, p: pRaw } = predictRaw(model, row.homeFeats);
            const pHome = applyCalib(pRaw, z, {
              shrink,
              temp,
              fairHome: row.mkt.fairHome,
            });
            const pAway = 1 - pHome;
            const pickHome = pHome >= pAway;
            const modelProb = pickHome ? pHome : pAway;
            const odds = pickHome ? row.mkt.homeOdds : row.mkt.awayOdds;
            const fair = pickHome ? row.mkt.fairHome : row.mkt.fairAway;
            const edge = modelProb - fair;
            const ev = modelProb * (odds - 1) - (1 - modelProb);
            const hit =
              pickHome === (Number(row.g.home_score) > Number(row.g.away_score));
            const cand = { odds, modelProb, edge, ev, hit };
            for (const [gateName, gate] of Object.entries(GATES)) {
              if (passGate(cand, gate)) bags[gateName].push(cand);
            }
          }
        }

        const row = {
          featName,
          shrink,
          temp,
          soft: summarize(bags.soft),
          mid: summarize(bags.mid),
          tight: summarize(bags.tight),
          direction: summarize(bags.direction),
        };
        variants.push(row);
      }
    }
  }

  function pickBest(gateKey, minBets = 25) {
    let best = null;
    for (const v of variants) {
      const s = v[gateKey];
      if (!s.bets || s.bets < minBets) continue;
      if (!best || (s.roi ?? -99) > (best.roi ?? -99)) {
        best = {
          featName: v.featName,
          shrink: v.shrink,
          temp: v.temp,
          gate: gateKey,
          ...s,
        };
      }
    }
    return best;
  }

  // 穩健分：soft+mid 平均 ROI，且 soft bets>=30
  let robust = null;
  for (const v of variants) {
    if (!v.soft.bets || v.soft.bets < 30) continue;
    if (!v.mid.bets || v.mid.bets < 20) continue;
    const score = ((v.soft.roi ?? -1) + (v.mid.roi ?? -1)) / 2;
    if (!robust || score > robust.score) {
      robust = {
        featName: v.featName,
        shrink: v.shrink,
        temp: v.temp,
        score: Number(score.toFixed(4)),
        soft: v.soft,
        mid: v.mid,
        direction: v.direction,
      };
    }
  }

  return {
    league,
    nGames,
    holdMonths,
    bestSoft: pickBest('soft'),
    bestMid: pickBest('mid'),
    bestTight: pickBest('tight', 15),
    robust,
    topSoft: variants
      .map((v) => ({
        featName: v.featName,
        shrink: v.shrink,
        temp: v.temp,
        ...v.soft,
      }))
      .filter((x) => x.bets >= 30)
      .sort((a, b) => (b.roi ?? -9) - (a.roi ?? -9))
      .slice(0, 8),
    topMid: variants
      .map((v) => ({
        featName: v.featName,
        shrink: v.shrink,
        temp: v.temp,
        ...v.mid,
      }))
      .filter((x) => x.bets >= 25)
      .sort((a, b) => (b.roi ?? -9) - (a.roi ?? -9))
      .slice(0, 8),
  };
}

console.log('calibrate NPB…');
const NPB = runLeague('NPB');
console.log('calibrate KBO…');
const KBO = runLeague('KBO');

const out = {
  experimentId: 'asian_logistic_calibrate_v1',
  researchOnly: true,
  wiredToFormal: false,
  grid: { SHRINKS, TEMPS, FEATURE_SETS: Object.keys(FEATURE_SETS), GATES },
  NPB,
  KBO,
};

fs.writeFileSync('tmp-asian-logistic-calibrate.json', JSON.stringify(out, null, 2));
console.log(
  JSON.stringify(
    {
      NPB: {
        robust: NPB.robust,
        bestSoft: NPB.bestSoft,
        bestMid: NPB.bestMid,
        topSoft: NPB.topSoft.slice(0, 3),
        topMid: NPB.topMid.slice(0, 3),
      },
      KBO: {
        robust: KBO.robust,
        bestSoft: KBO.bestSoft,
        bestMid: KBO.bestMid,
        topSoft: KBO.topSoft.slice(0, 3),
        topMid: KBO.topMid.slice(0, 3),
      },
    },
    null,
    2
  )
);
console.log('wrote tmp-asian-logistic-calibrate.json');
