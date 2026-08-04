/**
 * Hybrid Over 收緊掃描：Under 固定 raw；只抬大分閘門
 * 用法: node scripts/auditMlbTotalsHybridOverTighten.mjs
 * 產物: tmp-totals-hybrid-over-tighten.json
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
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function bestTotals(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
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
      if (!best || vig < best.vig) {
        const fair = removeVig(
          decimalToImpliedProb(overOdds),
          decimalToImpliedProb(underOdds)
        );
        best = {
          line: Number(over.point),
          overOdds,
          underOdds,
          fairOver: fair.fairA,
          fairUnder: fair.fairB,
        };
      }
    }
  }
  return best;
}

function mean(a) {
  return a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
}

function summarize(bets) {
  if (!bets.length) return { bets: 0, hits: 0, hitRate: null, roi: null, usd50: 0 };
  let unit = 0;
  let hits = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  return {
    bets: bets.length,
    hits,
    hitRate: Number((hits / bets.length).toFixed(4)),
    roi: Number((unit / bets.length).toFixed(4)),
    usd50: Math.round(unit * STAKE),
  };
}

function byYear(bets) {
  const o = {};
  for (const y of ['2024', '2025', '2026']) {
    o[y] = summarize(bets.filter((b) => b.year === y));
  }
  return o;
}

function parkBucket(pf) {
  return Number(pf) < (HYBRID.pitcherParkFactorMax || 0.97) ? 'pitcher' : 'other';
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
    const market = bestTotals(row.gameId, row.commenceTime);
    if (!market || actualTotal === market.line) continue;
    const pred = predictMlbGameRuns(model, features, { totalLine: market.line });
    games.push({
      year: w.key,
      line: market.line,
      homeMu: Number(pred.homeExpectedRuns),
      awayMu: Number(pred.awayExpectedRuns),
      mu: Number(pred.expectedTotal),
      overOdds: market.overOdds,
      underOdds: market.underOdds,
      fairOver: market.fairOver,
      fairUnder: market.fairUnder,
      actualSide: actualTotal > market.line ? 'over' : 'under',
      parkFactor: Number(features.parkFactor) || 1,
    });
  }
}
console.log('games', games.length);

function pitcherOff(train) {
  const xs = train
    .filter((g) => parkBucket(g.parkFactor) === 'pitcher')
    .map((g) => g.mu - g.line);
  return mean(xs);
}

function adjOver(g, po) {
  if (parkBucket(g.parkFactor) !== 'pitcher') {
    return { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu };
  }
  const h = Math.max(0.5, g.homeMu - po / 2);
  const a = Math.max(0.5, g.awayMu - po / 2);
  return { homeMu: h, awayMu: a, mu: h + a };
}

function trySide(g, adj, sideWanted, gates) {
  const gap = adj.mu - g.line;
  const side = gap > 0 ? 'over' : gap < 0 ? 'under' : null;
  if (side !== sideWanted) return null;
  if (Math.abs(gap) < gates.minAbsGap) return null;
  if (g.line > BASE.maxTotalLine) return null;
  const dist = buildMlbScoreDistribution({
    homeMean: adj.homeMu,
    awayMean: adj.awayMu,
    homeDispersion: dispersion,
    awayDispersion: dispersion,
  });
  const mk = deriveMlbScoreMarkets(dist, { totalLine: g.line });
  const pushP = Number(mk.total?.pushProbability) || 0;
  const overProb =
    Number(mk.total.overProbability) / Math.max(1e-9, 1 - pushP);
  const underProb =
    Number(mk.total.underProbability) / Math.max(1e-9, 1 - pushP);
  const modelProb = side === 'over' ? overProb : underProb;
  if (modelProb < 0.5) return null;
  if (modelProb < gates.minProb) return null;
  const pickOdds = side === 'over' ? g.overOdds : g.underOdds;
  const fair = side === 'over' ? g.fairOver : g.fairUnder;
  const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
  const edge = modelProb - fair;
  if (ev < gates.minEv) return null;
  if (edge < gates.minEdge) return null;
  if (pickOdds < BASE.pickOddsMin || pickOdds > BASE.pickOddsMax) return null;
  return {
    year: g.year,
    side,
    pickOdds,
    hit: side === g.actualSide,
    absGap: Math.abs(gap),
    modelProb,
    ev,
    edge,
  };
}

const underGates = {
  minAbsGap: BASE.minAbsGap,
  minEv: BASE.minimumExpectedValue,
  minEdge: BASE.minEdgeVsMarket,
  minProb: BASE.minimumModelProbability,
};

const overGrid = [];
for (const minAbsGap of [0.6, 0.9, 1.2, 1.5, 1.8]) {
  for (const minEv of [0.03, 0.05, 0.07]) {
    for (const minEdge of [0.03, 0.05]) {
      for (const minProb of [0.52, 0.55, 0.58]) {
        // skip useless combos that are looser than needed volume — still run all, filter later
        overGrid.push({
          id: `g${minAbsGap}_ev${minEv}_ed${minEdge}_p${minProb}`,
          minAbsGap,
          minEv,
          minEdge,
          minProb,
        });
      }
    }
  }
}

console.log('OOS grid', overGrid.length);
const board = [];

for (const gates of overGrid) {
  const allUnder = [];
  const allOver = [];
  const per = {};
  for (const hold of ['2024', '2025', '2026']) {
    const train = games.filter((g) => g.year !== hold);
    const test = games.filter((g) => g.year === hold);
    const po = pitcherOff(train);
    const yu = [];
    const yo = [];
    for (const g of test) {
      const raw = { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu };
      const u = trySide(g, raw, 'under', underGates);
      if (u) {
        yu.push(u);
        allUnder.push(u);
      }
      const o = trySide(g, adjOver(g, po), 'over', gates);
      if (o) {
        yo.push(o);
        allOver.push(o);
      }
    }
    per[hold] = { under: summarize(yu), over: summarize(yo) };
  }
  const under = summarize(allUnder);
  const over = summarize(allOver);
  const threePosOver = ['2024', '2025', '2026'].every(
    (y) => (per[y].over.roi ?? -1) >= 0
  );
  const threePosUnder = ['2024', '2025', '2026'].every(
    (y) => (per[y].under.roi ?? -1) >= 0
  );
  const baseOverRoi = 0.0364;
  const baseOverHr = 0.5415;
  board.push({
    id: gates.id,
    gates: {
      minAbsGap: gates.minAbsGap,
      minEv: gates.minEv,
      minEdge: gates.minEdge,
      minProb: gates.minProb,
    },
    under: { ...under, byYear: byYear(allUnder) },
    over: { ...over, byYear: byYear(allOver) },
    threePosOver,
    threePosUnder,
    deltaHitRatePp:
      over.hitRate != null
        ? Number(((over.hitRate - baseOverHr) * 100).toFixed(2))
        : null,
    deltaRoiPp:
      over.roi != null ? Number(((over.roi - baseOverRoi) * 100).toFixed(2)) : null,
    deltaUsd: over.usd50 - 2062,
    // prefer: threePos, higher HR, not collapse volume, ROI not worse
    score:
      (threePosOver ? 2000 : 0) +
      (over.bets >= 200 ? 300 : over.bets >= 100 ? 150 : 0) +
      Math.round((over.hitRate || 0) * 1000) +
      Math.round((over.roi || 0) * 5000) +
      Math.round((over.usd50 || 0) / 20),
  });
}

board.sort((a, b) => b.score - a.score);

const baseline = board.find((b) => b.id === 'g0.6_ev0.03_ed0.03_p0.52');
const passers = board.filter(
  (b) =>
    b.threePosOver &&
    b.over.bets >= 150 &&
    (b.over.hitRate ?? 0) >= (baseline?.over.hitRate ?? 0) &&
    (b.over.roi ?? -1) >= (baseline?.over.roi ?? 0) - 0.005
);
passers.sort(
  (a, b) =>
    (b.over.hitRate || 0) - (a.over.hitRate || 0) ||
    (b.over.roi || 0) - (a.over.roi || 0)
);

const bestHr = [...board]
  .filter((b) => b.threePosOver && b.over.bets >= 100)
  .sort(
    (a, b) =>
      (b.over.hitRate || 0) - (a.over.hitRate || 0) ||
      (b.over.usd50 || 0) - (a.over.usd50 || 0)
  )
  .slice(0, 10);

const bestRoi = [...board]
  .filter((b) => b.threePosOver && b.over.bets >= 100)
  .sort(
    (a, b) =>
      (b.over.roi || 0) - (a.over.roi || 0) ||
      (b.over.usd50 || 0) - (a.over.usd50 || 0)
  )
  .slice(0, 10);

const bestUsd = [...board]
  .filter((b) => b.threePosOver && b.over.bets >= 100)
  .sort((a, b) => (b.over.usd50 || 0) - (a.over.usd50 || 0))
  .slice(0, 10);

const out = {
  experimentId: 'hybrid_over_tighten',
  nGames: games.length,
  baselineOver: baseline?.over || null,
  baselineUnder: baseline?.under || null,
  topByScore: board.slice(0, 12).map(slim),
  bestHitRateAmongThreePos: bestHr.map(slim),
  bestRoiAmongThreePos: bestRoi.map(slim),
  bestUsdAmongThreePos: bestUsd.map(slim),
  passImproveHrAndNotLoseRoi: passers.slice(0, 10).map(slim),
  verdict: null,
};

function slim(b) {
  return {
    id: b.id,
    gates: b.gates,
    over: b.over,
    threePosOver: b.threePosOver,
    deltaHitRatePp: b.deltaHitRatePp,
    deltaRoiPp: b.deltaRoiPp,
    deltaUsd: b.deltaUsd,
  };
}

const rec =
  passers[0] ||
  bestHr.find((b) => (b.over.roi ?? -1) >= (baseline?.over.roi ?? 0)) ||
  null;

out.verdict = {
  recommend: rec?.id || null,
  recommendGates: rec?.gates || null,
  plain: rec
    ? `可收緊 Over → ${rec.id}：勝率 ${(rec.over.hitRate * 100).toFixed(1)}%（Δ ${rec.deltaHitRatePp}pp）、ROI ${(rec.over.roi * 100).toFixed(2)}%、n=${rec.over.bets}、三窗=${rec.threePosOver}。Under 不變。`
    : '抬門檻後無穩定同時提升勝率且不傷 ROI／三窗的方案；維持現狀 g0.6/ev3%/edge3%/p52。',
};

fs.writeFileSync(
  new URL('../tmp-totals-hybrid-over-tighten.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify({
  baselineOver: out.baselineOver,
  recommend: out.verdict,
  topHr: out.bestHitRateAmongThreePos.slice(0, 5),
  topRoi: out.bestRoiAmongThreePos.slice(0, 5),
  passers: out.passImproveHrAndNotLoseRoi.slice(0, 5),
}, null, 2));
console.log('wrote tmp-totals-hybrid-over-tighten.json');
