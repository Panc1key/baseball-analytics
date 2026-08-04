/**
 * Hybrid 嚴謹度三審計（研究；不動 Locked 常數）
 * 1) 路徑切片：砍/降權 Over·raw
 * 2) 實盤線映射：主線 L 信號 → L±0.5 重算或拒單
 * 3) Over·raw 脆弱區間
 *
 * 用法: node scripts/auditMlbTotalsHybridRigorThree.mjs
 * 產物: tmp-totals-hybrid-rigor-three.json
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
const FROZEN_PO = Number(HYBRID.pitcherParkMuMinusLineOffset) || 0.7;
const OVER_GAP = Number(HYBRID.overMinAbsGap) || 0.9;
const UNDER_GAP = Number(BASE.minAbsGap) || 0.6;
const PF_MAX = Number(HYBRID.pitcherParkFactorMax) || 0.97;

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-31' },
];

function collectTotalsLines(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return [];
  /** @type {Map<number, {line:number,overOdds:number,underOdds:number,fairOver:number,fairUnder:number,vig:number}>} */
  const byLine = new Map();
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
      const line = Number(over.point);
      const prev = byLine.get(line);
      if (!prev || vig < prev.vig) {
        const fair = removeVig(
          decimalToImpliedProb(overOdds),
          decimalToImpliedProb(underOdds)
        );
        byLine.set(line, {
          line,
          overOdds,
          underOdds,
          fairOver: fair.fairA,
          fairUnder: fair.fairB,
          vig,
        });
      }
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

function bestLine(lines) {
  if (!lines.length) return null;
  return lines.reduce((a, b) => (a.vig <= b.vig ? a : b));
}

function parkBucket(pf) {
  const x = Number(pf);
  if (x < PF_MAX) return 'pitcher';
  if (x > 1.03) return 'hitter';
  return 'mid';
}

function summarize(bets, stakeUsd = STAKE) {
  if (!bets.length) {
    return { bets: 0, hits: 0, hitRate: null, roi: null, usd50: 0, stakeUsd };
  }
  let unit = 0;
  let hits = 0;
  let pnl = 0;
  for (const b of bets) {
    const s = Number.isFinite(b.stakeUsd) ? b.stakeUsd : stakeUsd;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
      pnl += s * (b.pickOdds - 1);
    } else {
      unit -= 1;
      pnl -= s;
    }
  }
  return {
    bets: bets.length,
    hits,
    hitRate: Number((hits / bets.length).toFixed(4)),
    roi: Number((unit / bets.length).toFixed(4)),
    usd50: Math.round(pnl),
    stakeUsd,
  };
}

function byYear(bets, stakeUsd = STAKE) {
  const o = {};
  for (const y of ['2024', '2025', '2026']) {
    o[y] = summarize(
      bets.filter((b) => b.year === y),
      stakeUsd
    );
  }
  return o;
}

