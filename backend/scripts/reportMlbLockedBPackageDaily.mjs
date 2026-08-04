/**
 * 鎖定 B 組合包日頻分析：獨贏 + Hybrid v1.1 大小 + 串關（同日 ML2 / R1×Under）
 * 用法: node scripts/reportMlbLockedBPackageDaily.mjs
 * 產物: tmp-locked-b-package-daily.json
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
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import {
  buildFrozenBShadowPickSets,
  MLB_FROZEN_B_SHADOW_SPEC,
} from '../src/services/MlbFrozenBShadow.js';
import { MLB_HIGH_EV_SHRINK_SHADOW_SPEC } from '../src/services/MlbHighEvShrinkShadow.js';
import {
  MLB_TOTALS_SATELLITE_SPEC,
  MLB_TOTALS_SATELLITE_HYBRID_SPEC,
} from '../src/services/MlbTotalsSatellite.js';

const STAKE = 50;
const HIGH_EV = MLB_HIGH_EV_SHRINK_SHADOW_SPEC.highEvThreshold;
const W = MLB_HIGH_EV_SHRINK_SHADOW_SPEC.shrinkW;
const LAMBDA = MLB_HIGH_EV_SHRINK_SHADOW_SPEC.rankLambda;
const B = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: MLB_FROZEN_B_SHADOW_SPEC.selection.minimumH2hBookmakers,
};
const DROP_R3 = MLB_FROZEN_B_SHADOW_SPEC.selection.dropThirdIfMarginBelow;
const DROP_R2_MAX = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsBelow;
const DROP_R2_MIN = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsMin;
const BASE = MLB_TOTALS_SATELLITE_SPEC.rules;
const HYBRID = MLB_TOTALS_SATELLITE_HYBRID_SPEC;
const FROZEN_PO = Number(HYBRID.pitcherParkMuMinusLineOffset) || 0.7;
const OVER_GAP = Number(HYBRID.overMinAbsGap) || 0.9;
const UNDER_GAP = Number(BASE.minAbsGap) || 0.6;
const CAP = Number(HYBRID.rawOverMaxAbsGap) || 1.25;

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-31' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Hong_Kong',
  });
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

function applyDrop(sorted) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
  if (
    slots.length >= 2 &&
    slots[1].pickOdds >= DROP_R2_MIN &&
    slots[1].pickOdds < DROP_R2_MAX
  ) {
    slots = [slots[0], ...slots.slice(2)].slice(0, 2);
  }
  return slots;
}

function selectMl(baseBets) {
  const adjusted = [];
  for (const b of baseBets) {
    const market = 1 / b.pickOdds;
    const isHighEv = (b.ev ?? 0) >= HIGH_EV;
    let modelProb = b.modelProb;
    let ev = b.ev;
    let sortEv = b.ev;
    if (isHighEv && W > 0) {
      modelProb = modelProb * (1 - W) + market * W;
      ev = modelProb * (b.pickOdds - 1) - (1 - modelProb);
    }
    if (isHighEv && LAMBDA > 0) {
      sortEv = (ev ?? 0) - LAMBDA * Math.max(0, (b.ev ?? 0) - HIGH_EV);
    } else sortEv = ev;
    if (ev < B.minimumExpectedValue) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (b.margin < B.minimumExpectedRunMargin) continue;
    if (b.pickOdds < B.minimumPickOdds || b.pickOdds > B.maximumPickOdds) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: sortEv, modelProbability: modelProb },
      B
    );
    adjusted.push({ ...b, modelProb, ev, bScore });
  }
  const byDay = new Map();
  for (const b of adjusted) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (x, y) => y.bScore - x.bScore || y.margin - x.margin
    );
    applyDrop(arr).forEach((x, i) =>
      out.push({ ...x, rank: i + 1, marketKind: 'ml' })
    );
  }
  return out;
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
      const under = (market.outcomes || []).find(
        (o) => o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!over.price || !under?.price) continue;
      const overOdds = Number(over.price);
      const underOdds = Number(under.price);
      if (overOdds < BASE.pickOddsMin || underOdds < BASE.pickOddsMin) continue;
      if (overOdds > BASE.pickOddsMax || underOdds > BASE.pickOddsMax) continue;
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

function trySide(g, adj, sideWanted, minGap) {
  const gap = adj.mu - g.line;
  const side = gap > 0 ? 'over' : gap < 0 ? 'under' : null;
  if (side !== sideWanted) return null;
  if (Math.abs(gap) < minGap) return null;
  if (g.line > BASE.maxTotalLine) return null;
  const dist = buildMlbScoreDistribution({
    homeMean: adj.homeMu,
    awayMean: adj.awayMu,
    homeDispersion: g.dispersion,
    awayDispersion: g.dispersion,
  });
  const mk = deriveMlbScoreMarkets(dist, { totalLine: g.line });
  const pushP = Number(mk.total?.pushProbability) || 0;
  const overProb =
    Number(mk.total.overProbability) / Math.max(1e-9, 1 - pushP);
  const underProb =
    Number(mk.total.underProbability) / Math.max(1e-9, 1 - pushP);
  const modelProb = side === 'over' ? overProb : underProb;
  if (modelProb < 0.5 || modelProb < BASE.minimumModelProbability) return null;
  const pickOdds = side === 'over' ? g.overOdds : g.underOdds;
  const fair = side === 'over' ? g.fairOver : g.fairUnder;
  const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
  const edge = modelProb - fair;
  if (ev < BASE.minimumExpectedValue || edge < BASE.minEdgeVsMarket) return null;
  if (pickOdds < BASE.pickOddsMin || pickOdds > BASE.pickOddsMax) return null;
  return {
    side,
    pickOdds,
    hit: side === g.actualSide,
    absGap: Math.abs(gap),
    expectedValue: ev,
    modelProb,
  };
}

function dailyStats(bets, allSlateDays) {
  const byDay = new Map();
  for (const b of bets) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  }
  const activeDays = [...byDay.keys()].sort();
  const counts = activeDays.map((d) => byDay.get(d).length);
  const pnls = activeDays.map((d) => {
    let unit = 0;
    for (const b of byDay.get(d)) {
      if (b.hit) unit += b.pickOdds - 1;
      else unit -= 1;
    }
    return unit * STAKE;
  });
  const slateN = allSlateDays?.size || 0;
  const avgOnActive =
    counts.length > 0
      ? Number((counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2))
      : 0;
  const avgOnSlate =
    slateN > 0
      ? Number((bets.length / slateN).toFixed(2))
      : null;
  const avgUsdActive =
    pnls.length > 0
      ? Number((pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(1))
      : 0;
  const avgUsdSlate =
    slateN > 0
      ? Number((pnls.reduce((a, b) => a + b, 0) / slateN).toFixed(1))
      : null;
  const hist = { 1: 0, 2: 0, 3: 0, '4+': 0 };
  for (const c of counts) {
    if (c >= 4) hist['4+'] += 1;
    else hist[String(c)] += 1;
  }
  return {
    activeDays: activeDays.length,
    slateDays: slateN || null,
    activeDayRate:
      slateN > 0 ? Number((activeDays.length / slateN).toFixed(4)) : null,
    avgBetsOnActiveDay: avgOnActive,
    avgBetsOnSlateDay: avgOnSlate,
    avgUsdOnActiveDay: avgUsdActive,
    avgUsdOnSlateDay: avgUsdSlate,
    betsPerActiveDayHist: hist,
    medianBetsOnActiveDay: counts.length
      ? counts.slice().sort((a, b) => a - b)[Math.floor(counts.length / 2)]
      : 0,
  };
}

console.log('load locked B…');
const { shadow: baseAll } = buildFrozenBShadowPickSets({});
// filter to windows
const inWin = (day) => {
  if (!day) return false;
  return WINDOWS.some((w) => day >= w.from && day <= w.to);
};
const baseWin = baseAll.filter((b) => inWin(b.day));
const mlBets = selectMl(baseWin);
console.log('ML bets', mlBets.length, summarize(mlBets));

console.log('load hybrid totals…');
const model = getLatestMlbExpectedRunsValidation().model;
const dispersion = model.dispersion;
const totBets = [];
const slateDays = new Set();

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
    const day = hk(row.commenceTime);
    slateDays.add(day);
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
    const g = {
      line: market.line,
      homeMu: Number(pred.homeExpectedRuns),
      awayMu: Number(pred.awayExpectedRuns),
      mu: Number(pred.expectedTotal),
      overOdds: market.overOdds,
      underOdds: market.underOdds,
      fairOver: market.fairOver,
      fairUnder: market.fairUnder,
      actualSide: actualTotal > market.line ? 'over' : 'under',
      parkFactor: Number(features.parkFactor) || 1,
      dispersion,
    };
    const raw = { homeMu: g.homeMu, awayMu: g.awayMu, mu: g.mu };
    const u = trySide(g, raw, 'under', UNDER_GAP);
    if (u) {
      totBets.push({
        ...u,
        day,
        gameId: row.gameId,
        marketKind: 'totals',
        totalsSide: 'under',
      });
      continue;
    }
    const isPitcher = g.parkFactor < (HYBRID.pitcherParkFactorMax || 0.97);
    if (isPitcher) {
      const h = Math.max(0.5, g.homeMu - FROZEN_PO / 2);
      const a = Math.max(0.5, g.awayMu - FROZEN_PO / 2);
      const o = trySide(
        g,
        { homeMu: h, awayMu: a, mu: h + a },
        'over',
        OVER_GAP
      );
      if (o) {
        totBets.push({
          ...o,
          day,
          gameId: row.gameId,
          marketKind: 'totals',
          totalsSide: 'over',
          path: 'pitcher_debiased',
        });
      }
    } else {
      const o = trySide(g, raw, 'over', OVER_GAP);
      if (o && o.absGap <= CAP) {
        totBets.push({
          ...o,
          day,
          gameId: row.gameId,
          marketKind: 'totals',
          totalsSide: 'over',
          path: 'raw_capped',
        });
      }
    }
  }
}

/** 串關：同日獨贏 2 串（腿賠率≤2.10，取日排名前兩） */
const ML2_MAX = 2.1;
const parlayMl2 = [];
const mlByDay = new Map();
for (const b of mlBets) {
  if (!mlByDay.has(b.day)) mlByDay.set(b.day, []);
  mlByDay.get(b.day).push(b);
}
for (const [day, arr] of mlByDay) {
  const legs = [...arr]
    .filter((b) => Number(b.pickOdds) <= ML2_MAX)
    .sort((a, b) => (a.rank || 99) - (b.rank || 99) || b.margin - a.margin)
    .slice(0, 2);
  if (legs.length < 2) continue;
  const combined = legs[0].pickOdds * legs[1].pickOdds;
  const hit = legs[0].hit && legs[1].hit;
  parlayMl2.push({
    day,
    marketKind: 'parlay_ml2',
    pickOdds: combined,
    hit,
    legOdds: [legs[0].pickOdds, legs[1].pickOdds],
  });
}

