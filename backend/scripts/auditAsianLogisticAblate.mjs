/**
 * 亞聯研究：logistic 特徵消融 + shrink-to-market（不進正式）
 * 用法: node scripts/auditAsianLogisticAblate.mjs
 * 產物: tmp-asian-logistic-ablate.json
 */
import fs from 'fs';
import { createWalkForwardElo } from '../src/services/BaseballElo.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import { loadAsianCompletedGames } from '../src/services/AsianOpeningFoundation.js';
import {
  ASIAN_MATCHUP_FEATURE_KEYS,
  exampleFromGameSide,
  matchupVectorFromHomeFeatures,
} from '../src/services/AsianExpectedRunsLite.js';

const STAKE = 50;
const GATE = { minOdds: 1.7, maxOdds: 2.3, minProb: 0.52, minEdge: 0.02, minEv: 0.02 };

const ABLATIONS = {
  full: [...ASIAN_MATCHUP_FEATURE_KEYS],
  elo_only: ['eloDiff', 'eloStrength'],
  form_only: [
    'pythWinPct',
    'opponentPythWinPct',
    'seasonWinPct',
    'opponentSeasonWinPct',
    'runDiffPerGame',
    'opponentRunDiffPerGame',
    'last10WinPct',
    'opponentLast10WinPct',
  ],
  no_accel: ASIAN_MATCHUP_FEATURE_KEYS.filter(
    (k) => !['formWinAccel', 'rpgAccel', 'restDiff'].includes(k)
  ),
  elo_pyth: [
    'eloDiff',
    'eloStrength',
    'pythWinPct',
    'opponentPythWinPct',
    'runDiffPerGame',
    'opponentRunDiffPerGame',
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

function trainOnKeys(examples, keys) {
  const mapped = examples.map((e) => ({
    x: keys.map((k) => {
      const i = ASIAN_MATCHUP_FEATURE_KEYS.indexOf(k);
      return e.xFull[i];
    }),
    y: e.y,
  }));
  // monkey: temporarily train with custom keys via patching vector size
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

function predictKeys(model, homeFeats) {
  if (!model?.ok) return 0.5;
  let z = model.intercept;
  for (let i = 0; i < model.keys.length; i += 1) {
    const k = model.keys[i];
    const v = Number(homeFeats[k]) || 0;
    z += (model.weights[k] || 0) * ((v - model.means[i]) / model.scales[i]);
  }
  return Math.max(0.05, Math.min(0.95, 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))))));
}

function runLeague(league) {
  const games = loadAsianCompletedGames(league).filter(
    (g) => Number(g.home_score) !== Number(g.away_score)
  );
  const months = [...new Set(games.map((g) => String(g.commence_time).slice(0, 7)))].sort();
  const warmup = new Set(months.slice(0, 2));
  const labeled = [];
  const priorIndex = new Map();
  const elo = createWalkForwardElo(league, { seedFromRating: false });

  for (const g of games) {
    const opts = { priorIndex, eloLookup: (t) => elo.get(t) };
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
  }

  const holdMonths = months.filter((m) => !warmup.has(m));
  const out = {};

  for (const [ablName, keys] of Object.entries(ABLATIONS)) {
    for (const shrink of [0, 0.35, 0.5]) {
      const tag = `${ablName}_shrink${shrink}`;
      const bets = [];
      const dir = [];
      for (const hold of holdMonths) {
        const train = labeled
          .filter((r) => r.month < hold && r.ready)
          .map((r) => ({ xFull: r.xFull, y: r.y }));
        const model = trainOnKeys(train, keys);
        if (!model.ok) continue;
        for (const row of labeled) {
          if (row.month !== hold || !row.ready || !row.mkt) continue;
          let pHome = predictKeys(model, row.homeFeats);
          if (shrink > 0) {
            pHome = (1 - shrink) * pHome + shrink * row.mkt.fairHome;
          }
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
          dir.push(cand);
          if (
            odds >= GATE.minOdds &&
            odds <= GATE.maxOdds &&
            modelProb >= GATE.minProb &&
            edge >= GATE.minEdge &&
            ev >= GATE.minEv
          ) {
            bets.push(cand);
          }
        }
      }
      out[tag] = { gated: summarize(bets), direction: summarize(dir) };
    }
  }

  let best = null;
  for (const [name, s] of Object.entries(out)) {
    if (!s.gated.bets || s.gated.bets < 20) continue;
    if (!best || (s.gated.roi ?? -99) > (best.roi ?? -99)) {
      best = { name, ...s.gated };
    }
  }
  return { league, best, variants: out };
}

const NPB = runLeague('NPB');
const KBO = runLeague('KBO');
const payload = {
  experimentId: 'asian_logistic_ablate_v1',
  researchOnly: true,
  gate: GATE,
  NPB,
  KBO,
};
fs.writeFileSync('tmp-asian-logistic-ablate.json', JSON.stringify(payload, null, 2));
console.log(
  JSON.stringify(
    {
      NPB_best: NPB.best,
      KBO_best: KBO.best,
      NPB_top: Object.entries(NPB.variants)
        .map(([k, v]) => ({ k, ...v.gated }))
        .filter((x) => x.bets >= 20)
        .sort((a, b) => (b.roi ?? -9) - (a.roi ?? -9))
        .slice(0, 6),
      KBO_top: Object.entries(KBO.variants)
        .map(([k, v]) => ({ k, ...v.gated }))
        .filter((x) => x.bets >= 20)
        .sort((a, b) => (b.roi ?? -9) - (a.roi ?? -9))
        .slice(0, 6),
    },
    null,
    2
  )
);
console.log('wrote tmp-asian-logistic-ablate.json');