function monthKey(commenceTime) {
  const d = String(commenceTime || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(d) ? d : 'unknown';
}

function monthlyRoiSignStability(bets) {
  const byM = new Map();
  for (const b of bets) {
    const k = b.month || 'unknown';
    if (!byM.has(k)) byM.set(k, []);
    byM.get(k).push(b);
  }
  const months = [...byM.entries()]
    .filter(([k]) => k !== 'unknown')
    .map(([month, arr]) => {
      const s = summarize(arr);
      return { month, ...s, positive: (s.roi ?? -1) >= 0 };
    })
    .sort((a, b) => a.month.localeCompare(b.month));
  const n = months.length;
  const pos = months.filter((m) => m.positive).length;
  return {
    months: n,
    positiveMonths: pos,
    positiveRate: n ? Number((pos / n).toFixed(4)) : null,
    monthly: months,
  };
}

function trySideOnLine(g, adj, sideWanted, minAbsGap, lineObj) {
  const line = lineObj.line;
  const gap = adj.mu - line;
  const side = gap > 0 ? 'over' : gap < 0 ? 'under' : null;
  if (side !== sideWanted) return null;
  if (Math.abs(gap) < minAbsGap) return null;
  if (line > BASE.maxTotalLine) return null;
  const dist = buildMlbScoreDistribution({
    homeMean: adj.homeMu,
    awayMean: adj.awayMu,
    homeDispersion: g.dispersion,
    awayDispersion: g.dispersion,
  });
  const mk = deriveMlbScoreMarkets(dist, { totalLine: line });
  const pushP = Number(mk.total?.pushProbability) || 0;
  const overProb =
    Number(mk.total.overProbability) / Math.max(1e-9, 1 - pushP);
  const underProb =
    Number(mk.total.underProbability) / Math.max(1e-9, 1 - pushP);
  const modelProb = side === 'over' ? overProb : underProb;
  if (modelProb < 0.5 || modelProb < BASE.minimumModelProbability) return null;
  const pickOdds = side === 'over' ? lineObj.overOdds : lineObj.underOdds;
  const fair = side === 'over' ? lineObj.fairOver : lineObj.fairUnder;
  const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
  const edge = modelProb - fair;
  if (ev < BASE.minimumExpectedValue || edge < BASE.minEdgeVsMarket) return null;
  if (pickOdds < BASE.pickOddsMin || pickOdds > BASE.pickOddsMax) return null;
  const actualSide =
    g.actualTotal > line ? 'over' : g.actualTotal < line ? 'under' : 'push';
  if (actualSide === 'push') return null;
  return {
    year: g.year,
    month: g.month,
    side,
    pickOdds,
    hit: side === actualSide,
    absGap: Math.abs(gap),
    gap,
    modelProb,
    ev,
    edge,
    line,
    mu: adj.mu,
    muRaw: g.mu,
    parkFactor: g.parkFactor,
    parkBucket: g.parkBucket,
    actualTotal: g.actualTotal,
  };
}

function adjForOverPath(g, path) {
  if (path === 'pitcher_debiased_over') {
    const h = Math.max(0.5, g.homeMu - FROZEN_PO / 2);
    const a = Math.max(0.5, g.awayMu - FROZEN_PO / 2);
    return { homeMu: h, awayMu: a, mu: h + a };
  }
  return { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu };
}

function classifyHybridOnBest(g) {
  const best = g.best;
  const rawAdj = { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu };
  const u = trySideOnLine(g, rawAdj, 'under', UNDER_GAP, best);
  if (u) {
    return { ...u, hybridPath: 'raw_under', stakeUsd: STAKE };
  }
  if (g.parkBucket === 'pitcher') {
    const o = trySideOnLine(
      g,
      adjForOverPath(g, 'pitcher_debiased_over'),
      'over',
      OVER_GAP,
      best
    );
    if (o) {
      return { ...o, hybridPath: 'pitcher_debiased_over', stakeUsd: STAKE };
    }
  } else {
    const o = trySideOnLine(
      g,
      adjForOverPath(g, 'raw_over'),
      'over',
      OVER_GAP,
      best
    );
    if (o) {
      return { ...o, hybridPath: 'raw_over', stakeUsd: STAKE };
    }
  }
  return null;
}

console.log('load games…');
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
    const lines = collectTotalsLines(row.gameId, row.commenceTime);
    const best = bestLine(lines);
    if (!best) continue;
    if (actualTotal === best.line) continue;
    const pred = predictMlbGameRuns(model, features, { totalLine: best.line });
    const pf = Number(features.parkFactor) || 1;
    games.push({
      year: w.key,
      month: monthKey(row.commenceTime),
      commenceTime: row.commenceTime,
      gameId: row.gameId,
      homeMu: Number(pred.homeExpectedRuns),
      awayMu: Number(pred.awayExpectedRuns),
      mu: Number(pred.expectedTotal),
      dispersion,
      parkFactor: pf,
      parkBucket: parkBucket(pf),
      actualTotal,
      best,
      lines,
      lineCount: lines.length,
    });
  }
}
console.log('games', games.length);

// ─── 1) Path slice ─────────────────────────────────────────────
console.log('audit1 path slice…');
const baselineBets = [];
for (const g of games) {
  const pick = classifyHybridOnBest(g);
  if (pick) baselineBets.push(pick);
}

