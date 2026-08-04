/**
 * 公園條件校準 OOS（第一刀延伸）
 * 用法: node scripts/auditMlbTotalsCalibParkOos.mjs
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
import { MLB_TOTALS_SATELLITE_SPEC } from '../src/services/MlbTotalsSatellite.js';

const R = MLB_TOTALS_SATELLITE_SPEC.rules;
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
      if (overOdds < R.pickOddsMin || underOdds < R.pickOddsMin) continue;
      if (overOdds > R.pickOddsMax || underOdds > R.pickOddsMax) continue;
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
  if (!bets.length) return { bets: 0, hitRate: null, roi: null, usd50: 0 };
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
  if (pf < 0.97) return 'pitcher';
  if (pf > 1.03) return 'hitter';
  return 'mid';
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

function trainStats(train) {
  const by = { pitcher: [], mid: [], hitter: [], all: [] };
  for (const g of train) {
    const d = g.mu - g.line;
    by.all.push(d);
    by[parkBucket(g.parkFactor)].push(d);
  }
  return {
    pitcher: mean(by.pitcher),
    mid: mean(by.mid),
    hitter: mean(by.hitter),
    all: mean(by.all),
  };
}

function adjMeans(g, mode, st) {
  let off = 0;
  const b = parkBucket(g.parkFactor);
  if (mode === 'pitcher_only') off = b === 'pitcher' ? -st.pitcher : 0;
  if (mode === 'pitcher_mid') off = b === 'hitter' ? 0 : -st[b];
  if (mode === 'all_line') off = -st.all;
  const h = Math.max(0.5, g.homeMu + off / 2);
  const a = Math.max(0.5, g.awayMu + off / 2);
  return { homeMu: h, awayMu: a, mu: h + a };
}

function tryPick(g, adj, overMinGap, underMinGap) {
  const gap = adj.mu - g.line;
  const side = gap > 0 ? 'over' : gap < 0 ? 'under' : null;
  if (!side) return null;
  const minGap = side === 'over' ? overMinGap : underMinGap;
  if (Math.abs(gap) < minGap) return null;
  if (g.line > R.maxTotalLine) return null;
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
  if (modelProb < 0.5 || modelProb < R.minimumModelProbability) return null;
  const pickOdds = side === 'over' ? g.overOdds : g.underOdds;
  const fair = side === 'over' ? g.fairOver : g.fairUnder;
  const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
  const edge = modelProb - fair;
  if (ev < R.minimumExpectedValue || edge < R.minEdgeVsMarket) return null;
  return {
    year: g.year,
    side,
    pickOdds,
    hit: side === g.actualSide,
  };
}

const modes = ['raw', 'pitcher_only', 'pitcher_mid', 'all_line'];
const out = [];

for (const mode of modes) {
  for (const [og, ug] of [
    [0.6, 0.6],
    [1.5, 0.6],
  ]) {
    const all = [];
    const per2 = {};
    for (const hold of ['2024', '2025', '2026']) {
      const train = games.filter((g) => g.year !== hold);
      const test = games.filter((g) => g.year === hold);
      const st = trainStats(train);
      const yp = [];
      let leanO = 0;
      for (const g of test) {
        const adj =
          mode === 'raw'
            ? { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu }
            : adjMeans(g, mode, st);
        if (adj.mu > g.line) leanO += 1;
        const p = tryPick(g, adj, og, ug);
        if (p) {
          yp.push(p);
          all.push(p);
        }
      }
      per2[hold] = {
        leanOverShare: Number((leanO / test.length).toFixed(4)),
        under: summarize(yp.filter((p) => p.side === 'under')),
        over: summarize(yp.filter((p) => p.side === 'over')),
      };
    }
    const under = summarize(all.filter((p) => p.side === 'under'));
    const over = summarize(all.filter((p) => p.side === 'over'));
    out.push({
      id: `${mode}__over${og}_under${ug}`,
      under: { ...under, byYear: byYear(all.filter((p) => p.side === 'under')) },
      over: { ...over, byYear: byYear(all.filter((p) => p.side === 'over')) },
      threePosUnder: ['2024', '2025', '2026'].every(
        (y) => (per2[y].under.roi ?? -1) >= 0
      ),
      threePosOver: ['2024', '2025', '2026'].every(
        (y) => (per2[y].over.roi ?? -1) >= 0
      ),
      perYear: per2,
    });
  }
}

out.sort(
  (a, b) =>
    b.under.usd50 + b.over.usd50 - (a.under.usd50 + a.over.usd50)
);

const summary = out.map((r) => ({
  id: r.id,
  under: r.under,
  over: r.over,
  threePosUnder: r.threePosUnder,
  threePosOver: r.threePosOver,
  y26u: r.perYear['2026'].under,
  lean26: r.perYear['2026'].leanOverShare,
}));

fs.writeFileSync(
  new URL('../tmp-totals-calib-park-oos.json', import.meta.url),
  JSON.stringify({ summary, out }, null, 2)
);
console.log(JSON.stringify(summary, null, 2));
console.log('wrote tmp-totals-calib-park-oos.json');
