/**
 * Hybrid Over 第二輪收緊：以 gap≥0.9 為底座再細掃
 * 用法: node scripts/auditMlbTotalsHybridOverTighten2.mjs
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
const REF = { hitRate: 0.5432, roi: 0.0375, usd50: 2017, bets: 1077 }; // gap0.9 current

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
  return mean(
    train
      .filter((g) => parkBucket(g.parkFactor) === 'pitcher')
      .map((g) => g.mu - g.line)
  );
}

function adjOver(g, po, mode) {
  // mode: hybrid (pitcher only), all_shrink, pitcher_only_bets
  if (mode === 'all_shrink') {
    const h = Math.max(0.5, g.homeMu - po / 2);
    const a = Math.max(0.5, g.awayMu - po / 2);
    return { homeMu: h, awayMu: a, mu: h + a, allow: true };
  }
  if (mode === 'pitcher_bets_only') {
    if (parkBucket(g.parkFactor) !== 'pitcher') {
      return { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu, allow: false };
    }
    const h = Math.max(0.5, g.homeMu - po / 2);
    const a = Math.max(0.5, g.awayMu - po / 2);
    return { homeMu: h, awayMu: a, mu: h + a, allow: true };
  }
  // hybrid default
  if (parkBucket(g.parkFactor) === 'pitcher') {
    const h = Math.max(0.5, g.homeMu - po / 2);
    const a = Math.max(0.5, g.awayMu - po / 2);
    return { homeMu: h, awayMu: a, mu: h + a, allow: true };
  }
  return { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu, allow: true };
}

function tryOver(g, adj, gates) {
  if (!adj.allow) return null;
  const gap = adj.mu - g.line;
  if (!(gap > 0)) return null;
  if (Math.abs(gap) < gates.minAbsGap) return null;
  if (g.line > (gates.maxLine ?? BASE.maxTotalLine)) return null;
  if (g.overOdds < (gates.oddsMin ?? BASE.pickOddsMin)) return null;
  if (g.overOdds > (gates.oddsMax ?? BASE.pickOddsMax)) return null;
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
  if (overProb < 0.5) return null;
  if (overProb < gates.minProb) return null;
  const ev = overProb * (g.overOdds - 1) - (1 - overProb);
  const edge = overProb - g.fairOver;
  if (ev < gates.minEv) return null;
  if (edge < gates.minEdge) return null;
  return {
    year: g.year,
    pickOdds: g.overOdds,
    hit: g.actualSide === 'over',
    absGap: Math.abs(gap),
    modelProb: overProb,
    ev,
    edge,
  };
}

const grid = [];
for (const minAbsGap of [0.9, 1.0, 1.1, 1.2, 1.3, 1.5]) {
  for (const minEv of [0.03, 0.04, 0.05]) {
    for (const minProb of [0.52, 0.54, 0.56]) {
      for (const mode of ['hybrid', 'pitcher_bets_only']) {
        // keep edge fixed 0.03 unless noted
        grid.push({
          id: `${mode}_g${minAbsGap}_ev${minEv}_p${minProb}`,
          mode,
          minAbsGap,
          minEv,
          minEdge: 0.03,
          minProb,
          maxLine: 10,
          oddsMin: 1.5,
          oddsMax: 2.4,
        });
      }
    }
  }
}
// extras: tighter odds band on gap0.9 / gap1.1
for (const minAbsGap of [0.9, 1.1]) {
  for (const oddsMax of [2.2, 2.1]) {
    grid.push({
      id: `hybrid_g${minAbsGap}_oddsMax${oddsMax}`,
      mode: 'hybrid',
      minAbsGap,
      minEv: 0.03,
      minEdge: 0.03,
      minProb: 0.52,
      maxLine: 10,
      oddsMin: 1.5,
      oddsMax,
    });
  }
}
for (const maxLine of [9.5, 9]) {
  grid.push({
    id: `hybrid_g0.9_maxLine${maxLine}`,
    mode: 'hybrid',
    minAbsGap: 0.9,
    minEv: 0.03,
    minEdge: 0.03,
    minProb: 0.52,
    maxLine,
    oddsMin: 1.5,
    oddsMax: 2.4,
  });
}

console.log('grid', grid.length);
const board = [];

for (const gates of grid) {
  const all = [];
  const per = {};
  for (const hold of ['2024', '2025', '2026']) {
    const train = games.filter((g) => g.year !== hold);
    const test = games.filter((g) => g.year === hold);
    const po = pitcherOff(train);
    const yo = [];
    for (const g of test) {
      const adj = adjOver(g, po, gates.mode);
      const p = tryOver(g, adj, gates);
      if (p) {
        yo.push(p);
        all.push(p);
      }
    }
    per[hold] = summarize(yo);
  }
  const over = summarize(all);
  const threePos = ['2024', '2025', '2026'].every((y) => (per[y].roi ?? -1) >= 0);
  board.push({
    id: gates.id,
    gates: {
      mode: gates.mode,
      minAbsGap: gates.minAbsGap,
      minEv: gates.minEv,
      minProb: gates.minProb,
      maxLine: gates.maxLine,
      oddsMax: gates.oddsMax,
    },
    over: { ...over, byYear: per },
    threePos,
    deltaHitRatePp: over.hitRate != null
      ? Number(((over.hitRate - REF.hitRate) * 100).toFixed(2))
      : null,
    deltaRoiPp: over.roi != null
      ? Number(((over.roi - REF.roi) * 100).toFixed(2))
      : null,
    deltaUsd: over.usd50 - REF.usd50,
  });
}

const pass = board.filter(
  (b) =>
    b.threePos &&
    b.over.bets >= 120 &&
    (b.over.hitRate ?? 0) >= REF.hitRate - 0.001 &&
    (b.over.roi ?? -1) >= REF.roi - 0.002
);
pass.sort(
  (a, b) =>
    (b.over.hitRate || 0) - (a.over.hitRate || 0) ||
    (b.over.roi || 0) - (a.over.roi || 0)
);

const improveBoth = board.filter(
  (b) =>
    b.threePos &&
    b.over.bets >= 120 &&
    (b.over.hitRate ?? 0) > REF.hitRate + 0.002 &&
    (b.over.roi ?? -1) >= REF.roi - 0.002
);
improveBoth.sort(
  (a, b) =>
    (b.over.hitRate || 0) - (a.over.hitRate || 0) ||
    (b.deltaUsd || 0) - (a.deltaUsd || 0)
);

const topHr = [...board]
  .filter((b) => b.threePos && b.over.bets >= 100)
  .sort((a, b) => (b.over.hitRate || 0) - (a.over.hitRate || 0))
  .slice(0, 8);

const topRoi = [...board]
  .filter((b) => b.threePos && b.over.bets >= 100)
  .sort((a, b) => (b.over.roi || 0) - (a.over.roi || 0))
  .slice(0, 8);

const out = {
  experimentId: 'hybrid_over_tighten_r2',
  referenceGap09: REF,
  improveVsGap09: improveBoth.slice(0, 8),
  passNearGap09: pass.slice(0, 8),
  topHrThreePos: topHr,
  topRoiThreePos: topRoi,
  verdict: improveBoth[0]
    ? {
        recommend: improveBoth[0].id,
        gates: improveBoth[0].gates,
        over: improveBoth[0].over,
        plain: `相對 gap0.9 仍可再收：${improveBoth[0].id} → 勝率 ${(improveBoth[0].over.hitRate * 100).toFixed(1)}%（Δ${improveBoth[0].deltaHitRatePp}pp）、ROI ${(improveBoth[0].over.roi * 100).toFixed(2)}%、n=${improveBoth[0].over.bets}、Δ$=${improveBoth[0].deltaUsd}`,
      }
    : {
        recommend: null,
        plain:
          '相對現況 gap≥0.9：再收（抬 gap/EV/prob、只打投手公園、縮賠率帶／盤口）無穩定同時抬勝率且不傷 ROI 的方案。停在 0.9。',
      },
};

fs.writeFileSync(
  new URL('../tmp-totals-hybrid-over-tighten2.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify({
  verdict: out.verdict,
  improve: out.improveVsGap09.slice(0, 5),
  topHr: out.topHrThreePos.slice(0, 5).map((b) => ({
    id: b.id,
    hr: b.over.hitRate,
    roi: b.over.roi,
    n: b.over.bets,
    usd: b.over.usd50,
    dHr: b.deltaHitRatePp,
    dRoi: b.deltaRoiPp,
    dUsd: b.deltaUsd,
  })),
  topRoi: out.topRoiThreePos.slice(0, 5).map((b) => ({
    id: b.id,
    hr: b.over.hitRate,
    roi: b.over.roi,
    n: b.over.bets,
    usd: b.over.usd50,
    dHr: b.deltaHitRatePp,
    dRoi: b.deltaRoiPp,
    dUsd: b.deltaUsd,
  })),
}, null, 2));
console.log('wrote tmp-totals-hybrid-over-tighten2.json');
