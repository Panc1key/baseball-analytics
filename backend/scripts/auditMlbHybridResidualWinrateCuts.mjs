/**
 * 殘餘池提勝率試砍（相對偏弱但仍正 EV 的片）
 *   node scripts/auditMlbHybridResidualWinrateCuts.mjs
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

function sum(bets) {
  const s = bets.filter((b) => b.result !== 'push');
  if (!s.length) return { n: 0, hr: null, usd: 0 };
  let u = 0;
  let h = 0;
  for (const b of s) {
    if (b.result === 'win') {
      h += 1;
      u += b.odds - 1;
    } else u -= 1;
  }
  return {
    n: s.length,
    hr: Number((h / s.length).toFixed(4)),
    usd: Math.round(u * 50 * 100) / 100,
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

console.log('[residual-winrate] build…');
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
    if (cls.side === 'over' && layered.route.bans.includes('totals_over')) continue;
    const total = +row.homeScore + +row.awayScore;
    const odds = cls.side === 'over' ? totals.overOdds : totals.underOdds;
    const pf = Number(features.parkFactor);
    const parkBucket =
      cls.parkBucket || (pf < 0.97 ? 'pitcher' : pf > 1.03 ? 'hitter' : 'mid');
    pool.push({
      year: w.key,
      side: cls.side,
      odds,
      result: settle(cls.side, cls.line, total),
      type: layered.gameType.type,
      hybridPath: cls.hybridPath || 'unknown',
      parkBucket,
      line: cls.line,
    });
  }
}

const base = sum(pool);
const cuts = [
  {
    id: 'cut_pitcher_debiased_over',
    fn: (b) => b.hybridPath !== 'pitcher_debiased_over',
  },
  {
    id: 'cut_normal_pitcher_debiased_over',
    fn: (b) => !(b.type === 'normal' && b.hybridPath === 'pitcher_debiased_over'),
  },
  {
    id: 'cut_normal_over_mid',
    fn: (b) => !(b.type === 'normal' && b.side === 'over' && b.parkBucket === 'mid'),
  },
  {
    id: 'cut_normal_over_line_7_8',
    fn: (b) => !(b.type === 'normal' && b.side === 'over' && b.line > 7 && b.line <= 8),
  },
  {
    id: 'cut_over_mid_all',
    fn: (b) => !(b.side === 'over' && b.parkBucket === 'mid'),
  },
];

function ydelta(keep) {
  return Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const b = sum(pool.filter((x) => x.year === y));
      const a = sum(pool.filter((x) => x.year === y && keep(x)));
      return [y, Number((a.usd - b.usd).toFixed(2))];
    })
  );
}

const trials = cuts.map((c) => {
  const after = sum(pool.filter(c.fn));
  const cut = sum(pool.filter((b) => !c.fn(b)));
  const dUsd = Number((after.usd - base.usd).toFixed(2));
  const dHrPp =
    after.hr != null && base.hr != null
      ? Number(((after.hr - base.hr) * 100).toFixed(2))
      : null;
  const byYear = ydelta(c.fn);
  const yearOkUsd =
    (byYear['2024'] ?? -999) >= -120 &&
    (byYear['2025'] ?? -999) >= -120 &&
    (byYear['2026'] ?? -999) >= -120;
  return {
    id: c.id,
    cut,
    after,
    dUsd,
    dHrPp,
    byYear,
    winrateGate: dHrPp != null && dHrPp >= 0.4 && cut.n >= 20 && yearOkUsd,
    usdGate: dUsd >= 0 && (dHrPp ?? -1) >= -0.2 && yearOkUsd,
  };
});

const out = {
  experimentId: 'hybrid-residual-winrate-cuts-2026-08-08',
  base,
  trials,
  promoteWinrate: trials.filter((t) => t.winrateGate),
  promoteUsd: trials.filter((t) => t.usdGate),
  verdict:
    trials.some((t) => t.usdGate)
      ? 'FOUND_USD_CUT'
      : trials.some((t) => t.winrateGate)
        ? 'FOUND_WINRATE_ONLY_COMPARE'
        : 'NO_CUT_WORTH_APPLY',
};
fs.writeFileSync(
  new URL('../tmp-hybrid-residual-winrate-cuts.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
