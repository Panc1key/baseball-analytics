/**
 * 組合包最大回撤／連虧（單場+串 @$50）
 * 用法: node scripts/reportMlbPackageDrawdown.mjs
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
const FROZEN_PO = 0.7;
const OVER_GAP = 0.9;
const UNDER_GAP = 0.6;
const CAP = 1.25;
const ML2_MAX = 2.1;
const WINDOWS = [
  { from: '2024-04-01', to: '2024-09-30' },
  { from: '2025-04-01', to: '2025-09-30' },
  { from: '2026-04-01', to: '2026-07-31' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function applyDrop(sorted) {
  let s = sorted.slice(0, 3);
  if (s.length >= 3 && s[2].margin < DROP_R3) s = s.slice(0, 2);
  if (
    s.length >= 2 &&
    s[1].pickOdds >= DROP_R2_MIN &&
    s[1].pickOdds < DROP_R2_MAX
  ) {
    s = [s[0], ...s.slice(2)].slice(0, 2);
  }
  return s;
}
function selectMl(baseBets) {
  const adj = [];
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
    adj.push({ ...b, modelProb, ev, bScore });
  }
  const byDay = new Map();
  for (const b of adj) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (x, y) => y.bScore - x.bScore || y.margin - x.margin
    );
    applyDrop(arr).forEach((x, i) => out.push({ ...x, rank: i + 1 }));
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
  };
}
function ticketPnl(b) {
  return b.hit ? STAKE * (b.pickOdds - 1) : -STAKE;
}

console.log('load ML…');
const { shadow: baseAll } = buildFrozenBShadowPickSets({});
const inWin = (d) => WINDOWS.some((w) => d >= w.from && d <= w.to);
const mlBets = selectMl(baseAll.filter((b) => inWin(b.day)));

console.log('load totals…');
const model = getLatestMlbExpectedRunsValidation().model;
const dispersion = model.dispersion;
const totBets = [];
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
      totBets.push({ ...u, day, gameId: row.gameId });
      continue;
    }
    const isPitcher = g.parkFactor < (HYBRID.pitcherParkFactorMax || 0.97);
    if (isPitcher) {
      const h = Math.max(0.5, g.homeMu - FROZEN_PO / 2);
      const a = Math.max(0.5, g.awayMu - FROZEN_PO / 2);
      const o = trySide(g, { homeMu: h, awayMu: a, mu: h + a }, 'over', OVER_GAP);
      if (o) totBets.push({ ...o, day, gameId: row.gameId });
    } else {
      const o = trySide(g, raw, 'over', OVER_GAP);
      if (o && o.absGap <= CAP) totBets.push({ ...o, day, gameId: row.gameId });
    }
  }
}

const mlByDay = new Map();
for (const b of mlBets) {
  if (!mlByDay.has(b.day)) mlByDay.set(b.day, []);
  mlByDay.get(b.day).push(b);
}
const totByDay = new Map();
for (const b of totBets) {
  if (!totByDay.has(b.day)) totByDay.set(b.day, []);
  totByDay.get(b.day).push(b);
}
const parlays = [];
for (const [day, arr] of mlByDay) {
  const legs = [...arr]
    .filter((b) => Number(b.pickOdds) <= ML2_MAX)
    .sort((a, b) => (a.rank || 99) - (b.rank || 99))
    .slice(0, 2);
  if (legs.length < 2) continue;
  parlays.push({
    day,
    pickOdds: legs[0].pickOdds * legs[1].pickOdds,
    hit: legs[0].hit && legs[1].hit,
  });
}
for (const [day, mls] of mlByDay) {
  const r1 = [...mls].sort((a, b) => (a.rank || 99) - (b.rank || 99))[0];
  const unders = (totByDay.get(day) || []).filter((t) => t.side === 'under');
  if (!r1 || !unders.length) continue;
  const sorted = [...unders].sort(
    (a, b) => (b.expectedValue || 0) - (a.expectedValue || 0)
  );
  const tot = sorted.find((t) => t.gameId !== r1.gameId) || sorted[0];
  parlays.push({
    day,
    pickOdds: r1.pickOdds * tot.pickOdds,
    hit: r1.hit && tot.hit,
  });
}

const all = [...mlBets, ...totBets, ...parlays].sort((a, b) =>
  String(a.day).localeCompare(String(b.day))
);

let loseStreak = 0;
let maxLoseStreak = 0;
let worstLose = null;
let curStart = null;
let winStreak = 0;
let maxWin = 0;
for (const b of all) {
  if (b.hit) {
    winStreak += 1;
    maxWin = Math.max(maxWin, winStreak);
    loseStreak = 0;
    curStart = null;
  } else {
    winStreak = 0;
    if (!curStart) curStart = b.day;
    loseStreak += 1;
    if (loseStreak >= maxLoseStreak) {
      maxLoseStreak = loseStreak;
      worstLose = { n: loseStreak, from: curStart, to: b.day };
    }
  }
}

const byDay = new Map();
for (const b of all) {
  byDay.set(b.day, (byDay.get(b.day) || 0) + ticketPnl(b));
}
const days = [...byDay.keys()].sort();
let equity = 0;
let peak = 0;
let maxDD = 0;
let ddStart = null;
let worstDD = null;
let dayLose = 0;
let maxDayLose = 0;
let dayLoseStart = null;
let worstDayLose = null;
const daily = [];
for (const d of days) {
  const pnl = byDay.get(d);
  daily.push({ d, pnl });
  equity += pnl;
  if (equity > peak) {
    peak = equity;
    ddStart = d;
  }
  const dd = peak - equity;
  if (dd > maxDD) {
    maxDD = dd;
    worstDD = {
      peakDate: ddStart,
      troughDate: d,
      peak: Math.round(peak),
      trough: Math.round(equity),
      dd: Math.round(dd),
    };
  }
  if (pnl < 0) {
    if (!dayLoseStart) dayLoseStart = d;
    dayLose += 1;
    if (dayLose >= maxDayLose) {
      maxDayLose = dayLose;
      worstDayLose = { n: dayLose, from: dayLoseStart, to: d };
    }
  } else {
    dayLose = 0;
    dayLoseStart = null;
  }
}

function windowSum(arr, n) {
  let worst = 0;
  let from = null;
  let to = null;
  let s = 0;
  for (let i = 0; i < arr.length; i += 1) {
    s += arr[i].pnl;
    if (i >= n) s -= arr[i - n].pnl;
    if (i >= n - 1 && s < worst) {
      worst = s;
      from = arr[i - n + 1].d;
      to = arr[i].d;
    }
  }
  return { worst: Math.round(worst), from, to };
}

let eqS = 0;
let pkS = 0;
let ddS = 0;
for (const b of [...mlBets, ...totBets].sort((a, b) => a.day.localeCompare(b.day))) {
  eqS += ticketPnl(b);
  if (eqS > pkS) pkS = eqS;
  ddS = Math.max(ddS, pkS - eqS);
}

const out = {
  stakeUsd: STAKE,
  tickets: all.length,
  finalEquityUsd: Math.round(equity),
  maxDrawdownUsd: Math.round(maxDD),
  maxDrawdownDetail: worstDD,
  maxConsecutiveLosingTickets: worstLose,
  maxConsecutiveLosingDays: worstDayLose,
  worst7ActiveDays: windowSum(daily, 7),
  worst30ActiveDays: windowSum(daily, 30),
  maxWinTicketStreak: maxWin,
  singlesOnlyMaxDrawdownUsd: Math.round(ddS),
  psychologyBufferUsdAt50: Math.round(maxDD * 1.5),
  note: '組合包單場+串關；回撤依有下注日累積。活體可能更差，建議緩衝≥1.5×歷史最大回撤',
};
fs.writeFileSync('tmp-package-drawdown.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
