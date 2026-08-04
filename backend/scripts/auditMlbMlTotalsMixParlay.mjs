/**
 * 獨贏鎖定 B × 大小分衛星：混串是否推盈利（24/25/26）
 * 不改正式規則；僅審計
 *
 * 用法: node scripts/auditMlbMlTotalsMixParlay.mjs
 * 產物: tmp-ml-totals-mix-parlay.json
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
import { buildFrozenBShadowPickSets } from '../src/services/MlbFrozenBShadow.js';
import { MLB_TOTALS_SATELLITE_SPEC } from '../src/services/MlbTotalsSatellite.js';

const R = MLB_TOTALS_SATELLITE_SPEC.rules;
const PARLAY = 25;
const SINGLE = 50;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

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

function summarizeFlat(bets, stake = SINGLE) {
  if (!bets.length) return { bets: 0, hitRate: null, roi: null, usd: 0 };
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
    usd: Math.round(unit * stake),
  };
}

function summarizeParlays(parlays, stake = PARLAY) {
  if (!parlays.length) {
    return { bets: 0, hitRate: null, roi: null, usd: 0, avgCombined: null };
  }
  let profit = 0;
  let wins = 0;
  let comb = 0;
  for (const p of parlays) {
    profit += p.profit;
    if (p.won) wins += 1;
    comb += p.combined;
  }
  const n = parlays.length;
  const staked = n * stake;
  return {
    bets: n,
    hitRate: Number((wins / n).toFixed(4)),
    roi: Number((profit / staked).toFixed(4)),
    usd: Math.round(profit),
    avgCombined: Number((comb / n).toFixed(3)),
  };
}

function evalParlay(legs, stake = PARLAY) {
  const combined = legs.reduce((p, x) => p * x.pickOdds, 1);
  const won = legs.every((x) => x.hit);
  return {
    combined: Number(combined.toFixed(4)),
    won,
    profit: won ? stake * (combined - 1) : -stake,
    legs: legs.length,
  };
}

function byYearParlay(parlays) {
  const out = {};
  for (const y of ['2024', '2025', '2026']) {
    out[y] = summarizeParlays(parlays.filter((p) => p.year === y));
  }
  return out;
}

console.log('Loading locked B ML…');
const { shadow: mlPicks } = buildFrozenBShadowPickSets({});
const mlByGame = new Map(mlPicks.map((b) => [b.gameId, b]));
const mlByDay = new Map();
for (const b of mlPicks) {
  if (!mlByDay.has(b.day)) mlByDay.set(b.day, []);
  mlByDay.get(b.day).push(b);
}

console.log('Building totals satellite picks…');
const model = getLatestMlbExpectedRunsValidation().model;
const totals = [];
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
    totals.push({
      gameId: row.gameId,
      year: w.key,
      day: hk(row.commenceTime),
      side: pickOver ? 'over' : 'under',
      pickOdds,
      ev,
      hit: pickOver === actualTotal > market.line,
    });
  }
}
console.log('totals', totals.length, 'ml', mlPicks.length);

const totalsByGame = new Map(totals.map((t) => [t.gameId, t]));
const totalsByDay = new Map();
for (const t of totals) {
  if (!totalsByDay.has(t.day)) totalsByDay.set(t.day, []);
  totalsByDay.get(t.day).push(t);
}

// —— 同場 SGP：該場既有鎖定 B 獨贏、又有大小分衛星 ——
const sgpAll = [];
const sgpUnder = [];
for (const [gameId, ml] of mlByGame) {
  const tot = totalsByGame.get(gameId);
  if (!tot) continue;
  const p = {
    ...evalParlay(
      [
        { pickOdds: ml.pickOdds, hit: ml.hit },
        { pickOdds: tot.pickOdds, hit: tot.hit },
      ],
      PARLAY
    ),
    year: ml.window,
    day: ml.day,
    gameId,
    totalsSide: tot.side,
  };
  sgpAll.push(p);
  if (tot.side === 'under') sgpUnder.push(p);
}

// —— 同日異場：日 Rank1 獨贏 × 當日 EV 最高大小分（優先不同場）——
const crossDay = [];
const crossDayUnder = [];
for (const [day, mls] of mlByDay) {
  const tots = totalsByDay.get(day) || [];
  if (!tots.length) continue;
  const r1 = [...mls].sort((a, b) => (a.rank || 99) - (b.rank || 99))[0];
  const sortedTot = [...tots].sort((a, b) => b.ev - a.ev);
  const tot =
    sortedTot.find((t) => t.gameId !== r1.gameId) || sortedTot[0];
  if (!tot) continue;
  const p = {
    ...evalParlay(
      [
        { pickOdds: r1.pickOdds, hit: r1.hit },
        { pickOdds: tot.pickOdds, hit: tot.hit },
      ],
      PARLAY
    ),
    year: r1.window,
    day,
    totalsSide: tot.side,
    sameGame: tot.gameId === r1.gameId,
  };
  crossDay.push(p);
  if (tot.side === 'under') crossDayUnder.push(p);
}

// —— 對照：純大小分均注、純獨贏 ——
const flatTotals = summarizeFlat(totals, SINGLE);
const flatTotalsUnder = summarizeFlat(
  totals.filter((t) => t.side === 'under'),
  SINGLE
);
const flatMl = summarizeFlat(mlPicks, SINGLE);

const variants = {
  same_game_ml_x_totals: {
    ...summarizeParlays(sgpAll),
    byYear: byYearParlay(sgpAll),
  },
  same_game_ml_x_under: {
    ...summarizeParlays(sgpUnder),
    byYear: byYearParlay(sgpUnder),
  },
  same_day_r1_x_best_totals: {
    ...summarizeParlays(crossDay),
    byYear: byYearParlay(crossDay),
  },
  same_day_r1_x_best_under: {
    ...summarizeParlays(crossDayUnder),
    byYear: byYearParlay(crossDayUnder),
  },
};

function passMix(v) {
  if (!v.bets || v.bets < 30) return false;
  if ((v.usd ?? 0) <= 0) return false;
  const ys = v.byYear || {};
  return ['2024', '2025', '2026'].every((y) => (ys[y]?.usd ?? -1) >= -50);
}

const board = Object.entries(variants).map(([id, v]) => ({
  id,
  ...v,
  pass: passMix(v),
}));
board.sort((a, b) => (b.usd || 0) - (a.usd || 0));
const passers = board.filter((b) => b.pass);

const out = {
  experimentId: 'ml_totals_mix_parlay',
  stakes: { parlay: PARLAY, flatRef: SINGLE },
  flatRef: {
    lockedB_ml: flatMl,
    totals_sat_both: flatTotals,
    totals_sat_under: flatTotalsUnder,
  },
  variants: board,
  passers: passers.map((p) => p.id),
  verdict: passers.length
    ? `MIX_PARLAY_YES — ${passers.map((p) => p.id).join(', ')}（仍建議先當衛星觀察，勿混進鎖定 B 主倉）`
    : 'MIX_PARLAY_NO — 獨贏×大小分混串未能穩推盈利（或樣本／窗不穩）',
  note:
    '大小分單場衛星歷史已偏正；本審計只問「混進串關」是否還更好。可繼續開發測試衛星本身，與是否混串是兩件事。',
};

fs.writeFileSync(
  new URL('../tmp-ml-totals-mix-parlay.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
console.log('wrote tmp-ml-totals-mix-parlay.json');