/** 串關：R1 獨贏 × 當日 Hybrid Under（優先異場，EV 最高） */
const parlayR1Under = [];
const totByDay = new Map();
for (const b of totBets) {
  if (!totByDay.has(b.day)) totByDay.set(b.day, []);
  totByDay.get(b.day).push(b);
}
for (const [day, mls] of mlByDay) {
  const r1 = [...mls].sort((a, b) => (a.rank || 99) - (b.rank || 99))[0];
  if (!r1) continue;
  const unders = (totByDay.get(day) || []).filter((t) => t.totalsSide === 'under');
  if (!unders.length) continue;
  const sorted = [...unders].sort(
    (a, b) =>
      (b.expectedValue || 0) - (a.expectedValue || 0) ||
      (b.absGap || 0) - (a.absGap || 0)
  );
  let tot = sorted.find((t) => t.gameId !== r1.gameId) || sorted[0];
  if (!tot) continue;
  const combined = r1.pickOdds * tot.pickOdds;
  const hit = r1.hit && tot.hit;
  parlayR1Under.push({
    day,
    marketKind: 'parlay_r1_under',
    pickOdds: combined,
    hit,
    sameGame: tot.gameId === r1.gameId,
    legOdds: [r1.pickOdds, tot.pickOdds],
  });
}

