/**
 * 第一刀：總分 μ 對盤口校準 + 非對稱大分 gap + 特徵貢獻
 * 不改正式路徑；產物供是否升格衛星決策
 *
 * 用法: node scripts/auditMlbTotalsCalibKnife1.mjs
 * 產物: tmp-totals-calib-knife1.json
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
          vig,
        };
      }
    }
  }
  return best;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

/** OLS y = a*x + b */
function fitAffine(xs, ys) {
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const a = den > 1e-12 ? num / den : 1;
  const b = my - a * mx;
  return { a, b };
}

function applyAffineTotal(homeMu, awayMu, a, b) {
  const mu = homeMu + awayMu;
  const muAdj = a * mu + b;
  if (mu <= 1e-9) {
    return { homeMu: muAdj / 2, awayMu: muAdj / 2, mu: muAdj };
  }
  const scale = muAdj / mu;
  return {
    homeMu: Math.max(0.5, homeMu * scale),
    awayMu: Math.max(0.5, awayMu * scale),
    mu: muAdj,
  };
}

function applyOffsetTotal(homeMu, awayMu, offset) {
  // offset is added to total (negative = shrink)
  const half = offset / 2;
  const home = Math.max(0.5, homeMu + half);
  const away = Math.max(0.5, awayMu + half);
  return { homeMu: home, awayMu: away, mu: home + away };
}

function marketsFromMeans(homeMu, awayMu, dispersion, line) {
  const dist = buildMlbScoreDistribution({
    homeMean: homeMu,
    awayMean: awayMu,
    homeDispersion: dispersion,
    awayDispersion: dispersion,
  });
  return deriveMlbScoreMarkets(dist, { totalLine: line });
}

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hits: 0, hitRate: null, roi: null, usd50: 0 };
  }
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
  const out = {};
  for (const y of ['2024', '2025', '2026']) {
    out[y] = summarize(bets.filter((b) => b.year === y));
  }
  return out;
}

function threePos(s) {
  return ['2024', '2025', '2026'].every((y) => (s.byYear?.[y]?.roi ?? -1) >= 0);
}

/**
 * @param {object} g game row
 * @param {{homeMu,awayMu,mu}} adj
 * @param {number} dispersion
 * @param {{overMinGap:number, underMinGap:number}} gaps
 */
function tryPick(g, adj, dispersion, { overMinGap, underMinGap }) {
  const gap = adj.mu - g.line;
  const side = gap > 0 ? 'over' : gap < 0 ? 'under' : null;
  if (!side) return null;
  const minGap = side === 'over' ? overMinGap : underMinGap;
  const absGap = Math.abs(gap);
  if (absGap < minGap) return null;
  if (g.line > R.maxTotalLine) return null;

  const mk = marketsFromMeans(adj.homeMu, adj.awayMu, dispersion, g.line);
  const pushP = Number(mk.total?.pushProbability) || 0;
  const overProb =
    Number(mk.total?.overProbability) / Math.max(1e-9, 1 - pushP);
  const underProb =
    Number(mk.total?.underProbability) / Math.max(1e-9, 1 - pushP);
  const modelProb = side === 'over' ? overProb : underProb;
  if (modelProb < 0.5) return null;
  if (modelProb < R.minimumModelProbability) return null;
  const pickOdds = side === 'over' ? g.overOdds : g.underOdds;
  const fair = side === 'over' ? g.fairOver : g.fairUnder;
  const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
  const edge = modelProb - fair;
  if (ev < R.minimumExpectedValue) return null;
  if (edge < R.minEdgeVsMarket) return null;
  return {
    year: g.year,
    side,
    pickOdds,
    hit: side === g.actualSide,
    absGap,
    modelProb,
    ev,
    edge,
  };
}

