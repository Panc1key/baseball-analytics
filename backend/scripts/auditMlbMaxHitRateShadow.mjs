/**
 * 勝率最大化影子組合（單場腿命中率；服務串關）
 * 基準＝正式：手術 B + Under×投手
 *
 * 用法: node scripts/auditMlbMaxHitRateShadow.mjs
 * 產物: tmp-max-hitrate-shadow.json
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
import { buildFrozenBShadowPickSets } from '../src/services/MlbFrozenBShadow.js';
import {
  MLB_TOTALS_SATELLITE_SPEC,
  MLB_TOTALS_SATELLITE_HYBRID_SPEC,
} from '../src/services/MlbTotalsSatellite.js';
import { MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC } from '../src/services/MlbSurgicalAwayR1MidoddsShadow.js';
import { MLB_WINRATE_STRONG_HOME_SPEC } from '../src/services/MlbWinrateStrongHomeShadow.js';

const STAKE = 50;
const BASE = MLB_TOTALS_SATELLITE_SPEC.rules;
const HYBRID = MLB_TOTALS_SATELLITE_HYBRID_SPEC;
const FROZEN_PO = Number(HYBRID.pitcherParkMuMinusLineOffset) || 0.7;
const OVER_GAP = Number(HYBRID.overMinAbsGap) || 0.9;
const UNDER_GAP = Number(BASE.minAbsGap) || 0.6;
const PF_MAX = Number(HYBRID.pitcherParkFactorMax) || 0.97;
const RAW_OVER_MAX = Number(HYBRID.rawOverMaxAbsGap) || 1.25;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hits: 0, hitRate: null, roi: null, usd50: 0 };
  }
  let hits = 0;
  let unit = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hits,
    hitRate: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
  };
}

function applyCuts(base, preds) {
  return base.filter((b) => !preds.some((p) => p(b)));
}

function report(base, kept, id) {
  const bS = summarize(base);
  const kS = summarize(kept);
  return {
    id,
    cutN: base.length - kept.length,
    cutPct: Number(
      (((base.length - kept.length) / Math.max(1, base.length)) * 100).toFixed(1)
    ),
    baseline: bS,
    kept: kS,
    deltaHrPp: Number((((kS.hitRate ?? 0) - (bS.hitRate ?? 0)) * 100).toFixed(2)),
    deltaRoiPp: Number((((kS.roi ?? 0) - (bS.roi ?? 0)) * 100).toFixed(2)),
    deltaUsd50: kS.usd50 - bS.usd50,
  };
}

// ─── load ML ───────────────────────────────────────────────
console.log('[maxHR] ML…');
const { shadow: mlRaw } = buildFrozenBShadowPickSets({});
const rB = MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC.rule;
const isSurgB = (b) =>
  !b.pickHome &&
  b.rank === rB.rank &&
  b.pickOdds >= rB.minOdds &&
  b.pickOdds < rB.maxOddsExclusive;

const mlFormal = mlRaw
  .filter((b) => !isSurgB(b))
  .map((b) => ({
    ...b,
    marketProb: Number.isFinite(Number(b.marketProb))
      ? Number(b.marketProb)
      : 1 / b.pickOdds,
  }));

const mlCuts = {
  strongHome: (b) =>
    !b.pickHome &&
    Number(b.homeWinPct) >= MLB_WINRATE_STRONG_HOME_SPEC.strongHomeWinPct &&
    Number(b.ev) >= MLB_WINRATE_STRONG_HOME_SPEC.minEv,
  strongHome065: (b) =>
    !b.pickHome && Number(b.homeWinPct) >= 0.65 && Number(b.ev) >= 0.1,
  surgA065: (b) =>
    !b.pickHome && Number(b.homeWinPct) >= 0.65 && Number(b.ev) >= 0.1,
  // 高 EV 客（不限強主）— 試抬勝率
  awayEv15: (b) => !b.pickHome && Number(b.ev) >= 0.15,
  awayEv12: (b) => !b.pickHome && Number(b.ev) >= 0.12,
  awayEv10: (b) => !b.pickHome && Number(b.ev) >= 0.1,
  // R1 高 EV 客
  r1AwayEv10: (b) =>
    !b.pickHome && b.rank === 1 && Number(b.ev) >= 0.1,
  r1AwayEv12: (b) =>
    !b.pickHome && b.rank === 1 && Number(b.ev) >= 0.12,
};

const mlSingle = Object.entries(mlCuts).map(([id, pred]) =>
  report(mlFormal, applyCuts(mlFormal, [pred]), id)
);
mlSingle.sort((a, b) => b.deltaHrPp - a.deltaHrPp || b.deltaUsd50 - a.deltaUsd50);

const mlCombos = [
  { id: 'strongHome', preds: [mlCuts.strongHome] },
  { id: 'strongHome065', preds: [mlCuts.strongHome065] },
  { id: 'strongHome+awayEv15', preds: [mlCuts.strongHome, mlCuts.awayEv15] },
  { id: 'strongHome+r1AwayEv12', preds: [mlCuts.strongHome, mlCuts.r1AwayEv12] },
  { id: 'awayEv12', preds: [mlCuts.awayEv12] },
  { id: 'awayEv15', preds: [mlCuts.awayEv15] },
].map((c) => report(mlFormal, applyCuts(mlFormal, c.preds), c.id));
mlCombos.sort((a, b) => b.deltaHrPp - a.deltaHrPp || b.deltaUsd50 - a.deltaUsd50);

console.log(
  '[maxHR] ML singles by HR',
  mlSingle.slice(0, 6).map((x) => ({
    id: x.id,
    cutN: x.cutN,
    dHr: x.deltaHrPp,
    dRoi: x.deltaRoiPp,
    dUsd: x.deltaUsd50,
    hr: x.kept.hitRate,
  }))
);

// ─── load totals ───────────────────────────────────────────
function collectTotalsLines(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return [];
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
  return [...byLine.values()];
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
function readPitcherMeta(features) {
  const homeEra = Number(
    features?.pitchers?.home?.era ?? features?.home?.pitcher?.era
  );
  const awayEra = Number(
    features?.pitchers?.away?.era ?? features?.away?.pitcher?.era
  );
  const eras = [homeEra, awayEra].filter((x) => Number.isFinite(x));
  const maxEra = eras.length ? Math.max(...eras) : null;
  const homeR3 = Number(
    features?.pitchers?.home?.recent3Era ??
      features?.pitchers?.homeRecent?.recent3Era ??
      features?.home?.pitcherRecent?.recent3Era
  );
  const awayR3 = Number(
    features?.pitchers?.away?.recent3Era ??
      features?.pitchers?.awayRecent?.recent3Era ??
      features?.away?.pitcherRecent?.recent3Era
  );
  const r3s = [homeR3, awayR3].filter((x) => Number.isFinite(x));
  const blowups = [
    Number(features?.pitchers?.home?.blowupStartsLast3),
    Number(features?.pitchers?.away?.blowupStartsLast3),
    Number(features?.pitchers?.homeRecent?.blowupStartsLast3),
    Number(features?.pitchers?.awayRecent?.blowupStartsLast3),
  ].filter((x) => Number.isFinite(x));
  return {
    maxEra,
    maxR3: r3s.length ? Math.max(...r3s) : null,
    maxBlowup: blowups.length ? Math.max(...blowups) : 0,
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
    side,
    pickOdds,
    hit: side === actualSide,
    absGap: Math.abs(gap),
    ev,
    line,
    parkFactor: g.parkFactor,
    parkBucket: g.parkBucket,
    maxEra: g.maxEra,
    maxR3: g.maxR3,
    maxBlowup: g.maxBlowup,
    hybridPath: null,
  };
}
function classifyHybridV11(g) {
  const best = g.best;
  const rawAdj = { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu };
  const u = trySideOnLine(g, rawAdj, 'under', UNDER_GAP, best);
  if (u) return { ...u, hybridPath: 'raw_under' };
  if (g.parkBucket === 'pitcher') {
    const h = Math.max(0.5, g.homeMu - FROZEN_PO / 2);
    const a = Math.max(0.5, g.awayMu - FROZEN_PO / 2);
    const o = trySideOnLine(
      g,
      { homeMu: h, awayMu: a, mu: h + a },
      'over',
      OVER_GAP,
      best
    );
    if (o) return { ...o, hybridPath: 'pitcher_debiased_over' };
  } else {
    const o = trySideOnLine(g, rawAdj, 'over', OVER_GAP, best);
    if (o) {
      if (o.absGap > RAW_OVER_MAX) return null;
      return { ...o, hybridPath: 'raw_over' };
    }
  }
  return null;
}

console.log('[maxHR] totals…');
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
    const best = bestLine(collectTotalsLines(row.gameId, row.commenceTime));
    if (!best || actualTotal === best.line) continue;
    const pred = predictMlbGameRuns(model, features, { totalLine: best.line });
    const pf = Number(features.parkFactor) || 1;
    games.push({
      year: w.key,
      homeMu: Number(pred.homeExpectedRuns),
      awayMu: Number(pred.awayExpectedRuns),
      mu: Number(pred.expectedTotal),
      dispersion,
      parkFactor: pf,
      parkBucket: parkBucket(pf),
      actualTotal,
      best,
      ...readPitcherMeta(features),
    });
  }
}
const totRaw = [];
for (const g of games) {
  const p = classifyHybridV11(g);
  if (p) totRaw.push(p);
}
const totFormal = totRaw.filter(
  (b) => !(b.hybridPath === 'raw_under' && b.parkBucket === 'pitcher')
);

const totCuts = {
  fragile50: (b) => b.side === 'under' && (b.maxEra ?? -1) >= 5,
  fragile48: (b) => b.side === 'under' && (b.maxEra ?? -1) >= 4.8,
  blowupGap08: (b) =>
    b.side === 'under' && (b.maxBlowup ?? 0) >= 1 && Number(b.absGap) < 0.8,
  blowupGap10: (b) =>
    b.side === 'under' && (b.maxBlowup ?? 0) >= 1 && Number(b.absGap) < 1.0,
  r3_55_gap08: (b) =>
    b.side === 'under' && (b.maxR3 ?? -1) >= 5.5 && Number(b.absGap) < 0.8,
  underEv25: (b) => b.side === 'under' && Number(b.ev) >= 0.25,
  underEv20: (b) => b.side === 'under' && Number(b.ev) >= 0.2,
};

const totSingle = Object.entries(totCuts).map(([id, pred]) =>
  report(totFormal, applyCuts(totFormal, [pred]), id)
);
totSingle.sort((a, b) => b.deltaHrPp - a.deltaHrPp || b.deltaUsd50 - a.deltaUsd50);

const totCombos = [
  { id: 'fragile50', preds: [totCuts.fragile50] },
  { id: 'fragile50+blowupGap10', preds: [totCuts.fragile50, totCuts.blowupGap10] },
  { id: 'fragile50+blowupGap08', preds: [totCuts.fragile50, totCuts.blowupGap08] },
  { id: 'fragile48+blowupGap10', preds: [totCuts.fragile48, totCuts.blowupGap10] },
  {
    id: 'fragile50+blowupGap10+underEv25',
    preds: [totCuts.fragile50, totCuts.blowupGap10, totCuts.underEv25],
  },
  { id: 'fragile50+underEv25', preds: [totCuts.fragile50, totCuts.underEv25] },
  { id: 'blowupGap10+underEv25', preds: [totCuts.blowupGap10, totCuts.underEv25] },
].map((c) => report(totFormal, applyCuts(totFormal, c.preds), c.id));
totCombos.sort((a, b) => b.deltaHrPp - a.deltaHrPp || b.deltaUsd50 - a.deltaUsd50);

console.log(
  '[maxHR] Tot singles by HR',
  totSingle.slice(0, 6).map((x) => ({
    id: x.id,
    cutN: x.cutN,
    dHr: x.deltaHrPp,
    dRoi: x.deltaRoiPp,
    dUsd: x.deltaUsd50,
    hr: x.kept.hitRate,
  }))
);
console.log(
  '[maxHR] Tot combos by HR',
  totCombos.map((x) => ({
    id: x.id,
    cutN: x.cutN,
    dHr: x.deltaHrPp,
    dRoi: x.deltaRoiPp,
    dUsd: x.deltaUsd50,
    hr: x.kept.hitRate,
  }))
);

// 組合包近似：獨贏+大小合併勝率（權重＝注數）
function packageHr(ml, tot) {
  const bets = ml.bets + tot.bets;
  const hits = ml.hits + tot.hits;
  return {
    bets,
    hits,
    hitRate: bets ? Number((hits / bets).toFixed(4)) : null,
    usd50: ml.usd50 + tot.usd50,
  };
}

const formalPkg = packageHr(summarize(mlFormal), summarize(totFormal));
const bestMl = mlCombos[0];
const bestTot = totCombos[0];
const balancedTot = totCombos
  .filter((x) => x.deltaHrPp >= 0.4 && x.deltaUsd50 >= -200)
  .sort((a, b) => b.deltaHrPp - a.deltaHrPp)[0] || totCombos.find((x) => x.id === 'fragile50');

const maxHrPkg = packageHr(bestMl.kept, bestTot.kept);
const balancedPkg = packageHr(
  report(mlFormal, applyCuts(mlFormal, [mlCuts.strongHome]), 'strongHome').kept,
  (balancedTot || bestTot).kept
);

// 2-leg parlay rough: p^2
function parlayLift(p0, p1) {
  return {
    singlePp: Number(((p1 - p0) * 100).toFixed(2)),
    twoLegPp: Number(((p1 * p1 - p0 * p0) * 100).toFixed(2)),
    threeLegPp: Number(((p1 ** 3 - p0 ** 3) * 100).toFixed(2)),
  };
}

const payload = {
  generatedAt: new Date().toISOString(),
  objective: 'maximize_hit_rate_for_parlay_legs',
  formalBaseline: {
    moneyline: summarize(mlFormal),
    totals: summarize(totFormal),
    package: formalPkg,
  },
  moneyline: { singles: mlSingle, combos: mlCombos, bestByHr: bestMl },
  totals: {
    singles: totSingle,
    combos: totCombos,
    bestByHr: bestTot,
    bestBalanced: balancedTot,
  },
  package: {
    maxHitRate: {
      mlKnife: bestMl.id,
      totKnife: bestTot.id,
      ...maxHrPkg,
      deltaHrPp: Number(
        (((maxHrPkg.hitRate ?? 0) - (formalPkg.hitRate ?? 0)) * 100).toFixed(2)
      ),
      deltaUsd50: maxHrPkg.usd50 - formalPkg.usd50,
      parlayApprox: parlayLift(formalPkg.hitRate, maxHrPkg.hitRate),
    },
    recommendedForParlay: {
      note: '勝率優先但避免美元崩：獨贏強主場 + 大小 Fragile±blowup',
      mlKnife: 'strongHome',
      totKnife: balancedTot?.id || 'fragile50',
      ...balancedPkg,
      deltaHrPp: Number(
        (((balancedPkg.hitRate ?? 0) - (formalPkg.hitRate ?? 0)) * 100).toFixed(2)
      ),
      deltaUsd50: balancedPkg.usd50 - formalPkg.usd50,
      parlayApprox: parlayLift(formalPkg.hitRate, balancedPkg.hitRate),
    },
  },
};

fs.writeFileSync(
  new URL('../tmp-max-hitrate-shadow.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);
console.log('[maxHR] package', JSON.stringify(payload.package, null, 2));
