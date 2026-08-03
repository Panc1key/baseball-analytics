/**
 * 2025 totals 回補後：雙年複驗大小分衛星（含 maxTotalLine≤10）。
 * 產物：tmp-totals-sat-dual-year.json
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

function buildPool(from, to, model) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, from, to);

  const pool = [];
  let withMarket = 0;
  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const actualTotal = Number(row.homeScore) + Number(row.awayScore);
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
    if (!market) continue;
    withMarket += 1;
    if (actualTotal === market.line) continue;
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
    pool.push({
      absGap: Math.abs(gap),
      modelProb,
      pickOdds,
      ev,
      edgeVsMarket: modelProb - fair,
      line: market.line,
      hit: pickOver === actualTotal > market.line,
    });
  }
  return { pool, withMarket, games: rows.length };
}

function applyRule(pool, { useMaxLine = true } = {}) {
  return pool.filter((g) => {
    if (g.absGap < R.minAbsGap) return false;
    if (g.ev < R.minimumExpectedValue) return false;
    if (g.edgeVsMarket < R.minEdgeVsMarket) return false;
    if (g.modelProb < R.minimumModelProbability) return false;
    if (useMaxLine && g.line > R.maxTotalLine) return false;
    return true;
  });
}

const latest = getLatestMlbExpectedRunsValidation();
console.log('[dual-year] building…');
const byWindow = {};
const allBets = { naive: [], satOld: [], satNew: [] };

for (const w of WINDOWS) {
  const built = buildPool(w.from, w.to, latest.model);
  const naive = built.pool;
  const satOld = applyRule(naive, { useMaxLine: false });
  const satNew = applyRule(naive, { useMaxLine: true });
  byWindow[w.key] = {
    coverage: { games: built.games, withTotalsMarket: built.withMarket },
    naiveAgree: summarize(naive),
    satNoMaxLine: summarize(satOld),
    satCurrent: summarize(satNew),
  };
  allBets.naive.push(...naive);
  allBets.satOld.push(...satOld);
  allBets.satNew.push(...satNew);
  console.log(w.key, byWindow[w.key]);
}

const payload = {
  generatedAt: new Date().toISOString(),
  rules: R,
  byWindow,
  merged: {
    naiveAgree: summarize(allBets.naive),
    satNoMaxLine: summarize(allBets.satOld),
    satCurrent_maxLine10: summarize(allBets.satNew),
  },
  verdict: (() => {
    const y24 = byWindow['2024']?.satCurrent;
    const y25 = byWindow['2025'].satCurrent;
    const y26 = byWindow['2026'].satCurrent;
    const years = [y24, y25, y26].filter(Boolean);
    const dualPos = years.every((y) => (y.usd50 || 0) > 0);
    const dualRoi = years.every((y) => (y.roi || 0) > 0);
    return {
      allYearsUsdPositive: dualPos,
      allYearsRoiPositive: dualRoi,
      promoteFormalPaper:
        dualPos && dualRoi && years.every((y) => y.bets >= 80),
      note: dualPos && dualRoi
        ? '三窗紙上皆正；仍建議影子活體觀察，勿與鎖定 B 混排。'
        : '並非所有年份同時過閘；維持研究影子，不升正式。',
    };
  })(),
};

fs.writeFileSync(
  new URL('../tmp-totals-sat-dual-year.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);
console.log('MERGED', payload.merged);
console.log('VERDICT', payload.verdict);
