/**
 * 臨時：alt T3（rpg≥5 & era≥4.8）在 Hybrid 上 ban Under / ban Over
 *   node scripts/auditMlbAltOffenseHybridRoute.mjs
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

const BASE = MLB_TOTALS_SATELLITE_SPEC.rules;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-08-07' },
];

function fin(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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

function byYearDelta(pool, keepFn) {
  return Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const base = sum(pool.filter((b) => b.year === y));
      const after = sum(pool.filter((b) => b.year === y && keepFn(b)));
      return [y, Number((after.usd - base.usd).toFixed(2))];
    })
  );
}

function isAlt(features, minRpg = 5, minEra = 4.8) {
  const hr = fin(features?.home?.recentRunsPerGame ?? features?.home?.runsPerGame);
  const ar = fin(features?.away?.recentRunsPerGame ?? features?.away?.runsPerGame);
  if (hr == null || ar == null) return false;
  if ((hr + ar) / 2 < minRpg) return false;
  const he = fin(features?.pitchers?.home?.era ?? features?.pitchers?.homeRecent?.recent3Era);
  const ae = fin(features?.pitchers?.away?.era ?? features?.pitchers?.awayRecent?.recent3Era);
  return (he == null || he >= minEra) && (ae == null || ae >= minEra);
}

function bestTotals(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'totals');
    if (!m) continue;
    for (const over of m.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = m.outcomes.find(
        (o) => o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!over.price || !under?.price) continue;
      const oo = +over.price;
      const uo = +under.price;
      if (oo < BASE.pickOddsMin || uo < BASE.pickOddsMin) continue;
      if (oo > BASE.pickOddsMax || uo > BASE.pickOddsMax) continue;
      const vig = 1 / oo + 1 / uo;
      const fair = removeVig(decimalToImpliedProb(oo), decimalToImpliedProb(uo));
      const cand = {
        line: Number(over.point),
        overOdds: oo,
        underOdds: uo,
        fairOver: fair.fairA,
        fairUnder: fair.fairB,
        vig,
      };
      if (!best || vig < best.vig) best = cand;
    }
  }
  return best;
}

const model = getLatestMlbExpectedRunsValidation().model;
const pool = [];
for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
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
    const tot = bestTotals(row.gameId, row.commenceTime);
    if (!tot) continue;
    const pred = predictMlbGameRuns(model, features, { totalLine: tot.line });
    let cls = classifyMlbTotalsHybridCandidate({
      prediction: pred,
      totalsMarket: tot,
      parkFactor: features.parkFactor,
      spec: {
        ...MLB_TOTALS_SATELLITE_HYBRID_SPEC,
        rawOverMaxAbsGap: config.mlbTotalsRawOverMaxAbsGap,
      },
    });
    cls = applyTotalsUnderPitcherToCandidate(
      applyTotalsUnderBlowupGapToCandidate(
        applyTotalsFragileUnderShadow(cls, features),
        features
      ),
      features
    );
    if (cls.tier !== 'actionable' || !cls.side) continue;
    const total = +row.homeScore + +row.awayScore;
    const odds = cls.side === 'over' ? tot.overOdds : tot.underOdds;
    pool.push({
      year: w.key,
      side: cls.side,
      odds,
      result: settle(cls.side, cls.line, total),
      alt: isAlt(features),
    });
  }
}

const base = sum(pool);
const afterBanUnder = sum(pool.filter((b) => !(b.alt && b.side === 'under')));
const afterBanOver = sum(pool.filter((b) => !(b.alt && b.side === 'over')));
const cutUnder = sum(pool.filter((b) => b.alt && b.side === 'under'));
const cutOver = sum(pool.filter((b) => b.alt && b.side === 'over'));
const out = {
  baseline: base,
  altN: pool.filter((b) => b.alt).length,
  banUnder: {
    after: afterBanUnder,
    cut: cutUnder,
    dUsd: Number((afterBanUnder.usd - base.usd).toFixed(2)),
    dHrPp: Number((((afterBanUnder.hr ?? 0) - (base.hr ?? 0)) * 100).toFixed(2)),
    byYearDeltaUsd: byYearDelta(pool, (b) => !(b.alt && b.side === 'under')),
  },
  banOver: {
    after: afterBanOver,
    cut: cutOver,
    dUsd: Number((afterBanOver.usd - base.usd).toFixed(2)),
    dHrPp: Number((((afterBanOver.hr ?? 0) - (base.hr ?? 0)) * 100).toFixed(2)),
    byYearDeltaUsd: byYearDelta(pool, (b) => !(b.alt && b.side === 'over')),
  },
  note: 'alt 高打在 Hybrid 可下注僅 ~7 場；ban Over 表面 +$201 但樣本極小，只記 research。',
};
fs.writeFileSync(
  new URL('../tmp-alt-offense-hybrid-route.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