function applyPolicy(bets, policyId) {
  const out = [];
  for (const b of bets) {
    if (policyId === 'baseline_hybrid') {
      out.push({ ...b, stakeUsd: STAKE });
      continue;
    }
    if (policyId === 'drop_raw_over') {
      if (b.hybridPath === 'raw_over') continue;
      out.push({ ...b, stakeUsd: STAKE });
      continue;
    }
    if (policyId === 'drop_mid_raw_over') {
      if (b.hybridPath === 'raw_over' && b.parkBucket === 'mid') continue;
      out.push({ ...b, stakeUsd: STAKE });
      continue;
    }
    if (policyId === 'drop_mid_hitter_raw_over') {
      if (
        b.hybridPath === 'raw_over' &&
        (b.parkBucket === 'mid' || b.parkBucket === 'hitter')
      ) {
        continue;
      }
      out.push({ ...b, stakeUsd: STAKE });
      continue;
    }
    if (policyId === 'raw_over_half_stake') {
      if (b.hybridPath === 'raw_over') {
        out.push({ ...b, stakeUsd: 25 });
      } else {
        out.push({ ...b, stakeUsd: STAKE });
      }
      continue;
    }
  }
  return out;
}

const pathKeys = [
  'raw_under',
  'pitcher_debiased_over',
  'raw_over',
];
const pathSlice = {
  byPath: {},
  byPathPark: {},
  policies: {},
};
for (const k of pathKeys) {
  const subset = baselineBets.filter((b) => b.hybridPath === k);
  pathSlice.byPath[k] = {
    ...summarize(subset),
    byYear: byYear(subset),
    monthStab: monthlyRoiSignStability(subset),
  };
}
for (const k of pathKeys) {
  for (const pb of ['pitcher', 'mid', 'hitter']) {
    const subset = baselineBets.filter(
      (b) => b.hybridPath === k && b.parkBucket === pb
    );
    if (!subset.length) continue;
    pathSlice.byPathPark[`${k}__${pb}`] = {
      ...summarize(subset),
      byYear: byYear(subset),
      monthStab: monthlyRoiSignStability(subset),
    };
  }
}

const policies = [
  'baseline_hybrid',
  'drop_raw_over',
  'drop_mid_raw_over',
  'drop_mid_hitter_raw_over',
  'raw_over_half_stake',
];
for (const pid of policies) {
  const bets = applyPolicy(baselineBets, pid);
  const under = bets.filter((b) => b.side === 'under');
  const over = bets.filter((b) => b.side === 'over');
  const threePos = ['2024', '2025', '2026'].every(
    (y) => (byYear(bets)[y].roi ?? -1) >= 0
  );
  const threePosOver = ['2024', '2025', '2026'].every(
    (y) => (byYear(over)[y].roi ?? -1) >= 0
  );
  pathSlice.policies[pid] = {
    both: {
      ...summarize(bets),
      byYear: byYear(bets),
      monthStab: monthlyRoiSignStability(bets),
    },
    under: { ...summarize(under), byYear: byYear(under) },
    over: { ...summarize(over), byYear: byYear(over) },
    threePosBoth: threePos,
    threePosOver,
    deltaUsdVsBaseline: null,
  };
}
const baseUsd = pathSlice.policies.baseline_hybrid.both.usd50;
for (const pid of policies) {
  pathSlice.policies[pid].deltaUsdVsBaseline =
    pathSlice.policies[pid].both.usd50 - baseUsd;
}

// ─── 2) Exec line map ──────────────────────────────────────────
console.log('audit2 exec line map…');
const signalBets = baselineBets;
let mapStats = {
  signals: signalBets.length,
  hasAltMinus: 0,
  hasAltPlus: 0,
  hasEitherAlt: 0,
  lineCountHist: {},
};

const execModes = {
  stay_best: [],
  map_nearest_alt_reclassify: [],
  reject_if_no_exact_user_ladder: [],
  synthetic_pm05_keep_if_still_actionable: [],
};