const packageSingles = [...mlBets, ...totBets];
const packageAll = [...packageSingles, ...parlayMl2, ...parlayR1Under];
const mlDays = new Set(mlBets.map((b) => b.day));
const totDays = new Set(totBets.map((b) => b.day));
const pkgDays = new Set(packageSingles.map((b) => b.day));
const allTicketDays = new Set(packageAll.map((b) => b.day));

const out = {
  experimentId: 'locked_b_package_daily_v1.1_with_parlay',
  windows: WINDOWS,
  stakeUsd: STAKE,
  note: '獨贏+大小各 $50；串關另各 $50（有則打）：同日 ML2（≤2.10）+ R1×Hybrid Under',
  moneyline: {
    ...summarize(mlBets),
    daily: dailyStats(mlBets, slateDays),
  },
  totalsHybridV11: {
    ...summarize(totBets),
    under: summarize(totBets.filter((b) => b.totalsSide === 'under')),
    over: summarize(totBets.filter((b) => b.totalsSide === 'over')),
    daily: dailyStats(totBets, slateDays),
  },
  parlays: {
    sameDayMl2: {
      ...summarize(parlayMl2),
      daily: dailyStats(parlayMl2, slateDays),
      availableDayRate: Number(
        (parlayMl2.length / Math.max(1, slateDays.size)).toFixed(4)
      ),
    },
    r1xHybridUnder: {
      ...summarize(parlayR1Under),
      daily: dailyStats(parlayR1Under, slateDays),
      sameGameShare: parlayR1Under.length
        ? Number(
            (
              parlayR1Under.filter((p) => p.sameGame).length /
              parlayR1Under.length
            ).toFixed(4)
          )
        : null,
      availableDayRate: Number(
        (parlayR1Under.length / Math.max(1, slateDays.size)).toFixed(4)
      ),
    },
    bothParlays: summarize([...parlayMl2, ...parlayR1Under]),
  },
  packageSingles: {
    ...summarize(packageSingles),
    daily: dailyStats(packageSingles, slateDays),
    daysWithMl: mlDays.size,
    daysWithTotals: totDays.size,
    daysWithEither: pkgDays.size,
    daysWithBoth: [...pkgDays].filter((d) => mlDays.has(d) && totDays.has(d))
      .length,
  },
  packageWithParlays: {
    ...summarize(packageAll),
    daily: dailyStats(packageAll, slateDays),
    ticketDays: allTicketDays.size,
  },
  practical: {
    slateDaysInFeatureWindow: slateDays.size,
    singlesOnly: {
      avgTicketsPerSlateDay: Number(
        (packageSingles.length / Math.max(1, slateDays.size)).toFixed(2)
      ),
      avgUsdPerSlateDay: Number(
        (summarize(packageSingles).usd50 / Math.max(1, slateDays.size)).toFixed(
          1
        )
      ),
      monthlyUsdRough: Math.round(
        (summarize(packageSingles).usd50 / Math.max(1, slateDays.size)) * 30
      ),
    },
    withParlays: {
      avgTicketsPerSlateDay: Number(
        (packageAll.length / Math.max(1, slateDays.size)).toFixed(2)
      ),
      avgTicketsPerActiveDay: Number(
        (packageAll.length / Math.max(1, allTicketDays.size)).toFixed(2)
      ),
      avgUsdPerSlateDay: Number(
        (summarize(packageAll).usd50 / Math.max(1, slateDays.size)).toFixed(1)
      ),
      avgUsdPerActiveDay: Number(
        (
          summarize(packageAll).usd50 / Math.max(1, allTicketDays.size)
        ).toFixed(1)
      ),
      monthlyUsdRough: Math.round(
        (summarize(packageAll).usd50 / Math.max(1, slateDays.size)) * 30
      ),
      avgStakeDeployedPerSlateDay: Number(
        ((packageAll.length * STAKE) / Math.max(1, slateDays.size)).toFixed(0)
      ),
    },
  },
};

fs.writeFileSync(
  'tmp-locked-b-package-daily.json',
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