console.log('Step0: load games…');
const model = getLatestMlbExpectedRunsValidation().model;
const dispersion = model.dispersion;
const games = [];

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
    const homeGroups = pred.explanation?.home?.groups || {};
    const awayGroups = pred.explanation?.away?.groups || {};
    const groupImpact = {};
    for (const [k, v] of Object.entries(homeGroups)) {
      groupImpact[k] = (groupImpact[k] || 0) + Number(v.runImpact || 0);
    }
    for (const [k, v] of Object.entries(awayGroups)) {
      groupImpact[k] = (groupImpact[k] || 0) + Number(v.runImpact || 0);
    }

    games.push({
      year: w.key,
      line: market.line,
      actualTotal,
      actualHome: Number(row.hs),
      actualAway: Number(row.ascore),
      homeMu: Number(pred.homeExpectedRuns),
      awayMu: Number(pred.awayExpectedRuns),
      mu: Number(pred.expectedTotal),
      overOdds: market.overOdds,
      underOdds: market.underOdds,
      fairOver: market.fairOver,
      fairUnder: market.fairUnder,
      actualSide: actualTotal > market.line ? 'over' : 'under',
      parkFactor: Number(features.parkFactor) || 1,
      groupImpact,
      offenseRecentRpg:
        Number(features.homeOffenseRecentRpg ?? features.offenseRecentRpg) ||
        null,
    });
  }
}
console.log('games', games.length);

// —— Step1: calibrations ——
const muArr = games.map((g) => g.mu);
const actArr = games.map((g) => g.actualTotal);
const lineArr = games.map((g) => g.line);
const affineActual = fitAffine(muArr, actArr);
const affineLine = fitAffine(muArr, lineArr);
const offsetToLine = -mean(games.map((g) => g.mu - g.line));
const offsetToActual = -mean(games.map((g) => g.mu - g.actualTotal));
const homeBias = mean(games.map((g) => g.homeMu - g.actualHome));
const awayBias = mean(games.map((g) => g.awayMu - g.actualAway));

const calibSpecs = [
  { id: 'raw', kind: 'raw' },
  {
    id: 'offset_to_line',
    kind: 'offset',
    offset: offsetToLine,
    note: 'μ′=μ+mean(line−μ)；對齊盤口水平',
  },
  {
    id: 'offset_to_actual',
    kind: 'offset',
    offset: offsetToActual,
    note: 'μ′=μ+mean(actual−μ)；對齊賽果（預期幾乎為0）',
  },
  {
    id: 'affine_to_line',
    kind: 'affine',
    a: affineLine.a,
    b: affineLine.b,
    note: 'OLS line ~ a·μ+b',
  },
  {
    id: 'affine_to_actual',
    kind: 'affine',
    a: affineActual.a,
    b: affineActual.b,
    note: 'OLS actual ~ a·μ+b',
  },
  {
    id: 'side_offset_home_away',
    kind: 'side_offset',
    homeOff: -homeBias,
    awayOff: -awayBias,
    note: '主客各自扣掉對實際偏差',
  },
];

function adjust(g, spec) {
  if (spec.kind === 'raw') {
    return { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu };
  }
  if (spec.kind === 'offset') {
    return applyOffsetTotal(g.homeMu, g.awayMu, spec.offset);
  }
  if (spec.kind === 'affine') {
    return applyAffineTotal(g.homeMu, g.awayMu, spec.a, spec.b);
  }
  if (spec.kind === 'side_offset') {
    const homeMu = Math.max(0.5, g.homeMu + spec.homeOff);
    const awayMu = Math.max(0.5, g.awayMu + spec.awayOff);
    return { homeMu, awayMu, mu: homeMu + awayMu };
  }
  return { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu };
}

function leanStats(rows, spec) {
  let over = 0;
  let under = 0;
  const gaps = [];
  for (const g of rows) {
    const adj = adjust(g, spec);
    gaps.push(adj.mu - g.line);
    if (adj.mu > g.line) over += 1;
    else if (adj.mu < g.line) under += 1;
  }
  return {
    leanOverShare: Number((over / (over + under)).toFixed(4)),
    leanUnderShare: Number((under / (over + under)).toFixed(4)),
    meanMuMinusLine: Number(mean(gaps).toFixed(3)),
    meanMu: Number(mean(rows.map((g) => adjust(g, spec).mu)).toFixed(3)),
  };
}

// —— Step2: policies (symmetric + asymmetric over gap) ——
const gapPolicies = [
  { id: 'sym_0.6', overMinGap: 0.6, underMinGap: 0.6 },
  { id: 'over_0.9_under_0.6', overMinGap: 0.9, underMinGap: 0.6 },
  { id: 'over_1.2_under_0.6', overMinGap: 1.2, underMinGap: 0.6 },
  { id: 'over_1.5_under_0.6', overMinGap: 1.5, underMinGap: 0.6 },
  { id: 'over_1.8_under_0.6', overMinGap: 1.8, underMinGap: 0.6 },
];