for (const g of games) {
  const sig = classifyHybridOnBest(g);
  if (!sig) continue;
  const L = g.best.line;
  const histKey = String(g.lineCount);
  mapStats.lineCountHist[histKey] = (mapStats.lineCountHist[histKey] || 0) + 1;

  const lineM = g.lines.find((x) => Math.abs(x.line - (L - 0.5)) < 1e-9);
  const lineP = g.lines.find((x) => Math.abs(x.line - (L + 0.5)) < 1e-9);
  if (lineM) mapStats.hasAltMinus += 1;
  if (lineP) mapStats.hasAltPlus += 1;
  if (lineM || lineP) mapStats.hasEitherAlt += 1;

  execModes.stay_best.push({ ...sig, mapMode: 'stay_best' });

  // nearest alt: prefer same direction difficulty — Over prefers lower line if exist else higher
  let mappedLine = null;
  if (sig.side === 'over') {
    mappedLine = lineM || lineP || null;
  } else {
    mappedLine = lineP || lineM || null;
  }

  if (mappedLine && Math.abs(mappedLine.line - L) > 1e-9) {
    const path = sig.hybridPath;
    const adj =
      path === 'pitcher_debiased_over'
        ? adjForOverPath(g, path)
        : { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu };
    const minGap = sig.side === 'over' ? OVER_GAP : UNDER_GAP;
    const remapped = trySideOnLine(g, adj, sig.side, minGap, mappedLine);
    if (remapped) {
      execModes.map_nearest_alt_reclassify.push({
        ...remapped,
        hybridPath: path,
        stakeUsd: STAKE,
        mapMode: 'map_nearest_alt_reclassify',
        fromLine: L,
      });
    }
  } else {
    // no alt in PIT — stay on best (executable as-is in odds data)
    execModes.map_nearest_alt_reclassify.push({
      ...sig,
      mapMode: 'map_nearest_alt_unavailable_stay',
    });
  }

  // reject if book only has half-lines and signal is integer (or vice versa):
  // proxy: if user ladder assumed = all half-lines (.5) and signal line is integer
  const isHalf = Math.abs(L * 2 - Math.round(L * 2)) > 1e-9 || L % 1 !== 0;
  const lineIsInteger = Math.abs(L - Math.round(L)) < 1e-9;
  // For rigor: if signal line has no sibling ±0.5 in PIT, treat as "may not match user book"
  if (lineM || lineP) {
    execModes.reject_if_no_exact_user_ladder.push({
      ...sig,
      mapMode: 'has_ladder_keep',
    });
  }
  // else reject (don't bet)
  void isHalf;
  void lineIsInteger;

  // synthetic ±0.5: invent odds by copying best vig prices (conservative proxy)
  const synthTargets =
    sig.side === 'over' ? [L - 0.5, L + 0.5] : [L + 0.5, L - 0.5];
  let keptSynth = false;
  for (const t of synthTargets) {
    if (t > BASE.maxTotalLine) continue;
    const existing = g.lines.find((x) => Math.abs(x.line - t) < 1e-9);
    const synth = existing || {
      line: t,
      overOdds: g.best.overOdds,
      underOdds: g.best.underOdds,
      fairOver: g.best.fairOver,
      fairUnder: g.best.fairUnder,
      vig: g.best.vig,
    };
    const path = sig.hybridPath;
    const adj =
      path === 'pitcher_debiased_over'
        ? adjForOverPath(g, path)
        : { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu };
    const minGap = sig.side === 'over' ? OVER_GAP : UNDER_GAP;
    const remapped = trySideOnLine(g, adj, sig.side, minGap, synth);
    if (remapped) {
      execModes.synthetic_pm05_keep_if_still_actionable.push({
        ...remapped,
        hybridPath: path,
        stakeUsd: STAKE,
        mapMode: existing ? 'real_alt' : 'synthetic_odds_proxy',
        fromLine: L,
      });
      keptSynth = true;
      break;
    }
  }
  if (!keptSynth) {
    // reject — no push into synthetic list
  }
}

mapStats.hasEitherAltRate = signalBets.length
  ? Number((mapStats.hasEitherAlt / signalBets.length).toFixed(4))
  : null;

const execLineMap = {
  coverage: mapStats,
  modes: {},
};
for (const [mode, bets] of Object.entries(execModes)) {
  const over = bets.filter((b) => b.side === 'over');
  const under = bets.filter((b) => b.side === 'under');
  execLineMap.modes[mode] = {
    both: {
      ...summarize(bets),
      byYear: byYear(bets),
      monthStab: monthlyRoiSignStability(bets),
    },
    over: { ...summarize(over), byYear: byYear(over) },
    under: { ...summarize(under), byYear: byYear(under) },
    coverageVsSignals: signalBets.length
      ? Number((bets.length / signalBets.length).toFixed(4))
      : null,
  };
}

// ─── 3) Over·raw fragility ─────────────────────────────────────
console.log('audit3 over raw fragility…');
const rawOver = baselineBets.filter((b) => b.hybridPath === 'raw_over');

function quantileEdges(arr, q) {
  if (!arr.length) return [];
  const s = [...arr].sort((a, b) => a - b);
  const edges = [];
  for (let i = 1; i < q; i += 1) {
    const idx = Math.floor((i / q) * (s.length - 1));
    edges.push(s[idx]);
  }
  return edges;
}

