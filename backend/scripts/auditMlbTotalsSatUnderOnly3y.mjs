/**
 * 大小分 01b 閘門下：under-only / over-only 三窗（平行影子候選，不改 01b 主規格）。
 * 產物：tmp-totals-sat-under-only-3y.json
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
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { MLB_TOTALS_SATELLITE_SPEC } from '../src/services/MlbTotalsSatellite.js';

const R = MLB_TOTALS_SATELLITE_SPEC.rules;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-28' },
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
        const fair = removeVig(decimalToImpliedProb(overOdds), decimalToImpliedProb(underOdds));
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
    usd50: Math.round(unit * 50),
  };
}

function build(model) {
  const all = [];
  for (const w of WINDOWS) {
    const rows = db
      .prepare(
        `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
                g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS hs, g.away_score AS ascore
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
      const expectedTotal = Number(pred.expectedTotal);
      const pushP = Number(pred.markets?.total?.pushProbability) || 0;
      const overProb =
        Number(pred.markets?.total?.overProbability) / Math.max(1e-9, 1 - pushP);
      const underProb =
        Number(pred.markets?.total?.underProbability) / Math.max(1e-9, 1 - pushP);
      const gap = expectedTotal - market.line;
      const pickOver = gap > 0;
      if (pickOver && overProb < 0.5) continue;
      if (!pickOver && underProb < 0.5) continue;
      const modelProb = pickOver ? overProb : underProb;
      const pickOdds = pickOver ? market.overOdds : market.underOdds;
      const fair = pickOver ? market.fairOver : market.fairUnder;
      const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
      const edge = modelProb - fair;
      if (Math.abs(gap) < R.minAbsGap) continue;
      if (ev < R.minimumExpectedValue) continue;
      if (edge < R.minEdgeVsMarket) continue;
      if (modelProb < R.minimumModelProbability) continue;
      if (market.line > R.maxTotalLine) continue;
      all.push({
        year: w.key,
        side: pickOver ? 'over' : 'under',
        hit: pickOver === actualTotal > market.line,
        pickOdds,
      });
    }
  }
  return all;
}

const latest = getLatestMlbExpectedRunsValidation();
const bets = build(latest.model);
const both = bets;
const under = bets.filter((b) => b.side === 'under');
const over = bets.filter((b) => b.side === 'over');

function byY(list) {
  return {
    2024: summarize(list.filter((b) => b.year === '2024')),
    2025: summarize(list.filter((b) => b.year === '2025')),
    2026: summarize(list.filter((b) => b.year === '2026')),
    merged: summarize(list),
  };
}

const payload = {
  generatedAt: new Date().toISOString(),
  baseRules: R,
  note: '在 01b 閘門內切片；under-only 若三窗皆正可作平行影子，不替換 01b',
  both: byY(both),
  underOnly: byY(under),
  overOnly: byY(over),
};

const u = payload.underOnly;
const underPass =
  (u['2024'].roi ?? -1) > 0 &&
  (u['2025'].roi ?? -1) > 0 &&
  (u['2026'].roi ?? -1) > 0 &&
  u['2024'].bets >= 40 &&
  u['2025'].bets >= 40 &&
  u['2026'].bets >= 25;

payload.verdict = {
  underOnlyThreeWindowPositive: underPass,
  promoteUnderOnlyParallelShadow: underPass && (u.merged.roi ?? 0) >= 0.05,
  note: underPass
    ? 'under-only 三窗皆正；可平行影子觀察（注少），勿替換 01b 主衛星'
    : 'under-only 未達三窗穩定；維持 01b both-sides',
};

fs.writeFileSync(
  new URL('../tmp-totals-sat-under-only-3y.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);
console.log(JSON.stringify(payload, null, 2));
