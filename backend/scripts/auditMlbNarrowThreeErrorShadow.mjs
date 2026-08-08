/**
 * 更窄條件網格：海盜型（逆市場客）+ 勇士型（小分低估）
 * 基準＝正式手術 B + Under×投手之後
 *
 * 用法: node scripts/auditMlbNarrowThreeErrorShadow.mjs
 * 產物: tmp-narrow-three-error-shadow.json
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

function knifeReport(base, pred, id, extra = {}) {
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
  const pass =
    kS.hitRate != null &&
    bS.hitRate != null &&
    kS.hitRate >= bS.hitRate + 0.002 && // ≥+0.2pp
    kS.roi != null &&
    bS.roi != null &&
    kS.roi >= bS.roi - 0.002 && // ROI 不明顯變差
    kS.usd50 >= bS.usd50 - 80; // 美元跌幅可控
  const passStrict =
    pass && kS.usd50 >= bS.usd50 && kS.roi >= bS.roi;
  return {
    id,
    ...extra,
    cutN: cut.length,
    cutPct: Number(((cut.length / Math.max(1, base.length)) * 100).toFixed(1)),
    cut: cS,
    kept: kS,
    deltaHrPp: Number((((kS.hitRate ?? 0) - (bS.hitRate ?? 0)) * 100).toFixed(2)),
    deltaRoiPp: Number((((kS.roi ?? 0) - (bS.roi ?? 0)) * 100).toFixed(2)),
    deltaUsd50: kS.usd50 - bS.usd50,
    byYearDeltaUsd50: years,
    passSoft: pass,
    passStrict,
  };
}

// ─── ML narrow grid ────────────────────────────────────────
console.log('[narrow] ML…');
const { shadow: mlRaw } = buildFrozenBShadowPickSets({});
const rB = MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC.rule;
const isSurgB = (b) =>
  !b.pickHome &&
  b.rank === rB.rank &&
  b.pickOdds >= rB.minOdds &&
  b.pickOdds < rB.maxOddsExclusive;

const mlBase = mlRaw
  .filter((b) => !isSurgB(b))
  .map((b) => {
    const marketProb = Number.isFinite(Number(b.marketProb))
      ? Number(b.marketProb)
      : 1 / b.pickOdds;
    const modelProb = Number(b.modelProb);
    return {
      ...b,
      marketProb,
      edge: Number.isFinite(modelProb) ? modelProb - marketProb : null,
      // 市場偏主：客隊隱含勝率明顯低於 50%
      marketHomeFavMargin: Number.isFinite(marketProb)
        ? 0.5 - marketProb
        : null,
    };
  });

function disagree(b, { maxMkt, minEdge, minHwp, minRank = null, maxRank = null, minOdds = null, maxOdds = null, minHomeFavMargin = null }) {
  if (b.pickHome) return false;
  if (!Number.isFinite(b.marketProb) || !Number.isFinite(b.edge)) return false;
  if (b.marketProb > maxMkt) return false;
  if (b.edge < minEdge) return false;
  if (Number(b.homeWinPct) < minHwp) return false;
  if (minRank != null && b.rank < minRank) return false;
  if (maxRank != null && b.rank > maxRank) return false;
  if (minOdds != null && b.pickOdds < minOdds) return false;
  if (maxOdds != null && b.pickOdds >= maxOdds) return false;
  if (
    minHomeFavMargin != null &&
    (b.marketHomeFavMargin == null || b.marketHomeFavMargin < minHomeFavMargin)
  ) {
    return false;
  }
  return true;
}

const mlSpecs = [];
// 更窄：市場更偏主 + edge 更大 + 更強主場
for (const maxMkt of [0.44, 0.42, 0.4]) {
  for (const minEdge of [0.1, 0.12, 0.15]) {
    for (const minHwp of [0.62, 0.65, 0.68]) {
      mlSpecs.push({
        id: `dis_mkt${String(maxMkt).slice(2)}_e${Math.round(minEdge * 100)}_h${Math.round(minHwp * 100)}`,
        maxMkt,
        minEdge,
        minHwp,
      });
    }
  }
}
// 再窄：只砍日 Rank1 逆市場客
for (const maxMkt of [0.45, 0.43, 0.4]) {
  for (const minEdge of [0.1, 0.12]) {
    for (const minHwp of [0.6, 0.65]) {
      mlSpecs.push({
        id: `dis_R1_mkt${String(maxMkt).slice(2)}_e${Math.round(minEdge * 100)}_h${Math.round(minHwp * 100)}`,
        maxMkt,
        minEdge,
        minHwp,
        maxRank: 1,
      });
    }
  }
}
// 長水客逆強主（海盜型常是 2.1+）
for (const maxMkt of [0.45, 0.43]) {
  for (const minEdge of [0.1, 0.12]) {
    mlSpecs.push({
      id: `dis_long_mkt${String(maxMkt).slice(2)}_e${Math.round(minEdge * 100)}_h65_odds215`,
      maxMkt,
      minEdge,
      minHwp: 0.65,
      minOdds: 2.15,
    });
  }
}
// 市場主隊優勢幅度（隱含主勝 − 50%）
for (const margin of [0.08, 0.1, 0.12]) {
  for (const minEdge of [0.1, 0.12]) {
    mlSpecs.push({
      id: `dis_favM${Math.round(margin * 100)}_e${Math.round(minEdge * 100)}_h62`,
      maxMkt: 0.5 - margin,
      minEdge,
      minHwp: 0.62,
      minHomeFavMargin: margin,
    });
  }
}

const mlKnives = mlSpecs.map((s) =>
  knifeReport(
    mlBase,
    (b) =>
      disagree(b, {
        maxMkt: s.maxMkt,
        minEdge: s.minEdge,
        minHwp: s.minHwp,
        maxRank: s.maxRank,
        minOdds: s.minOdds,
        minHomeFavMargin: s.minHomeFavMargin,
      }),
    s.id,
    { family: 'moneyline_disagree_narrow' }
  )
);

const mlImproved = mlKnives
  .filter((k) => k.cutN >= 5)
  .sort((a, b) => b.deltaUsd50 - a.deltaUsd50 || b.deltaHrPp - a.deltaHrPp);

console.log('[narrow] ML baseline', summarize(mlBase));
console.log(
  '[narrow] ML passStrict',
  mlImproved.filter((k) => k.passStrict).slice(0, 8)
);
console.log(
  '[narrow] ML best by $ (cut≥5)',
  mlImproved.slice(0, 8).map((k) => ({
    id: k.id,
    cutN: k.cutN,
    dHr: k.deltaHrPp,
    dRoi: k.deltaRoiPp,
    dUsd: k.deltaUsd50,
    passSoft: k.passSoft,
    passStrict: k.passStrict,
  }))
);

// ─── Totals narrow（勇士型）────────────────────────────────
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
  const maxR3 = r3s.length ? Math.max(...r3s) : null;
  const blowups = [
    Number(features?.pitchers?.home?.blowupStartsLast3),
    Number(features?.pitchers?.away?.blowupStartsLast3),
    Number(features?.pitchers?.homeRecent?.blowupStartsLast3),
    Number(features?.pitchers?.awayRecent?.blowupStartsLast3),
  ].filter((x) => Number.isFinite(x));
  return {
    maxEra,
    maxR3,
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
    window: g.year,
    side,
    pickOdds,
    hit: side === actualSide,
    absGap: Math.abs(gap),
    gap,
    ev,
    line,
    mu: adj.mu,
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

console.log('[narrow] totals…');
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
    if (i % 600 === 0) console.log(`[narrow] ${w.key} ${i}/${rows.length}`);
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
const totBase = totRaw.filter(
  (b) => !(b.hybridPath === 'raw_under' && b.parkBucket === 'pitcher')
);

// 更窄勇士型：交叉條件，避免整片打者公園
const totSpecs = [
  // ERA 接近但未到 5 + 薄 gap
  {
    id: 'under_era48_gap08',
    pred: (b) =>
      b.side === 'under' && (b.maxEra ?? -1) >= 4.8 && Number(b.absGap) < 0.8,
  },
  {
    id: 'under_era48_gap10',
    pred: (b) =>
      b.side === 'under' && (b.maxEra ?? -1) >= 4.8 && Number(b.absGap) < 1.0,
  },
  {
    id: 'under_era47_gap08',
    pred: (b) =>
      b.side === 'under' && (b.maxEra ?? -1) >= 4.7 && Number(b.absGap) < 0.8,
  },
  // 打者公園 + 更薄 gap
  {
    id: 'under_hitter_gap07',
    pred: (b) =>
      b.side === 'under' && b.parkBucket === 'hitter' && Number(b.absGap) < 0.7,
  },
  {
    id: 'under_hitter_gap08',
    pred: (b) =>
      b.side === 'under' && b.parkBucket === 'hitter' && Number(b.absGap) < 0.8,
  },
  // pf 高 + 薄 gap + ERA 偏高
  {
    id: 'under_pf102_gap10_era45',
    pred: (b) =>
      b.side === 'under' &&
      Number(b.parkFactor) >= 1.02 &&
      Number(b.absGap) < 1.0 &&
      (b.maxEra ?? -1) >= 4.5,
  },
  {
    id: 'under_pf102_gap08_era45',
    pred: (b) =>
      b.side === 'under' &&
      Number(b.parkFactor) >= 1.02 &&
      Number(b.absGap) < 0.8 &&
      (b.maxEra ?? -1) >= 4.5,
  },
  {
    id: 'under_pf103_gap10_era48',
    pred: (b) =>
      b.side === 'under' &&
      Number(b.parkFactor) >= 1.03 &&
      Number(b.absGap) < 1.0 &&
      (b.maxEra ?? -1) >= 4.8,
  },
  // 近況爆分 + 薄 gap
  {
    id: 'under_blowup_gap08',
    pred: (b) =>
      b.side === 'under' &&
      (b.maxBlowup ?? 0) >= 1 &&
      Number(b.absGap) < 0.8,
  },
  {
    id: 'under_blowup_gap10',
    pred: (b) =>
      b.side === 'under' &&
      (b.maxBlowup ?? 0) >= 1 &&
      Number(b.absGap) < 1.0,
  },
  {
    id: 'under_r3_55_gap08',
    pred: (b) =>
      b.side === 'under' &&
      (b.maxR3 ?? -1) >= 5.5 &&
      Number(b.absGap) < 0.8,
  },
  {
    id: 'under_r3_50_gap08',
    pred: (b) =>
      b.side === 'under' &&
      (b.maxR3 ?? -1) >= 5.0 &&
      Number(b.absGap) < 0.8,
  },
  // 高 EV 小分虚高 × 打者/高 pf
  {
    id: 'under_ev20_pf102',
    pred: (b) =>
      b.side === 'under' &&
      Number(b.ev) >= 0.2 &&
      Number(b.parkFactor) >= 1.02,
  },
  {
    id: 'under_ev25_hitter',
    pred: (b) =>
      b.side === 'under' &&
      Number(b.ev) >= 0.25 &&
      b.parkBucket === 'hitter',
  },
  {
    id: 'under_ev20_gap08_pf102',
    pred: (b) =>
      b.side === 'under' &&
      Number(b.ev) >= 0.2 &&
      Number(b.absGap) < 0.8 &&
      Number(b.parkFactor) >= 1.02,
  },
  // μ 離線很近（幾乎壓線）且 ERA 偏弱
  {
    id: 'under_gap065_era48',
    pred: (b) =>
      b.side === 'under' &&
      Number(b.absGap) < 0.65 &&
      (b.maxEra ?? -1) >= 4.8,
  },
  {
    id: 'under_gap065_era50',
    pred: (b) =>
      b.side === 'under' &&
      Number(b.absGap) < 0.65 &&
      (b.maxEra ?? -1) >= 5.0,
  },
];

const totKnives = totSpecs.map((s) =>
  knifeReport(totBase, s.pred, s.id, { family: 'totals_braves_narrow' })
);
const totImproved = totKnives
  .filter((k) => k.cutN >= 5)
  .sort((a, b) => b.deltaUsd50 - a.deltaUsd50 || b.deltaHrPp - a.deltaHrPp);

console.log('[narrow] totals baseline', summarize(totBase));
console.log(
  '[narrow] totals passStrict',
  totImproved.filter((k) => k.passStrict).map((k) => k.id)
);
console.log(
  '[narrow] totals best by $',
  totImproved.slice(0, 10).map((k) => ({
    id: k.id,
    cutN: k.cutN,
    dHr: k.deltaHrPp,
    dRoi: k.deltaRoiPp,
    dUsd: k.deltaUsd50,
    passSoft: k.passSoft,
    passStrict: k.passStrict,
  }))
);

const payload = {
  generatedAt: new Date().toISOString(),
  stakeUsd: STAKE,
  note: '更窄網格：2=逆市場客；3=勇士型小分交叉。基準＝手術B+Under×投手。',
  moneyline: {
    baselineAfterSurgicalB: summarize(mlBase),
    knives: mlImproved,
    passStrict: mlImproved.filter((k) => k.passStrict),
    passSoft: mlImproved.filter((k) => k.passSoft),
  },
  totals: {
    baselineAfterUnderPitcher: summarize(totBase),
    knives: totImproved,
    passStrict: totImproved.filter((k) => k.passStrict),
    passSoft: totImproved.filter((k) => k.passSoft),
  },
};

const out = new URL('../tmp-narrow-three-error-shadow.json', import.meta.url);
fs.writeFileSync(out, JSON.stringify(payload, null, 2));
console.log('[narrow] wrote', out.pathname);
console.log(
  JSON.stringify(
    {
      mlPassStrictN: payload.moneyline.passStrict.length,
      totPassStrictN: payload.totals.passStrict.length,
      mlTop: payload.moneyline.passStrict[0] || payload.moneyline.knives[0],
      totTop: payload.totals.passStrict[0] || payload.totals.knives[0],
    },
    null,
    2
  )
);
