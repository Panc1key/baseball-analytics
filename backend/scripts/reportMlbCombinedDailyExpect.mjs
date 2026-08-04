/**
 * 鎖定 B + Under 衛星（+$25 串關）合併日均期望
 * 不改正式規則；純報表
 *
 * 用法: node scripts/reportMlbCombinedDailyExpect.mjs
 * 產物: tmp-combined-daily-expect.json
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
const ML_STAKE = 50;
const TOT_STAKE = 25;
const PARLAY_STAKE = 25;
const PARLAY_MAX_LEG_ODDS = 2.1;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function calendarDaysInclusive(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((b - a) / 86400000) + 1;
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

function pnlFlat(bets, stake) {
  let profit = 0;
  let hits = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      profit += stake * (b.pickOdds - 1);
    } else profit -= stake;
  }
  const n = bets.length;
  return {
    bets: n,
    hits,
    hitRate: n ? Number((hits / n).toFixed(4)) : null,
    roi: n ? Number((profit / (n * stake)).toFixed(4)) : null,
    usd: Math.round(profit),
  };
}

function evalParlay(legs, stake) {
  const combined = legs.reduce((p, x) => p * x.pickOdds, 1);
  const won = legs.every((x) => x.hit);
  return {
    combined: Number(combined.toFixed(4)),
    won,
    profit: won ? stake * (combined - 1) : -stake,
  };
}

function pnlParlays(parlays, stake) {
  if (!parlays.length) {
    return { bets: 0, hits: 0, hitRate: null, roi: null, usd: 0 };
  }
  let profit = 0;
  let wins = 0;
  for (const p of parlays) {
    profit += p.profit;
    if (p.won) wins += 1;
  }
  const n = parlays.length;
  return {
    bets: n,
    hits: wins,
    hitRate: Number((wins / n).toFixed(4)),
    roi: Number((profit / (n * stake)).toFixed(4)),
    usd: Math.round(profit),
  };
}

function dailyAvg(usd, pickDays, calendarDays) {
  return {
    perPickDay: pickDays ? Number((usd / pickDays).toFixed(2)) : null,
    perCalendarDay: calendarDays ? Number((usd / calendarDays).toFixed(2)) : null,
  };
}

console.log('Loading Locked B…');
const { shadow: mlPicks } = buildFrozenBShadowPickSets({});
const mlByDay = new Map();
for (const b of mlPicks) {
  if (!mlByDay.has(b.day)) mlByDay.set(b.day, []);
  mlByDay.get(b.day).push(b);
}

console.log('Building Under totals…');
const model = getLatestMlbExpectedRunsValidation().model;
const underPicks = [];
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
    if (pickOver) continue; // under-only
    if (underProb < 0.5) continue;
    const modelProb = underProb;
    const pickOdds = market.underOdds;
    const fair = market.fairUnder;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const edge = modelProb - fair;
    if (Math.abs(gap) < R.minAbsGap) continue;
    if (ev < R.minimumExpectedValue) continue;
    if (edge < R.minEdgeVsMarket) continue;
    if (modelProb < R.minimumModelProbability) continue;
    if (market.line > R.maxTotalLine) continue;
    underPicks.push({
      gameId: row.gameId,
      year: w.key,
      day: hk(row.commenceTime),
      pickOdds,
      ev,
      hit: actualTotal < market.line,
    });
  }
}

const underByDay = new Map();
for (const t of underPicks) {
  if (!underByDay.has(t.day)) underByDay.set(t.day, []);
  underByDay.get(t.day).push(t);
}

// 同日 ML 2 串：可看選邊中賠率≤2.10，取日排名前兩腿
const ml2Parlays = [];
for (const [day, list] of mlByDay) {
  const legs = [...list]
    .filter((b) => Number(b.pickOdds) <= PARLAY_MAX_LEG_ODDS)
    .sort((a, b) => (a.rank || 99) - (b.rank || 99))
    .slice(0, 2);
  if (legs.length < 2) continue;
  const year = day.slice(0, 4);
  ml2Parlays.push({
    day,
    year,
    ...evalParlay(
      legs.map((l) => ({ pickOdds: l.pickOdds, hit: l.hit })),
      PARLAY_STAKE
    ),
  });
}

// 同日 R1 獨贏 × 當日 EV 最高 Under（優先異場）
const mixParlays = [];
for (const [day, mls] of mlByDay) {
  const tots = underByDay.get(day) || [];
  if (!tots.length) continue;
  const r1 = [...mls].sort((a, b) => (a.rank || 99) - (b.rank || 99))[0];
  const sortedTot = [...tots].sort((a, b) => b.ev - a.ev);
  const tot = sortedTot.find((t) => t.gameId !== r1.gameId) || sortedTot[0];
  if (!tot) continue;
  mixParlays.push({
    day,
    year: day.slice(0, 4),
    ...evalParlay(
      [
        { pickOdds: r1.pickOdds, hit: r1.hit },
        { pickOdds: tot.pickOdds, hit: tot.hit },
      ],
      PARLAY_STAKE
    ),
  });
}

const calendarDays = WINDOWS.reduce(
  (s, w) => s + calendarDaysInclusive(w.from, w.to),
  0
);
const mlPickDays = mlByDay.size;
const underPickDays = underByDay.size;
const activeUnionDays = new Set([...mlByDay.keys(), ...underByDay.keys()]).size;

const mlFlat = pnlFlat(mlPicks, ML_STAKE);
const underFlat = pnlFlat(underPicks, TOT_STAKE);
const ml2 = pnlParlays(ml2Parlays, PARLAY_STAKE);
const mix = pnlParlays(mixParlays, PARLAY_STAKE);

const pkgSingles = {
  id: 'lockedB_50_plus_under_25',
  usd: mlFlat.usd + underFlat.usd,
  components: { lockedB: mlFlat, underSat: underFlat },
};
const pkgPlusMl2 = {
  id: 'singles_plus_ml2leg_25',
  usd: pkgSingles.usd + ml2.usd,
  components: { ...pkgSingles.components, ml2leg: ml2 },
};
const pkgPlusMix = {
  id: 'singles_plus_r1xUnder_25',
  usd: pkgSingles.usd + mix.usd,
  components: { ...pkgSingles.components, r1xUnder: mix },
};
const pkgFull = {
  id: 'singles_plus_ml2_plus_r1xUnder',
  usd: pkgSingles.usd + ml2.usd + mix.usd,
  components: { lockedB: mlFlat, underSat: underFlat, ml2leg: ml2, r1xUnder: mix },
  note: '兩種串關可同日並存；歷史加總，非保證未來',
};

function enrichPkg(pkg) {
  return {
    ...pkg,
    daily: {
      perMlPickDay: dailyAvg(pkg.usd, mlPickDays, calendarDays),
      perUnionActiveDay: dailyAvg(pkg.usd, activeUnionDays, calendarDays),
      perCalendarDay: Number((pkg.usd / calendarDays).toFixed(2)),
    },
  };
}

const byYear = {};
for (const w of WINDOWS) {
  const y = w.key;
  const mlY = pnlFlat(
    mlPicks.filter((b) => String(b.window || b.day?.slice(0, 4)) === y || b.day?.startsWith(y)),
    ML_STAKE
  );
  // window field on shadow
  const mlY2 = pnlFlat(
    mlPicks.filter((b) => String(b.window) === y || String(b.day || '').startsWith(y)),
    ML_STAKE
  );
  const underY = pnlFlat(
    underPicks.filter((t) => t.year === y),
    TOT_STAKE
  );
  const ml2Y = pnlParlays(
    ml2Parlays.filter((p) => p.year === y),
    PARLAY_STAKE
  );
  const mixY = pnlParlays(
    mixParlays.filter((p) => p.year === y),
    PARLAY_STAKE
  );
  const calY = calendarDaysInclusive(w.from, w.to);
  const pickDaysY = [...mlByDay.keys()].filter((d) => d.startsWith(y)).length;
  const singlesUsd = mlY2.usd + underY.usd;
  const fullUsd = singlesUsd + ml2Y.usd + mixY.usd;
  byYear[y] = {
    calendarDays: calY,
    mlPickDays: pickDaysY,
    lockedB: mlY2,
    underSat: underY,
    ml2leg: ml2Y,
    r1xUnder: mixY,
    packages: {
      singlesOnly: {
        usd: singlesUsd,
        perPickDay: Number((singlesUsd / Math.max(1, pickDaysY)).toFixed(2)),
        perCalendarDay: Number((singlesUsd / calY).toFixed(2)),
      },
      singlesPlusBothParlays: {
        usd: fullUsd,
        perPickDay: Number((fullUsd / Math.max(1, pickDaysY)).toFixed(2)),
        perCalendarDay: Number((fullUsd / calY).toFixed(2)),
      },
    },
  };
  void mlY;
}

const out = {
  experimentId: 'combined_daily_expect_v1',
  stakes: {
    lockedBSingle: ML_STAKE,
    underSatellite: TOT_STAKE,
    parlay: PARLAY_STAKE,
  },
  windows: WINDOWS,
  denominators: {
    calendarDays,
    mlPickDays,
    underPickDays,
    unionActiveDays: activeUnionDays,
    note:
      'perPickDay＝有鎖定 B 選邊的港日；perCalendarDay＝窗內每個日曆日（含空手日）',
  },
  components: {
    lockedB: { ...mlFlat, daily: dailyAvg(mlFlat.usd, mlPickDays, calendarDays) },
    underSat: {
      ...underFlat,
      daily: dailyAvg(underFlat.usd, underPickDays, calendarDays),
    },
    ml2leg: {
      ...ml2,
      daily: dailyAvg(ml2.usd, ml2Parlays.length || 1, calendarDays),
      rule: `同日≥2 腿且賠率≤${PARLAY_MAX_LEG_ODDS}，取日排名前兩腿`,
    },
    r1xUnder: {
      ...mix,
      daily: dailyAvg(mix.usd, mixParlays.length || 1, calendarDays),
      rule: '同日 R1 獨贏 × 當日 EV 最高 Under（優先異場）',
    },
  },
  packages: {
    singlesOnly: enrichPkg(pkgSingles),
    singlesPlusMl2: enrichPkg(pkgPlusMl2),
    singlesPlusMix: enrichPkg(pkgPlusMix),
    fullRecommended: enrichPkg(pkgFull),
  },
  byYear,
  plainAnswer: {
    singlesOnly_avgPerMlPickDay: enrichPkg(pkgSingles).daily.perMlPickDay.perPickDay,
    singlesOnly_avgPerCalendarDay: enrichPkg(pkgSingles).daily.perCalendarDay,
    withParlays_avgPerMlPickDay: enrichPkg(pkgFull).daily.perMlPickDay.perPickDay,
    withParlays_avgPerCalendarDay: enrichPkg(pkgFull).daily.perCalendarDay,
    note:
      '期望＝歷史窗回測均攤，非保證；空手日會拉低日曆日均。建議看「有選邊日」為操作日期望。',
  },
};

fs.writeFileSync(
  new URL('../tmp-combined-daily-expect.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out.plainAnswer, null, 2));
console.log(
  JSON.stringify(
    {
      componentsUsd: {
        lockedB: mlFlat.usd,
        under: underFlat.usd,
        ml2: ml2.usd,
        mix: mix.usd,
      },
      packagesUsd: {
        singles: pkgSingles.usd,
        full: pkgFull.usd,
      },
      days: { calendarDays, mlPickDays, underPickDays, activeUnionDays },
    },
    null,
    2
  )
);
console.log('wrote tmp-combined-daily-expect.json');
