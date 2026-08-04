/**
 * 雙軌：Under=raw，Over=pitcher_only 去偏；OOS leave-one-year
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

function pitcherOff(train) {
  const xs = train
    .filter((g) => parkBucket(g.parkFactor) === 'pitcher')
    .map((g) => g.mu - g.line);
  return mean(xs);
}

function tryPick(g, adj, sideWanted, minGap) {
  const gap = adj.mu - g.line;
  const side = gap > 0 ? 'over' : gap < 0 ? 'under' : null;
  if (side !== sideWanted) return null;
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

const all = [];
const per = {};
for (const hold of ['2024', '2025', '2026']) {
  const train = games.filter((g) => g.year !== hold);
  const test = games.filter((g) => g.year === hold);
  const po = pitcherOff(train);
  const yp = [];
  for (const g of test) {
    // Under: raw
    const raw = { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu };
    const u = tryPick(g, raw, 'under', 0.6);
    if (u) yp.push(u);
    // Over: pitcher-park shrink only
    let adj = raw;
    if (parkBucket(g.parkFactor) === 'pitcher') {
      const h = Math.max(0.5, g.homeMu - po / 2);
      const a = Math.max(0.5, g.awayMu - po / 2);
      adj = { homeMu: h, awayMu: a, mu: h + a };
    }
    const o = tryPick(g, adj, 'over', 0.6);
    if (o) yp.push(o);
  }
  per[hold] = {
    under: summarize(yp.filter((p) => p.side === 'under')),
    over: summarize(yp.filter((p) => p.side === 'over')),
    both: summarize(yp),
  };
  all.push(...yp);
}

const under = summarize(all.filter((p) => p.side === 'under'));
const over = summarize(all.filter((p) => p.side === 'over'));
const both = summarize(all);
const out = {
  id: 'hybrid_rawUnder_pitcherDebiasOver',
  under: { ...under, byYear: byYear(all.filter((p) => p.side === 'under')) },
  over: { ...over, byYear: byYear(all.filter((p) => p.side === 'over')) },
  both: { ...both, byYear: byYear(all) },
  threePosUnder: ['2024', '2025', '2026'].every(
    (y) => (per[y].under.roi ?? -1) >= 0
  ),
  threePosOver: ['2024', '2025', '2026'].every(
    (y) => (per[y].over.roi ?? -1) >= 0
  ),
  perYear: per,
  note: 'Under 用 raw μ；Over 僅在投手公園扣該窗 train 的 mean(μ−line)',
};

fs.writeFileSync(
  new URL('../tmp-totals-calib-hybrid-oos.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