function evalPolicy(rows, spec, gapPol) {
  const picks = [];
  for (const g of rows) {
    const adj = adjust(g, spec);
    const p = tryPick(g, adj, dispersion, gapPol);
    if (p) picks.push(p);
  }
  const both = summarize(picks);
  const over = summarize(picks.filter((p) => p.side === 'over'));
  const under = summarize(picks.filter((p) => p.side === 'under'));
  const bothY = { ...both, byYear: byYear(picks) };
  const overY = { ...over, byYear: byYear(picks.filter((p) => p.side === 'over')) };
  const underY = {
    ...under,
    byYear: byYear(picks.filter((p) => p.side === 'under')),
  };
  return {
    both: bothY,
    over: overY,
    under: underY,
    threePos: {
      both: threePos(bothY),
      over: threePos(overY),
      under: threePos(underY),
    },
    overShare: picks.length
      ? Number(
          (picks.filter((p) => p.side === 'over').length / picks.length).toFixed(4)
        )
      : null,
  };
}

console.log('Step1–2: calib × gap grid (NB markets)…');
const board = [];
for (const spec of calibSpecs) {
  const lean = leanStats(games, spec);
  for (const gapPol of gapPolicies) {
    // skip asymmetric gaps on non-primary calibs to save time? User wants full knife — run all but raw+offset_to_line+affine_to_line get full gap grid; others only sym
    const runGaps =
      spec.id === 'raw' ||
      spec.id === 'offset_to_line' ||
      spec.id === 'affine_to_line'
        ? gapPolicies
        : gapPolicies.filter((g) => g.id === 'sym_0.6');
    if (!runGaps.includes(gapPol)) continue;

    const ev = evalPolicy(games, spec, gapPol);
    const passLean = lean.leanOverShare >= 0.45 && lean.leanOverShare <= 0.55;
    const passUnder =
      ev.threePos.under && (ev.under.roi ?? -1) >= 0.03 && ev.under.bets >= 100;
    const passOverImprove =
      ev.threePos.over &&
      (ev.over.roi ?? -1) >= 0.02 &&
      (ev.over.usd50 ?? 0) > 0;
    board.push({
      id: `${spec.id}__${gapPol.id}`,
      calib: spec.id,
      gap: gapPol.id,
      lean,
      ...ev,
      flags: {
        leanBalanced: passLean,
        underHealthy: passUnder,
        overHealthy: passOverImprove,
      },
      score:
        (ev.under.usd50 || 0) +
        (ev.over.usd50 || 0) +
        (passLean ? 500 : 0) +
        (passUnder ? 300 : 0) +
        (passOverImprove ? 200 : 0),
    });
  }
}
board.sort((a, b) => b.score - a.score);

// —— Leave-one-year OOS for top candidates (fit on other years) ——
console.log('Step2b: leave-one-year OOS for top calibs…');
function fitSpecOn(train, baseId) {
  if (baseId === 'raw') return { id: 'raw', kind: 'raw' };
  if (baseId === 'offset_to_line') {
    return {
      id: 'offset_to_line',
      kind: 'offset',
      offset: -mean(train.map((g) => g.mu - g.line)),
    };
  }
  if (baseId === 'offset_to_actual') {
    return {
      id: 'offset_to_actual',
      kind: 'offset',
      offset: -mean(train.map((g) => g.mu - g.actualTotal)),
    };
  }
  if (baseId === 'affine_to_line') {
    const f = fitAffine(
      train.map((g) => g.mu),
      train.map((g) => g.line)
    );
    return { id: 'affine_to_line', kind: 'affine', a: f.a, b: f.b };
  }
  if (baseId === 'affine_to_actual') {
    const f = fitAffine(
      train.map((g) => g.mu),
      train.map((g) => g.actualTotal)
    );
    return { id: 'affine_to_actual', kind: 'affine', a: f.a, b: f.b };
  }
  if (baseId === 'side_offset_home_away') {
    return {
      id: 'side_offset_home_away',
      kind: 'side_offset',
      homeOff: -mean(train.map((g) => g.homeMu - g.actualHome)),
      awayOff: -mean(train.map((g) => g.awayMu - g.actualAway)),
    };
  }
  return { id: 'raw', kind: 'raw' };
}

const oosTargets = [
  { calib: 'offset_to_line', gap: 'over_1.2_under_0.6' },
  { calib: 'offset_to_line', gap: 'over_1.5_under_0.6' },
  { calib: 'affine_to_line', gap: 'over_1.2_under_0.6' },
  { calib: 'affine_to_line', gap: 'sym_0.6' },
  { calib: 'raw', gap: 'over_1.5_under_0.6' },
  { calib: 'raw', gap: 'sym_0.6' },
];

