/**
 * Hybrid：在 R1 底座上試「Over 向市場收縮」／薄邊降權（μ 風格）
 *   node scripts/auditMlbHybridMarketShrink.mjs
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
  if (!settled.length) return { n: 0, hr: null, usd: 0 };
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

console.log('[hybrid-market-shrink] build…');
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
    const fair = cls.side === 'over' ? totals.fairOver : totals.fairUnder;
    const modelP = Number(cls.modelProbability ?? cls.pModel ?? null);
    // Hybrid candidate may expose different prob fields — derive from EV if needed
    let pModel = modelP;
    if (!Number.isFinite(pModel) && Number.isFinite(Number(cls.expectedValue))) {
      // ev = p*(o-1)-(1-p) => p = (ev+1)/o
      pModel = (Number(cls.expectedValue) + 1) / odds;
    }
    if (!Number.isFinite(pModel)) pModel = fair;
    pool.push({
      year: w.key,
      side: cls.side,
      odds,
      fair,
      pModel,
      absGap: Number(cls.absGap),
      hybridPath: cls.hybridPath || 'unknown',
      type: layered.gameType.type,
      result: settle(cls.side, cls.line, total),
      ev: Number(cls.expectedValue),
    });
  }
}

const base = summarize(pool);

function keepWithShrink(w, { onlyOver = false, onlyPath = null, minGap = null } = {}) {
  return pool.filter((b) => {
    if (onlyOver && b.side !== 'over') return true;
    if (onlyPath && b.hybridPath !== onlyPath) return true;
    if (minGap != null && !(Number.isFinite(b.absGap) && b.absGap >= minGap)) return true;
    const marketP = 1 / b.odds;
    const p = (1 - w) * b.pModel + w * marketP;
    const ev = p * (b.odds - 1) - (1 - p);
    // drop if EV falls below hybrid min (use 0.03 as soft)
    return ev >= 0.03;
  });
}

function evalKeep(rows) {
  const list = Array.isArray(rows) ? rows : pool.filter(rows);
  const s = summarize(list);
  const byYear = Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const b = summarize(pool.filter((x) => x.year === y));
      const a = summarize(list.filter((x) => x.year === y));
      return [y, Number((a.usd - b.usd).toFixed(2))];
    })
  );
  const dUsd = Number((s.usd - base.usd).toFixed(2));
  const dHrPp =
    s.hr != null && base.hr != null
      ? Number(((s.hr - base.hr) * 100).toFixed(2))
      : null;
  return {
    after: s,
    cutN: base.n - s.n,
    dUsd,
    dHrPp,
    byYear,
    gate: dUsd >= 0 && (dHrPp ?? -1) >= -0.2 && yearOk(byYear) && base.n - s.n >= 5,
  };
}

const real = [];
for (const w of [0.15, 0.25, 0.35, 0.45]) {
  real.push({ id: `shrink_all_w${w}`, ...evalKeep(keepWithShrink(w, {})) });
}
for (const w of [0.2, 0.35, 0.5]) {
  real.push({
    id: `shrink_over_w${w}`,
    ...evalKeep(keepWithShrink(w, { onlyOver: true })),
  });
}
for (const w of [0.25, 0.4]) {
  real.push({
    id: `shrink_pitcher_debiased_w${w}`,
    ...evalKeep(keepWithShrink(w, { onlyPath: 'pitcher_debiased_over' })),
  });
}

real.sort((a, b) => (b.dUsd ?? -999) - (a.dUsd ?? -999));
const promote = real.filter((t) => t.gate);

const out = {
  experimentId: 'hybrid-market-shrink-2026-08-08',
  baseline: base,
  top: real.slice(0, 10),
  promote,
  verdict: promote.length ? 'HYBRID_SHRINK_COMPARE' : 'HYBRID_NO_SHRINK',
};
fs.writeFileSync(
  new URL('../tmp-hybrid-market-shrink.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      baseline: base,
      promote: promote.map((t) => ({
        id: t.id,
        dUsd: t.dUsd,
        dHrPp: t.dHrPp,
        cutN: t.cutN,
        byYear: t.byYear,
      })),
      best: real[0]
        ? {
            id: real[0].id,
            dUsd: real[0].dUsd,
            dHrPp: real[0].dHrPp,
            byYear: real[0].byYear,
            gate: real[0].gate,
          }
        : null,
      verdict: out.verdict,
    },
    null,
    2
  )
);
