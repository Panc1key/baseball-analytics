/**
 * 三類不可接受錯單 → 影子刀回放（勝率／ROI／@$50）
 * 基準：正式已套用 手術B + Under×投手 之後再疊新刀
 *
 * 用法: node scripts/auditMlbThreeErrorShadow.mjs
 * 產物: tmp-three-error-shadow.json
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

function summarize(bets, oddsKey = 'pickOdds') {
  if (!bets.length) {
    return { bets: 0, hits: 0, hitRate: null, roi: null, usd50: 0 };
  }
  let hits = 0;
  let unit = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b[oddsKey] - 1;
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

function knifeReport(base, pred, id) {
  const cut = base.filter(pred);
  const kept = base.filter((b) => !pred(b));
  const bS = summarize(base);
  const kS = summarize(kept);
  const cS = summarize(cut);
  const years = {};
  for (const y of ['2024', '2025', '2026']) {
    const bY = base.filter((b) => (b.window || b.year) === y);
    const kY = bY.filter((b) => !pred(b));
    years[y] = summarize(kY).usd50 - summarize(bY).usd50;
  }
  return {
    id,
    cutN: cut.length,
    cutPct: Number(((cut.length / Math.max(1, base.length)) * 100).toFixed(1)),
    cut: cS,
    kept: kS,
    deltaHrPp: Number((((kS.hitRate ?? 0) - (bS.hitRate ?? 0)) * 100).toFixed(2)),
    deltaRoiPp: Number((((kS.roi ?? 0) - (bS.roi ?? 0)) * 100).toFixed(2)),
    deltaUsd50: kS.usd50 - bS.usd50,
    byYearDeltaUsd50: years,
  };
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
  const maxR3 = r3s.length ? Math.max(...r3s) : null;
  const blowups = [
    Number(features?.pitchers?.home?.blowupStartsLast3),
    Number(features?.pitchers?.away?.blowupStartsLast3),
    Number(features?.pitchers?.homeRecent?.blowupStartsLast3),
    Number(features?.pitchers?.awayRecent?.blowupStartsLast3),
  ].filter((x) => Number.isFinite(x));
  const maxBlowup = blowups.length ? Math.max(...blowups) : 0;
  return { maxEra, maxR3, maxBlowup };
}

// ─── ML ────────────────────────────────────────────────────
console.log('[3err] frozen B moneyline…');
const { shadow: mlRawList } = buildFrozenBShadowPickSets({});
const rB = MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC.rule;
const isSurgB = (b) =>
  !b.pickHome &&
  b.rank === rB.rank &&
  b.pickOdds >= rB.minOdds &&
  b.pickOdds < rB.maxOddsExclusive;

const mlBase = mlRawList
  .filter((b) => !isSurgB(b))
  .map((b) => ({
    ...b,
    marketProb: Number.isFinite(Number(b.marketProb))
      ? Number(b.marketProb)
      : 1 / b.pickOdds,
  }));

const isStrongHome = (b) =>
  !b.pickHome &&
  Number(b.homeWinPct) >= MLB_WINRATE_STRONG_HOME_SPEC.strongHomeWinPct &&
  Number(b.ev) >= MLB_WINRATE_STRONG_HOME_SPEC.minEv;

function isMarketDisagreeAway(b, spec) {
  if (b.pickHome) return false;
  const modelP = Number(b.modelProb);
  const marketProb = Number(b.marketProb);
  if (!Number.isFinite(modelP) || !Number.isFinite(marketProb)) return false;
  const edge = modelP - marketProb;
  const hwp = Number(b.homeWinPct);
  return (
    marketProb <= spec.maxAwayMarketProb &&
    edge >= spec.minEdge &&
    Number.isFinite(hwp) &&
    hwp >= spec.minHomeWinPct
  );
}

const mlKnives = [
  { id: 'strong_home_skip_hwp062_ev10', pred: isStrongHome },
  {
    id: 'disagree_mkt047_edge08_hwp060',
    pred: (b) =>
      isMarketDisagreeAway(b, {
        maxAwayMarketProb: 0.47,
        minEdge: 0.08,
        minHomeWinPct: 0.6,
      }),
  },
  {
    id: 'disagree_mkt045_edge08_hwp060',
    pred: (b) =>
      isMarketDisagreeAway(b, {
        maxAwayMarketProb: 0.45,
        minEdge: 0.08,
        minHomeWinPct: 0.6,
      }),
  },
  {
    id: 'disagree_mkt047_edge10_hwp062',
    pred: (b) =>
      isMarketDisagreeAway(b, {
        maxAwayMarketProb: 0.47,
        minEdge: 0.1,
        minHomeWinPct: 0.62,
      }),
  },
  {
    id: 'disagree_mkt047_edge08_hwp058',
    pred: (b) =>
      isMarketDisagreeAway(b, {
        maxAwayMarketProb: 0.47,
        minEdge: 0.08,
        minHomeWinPct: 0.58,
      }),
  },
].map((k) => knifeReport(mlBase, k.pred, k.id));

mlKnives.sort((a, b) => b.deltaUsd50 - a.deltaUsd50 || b.deltaHrPp - a.deltaHrPp);

const moneyline = {
  baselineRawFrozenB: summarize(mlRawList),
  baselineAfterSurgicalB: summarize(mlBase),
  knives: mlKnives,
};
console.log('[3err] ML after B', moneyline.baselineAfterSurgicalB);
console.log(
  '[3err] ML knives',
  mlKnives.map((k) => ({
    id: k.id,
    cutN: k.cutN,
    dHr: k.deltaHrPp,
    dRoi: k.deltaRoiPp,
    dUsd: k.deltaUsd50,
  }))
);

// ─── Totals（同 autopsy 載入）──────────────────────────────
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
    window: g.year,
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

console.log('[3err] hybrid totals load…');
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

  let i = 0;
  for (const row of rows) {
    i += 1;
    if (i % 500 === 0) console.log(`[3err] ${w.key} ${i}/${rows.length}`);
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
    const meta = readPitcherMeta(features);
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
      ...meta,
    });
  }
}

console.log('[3err] classify hybrid', games.length);
const totRawList = [];
for (const g of games) {
  const pick = classifyHybridV11(g);
  if (pick) totRawList.push(pick);
}

const isUnderPitcher = (b) =>
  b.hybridPath === 'raw_under' && b.parkBucket === 'pitcher';
const totBase = totRawList.filter((b) => !isUnderPitcher(b));

const totKnives = [
  {
    id: 'fragile_era_ge50',
    pred: (b) => b.side === 'under' && (b.maxEra ?? -1) >= 5,
  },
  {
    id: 'fragile_era_ge48',
    pred: (b) => b.side === 'under' && (b.maxEra ?? -1) >= 4.8,
  },
  {
    id: 'under_hitter_thin_gap_10',
    pred: (b) =>
      b.side === 'under' && b.parkBucket === 'hitter' && Number(b.absGap) < 1.0,
  },
  {
    id: 'under_pf_ge102_thin_gap_12',
    pred: (b) =>
      b.side === 'under' &&
      Number(b.parkFactor) >= 1.02 &&
      Number(b.absGap) < 1.2,
  },
  {
    id: 'under_r3era_ge45',
    pred: (b) => b.side === 'under' && (b.maxR3 ?? -1) >= 4.5,
  },
  {
    id: 'under_blowup_ge1',
    pred: (b) => b.side === 'under' && (b.maxBlowup ?? 0) >= 1,
  },
  {
    id: 'fragile_or_hitter_thin',
    pred: (b) =>
      b.side === 'under' &&
      ((b.maxEra ?? -1) >= 5 ||
        (b.parkBucket === 'hitter' && Number(b.absGap) < 1.0)),
  },
  {
    id: 'fragile_or_pf102_thin',
    pred: (b) =>
      b.side === 'under' &&
      ((b.maxEra ?? -1) >= 5 ||
        (Number(b.parkFactor) >= 1.02 && Number(b.absGap) < 1.2)),
  },
].map((k) => knifeReport(totBase, k.pred, k.id));

totKnives.sort((a, b) => b.deltaUsd50 - a.deltaUsd50 || b.deltaHrPp - a.deltaHrPp);

const totals = {
  baselineRawHybrid: summarize(totRawList),
  baselineAfterUnderPitcher: summarize(totBase),
  knives: totKnives,
  eraCoverageNote:
    '若 maxEra 大量為 null，fragile 刀樣本會偏少（feature 缺 pitcher era）',
  nullEraUnder: totBase.filter((b) => b.side === 'under' && b.maxEra == null)
    .length,
  underN: totBase.filter((b) => b.side === 'under').length,
};

console.log('[3err] totals after under-pitcher', totals.baselineAfterUnderPitcher);
console.log(
  '[3err] totals knives',
  totKnives.map((k) => ({
    id: k.id,
    cutN: k.cutN,
    dHr: k.deltaHrPp,
    dRoi: k.deltaRoiPp,
    dUsd: k.deltaUsd50,
  }))
);

const payload = {
  generatedAt: new Date().toISOString(),
  stakeUsd: STAKE,
  note:
    '基準＝正式手術 B + Under×投手之後；評估新刀能否再抬勝率／ROI。藍鳥型五五開不在範圍。',
  moneyline,
  totals,
  recommendation: null,
};

// 簡單推薦：美元不傷且勝率升，或勝率升且美元跌幅可接受
function pickBest(knives, { minHr = 0.3, maxUsdLoss = -200 } = {}) {
  const ok = knives.filter(
    (k) => k.deltaHrPp >= minHr && k.deltaUsd50 >= maxUsdLoss && k.cutN >= 10
  );
  if (!ok.length) return knives[0] || null;
  return ok.sort(
    (a, b) =>
      b.deltaHrPp * 50 + b.deltaUsd50 - (a.deltaHrPp * 50 + a.deltaUsd50)
  )[0];
}

payload.recommendation = {
  moneyline: pickBest(mlKnives, { minHr: 0.3, maxUsdLoss: -150 }),
  totals: pickBest(totKnives, { minHr: 0.4, maxUsdLoss: -200 }),
};

const outPath = new URL('../tmp-three-error-shadow.json', import.meta.url);
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log('[3err] wrote', outPath.pathname);
console.log(
  '[3err] recommend',
  JSON.stringify(payload.recommendation, null, 2)
);