function bucketByEdges(x, edges, labels) {
  for (let i = 0; i < edges.length; i += 1) {
    if (x <= edges[i]) return labels[i];
  }
  return labels[labels.length - 1];
}

const gapEdges = quantileEdges(
  rawOver.map((b) => b.absGap),
  5
);
const gapLabels = ['q1', 'q2', 'q3', 'q4', 'q5'];
const muLineEdges = quantileEdges(
  rawOver.map((b) => b.muRaw - b.line),
  5
);

function lineBand(line) {
  if (line <= 8.5) return 'le_8.5';
  if (line <= 9.5) return '9_to_9.5';
  return 'ge_10';
}

const fragility = {
  n: rawOver.length,
  overall: {
    ...summarize(rawOver),
    byYear: byYear(rawOver),
    monthStab: monthlyRoiSignStability(rawOver),
  },
  byParkBucket: {},
  byLineBand: {},
  byGapQuintile: {},
  byMuMinusLineQuintile: {},
  thinEdgeHighVolume: null,
};

for (const pb of ['mid', 'hitter', 'pitcher']) {
  const subset = rawOver.filter((b) => b.parkBucket === pb);
  if (!subset.length) continue;
  fragility.byParkBucket[pb] = {
    ...summarize(subset),
    byYear: byYear(subset),
    monthStab: monthlyRoiSignStability(subset),
  };
}
for (const band of ['le_8.5', '9_to_9.5', 'ge_10']) {
  const subset = rawOver.filter((b) => lineBand(b.line) === band);
  if (!subset.length) continue;
  fragility.byLineBand[band] = {
    ...summarize(subset),
    byYear: byYear(subset),
    monthStab: monthlyRoiSignStability(subset),
  };
}

const gapLabeled = rawOver.map((b) => ({
  ...b,
  gapQ: bucketByEdges(b.absGap, gapEdges, gapLabels),
}));
for (const lab of gapLabels) {
  const subset = gapLabeled.filter((b) => b.gapQ === lab);
  if (!subset.length) continue;
  fragility.byGapQuintile[lab] = {
    edgeRangeHint:
      lab === 'q1'
        ? `<=${gapEdges[0]?.toFixed?.(3) ?? '?'}`
        : lab === 'q5'
          ? `>${gapEdges[gapEdges.length - 1]?.toFixed?.(3) ?? '?'}`
          : 'mid',
    ...summarize(subset),
    byYear: byYear(subset),
    monthStab: monthlyRoiSignStability(subset),
  };
}

const mlLabeled = rawOver.map((b) => ({
  ...b,
  mlQ: bucketByEdges(b.muRaw - b.line, muLineEdges, gapLabels),
}));
for (const lab of gapLabels) {
  const subset = mlLabeled.filter((b) => b.mlQ === lab);
  if (!subset.length) continue;
  fragility.byMuMinusLineQuintile[lab] = {
    ...summarize(subset),
    byYear: byYear(subset),
    monthStab: monthlyRoiSignStability(subset),
  };
}

// thin edge = lowest two gap quintiles combined
const thin = gapLabeled.filter((b) => b.gapQ === 'q1' || b.gapQ === 'q2');
const thick = gapLabeled.filter((b) => b.gapQ === 'q4' || b.gapQ === 'q5');
fragility.thinEdgeHighVolume = {
  definition: 'raw_over gap quintiles q1+q2 vs q4+q5',
  gapEdges,
  thin: {
    ...summarize(thin),
    byYear: byYear(thin),
    monthStab: monthlyRoiSignStability(thin),
  },
  thick: {
    ...summarize(thick),
    byYear: byYear(thick),
    monthStab: monthlyRoiSignStability(thick),
  },
};

// ─── Verdict helpers ───────────────────────────────────────────
const drop = pathSlice.policies.drop_raw_over;
const half = pathSlice.policies.raw_over_half_stake;
const base = pathSlice.policies.baseline_hybrid;
const rawPath = pathSlice.byPath.raw_over;
const debPath = pathSlice.byPath.pitcher_debiased_over;

