/**
 * 亞聯研究多頭 OOS + 先發滾動特徵（不進正式推薦）
 * 用法: node scripts/auditAsianExpectedRunsLiteOos.mjs
 * 產物: tmp-asian-er-lite-oos.json
 */
import fs from 'fs';
import { createWalkForwardElo, eloHomeWinProb } from '../src/services/BaseballElo.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import { loadAsianCompletedGames } from '../src/services/AsianOpeningFoundation.js';
import {
  appendPitcherHistory,
  loadAsianStarterSnapshotMap,
  summarizePitcherHistory,
} from '../src/services/AsianStarterSnapshots.js';
import {
  exampleFromGameSide,
  matchupVectorFromHomeFeatures,
  poissonHomeWinProb,
  predictLogisticHomeWin,
  projectEloLambdaRuns,
  trainAsianLogisticHomeWin,
  trainAsianRunsLinear,
} from '../src/services/AsianExpectedRunsLite.js';

const STAKE = 50;
const HEADS = [
  'ridge_poisson',
  'logistic_h2h',
  'elo_h2h',
  'elo_lambda_poisson',
  'market_fav',
];

const GATE_PRESETS = {
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
      best = {
        homeOdds,
        awayOdds,
        fairHome: fair.fairA,
        fairAway: fair.fairB,
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
  let decided = 0;
  for (const b of bets) {
    if (b.push) continue;
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

function predictSideFromVec(model, x) {
  if (!model?.ok) return 4.2;
  let y = model.intercept;
  for (let i = 0; i < model.featureKeys.length; i += 1) {
    const k = model.featureKeys[i];
    const z = (Number(x[i]) - model.means[i]) / model.scales[i];
    y += (model.weights[k] || 0) * z;
  }
  return Math.max(1.5, Math.min(9.5, y));
}

function headProbs(head, row, ridgeModel, logModel) {
  if (head === 'market_fav') {
    return { homeWinProb: row.mkt.fairHome, awayWinProb: row.mkt.fairAway };
  }
  if (head === 'elo_h2h') {
    const p = eloHomeWinProb(row.homeFeats.elo, row.awayFeats.elo);
    return { homeWinProb: p, awayWinProb: 1 - p };
  }
  if (head === 'elo_lambda_poisson') {
    return projectEloLambdaRuns(row.homeFeats, row.awayFeats, row.g.league);
  }
  if (head === 'logistic_h2h') {
    const p = predictLogisticHomeWin(logModel, row.homeFeats);
    return { homeWinProb: p, awayWinProb: 1 - p };
  }
  const homeMu = predictSideFromVec(ridgeModel, row.homeEx.x);
  const awayMu = predictSideFromVec(ridgeModel, row.awayEx.x);
  return poissonHomeWinProb(homeMu, awayMu);
}

function runLeague(league) {
  const games = loadAsianCompletedGames(league).filter(
    (g) => Number(g.home_score) !== Number(g.away_score)
  );
  const months = [...new Set(games.map((g) => String(g.commence_time).slice(0, 7)))].sort();
  const warmupMonths = new Set(months.slice(0, 2));
  const starterMap = loadAsianStarterSnapshotMap(league);

  const labeled = [];
  const priorIndex = new Map();
  const pitcherHist = new Map();
  const elo = createWalkForwardElo(league, { seedFromRating: false });
  let starterCoverage = 0;

  for (const g of games) {
    const snap = starterMap.get(g.id) || null;
    if (snap?.home || snap?.away) starterCoverage += 1;
    const homeKey = snap?.home?.key || null;
    const awayKey = snap?.away?.key || null;
    const homePitcherHist = summarizePitcherHistory(
      pitcherHist.get(homeKey),
      g.commence_time
    );
    const awayPitcherHist = summarizePitcherHistory(
      pitcherHist.get(awayKey),
      g.commence_time
    );

    const opts = {
      priorIndex,
      eloLookup: (team) => elo.get(team),
      homePitcherHist,
      awayPitcherHist,
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
      ready: homeEx.ready,
      homeEx,
      awayEx,
      homeFeats: homeEx.features,
      awayFeats: awayEx.features,
      mkt: bestH2h(books, g.home_team, g.away_team),
      hasStarter: Boolean(homeKey || awayKey),
    });

    for (const team of [g.home_team, g.away_team]) {
      if (!priorIndex.has(team)) priorIndex.set(team, []);
      priorIndex.get(team).push(g);
    }
    elo.applyGame(g.home_team, g.away_team, g.home_score, g.away_score);
    // 先發「被打分數」= 對手得分（粗 PIT proxy）
    appendPitcherHistory(pitcherHist, homeKey, g.commence_time, g.away_score);
    appendPitcherHistory(pitcherHist, awayKey, g.commence_time, g.home_score);
  }

  const holdMonths = months.filter((m) => !warmupMonths.has(m));
  const results = {};
  for (const head of HEADS) {
    results[head] = {};
    for (const gateName of Object.keys(GATE_PRESETS)) {
      results[head][gateName] = { bets: [], folds: [] };
    }
  }

  for (const hold of holdMonths) {
    const trainSide = [];
    const trainMatch = [];
    for (const row of labeled) {
      if (row.month >= hold || !row.ready) continue;
      trainSide.push(row.homeEx, row.awayEx);
      trainMatch.push({
        x: matchupVectorFromHomeFeatures(row.homeFeats),
        y: Number(row.g.home_score) > Number(row.g.away_score) ? 1 : 0,
      });
    }
    const ridgeModel = trainAsianRunsLinear(trainSide, { ridge: 0.05 });
    const logModel = trainAsianLogisticHomeWin(trainMatch, { ridge: 0.05 });

    const foldBags = {};
    for (const head of HEADS) {
      foldBags[head] = {};
      for (const gateName of Object.keys(GATE_PRESETS)) foldBags[head][gateName] = [];
    }

    for (const row of labeled) {
      if (row.month !== hold || !row.ready || !row.mkt) continue;
      const actualHomeWin =
        Number(row.g.home_score) > Number(row.g.away_score);

      for (const head of HEADS) {
        if (head === 'ridge_poisson' && !ridgeModel.ok) continue;
        if (head === 'logistic_h2h' && !logModel.ok) continue;
        const win = headProbs(head, row, ridgeModel, logModel);
        const pickHome = win.homeWinProb >= win.awayWinProb;
        const modelProb = pickHome ? win.homeWinProb : win.awayWinProb;
        const odds = pickHome ? row.mkt.homeOdds : row.mkt.awayOdds;
        const fair = pickHome ? row.mkt.fairHome : row.mkt.fairAway;
        const edge = modelProb - fair;
        const ev = modelProb * (odds - 1) - (1 - modelProb);
        const hit = pickHome ? actualHomeWin : !actualHomeWin;
        const cand = {
          hold,
          head,
          pickHome,
          odds,
          modelProb,
          edge,
          ev,
          hit,
          push: false,
          hasStarter: row.hasStarter,
        };
        for (const [gateName, gate] of Object.entries(GATE_PRESETS)) {
          if (!passGate(cand, gate)) continue;
          results[head][gateName].bets.push(cand);
          foldBags[head][gateName].push(cand);
        }
      }
    }

    for (const head of HEADS) {
      for (const gateName of Object.keys(GATE_PRESETS)) {
        results[head][gateName].folds.push({
          hold,
          trainSideN: trainSide.length,
          trainMatchN: trainMatch.length,
          ...summarize(foldBags[head][gateName]),
        });
      }
    }
  }

  const summary = {};
  for (const head of HEADS) {
    summary[head] = {};
    for (const gateName of Object.keys(GATE_PRESETS)) {
      summary[head][gateName] = {
        overall: summarize(results[head][gateName].bets),
        folds: results[head][gateName].folds,
      };
    }
  }

  let best = null;
  for (const head of HEADS) {
    for (const gateName of ['soft', 'mid']) {
      const s = summary[head][gateName].overall;
      if (!s.bets || s.bets < 20) continue;
      if (!best || (s.roi ?? -99) > (best.roi ?? -99)) {
        best = { head, gateName, ...s };
      }
    }
  }

  return {
    league,
    nGames: games.length,
    starterCoverage,
    starterCoverageRate: games.length
      ? Number((starterCoverage / games.length).toFixed(4))
      : 0,
    months,
    warmupMonths: [...warmupMonths],
    heads: summary,
    bestSoftMid: best,
  };
}

console.log('NPB…');
const npb = runLeague('NPB');
console.log('KBO…');
const kbo = runLeague('KBO');

const out = {
  experimentId: 'asian_research_multihead_oos_v3_pitchers',
  researchOnly: true,
  isolation: {
    usesMlbExpectedRunsWeights: false,
    usesLockedBConstants: false,
    wiredToFormalRecommendations: false,
  },
  NPB: npb,
  KBO: kbo,
};

fs.writeFileSync('tmp-asian-er-lite-oos.json', JSON.stringify(out, null, 2));

function compact(leagueRes) {
  const c = {};
  for (const [head, gates] of Object.entries(leagueRes.heads)) {
    c[head] = {
      direction: gates.direction.overall,
      soft: gates.soft.overall,
      mid: gates.mid.overall,
    };
  }
  return {
    starterCoverageRate: leagueRes.starterCoverageRate,
    best: leagueRes.bestSoftMid,
    heads: c,
  };
}

console.log(JSON.stringify({ NPB: compact(npb), KBO: compact(kbo) }, null, 2));
console.log('wrote tmp-asian-er-lite-oos.json');
