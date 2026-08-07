/**
 * Hybrid 大小 v1.1 輸注反推（影子；不改正式常數）
 * 用法: node scripts/auditMlbTotalsHybridLossAutopsy.mjs
 * 產物: tmp-totals-hybrid-loss-autopsy.json
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
    return { n: 0, hits: 0, hr: null, roi: null, usd: 0, avgOdds: null, avgEv: null };
  }
  let hits = 0;
  let unit = 0;
  let odds = 0;
  let ev = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    ev += b.ev ?? 0;
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
    avgOdds: Number((odds / n).toFixed(3)),
    avgEv: Number(((ev / n) * 100).toFixed(2)),
  };
}

function bucket(bets, keyFn) {
  const map = new Map();
  for (const b of bets) {
    const k = keyFn(b);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(b);
  }
  return [...map.entries()]
    .map(([k, arr]) => ({ key: k, ...summarize(arr) }))
    .sort((a, b) => b.n - a.n);
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
      if (o.absGap > RAW_OVER_MAX) return null; // v1.1 raw over cap
      return { ...o, hybridPath: 'raw_over' };
    }
  }
  return null;
}

function applyCut(base, pred) {
  const cut = base.filter(pred);
  const kept = base.filter((b) => !pred(b));
  const bS = summarize(base);
  const kS = summarize(kept);
  const cS = summarize(cut);
  return {
    cutPct: Number(((100 * cut.length) / Math.max(1, base.length)).toFixed(1)),
    cut: cS,
    kept: kS,
    dHr: Number((kS.hr - bS.hr).toFixed(2)),
    dRoi: Number((kS.roi - bS.roi).toFixed(2)),
    dUsd: kS.usd - bS.usd,
    keepRate: Number((kept.length / Math.max(1, base.length)).toFixed(3)),
    byYearDelta: Object.fromEntries(
      ['2024', '2025', '2026'].map((y) => {
        const bY = base.filter((x) => x.year === y);
        const kY = kept.filter((x) => x.year === y);
        return [y, summarize(kY).usd - summarize(bY).usd];
      })
    ),
  };
}

console.log('[hybrid-loss] load games…');
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
      gameId: row.gameId,
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

console.log('[hybrid-loss] games', games.length, 'classify…');
const base = [];
for (const g of games) {
  const pick = classifyHybridV11(g);
  if (pick) base.push(pick);
}

const wins = base.filter((b) => b.hit);
const losses = base.filter((b) => !b.hit);

const dims = {
  path: bucket(base, (b) => b.hybridPath),
  side: bucket(base, (b) => b.side),
  park: bucket(base, (b) => b.parkBucket),
  line: bucket(base, (b) =>
    b.line <= 7.5 ? '≤7.5' : b.line <= 8.5 ? '8-8.5' : b.line <= 9.5 ? '9-9.5' : '10'
  ),
  odds: bucket(base, (b) =>
    b.pickOdds < 1.8
      ? '<1.80'
      : b.pickOdds < 1.95
        ? '1.80-1.95'
        : b.pickOdds < 2.1
          ? '1.95-2.10'
          : '≥2.10'
  ),
  ev: bucket(base, (b) =>
    b.ev < 0.08
      ? 'EV<8%'
      : b.ev < 0.15
        ? 'EV8-15%'
        : b.ev < 0.25
          ? 'EV15-25%'
          : 'EV≥25%'
  ),
  gap: bucket(base, (b) =>
    b.absGap < 0.8
      ? 'gap<0.8'
      : b.absGap < 1.1
        ? 'gap0.8-1.1'
        : b.absGap < 1.4
          ? 'gap1.1-1.4'
          : 'gap≥1.4'
  ),
  p: bucket(base, (b) =>
    b.modelProb < 0.55
      ? 'P<55'
      : b.modelProb < 0.6
        ? 'P55-60'
        : b.modelProb < 0.65
          ? 'P60-65'
          : 'P≥65'
  ),
};

function liftsFor(keyFn) {
  const allB = bucket(base, keyFn);
  const lossB = bucket(losses, keyFn);
  const allN = base.length || 1;
  const lossN = losses.length || 1;
  return lossB
    .map((row) => {
      const a = allB.find((x) => x.key === row.key);
      const allShare = (a?.n ?? 0) / allN;
      const lossShare = row.n / lossN;
      return {
        key: row.key,
        lossN: row.n,
        lossShare: Number((lossShare * 100).toFixed(1)),
        allN: a?.n ?? 0,
        allShare: Number((allShare * 100).toFixed(1)),
        allHr: a?.hr ?? null,
        allRoi: a?.roi ?? null,
        allUsd: a?.usd ?? null,
        lift: allShare > 0 ? Number((lossShare / allShare).toFixed(2)) : null,
      };
    })
    .filter((r) => r.lossN >= 20)
    .sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));
}

const lifts = {
  path: liftsFor((b) => b.hybridPath),
  side: liftsFor((b) => b.side),
  park: liftsFor((b) => b.parkBucket),
  line: liftsFor((b) =>
    b.line <= 7.5 ? '≤7.5' : b.line <= 8.5 ? '8-8.5' : b.line <= 9.5 ? '9-9.5' : '10'
  ),
  odds: liftsFor((b) =>
    b.pickOdds < 1.8
      ? '<1.80'
      : b.pickOdds < 1.95
        ? '1.80-1.95'
        : b.pickOdds < 2.1
          ? '1.95-2.10'
          : '≥2.10'
  ),
  ev: liftsFor((b) =>
    b.ev < 0.08
      ? 'EV<8%'
      : b.ev < 0.15
        ? 'EV8-15%'
        : b.ev < 0.25
          ? 'EV15-25%'
          : 'EV≥25%'
  ),
  gap: liftsFor((b) =>
    b.absGap < 0.8
      ? 'gap<0.8'
      : b.absGap < 1.1
        ? 'gap0.8-1.1'
        : b.absGap < 1.4
          ? 'gap1.1-1.4'
          : 'gap≥1.4'
  ),
  pathPark: liftsFor((b) => `${b.hybridPath}|${b.parkBucket}`),
  overGapPark: liftsFor((b) => {
    if (b.side !== 'over') return 'under';
    const g =
      b.absGap < 1.0
        ? 'gap<1.0'
        : b.absGap <= 1.25
          ? 'gap1.0-1.25'
          : 'gap>1.25';
    return `over|${b.parkBucket}|${g}`;
  }),
};

const knives = [
  {
    id: 'drop_raw_over',
    label: '砍掉全部 Over·raw',
    pred: (b) => b.hybridPath === 'raw_over',
  },
  {
    id: 'drop_raw_over_mid_park',
    label: '砍 Over·raw × 中性公園',
    pred: (b) => b.hybridPath === 'raw_over' && b.parkBucket === 'mid',
  },
  {
    id: 'drop_raw_over_hitter',
    label: '砍 Over·raw × 打者公園',
    pred: (b) => b.hybridPath === 'raw_over' && b.parkBucket === 'hitter',
  },
  {
    id: 'drop_raw_over_thin_gap',
    label: '砍 Over·raw × gap<1.0',
    pred: (b) => b.hybridPath === 'raw_over' && b.absGap < 1.0,
  },
  {
    id: 'drop_high_ev_ge25',
    label: '砍 EV≥25%（畫面虚高嫌疑）',
    pred: (b) => b.ev >= 0.25,
  },
  {
    id: 'drop_under_thin',
    label: '砍 Under × gap<0.8',
    pred: (b) => b.side === 'under' && b.absGap < 0.8,
  },
  {
    id: 'drop_over_line10',
    label: '砍 Over × 盤口=10',
    pred: (b) => b.side === 'over' && b.line >= 10,
  },
  {
    id: 'drop_odds_lt180',
    label: '砍賠率<1.80',
    pred: (b) => b.pickOdds < 1.8,
  },
  {
    id: 'drop_raw_over_or_high_ev',
    label: '砍 raw_over ∪ EV≥25%',
    pred: (b) => b.hybridPath === 'raw_over' || b.ev >= 0.25,
  },
  {
    id: 'drop_under_pitcher_park',
    label: '砍 Under × 投手公園（主候選）',
    pred: (b) => b.hybridPath === 'raw_under' && b.parkBucket === 'pitcher',
  },
  {
    id: 'drop_under_pitcher_thin',
    label: '砍 Under × 投手公園 × gap<1.0',
    pred: (b) =>
      b.hybridPath === 'raw_under' &&
      b.parkBucket === 'pitcher' &&
      b.absGap < 1.0,
  },
  {
    id: 'drop_all_pitcher_park',
    label: '砍全部投手公園大小',
    pred: (b) => b.parkBucket === 'pitcher',
  },
  {
    id: 'drop_under_ev_ge25',
    label: '砍 Under × EV≥25%',
    pred: (b) => b.side === 'under' && b.ev >= 0.25,
  },
  {
    id: 'drop_under_ev_ge30',
    label: '砍 Under × EV≥30%',
    pred: (b) => b.side === 'under' && b.ev >= 0.3,
  },
  {
    id: 'drop_line_10',
    label: '砍盤口=10（大小）',
    pred: (b) => b.line >= 10,
  },
  {
    id: 'drop_ev_8_15',
    label: '砍 EV 8–15% 帶',
    pred: (b) => b.ev >= 0.08 && b.ev < 0.15,
  },
].map((k) => ({ id: k.id, label: k.label, ...applyCut(base, k.pred) }));

knives.sort((a, b) => {
  const score = (k) => {
    const yOk =
      (k.byYearDelta['2024'] ?? 0) >= -50 &&
      (k.byYearDelta['2025'] ?? 0) >= -50 &&
      (k.byYearDelta['2026'] ?? 0) >= -80;
    return (
      k.dHr * 8 +
      k.dRoi * 3 +
      Math.min(k.dUsd, 600) / 200 +
      (yOk ? 2 : -4) +
      (k.cut.n >= 30 && k.cut.roi < 5 ? 1.5 : 0) -
      (k.keepRate < 0.7 ? 3 : 0)
    );
  };
  return score(b) - score(a);
});

const good = knives.filter(
  (k) =>
    k.cut.n >= 20 &&
    k.dHr >= 0.4 &&
    k.dRoi >= 0 &&
    k.dUsd >= -100 &&
    k.keepRate >= 0.7 &&
    (k.byYearDelta['2024'] ?? 0) >= -80 &&
    (k.byYearDelta['2025'] ?? 0) >= -80 &&
    (k.byYearDelta['2026'] ?? 0) >= -100
);

const interpretation = [];
interpretation.push(
  `基線 Hybrid v1.1 n=${base.length} HR=${summarize(base).hr}% ROI=${summarize(base).roi}% $${summarize(base).usd}；輸=${losses.length}`
);
for (const row of dims.path) {
  interpretation.push(
    `路徑 ${row.key}: n=${row.n} HR=${row.hr}% ROI=${row.roi}% $${row.usd}`
  );
}
const underPitcher = dims.pathPark
  ? null
  : null;
const up = base.filter(
  (b) => b.hybridPath === 'raw_under' && b.parkBucket === 'pitcher'
);
interpretation.push(
  `主病灶 Under×投手公園: n=${up.length} ${JSON.stringify(summarize(up))}`
);

for (const k of good.slice(0, 5)) {
  interpretation.push(
    `可跟進刀：${k.label} 砍${k.cutPct}% 被砍ROI=${k.cut.roi}% → HR ${k.kept.hr}% (${k.dHr >= 0 ? '+' : ''}${k.dHr}) ROI ${k.kept.roi}% (${k.dRoi >= 0 ? '+' : ''}${k.dRoi}) Δ$${k.dUsd} 年Δ=${JSON.stringify(k.byYearDelta)}`
  );
}

const out = {
  experimentId: 'totals-hybrid-loss-autopsy-2026-08-06',
  note: 'Hybrid v1.1 含 raw_over absGap≤1.25；不改正式常數',
  baseline: summarize(base),
  wins: summarize(wins),
  losses: summarize(losses),
  byPath: dims.path,
  bySide: dims.side,
  byPark: dims.park,
  slices: dims,
  lossLifts: lifts,
  knives,
  recommendedNext: good.slice(0, 3).map((k) => k.id),
  interpretation,
  doNot: [
    'global_mu_offset_to_line',
    'raise_over_gap_from_single_game',
    'mix_totals_into_locked_b_topk',
    'apply_without_shadow',
  ],
};

fs.writeFileSync(
  new URL('../tmp-totals-hybrid-loss-autopsy.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('BASE', out.baseline);
console.log('WINS', out.wins);
console.log('LOSSES', out.losses);
console.log('\nBY PATH');
for (const r of dims.path) console.log(' ', r.key, r);
console.log('\nBY PARK');
for (const r of dims.park) console.log(' ', r.key, r);
console.log('\nTOP LIFTS');
for (const [dim, rows] of Object.entries(lifts)) {
  const top = rows.filter((r) => (r.lift ?? 0) >= 1.1).slice(0, 3);
  for (const r of top) {
    console.log(
      `  ${dim}=${r.key} lift=${r.lift} lossShare=${r.lossShare}% HR=${r.allHr}% ROI=${r.allRoi}% $${r.allUsd}`
    );
  }
}
console.log('\nKNIVES');
for (const k of knives.slice(0, 10)) {
  console.log(
    `  ${k.id} cut ${k.cutPct}% cutROI=${k.cut.roi}% keep HR=${k.kept.hr}% (${k.dHr >= 0 ? '+' : ''}${k.dHr}) ROI=${k.kept.roi}% (${k.dRoi >= 0 ? '+' : ''}${k.dRoi}) Δ$${k.dUsd}`,
    '年Δ',
    k.byYearDelta
  );
}
console.log('\nNEXT', out.recommendedNext);
console.log('\nINTERP');
for (const line of interpretation) console.log(' -', line);
