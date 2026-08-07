/**
 * ERA≥5 小分切片：繼續買小 vs 不下 vs 翻大
 * 產物：tmp-fragile-under-flip-over.json
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
const ERA_CUT = 5;
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
          vig,
        };
      }
    }
  }
  return best;
}

function summarize(bets, oddsKey = 'pickOdds') {
  if (!bets.length) {
    return { bets: 0, wins: 0, hitRate: null, roi: null, usd50: 0, avgOdds: null };
  }
  let unit = 0;
  let hits = 0;
  let oddsSum = 0;
  for (const b of bets) {
    const o = b[oddsKey];
    oddsSum += o;
    if (b.hit) {
      hits += 1;
      unit += o - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    wins: hits,
    hitRate: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * 50),
    avgOdds: Number((oddsSum / n).toFixed(3)),
  };
}

function maxEra(features) {
  const a = [Number(features?.pitchers?.home?.era), Number(features?.pitchers?.away?.era)].filter(
    (x) => Number.isFinite(x)
  );
  return a.length ? Math.max(...a) : null;
}

const model = getLatestMlbExpectedRunsValidation()?.model;
if (!model) {
  console.error('no model');
  process.exit(1);
}

const underPool = [];
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
    features.parkFactor = resolveMlbParkFactor({
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    const weather = getCachedMlbGameWeather(row.gameId);
    if (weather) features.weather = weather;

    let pred;
    try {
      pred = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    } catch {
      continue;
    }
    const market = bestTotals(row.gameId, row.commenceTime);
    if (!market) continue;
    const mu = Number(pred.expectedTotal);
    const gap = mu - market.line;
    if (!(gap < 0) || Math.abs(gap) < R.minAbsGap) continue;
    if (market.line > R.maxTotalLine) continue;

    const dist = buildMlbScoreDistribution({
      homeMean: Number(pred.homeExpectedRuns),
      awayMean: Number(pred.awayExpectedRuns),
      homeDispersion: Number(pred.dispersion ?? 3.5),
      awayDispersion: Number(pred.dispersion ?? 3.5),
    });
    const mk = deriveMlbScoreMarkets(dist, { totalLine: market.line });
    const pushP = Number(mk.total?.pushProbability) || 0;
    const underRaw = Number(mk.total?.underProbability);
    if (!Number.isFinite(underRaw)) continue;
    const modelProb = underRaw / Math.max(1e-9, 1 - pushP);
    const underOdds = market.underOdds;
    const overOdds = market.overOdds;
    const ev = modelProb * (underOdds - 1) - (1 - modelProb);
    const edge = modelProb - market.fairUnder;
    if (ev < R.minimumExpectedValue) continue;
    if (edge < R.minEdgeVsMarket) continue;
    if (modelProb < R.minimumModelProbability) continue;

    const total = Number(row.hs) + Number(row.ascore);
    if (total === market.line) continue;

    underPool.push({
      window: w.key,
      underOdds,
      overOdds,
      underHit: total < market.line,
      overHit: total > market.line,
      maxEra: maxEra(features),
      overshoot: total - market.line,
    });
  }
}

const fragile = underPool.filter((b) => (b.maxEra ?? -1) >= ERA_CUT);
const keepUnder = fragile.map((b) => ({
  hit: b.underHit,
  pickOdds: b.underOdds,
  window: b.window,
}));
const flipOver = fragile.map((b) => ({
  hit: b.overHit,
  pickOdds: b.overOdds,
  window: b.window,
}));

const fullUnder = underPool.map((b) => ({
  hit: b.underHit,
  pickOdds: b.underOdds,
}));
const skipFragile = underPool
  .filter((b) => (b.maxEra ?? -1) < ERA_CUT)
  .map((b) => ({ hit: b.underHit, pickOdds: b.underOdds }));
const flipInLedger = underPool.map((b) => {
  if ((b.maxEra ?? -1) >= ERA_CUT) {
    return { hit: b.overHit, pickOdds: b.overOdds };
  }
  return { hit: b.underHit, pickOdds: b.underOdds };
});

function byYear(rows, mapFn) {
  const out = {};
  for (const w of WINDOWS) {
    out[w.key] = summarize(mapFn(rows.filter((r) => r.window === w.key)));
  }
  return out;
}

const sliceKeep = summarize(keepUnder);
const sliceFlip = summarize(flipOver);
const baseAll = summarize(fullUnder);
const skipAll = summarize(skipFragile);
const flipAll = summarize(flipInLedger);

const report = {
  experimentId: 'fragile-under-era5-flip-over-2026-08-07',
  question: '先發 ERA≥5 的小分，翻大是否正期望？',
  fragileSlice: {
    n: fragile.length,
    keepUnder: sliceKeep,
    flipOver: sliceFlip,
    deltaFlipVsKeepUsd: sliceFlip.usd50 - sliceKeep.usd50,
    deltaFlipVsSkipUsd: sliceFlip.usd50, // skip=0 on this slice
    byYear: {
      keepUnder: byYear(fragile, (rows) =>
        rows.map((b) => ({ hit: b.underHit, pickOdds: b.underOdds, window: b.window }))
      ),
      flipOver: byYear(fragile, (rows) =>
        rows.map((b) => ({ hit: b.overHit, pickOdds: b.overOdds, window: b.window }))
      ),
    },
  },
  fullUnderLedger: {
    keepAllUnder: baseAll,
    skipFragileUnder: skipAll,
    flipFragileToOver: flipAll,
    deltaSkipVsKeep: skipAll.usd50 - baseAll.usd50,
    deltaFlipVsKeep: flipAll.usd50 - baseAll.usd50,
    deltaFlipVsSkip: flipAll.usd50 - skipAll.usd50,
  },
  verdict: (() => {
    const slicePositive = sliceFlip.roi != null && sliceFlip.roi > 0;
    const betterThanSkip = flipAll.usd50 > skipAll.usd50;
    const betterThanKeep = flipAll.usd50 > baseAll.usd50;
    let primary = 'skip_still_best';
    if (slicePositive && betterThanSkip && betterThanKeep) primary = 'flip_positive_and_best';
    else if (slicePositive && betterThanKeep) primary = 'flip_beats_keep_under_but_check_skip';
    else if (!slicePositive) primary = 'flip_negative_do_not_flip';
    return {
      primary,
      sliceFlipRoi: sliceFlip.roi,
      sliceKeepRoi: sliceKeep.roi,
      plainSpeak: slicePositive
        ? betterThanSkip
          ? `翻大在此切片 ROI=${sliceFlip.roi}，且整帳優於不下 → 可考慮翻大`
          : `翻大切片看似正，但整帳不如「不下」（Δ$=${flipAll.usd50 - skipAll.usd50}）→ 仍建議不下`
        : `翻大在此切片 ROI=${sliceFlip.roi}（負）→ 不是正期望，不要翻大，維持不下`,
    };
  })(),
};

fs.writeFileSync(
  new URL('../tmp-fragile-under-flip-over.json', import.meta.url),
  JSON.stringify(report, null, 2)
);
console.log(JSON.stringify(report.fragileSlice, null, 2));
console.log(JSON.stringify(report.fullUnderLedger, null, 2));
console.log(JSON.stringify(report.verdict, null, 2));
