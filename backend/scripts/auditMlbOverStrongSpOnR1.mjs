/**
 * 正式 Hybrid 底座（Fragile+Blowup+UnderPitcher+R1）上：
 * 雙強先發×低線禁 Over 的「增量」是否仍正、能否過 LOY／月閘。
 *   node scripts/auditMlbOverStrongSpOnR1.mjs
 * 產物: tmp-over-strong-sp-on-r1.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import { getCachedMlbGameWeather } from '../src/services/MlbGameWeatherService.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import {
  classifyMlbTotalsHybridCandidate,
  MLB_TOTALS_SATELLITE_HYBRID_SPEC,
  MLB_TOTALS_SATELLITE_SPEC,
} from '../src/services/MlbTotalsSatellite.js';
import { config } from '../src/config.js';
import { applyTotalsFragileUnderShadow } from '../src/services/MlbTotalsFragileUnderShadow.js';
import { applyTotalsUnderBlowupGapToCandidate } from '../src/services/MlbTotalsUnderBlowupGapShadow.js';
import { applyTotalsUnderPitcherToCandidate } from '../src/services/MlbTotalsUnderPitcherShadow.js';
import { buildMlbLayeredDecision } from '../src/services/MlbLayeredArchitecture.js';
import {
  matchOverStrongSpDuel,
  MLB_TOTALS_OVER_STRONG_SP_DUEL_SPEC,
} from '../src/services/MlbTotalsOverStrongSpDuelShadow.js';

const STAKE = 50;
const BASE = MLB_TOTALS_SATELLITE_SPEC.rules;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-08-07' },
];

function settle(side, line, total) {
  if (side === 'over') {
    if (total > line) return 'win';
    if (total < line) return 'loss';
    return 'push';
  }
  if (total < line) return 'win';
  if (total > line) return 'loss';
  return 'push';
}

function summarize(bets) {
  const settled = bets.filter((b) => b.result !== 'push');
  if (!settled.length) return { n: 0, hr: null, usd: 0, hits: 0 };
  let unit = 0;
  let hits = 0;
  for (const b of settled) {
    if (b.result === 'win') {
      hits += 1;
      unit += b.odds - 1;
    } else unit -= 1;
  }
  return {
    n: settled.length,
    hits,
    hr: Number((hits / settled.length).toFixed(4)),
    usd: Math.round(unit * STAKE * 100) / 100,
  };
}

function bestTotals(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return { totals: null, homeOdds: null };
  let best = null;
  let homeOdds = null;
  const homeTeam = pit.home_team;
  for (const book of pit.bookmakers) {
    const h2h = book.markets?.find((m) => m.key === 'h2h');
    if (h2h && homeTeam) {
      const home = h2h.outcomes?.find((o) => o.name === homeTeam);
      if (home?.price && (homeOdds == null || Number(home.price) < homeOdds)) {
        homeOdds = Number(home.price);
      }
    }
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
      const fair = removeVig(
        decimalToImpliedProb(overOdds),
        decimalToImpliedProb(underOdds)
      );
      const cand = {
        line: Number(over.point),
        overOdds,
        underOdds,
        fairOver: fair.fairA,
        fairUnder: fair.fairB,
        vig,
      };
      if (!best || vig < best.vig) best = cand;
    }
  }
  return { totals: best, homeOdds };
}

function yearOk(y) {
  return (
    (y?.['2024'] ?? -999) >= -80 &&
    (y?.['2025'] ?? -999) >= -80 &&
    (y?.['2026'] ?? -999) >= -80
  );
}

console.log('[over-sp-on-r1] build…');
const model = getLatestMlbExpectedRunsValidation().model;
const pool = [];

for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL
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
    features.parkFactor = resolveMlbParkFactor({
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    features.weather = getCachedMlbGameWeather(row.gameId)?.weather || null;
    const { totals, homeOdds } = bestTotals(row.gameId, row.commenceTime);
    if (!totals) continue;
    const pred = predictMlbGameRuns(model, features, { totalLine: totals.line });
    let cls = classifyMlbTotalsHybridCandidate({
      prediction: pred,
      totalsMarket: totals,
      parkFactor: features.parkFactor,
      spec: {
        ...MLB_TOTALS_SATELLITE_HYBRID_SPEC,
        rawOverMaxAbsGap: config.mlbTotalsRawOverMaxAbsGap,
      },
    });
    cls = applyTotalsFragileUnderShadow(cls, features);
    cls = applyTotalsUnderBlowupGapToCandidate(cls, features);
    cls = applyTotalsUnderPitcherToCandidate(cls);
    if (cls.tier !== 'actionable' || !cls.side) continue;
    const layered = buildMlbLayeredDecision({
      features,
      totalsLine: cls.line,
      homeOdds,
      gameId: row.gameId,
    });
    // 正式 R1：對決禁 Over
    if (cls.side === 'over' && layered.route.bans.includes('totals_over')) continue;

    const total = +row.homeScore + +row.awayScore;
    const odds = cls.side === 'over' ? totals.overOdds : totals.underOdds;
    const match = matchOverStrongSpDuel(cls, features, MLB_TOTALS_OVER_STRONG_SP_DUEL_SPEC);
    const day = new Date(row.commenceTime).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Hong_Kong',
    });
    pool.push({
      year: w.key,
      month: day.slice(0, 7),
      side: cls.side,
      odds,
      line: cls.line,
      type: layered.gameType.type,
      hybridPath: cls.hybridPath || null,
      matchStrongSp: Boolean(match.matched),
      result: settle(cls.side, cls.line, total),
    });
  }
}

const base = pool;
const cut = pool.filter((b) => !(b.side === 'over' && b.matchStrongSp));
const baseS = summarize(base);
const cutS = summarize(cut);
const cutSlice = summarize(pool.filter((b) => b.side === 'over' && b.matchStrongSp));

const byYear = Object.fromEntries(
  ['2024', '2025', '2026'].map((y) => {
    const b = summarize(base.filter((x) => x.year === y));
    const a = summarize(cut.filter((x) => x.year === y));
    return [y, Number((a.usd - b.usd).toFixed(2))];
  })
);
const dUsd = Number((cutS.usd - baseS.usd).toFixed(2));
const dHrPp =
  cutS.hr != null && baseS.hr != null
    ? Number(((cutS.hr - baseS.hr) * 100).toFixed(2))
    : null;

const loy = {};
for (const leave of ['2024', '2025', '2026']) {
  const keep = ['2024', '2025', '2026'].filter((y) => y !== leave);
  const a = summarize(cut.filter((x) => keep.includes(x.year)));
  const b = summarize(base.filter((x) => keep.includes(x.year)));
  loy[leave] = Number((a.usd - b.usd).toFixed(2));
}

const months = [...new Set(pool.map((g) => g.month))].sort();
let monthSum = 0;
let monthPos = 0;
let monthNeg = 0;
for (const m of months) {
  const a = summarize(cut.filter((x) => x.month === m));
  const b = summarize(base.filter((x) => x.month === m));
  const d = a.usd - b.usd;
  monthSum += d;
  if (d > 0) monthPos += 1;
  if (d < 0) monthNeg += 1;
}

const warmup = 3;
let expUsd = 0;
const expByYear = { '2024': 0, '2025': 0, '2026': 0 };
for (let i = warmup; i < months.length; i++) {
  const m = months[i];
  const a = summarize(cut.filter((x) => x.month === m));
  const b = summarize(base.filter((x) => x.month === m));
  const d = a.usd - b.usd;
  expUsd += d;
  const y = m.slice(0, 4);
  if (expByYear[y] != null) expByYear[y] += d;
}

const fixedPass =
  dUsd >= 50 && (dHrPp ?? -1) >= -0.2 && yearOk(byYear) && cutSlice.n >= 5;
const loyPass = Object.values(loy).every((v) => v >= 0);
const monthPass = monthSum >= 0;
const expandingPass =
  expUsd >= 0 &&
  (expByYear['2024'] ?? -999) >= -80 &&
  (expByYear['2025'] ?? -999) >= -80 &&
  (expByYear['2026'] ?? -999) >= -80;

const out = {
  experimentId: 'over-strong-sp-on-r1-2026-08-08',
  plain: '底座＝Hybrid 正式影（Fragile/Blowup/UnderPitcher）+ R1 禁對決 Over；再疊 strong-SP×line≤7',
  spec: {
    maxTotalLine: MLB_TOTALS_OVER_STRONG_SP_DUEL_SPEC.maxTotalLine,
    maxStarterEra: MLB_TOTALS_OVER_STRONG_SP_DUEL_SPEC.maxStarterEra,
  },
  baseline: baseS,
  after: cutS,
  incrementalCut: cutSlice,
  overlapNote: 'cut 僅統計 R1 之後仍存活的 Over',
  fixed: { dUsd, dHrPp, byYear, pass: fixedPass },
  loy: { deltas: loy, pass: loyPass },
  monthly: {
    sum: Number(monthSum.toFixed(2)),
    pos: monthPos,
    neg: monthNeg,
    pass: monthPass,
  },
  expanding: {
    warmupMonths: warmup,
    dUsd: Math.round(expUsd * 100) / 100,
    byYear: Object.fromEntries(
      Object.entries(expByYear).map(([k, v]) => [k, Number(v.toFixed(2))])
    ),
    pass: expandingPass,
  },
  verdict:
    fixedPass && loyPass && monthPass && expandingPass
      ? 'PASS_STRESS_MAY_APPLY'
      : fixedPass && monthPass && expandingPass && !loyPass
        ? 'FAIL_LOY_KEEP_COMPARE'
        : 'FAIL_STRESS_KEEP_COMPARE',
};

fs.writeFileSync(
  new URL('../tmp-over-strong-sp-on-r1.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
