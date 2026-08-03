/**
 * 新閘門下 under vs over 診斷（不改選注）。
 * 產物：tmp-totals-sat-side-diag.json
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
          vig,
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

function select(pool) {
  return pool.filter((g) => {
    if (g.absGap < R.minAbsGap) return false;
    if (g.ev < R.minimumExpectedValue) return false;
    if (g.edge < R.minEdgeVsMarket) return false;
    if (g.modelProb < R.minimumModelProbability) return false;
    if (g.line > R.maxTotalLine) return false;
    return true;
  });
}

const latest = getLatestMlbExpectedRunsValidation();
const pool = [];
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
    const pred = predictMlbGameRuns(latest.model, features, { totalLine: market.line });
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
    pool.push({
      year: w.key,
      side: pickOver ? 'over' : 'under',
      absGap: Math.abs(gap),
      modelProb,
      pickOdds,
      ev: modelProb * (pickOdds - 1) - (1 - modelProb),
      edge: modelProb - fair,
      line: market.line,
      hit: pickOver === actualTotal > market.line,
    });
  }
}

const bets = select(pool);
const sides = ['over', 'under'];
const years = ['2024', '2025', '2026'];

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'diagnosis_only',
  specId: MLB_TOTALS_SATELLITE_SPEC.id,
  rules: R,
  overall: {
    both: summarize(bets),
    over: summarize(bets.filter((b) => b.side === 'over')),
    under: summarize(bets.filter((b) => b.side === 'under')),
  },
  byYear: Object.fromEntries(
    years.map((y) => {
      const ys = bets.filter((b) => b.year === y);
      return [
        y,
        {
          both: summarize(ys),
          over: summarize(ys.filter((b) => b.side === 'over')),
          under: summarize(ys.filter((b) => b.side === 'under')),
        },
      ];
    })
  ),
  verdict: {
    changeToSideOnly: false,
    note: null,
  },
};

const o = payload.overall.over;
const u = payload.overall.under;
const yearUnderAllPos = years.every((y) => (payload.byYear[y].under.roi ?? -1) >= 0);
const yearOverAllPos = years.every((y) => (payload.byYear[y].over.roi ?? -1) >= 0);
if ((u.roi ?? -1) - (o.roi ?? -1) >= 0.03 && yearUnderAllPos && !yearOverAllPos) {
  payload.verdict.note =
    'under 合併明顯優於 over 且三窗 under 皆非負、over 非三窗皆正；仍只診斷，不改成只押一邊。';
} else if ((o.roi ?? -1) - (u.roi ?? -1) >= 0.03 && yearOverAllPos && !yearUnderAllPos) {
  payload.verdict.note =
    'over 合併明顯優於 under；仍只診斷，不改成只押一邊。';
} else {
  payload.verdict.note = '兩邊無穩定單邊優勢（或優勢不足以改主規則）；維持 over+under。';
}

fs.writeFileSync(
  new URL('../tmp-totals-sat-side-diag.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);
console.log(JSON.stringify({ overall: payload.overall, byYear: payload.byYear, verdict: payload.verdict }, null, 2));
