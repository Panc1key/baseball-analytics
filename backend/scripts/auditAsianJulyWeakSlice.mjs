/**
 * 亞聯研究：7 月弱切片診斷（對凍結候選，不進正式）
 * 用法: node scripts/auditAsianJulyWeakSlice.mjs
 * 產物: tmp-asian-july-weak.json
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

const FEATURE_MAP = {
  full: [...ASIAN_MATCHUP_FEATURE_KEYS],
  no_pitcher: [...ASIAN_FEATURE_SET_NO_PITCHER],
  pitcher_core: [...ASIAN_FEATURE_SET_PITCHER_CORE],
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
    z += (model.weights[k] || 0) * (((Number(homeFeats[k]) || 0) - model.means[i]) / model.scales[i]);
  }
  return z;
}

function bucket(v, edges, labels) {
  for (let i = 0; i < edges.length; i += 1) {
    if (v < edges[i]) return labels[i];
  }
  return labels[labels.length - 1];
}

function sliceStats(rows) {
  const out = {};
  for (const r of rows) {
    if (!out[r.key]) out[r.key] = { n: 0, hits: 0, unit: 0 };
    out[r.key].n += 1;
    if (r.hit) {
      out[r.key].hits += 1;
      out[r.key].unit += r.odds - 1;
    } else out[r.key].unit -= 1;
  }
  return Object.fromEntries(
    Object.entries(out)
      .map(([k, s]) => [
        k,
        {
          bets: s.n,
          hitRate: Number((s.hits / s.n).toFixed(4)),
          roi: Number((s.unit / s.n).toFixed(4)),
        },
      ])
      .sort((a, b) => a[1].roi - b[1].roi)
  );
}

function diagnose(league, candName, cand) {
  const keys = FEATURE_MAP[cand.features];
  const gate =
    cand.gate === 'mid'
      ? { minOdds: 1.7, maxOdds: 2.3, minProb: 0.52, minEdge: 0.02, minEv: 0.02 }
      : { minOdds: 1.65, maxOdds: 2.4, minProb: 0.5, minEdge: 0.01, minEv: 0.01 };

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
    });
    for (const team of [g.home_team, g.away_team]) {
      if (!priorIndex.has(team)) priorIndex.set(team, []);
      priorIndex.get(team).push(g);
    }
    elo.applyGame(g.home_team, g.away_team, g.home_score, g.away_score);
    appendPitcherHistory(pitcherHist, homeKey, g.commence_time, g.away_score);
    appendPitcherHistory(pitcherHist, awayKey, g.commence_time, g.home_score);
  }

  const hold = '2026-07';
  const train = labeled
    .filter((r) => r.month < hold && r.ready)
    .map((r) => ({ xFull: r.xFull, y: r.y }));
  const model = trainOnKeys(train, keys);
  const julyAll = [];
  const julyBet = [];

  for (const row of labeled) {
    if (row.month !== hold || !row.ready || !row.mkt || !model.ok) continue;
    const z = predictZ(model, row.homeFeats);
    const pRaw =
      1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
    const pHome = applyAsianLogisticCalibration(z, {
      fromLogit: true,
      shrink: cand.shrink,
      temp: cand.temp,
      fairHome: row.mkt.fairHome,
    });
    const pickHome = pHome >= 0.5;
    const modelProb = pickHome ? pHome : 1 - pHome;
    const odds = pickHome ? row.mkt.homeOdds : row.mkt.awayOdds;
    const fair = pickHome ? row.mkt.fairHome : row.mkt.fairAway;
    const edge = modelProb - fair;
    const ev = modelProb * (odds - 1) - (1 - modelProb);
    const hit = pickHome === (Number(row.g.home_score) > Number(row.g.away_score));
    const absGap = Math.abs(pHome - row.mkt.fairHome);
    const rec = {
      day: String(row.g.commence_time).slice(0, 10),
      pickHome,
      odds,
      modelProb,
      pRaw: pickHome ? pRaw : 1 - pRaw,
      fair,
      edge,
      ev,
      hit,
      absGap,
      side: pickHome ? 'home' : 'away',
      restDiff: row.homeFeats.restDiff,
      pitcherKnown: row.homeFeats.pitcherKnown,
      eloDiff: row.homeFeats.eloDiff,
    };
    julyAll.push(rec);
    if (
      odds >= gate.minOdds &&
      odds <= gate.maxOdds &&
      modelProb >= gate.minProb &&
      edge >= gate.minEdge &&
      ev >= gate.minEv
    ) {
      julyBet.push(rec);
    }
  }

  const toRows = (arr, keyFn) => arr.map((r) => ({ ...r, key: keyFn(r) }));

  return {
    candName,
    cand,
    julyUniverse: julyAll.length,
    julyBets: julyBet.length,
    julyHitRate: julyBet.length
      ? Number((julyBet.filter((b) => b.hit).length / julyBet.length).toFixed(4))
      : null,
    julyRoi: julyBet.length
      ? Number(
          (
            julyBet.reduce((u, b) => u + (b.hit ? b.odds - 1 : -1), 0) / julyBet.length
          ).toFixed(4)
        )
      : null,
    slices: {
      byOdds: sliceStats(
        toRows(julyBet, (r) =>
          bucket(r.odds, [1.8, 1.95, 2.1, 2.25], ['<1.8', '1.8-1.95', '1.95-2.1', '2.1-2.25', '>=2.25'])
        )
      ),
      byEdge: sliceStats(
        toRows(julyBet, (r) =>
          bucket(r.edge, [0.02, 0.04, 0.06, 0.1], ['<0.02', '0.02-0.04', '0.04-0.06', '0.06-0.1', '>=0.1'])
        )
      ),
      bySide: sliceStats(toRows(julyBet, (r) => r.side)),
      byAbsGapToMkt: sliceStats(
        toRows(julyBet, (r) =>
          bucket(r.absGap, [0.02, 0.04, 0.06], ['gap<0.02', '0.02-0.04', '0.04-0.06', 'gap>=0.06'])
        )
      ),
      byRawOverconf: sliceStats(
        toRows(julyBet, (r) =>
          bucket(r.pRaw - r.fair, [0, 0.03, 0.06], ['raw<=mkt', 'raw+0-3', 'raw+3-6', 'raw+>=6'])
        )
      ),
    },
    losses: julyBet
      .filter((b) => !b.hit)
      .sort((a, b) => b.edge - a.edge)
      .slice(0, 12),
  };
}

const out = {
  experimentId: 'asian_july_weak_slice_v1',
  researchOnly: true,
  NPB_primary: diagnose('NPB', 'NPB_primary', ASIAN_RESEARCH_FREEZE.candidates.NPB_primary),
  KBO_noPitcher_safe: diagnose(
    'KBO',
    'KBO_noPitcher_safe',
    ASIAN_RESEARCH_FREEZE.candidates.KBO_noPitcher_safe
  ),
  KBO_primary_pitcher: diagnose(
    'KBO',
    'KBO_primary_pitcher',
    ASIAN_RESEARCH_FREEZE.candidates.KBO_primary_pitcher
  ),
};

fs.writeFileSync('tmp-asian-july-weak.json', JSON.stringify(out, null, 2));
console.log(
  JSON.stringify(
    {
      NPB_primary: {
        julyBets: out.NPB_primary.julyBets,
        julyRoi: out.NPB_primary.julyRoi,
        slices: out.NPB_primary.slices,
      },
      KBO_noPitcher_safe: {
        julyBets: out.KBO_noPitcher_safe.julyBets,
        julyRoi: out.KBO_noPitcher_safe.julyRoi,
        slices: out.KBO_noPitcher_safe.slices,
      },
      KBO_primary_pitcher: {
        julyBets: out.KBO_primary_pitcher.julyBets,
        julyRoi: out.KBO_primary_pitcher.julyRoi,
        slices: out.KBO_primary_pitcher.slices,
      },
    },
    null,
    2
  )
);
console.log('wrote tmp-asian-july-weak.json');
