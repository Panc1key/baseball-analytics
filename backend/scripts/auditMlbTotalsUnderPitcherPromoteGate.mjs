/**
 * 升格前硬核驗：Under×投手公園
 * - 三年窗各自 Δ$
 * - 月級 ROI 正占比
 * - 對照：同公園 Over 去偏必須仍健康（證明不是「投手公園全毒」）
 * - 對照：Under×mid/hitter 必須仍健康（證明不是「Under 全毒」）
 *
 * 用法: node scripts/auditMlbTotalsUnderPitcherPromoteGate.mjs
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
import { matchesTotalsUnderPitcher } from '../src/services/MlbTotalsUnderPitcherShadow.js';

const BASE = MLB_TOTALS_SATELLITE_SPEC.rules;
const HYBRID = MLB_TOTALS_SATELLITE_HYBRID_SPEC;
const STAKE = 50;
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

function summarize(bets) {
  if (!bets.length) {
    return { n: 0, hits: 0, hr: null, roi: null, usd: 0 };
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
    n,
    hits,
    hr: Number(((hits / n) * 100).toFixed(2)),
    roi: Number(((unit / n) * 100).toFixed(2)),
    usd: Math.round(unit * STAKE),
  };
}

function monthKey(iso) {
  const d = String(iso || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(d) ? d : null;
}

function monthlyPosRate(bets) {
  const byM = new Map();
  for (const b of bets) {
    if (!b.month) continue;
    if (!byM.has(b.month)) byM.set(b.month, []);
    byM.get(b.month).push(b);
  }
  const months = [...byM.entries()].map(([m, arr]) => ({
    month: m,
    ...summarize(arr),
  }));
  const pos = months.filter((x) => (x.roi ?? -1) >= 0).length;
  return {
    months: months.length,
    positiveMonths: pos,
    positiveRate: months.length
      ? Number((pos / months.length).toFixed(3))
      : null,
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
    ev,
    modelProb,
    line,
    parkFactor: g.parkFactor,
    parkBucket: g.parkBucket,
  };
}

function classifyHybridV11(g) {
  const best = g.best;
  const rawAdj = { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu };
  const u = trySideOnLine(g, rawAdj, 'under', UNDER_GAP, best);
  if (u) {
    return {
      ...u,
      hybridPath: 'raw_under',
      tier: 'actionable',
    };
  }
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
    if (o) {
      return {
        ...o,
        hybridPath: 'pitcher_debiased_over',
        tier: 'actionable',
      };
    }
  } else {
    const o = trySideOnLine(g, rawAdj, 'over', OVER_GAP, best);
    if (o) {
      if (o.absGap > RAW_OVER_MAX) return null;
      return { ...o, hybridPath: 'raw_over', tier: 'actionable' };
    }
  }
  return null;
}

console.log('[promote-gate] load…');
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
    if (!best || actualTotal === best.line) continue;
    const pred = predictMlbGameRuns(model, features, { totalLine: best.line });
    const pf = Number(features.parkFactor) || 1;
    games.push({
      year: w.key,
      month: monthKey(row.commenceTime),
      homeMu: Number(pred.homeExpectedRuns),
      awayMu: Number(pred.awayExpectedRuns),
      mu: Number(pred.expectedTotal),
      dispersion,
      parkFactor: pf,
      parkBucket: parkBucket(pf),
      actualTotal,
      best,
    });
  }
}

const base = [];
for (const g of games) {
  const p = classifyHybridV11(g);
  if (p) base.push(p);
}

const isCut = (b) =>
  matchesTotalsUnderPitcher({
    tier: 'actionable',
    side: b.side,
    hybridPath: b.hybridPath,
    parkFactor: b.parkFactor,
    parkBucket: b.parkBucket,
  });

const cut = base.filter(isCut);
const kept = base.filter((b) => !isCut(b));
const baseS = summarize(base);
const keptS = summarize(kept);
const cutS = summarize(cut);

const byYear = {};
for (const y of ['2024', '2025', '2026']) {
  const bY = base.filter((x) => x.year === y);
  const kY = kept.filter((x) => x.year === y);
  const cY = cut.filter((x) => x.year === y);
  byYear[y] = {
    baseline: summarize(bY),
    kept: summarize(kY),
    cut: summarize(cY),
    deltaUsd: summarize(kY).usd - summarize(bY).usd,
  };
}

const controls = {
  underMidHitter: summarize(
    base.filter(
      (b) =>
        b.hybridPath === 'raw_under' &&
        (b.parkBucket === 'mid' || b.parkBucket === 'hitter')
    )
  ),
  pitcherDebiasedOver: summarize(
    base.filter((b) => b.hybridPath === 'pitcher_debiased_over')
  ),
  rawOver: summarize(base.filter((b) => b.hybridPath === 'raw_over')),
};

const monthBase = monthlyPosRate(base);
const monthKept = monthlyPosRate(kept);
const monthCut = monthlyPosRate(cut);

/** 升格閘：務實、防幻覺 */
const gates = {
  cutClearlyWeak:
    cutS.n >= 30 && (cutS.roi ?? 0) < 0 && (cutS.hr ?? 100) <= 50,
  overallDeltaNonNegative: keptS.usd - baseS.usd >= 0,
  hrImproves: (keptS.hr ?? 0) - (baseS.hr ?? 0) >= 0.4,
  roiImproves: (keptS.roi ?? 0) - (baseS.roi ?? 0) >= 0.5,
  /** 允許單年小負，但不許兩年都明顯負 */
  yearsNotSystemicallyHurt:
    ['2024', '2025', '2026'].filter((y) => (byYear[y].deltaUsd ?? 0) < -150)
      .length === 0 &&
    ['2024', '2025', '2026'].filter((y) => (byYear[y].deltaUsd ?? 0) >= 0)
      .length >= 2,
  /** 對照仍健康：證明病灶是交叉項不是整類 */
  underElsewhereHealthy: (controls.underMidHitter.roi ?? 0) >= 8,
  pitcherOverHealthy: (controls.pitcherDebiasedOver.roi ?? 0) >= 8,
  rawOverHealthy: (controls.rawOver.roi ?? 0) >= 8,
  monthKeptNotWorse:
    (monthKept.positiveRate ?? 0) + 0.02 >= (monthBase.positiveRate ?? 0),
  matchFnAgreesWithPath:
    cut.every((b) => b.hybridPath === 'raw_under' && b.parkBucket === 'pitcher') &&
    cut.length ===
      base.filter(
        (b) => b.hybridPath === 'raw_under' && b.parkBucket === 'pitcher'
      ).length,
};

const failKeys = Object.entries(gates)
  .filter(([, v]) => !v)
  .map(([k]) => k);
const pass = failKeys.length === 0;

const out = {
  experimentId: 'totals-under-pitcher-promote-gate-2026-08-06',
  pass,
  failKeys,
  recommendApply: pass,
  baseline: baseS,
  kept: keptS,
  cut: cutS,
  deltaUsd: keptS.usd - baseS.usd,
  deltaHrPp: Number(((keptS.hr ?? 0) - (baseS.hr ?? 0)).toFixed(2)),
  deltaRoiPp: Number(((keptS.roi ?? 0) - (baseS.roi ?? 0)).toFixed(2)),
  byYear,
  controls,
  monthStab: { baseline: monthBase, kept: monthKept, cut: monthCut },
  gates,
  plain: pass
    ? '閘門全過：病灶是「Under×投手公園」交叉項，不是幻覺；可 apply（仍可一鍵回退）'
    : `未過閘：${failKeys.join(', ')} — 維持 compare，勿當正式優化`,
};

fs.writeFileSync(
  new URL('../tmp-totals-under-pitcher-promote-gate.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log(JSON.stringify(out, null, 2));