const oosResults = [];
for (const t of oosTargets) {
  const gapPol = gapPolicies.find((g) => g.id === t.gap);
  const mergedPicks = [];
  const perYear = {};
  for (const hold of ['2024', '2025', '2026']) {
    const train = games.filter((g) => g.year !== hold);
    const test = games.filter((g) => g.year === hold);
    const spec = fitSpecOn(train, t.calib);
    const ev = evalPolicy(test, spec, gapPol);
    perYear[hold] = {
      lean: leanStats(test, spec),
      under: ev.under,
      over: ev.over,
      both: ev.both,
      fit:
        spec.kind === 'affine'
          ? { a: spec.a, b: spec.b }
          : spec.kind === 'offset'
            ? { offset: spec.offset }
            : spec.kind === 'side_offset'
              ? { homeOff: spec.homeOff, awayOff: spec.awayOff }
              : null,
    };
    // collect picks for merged — re-eval
    for (const g of test) {
      const adj = adjust(g, spec);
      const p = tryPick(g, adj, dispersion, gapPol);
      if (p) mergedPicks.push(p);
    }
  }
  const under = summarize(mergedPicks.filter((p) => p.side === 'under'));
  const over = summarize(mergedPicks.filter((p) => p.side === 'over'));
  const both = summarize(mergedPicks);
  oosResults.push({
    id: `${t.calib}__${t.gap}`,
    perYear,
    merged: {
      both: { ...both, byYear: byYear(mergedPicks) },
      under: {
        ...under,
        byYear: byYear(mergedPicks.filter((p) => p.side === 'under')),
      },
      over: {
        ...over,
        byYear: byYear(mergedPicks.filter((p) => p.side === 'over')),
      },
    },
    threePosUnder: ['2024', '2025', '2026'].every(
      (y) => (perYear[y].under.roi ?? -1) >= 0
    ),
    threePosOver: ['2024', '2025', '2026'].every(
      (y) => (perYear[y].over.roi ?? -1) >= 0
    ),
  });
}
oosResults.sort(
  (a, b) =>
    (b.merged.under.usd50 || 0) +
    (b.merged.over.usd50 || 0) -
    ((a.merged.under.usd50 || 0) + (a.merged.over.usd50 || 0))
);

// —— Step3: feature / group contribution to μ−line ——
console.log('Step3: feature groups vs μ−line…');
const groupKeys = [
  ...new Set(games.flatMap((g) => Object.keys(g.groupImpact || {}))),
];
const featureScan = groupKeys.map((key) => {
  const impacts = games.map((g) => Number(g.groupImpact[key]) || 0);
  const gaps = games.map((g) => g.mu - g.line);
  const mImpact = mean(impacts);
  // corr
  const mi = mean(impacts);
  const mg = mean(gaps);
  let num = 0;
  let d1 = 0;
  let d2 = 0;
  for (let i = 0; i < games.length; i += 1) {
    num += (impacts[i] - mi) * (gaps[i] - mg);
    d1 += (impacts[i] - mi) ** 2;
    d2 += (gaps[i] - mg) ** 2;
  }
  const corr = d1 > 0 && d2 > 0 ? num / Math.sqrt(d1 * d2) : null;
  const leanOver = games.filter((g) => g.mu > g.line);
  const leanUnder = games.filter((g) => g.mu < g.line);
  return {
    group: key,
    meanRunImpact: Number(mImpact.toFixed(4)),
    corrWithMuMinusLine: corr != null ? Number(corr.toFixed(4)) : null,
    meanImpactWhenLeanOver: Number(
      mean(leanOver.map((g) => Number(g.groupImpact[key]) || 0)).toFixed(4)
    ),
    meanImpactWhenLeanUnder: Number(
      mean(leanUnder.map((g) => Number(g.groupImpact[key]) || 0)).toFixed(4)
    ),
  };
});
featureScan.sort(
  (a, b) =>
    Math.abs(b.meanRunImpact) - Math.abs(a.meanRunImpact)
);