const verdict = {
  pathSlice: {
    rawOverRoi: rawPath?.roi ?? null,
    pitcherDebiasedOverRoi: debPath?.roi ?? null,
    rawWeakerThanDebiased:
      rawPath?.roi != null &&
      debPath?.roi != null &&
      rawPath.roi < debPath.roi,
    dropRawOverDeltaUsd: drop?.deltaUsdVsBaseline ?? null,
    dropRawOverThreePos: drop?.threePosBoth ?? null,
    dropRawOverMonthPosRate: drop?.both?.monthStab?.positiveRate ?? null,
    baselineMonthPosRate: base?.both?.monthStab?.positiveRate ?? null,
    halfStakeDeltaUsd: half?.deltaUsdVsBaseline ?? null,
    recommend:
      drop &&
      drop.threePosBoth &&
      (drop.both.monthStab?.positiveRate ?? 0) >=
        (base.both.monthStab?.positiveRate ?? 0) &&
      drop.deltaUsdVsBaseline >= -200
        ? 'shadow_drop_or_downweight_raw_over'
        : drop && drop.deltaUsdVsBaseline > 0
          ? 'shadow_candidate_review_volume'
          : 'keep_baseline_research_only_no_promote',
  },
  execLineMap: {
    altCoverage: mapStats.hasEitherAltRate,
    stayUsd: execLineMap.modes.stay_best?.both?.usd50 ?? null,
    mapNearestUsd:
      execLineMap.modes.map_nearest_alt_reclassify?.both?.usd50 ?? null,
    synthKeepUsd:
      execLineMap.modes.synthetic_pm05_keep_if_still_actionable?.both?.usd50 ??
      null,
    synthCoverage:
      execLineMap.modes.synthetic_pm05_keep_if_still_actionable
        ?.coverageVsSignals ?? null,
    recommend:
      (mapStats.hasEitherAltRate ?? 0) < 0.3
        ? 'need_live_book_ladder_spec_pit_alts_sparse'
        : 'define_exec_map_spec_reclassify_or_reject',
  },
  fragility: {
    midRoi: fragility.byParkBucket.mid?.roi ?? null,
    hitterRoi: fragility.byParkBucket.hitter?.roi ?? null,
    thinRoi: fragility.thinEdgeHighVolume?.thin?.roi ?? null,
    thickRoi: fragility.thinEdgeHighVolume?.thick?.roi ?? null,
    recommend: 'use_slices_to_choose_cut_path_vs_half_stake',
  },
  doNot: [
    'global_mu_offset_to_line',
    'raise_gap_from_single_4run_game',
    'mix_totals_into_locked_b_topk',
    'change_locked_constants_without_shadow',
  ],
};

const out = {
  experimentId: 'hybrid_rigor_three_v1',
  frozen: {
    pitcherParkMuMinusLineOffset: FROZEN_PO,
    overMinAbsGap: OVER_GAP,
    underMinAbsGap: UNDER_GAP,
    stakeUsd: STAKE,
    windows: WINDOWS,
  },
  nGames: games.length,
  nBaselineBets: baselineBets.length,
  audit1_pathSlice: pathSlice,
  audit2_execLineMap: execLineMap,
  audit3_overRawFragility: fragility,
  verdict,
};

fs.writeFileSync(
  'tmp-totals-hybrid-rigor-three.json',
  JSON.stringify(out, null, 2)
);

function brief(s) {
  if (!s) return 'n/a';
  return `n=${s.bets} hr=${s.hitRate} roi=${s.roi} $=${s.usd50}`;
}

console.log('\n=== AUDIT1 path slice ===');
for (const k of pathKeys) {
  console.log(k, brief(pathSlice.byPath[k]));
}
for (const pid of policies) {
  const p = pathSlice.policies[pid];
  console.log(
    pid,
    brief(p.both),
    'Δ$',
    p.deltaUsdVsBaseline,
    '3y+',
    p.threePosBoth,
    'month+',
    p.both.monthStab?.positiveRate
  );
}

console.log('\n=== AUDIT2 exec line map ===');
console.log('altCoverage', mapStats.hasEitherAltRate, mapStats);
for (const [mode, m] of Object.entries(execLineMap.modes)) {
  console.log(mode, brief(m.both), 'cov', m.coverageVsSignals);
}

console.log('\n=== AUDIT3 raw_over fragility ===');
console.log('overall', brief(fragility.overall));
console.log('byPark', JSON.stringify(fragility.byParkBucket, null, 0).slice(0, 500));
console.log('thin', brief(fragility.thinEdgeHighVolume.thin));
console.log('thick', brief(fragility.thinEdgeHighVolume.thick));
console.log('\nVERDICT', JSON.stringify(verdict, null, 2));
console.log('\nwrote tmp-totals-hybrid-rigor-three.json');