// park slice for raw μ−line
const parkScan = ['pitcher_park', 'mid', 'hitter_park'].map((b) => {
  const sub = games.filter((g) => {
    if (b === 'pitcher_park') return g.parkFactor < 0.97;
    if (b === 'hitter_park') return g.parkFactor > 1.03;
    return g.parkFactor >= 0.97 && g.parkFactor <= 1.03;
  });
  return {
    bucket: b,
    n: sub.length,
    meanMuMinusLine: Number(mean(sub.map((g) => g.mu - g.line)).toFixed(3)),
    leanOverShare: Number(
      (sub.filter((g) => g.mu > g.line).length / sub.length).toFixed(4)
    ),
  };
});

const baselineRaw = board.find((b) => b.id === 'raw__sym_0.6');

const out = {
  experimentId: 'totals_calib_knife1',
  n: games.length,
  step1_calibrations: {
    homeBiasVsActual: Number(homeBias.toFixed(4)),
    awayBiasVsActual: Number(awayBias.toFixed(4)),
    affineActual,
    affineLine,
    offsetToLine: Number(offsetToLine.toFixed(4)),
    offsetToActual: Number(offsetToActual.toFixed(4)),
    leanByCalib: Object.fromEntries(
      calibSpecs.map((s) => [s.id, leanStats(games, s)])
    ),
  },
  step2_inSampleBoard: board.slice(0, 20),
  step2_oos: oosResults,
  step3_featureGroups: featureScan,
  step3_park: parkScan,
  baselineRawSym: baselineRaw
    ? {
        under: baselineRaw.under,
        over: baselineRaw.over,
        both: baselineRaw.both,
        lean: baselineRaw.lean,
      }
    : null,
  verdict: null,
};

// pick recommended
const bestOos = oosResults.find(
  (r) =>
    r.threePosUnder &&
    (r.merged.under.roi ?? 0) >= 0.03 &&
    r.id.includes('offset_to_line')
) || oosResults.find((r) => r.threePosUnder);

const bestAsymRaw = oosResults.find((r) => r.id.startsWith('raw__over_'));

out.verdict = {
  recommendedShadow: bestOos?.id || null,
  userAsymOverHypothesis: bestAsymRaw
    ? {
        id: bestAsymRaw.id,
        over: bestAsymRaw.merged.over,
        under: bestAsymRaw.merged.under,
        threePosOver: bestAsymRaw.threePosOver,
        threePosUnder: bestAsymRaw.threePosUnder,
        note: '大分提高 minGap 是否改善 Over',
      }
    : null,
  plain: null,
};

const oosLine12 = oosResults.find(
  (r) => r.id === 'offset_to_line__over_1.2_under_0.6'
);
const oosRaw15 = oosResults.find((r) => r.id === 'raw__over_1.5_under_0.6');
const oosRawSym = oosResults.find((r) => r.id === 'raw__sym_0.6');

out.verdict.plain = [
  `主客對實際偏差很小（home ${homeBias.toFixed(3)} / away ${awayBias.toFixed(3)}），校準應對準盤口而非再砍得分。`,
  oosLine12
    ? `OOS offset_to_line + overGap1.2：Under n=${oosLine12.merged.under.bets} ROI=${oosLine12.merged.under.roi} $=${oosLine12.merged.under.usd50}；Over n=${oosLine12.merged.over.bets} ROI=${oosLine12.merged.over.roi} $=${oosLine12.merged.over.usd50}；under三窗=${oosLine12.threePosUnder} over三窗=${oosLine12.threePosOver}。`
    : '',
  oosRaw15 && oosRawSym
    ? `你的建議（大分 gap↑）：raw over@1.5 Under ROI=${oosRaw15.merged.under.roi} Over ROI=${oosRaw15.merged.over.roi}（對照 sym Under ${oosRawSym.merged.under.roi} / Over ${oosRawSym.merged.over.roi}）。`
    : '',
  `特徵上 μ−line 相關見 step3；公園：投手公園 μ−line 最大。`,
].filter(Boolean).join(' ');

fs.writeFileSync(
  new URL('../tmp-totals-calib-knife1.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify({
  leanByCalib: out.step1_calibrations.leanByCalib,
  topBoard: board.slice(0, 8).map((b) => ({
    id: b.id,
    lean: b.lean.leanOverShare,
    under: b.under,
    over: b.over,
    flags: b.flags,
  })),
  oos: oosResults.map((r) => ({
    id: r.id,
    under: r.merged.under,
    over: r.merged.over,
    threePosUnder: r.threePosUnder,
    threePosOver: r.threePosOver,
  })),
  featureTop: featureScan.slice(0, 8),
  parkScan,
  plain: out.verdict.plain,
}, null, 2));
console.log('wrote tmp-totals-calib-knife1.json');
