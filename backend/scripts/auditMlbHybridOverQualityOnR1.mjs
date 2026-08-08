/**
 * 正式 Hybrid+R1 殘餘池上掃 Over 質量刀（正面方向）
 *   node scripts/auditMlbHybridOverQualityOnR1.mjs
 * 產物: tmp-hybrid-over-quality-on-r1.json
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
function yearOk(y) {
  return (
    (y?.['2024'] ?? -999) >= -80 &&
    (y?.['2025'] ?? -999) >= -80 &&
    (y?.['2026'] ?? -999) >= -80
  );
}
function parkBucket(pf) {
  const n = Number(pf);
  if (!Number.isFinite(n)) return 'unk';
  if (n <= 0.97) return 'pitcher';
  if (n >= 1.03) return 'hitter';
  return 'mid';
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

console.log('[hybrid-over-quality] build…');
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
    const day = new Date(row.commenceTime).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Hong_Kong',
    });
    const home = features?.pitchers?.home || {};
    const away = features?.pitchers?.away || {};
    const homeEra = Number(home.era);
    const awayEra = Number(away.era);
    pool.push({
      year: w.key,
      month: day.slice(0, 7),
      side: cls.side,
      odds,
      line: Number(cls.line),
      absGap: Number(cls.absGap),
      ev: Number(cls.expectedValue),
      hybridPath: cls.hybridPath || 'unknown',
      type: layered.gameType.type,
      park: parkBucket(features.parkFactor),
      bothEraLe425:
        Number.isFinite(homeEra) &&
        Number.isFinite(awayEra) &&
        homeEra <= 4.25 &&
        awayEra <= 4.25,
      result: settle(cls.side, cls.line, total),
    });
  }
}

const baseS = summarize(pool);

function evalKeep(pred, id) {
  const kept = pool.filter(pred);
  const s = summarize(kept);
  const byYear = Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const b = summarize(pool.filter((x) => x.year === y));
      const a = summarize(kept.filter((x) => x.year === y));
      return [y, Number((a.usd - b.usd).toFixed(2))];
    })
  );
  const dUsd = Number((s.usd - baseS.usd).toFixed(2));
  const dHrPp =
    s.hr != null && baseS.hr != null
      ? Number(((s.hr - baseS.hr) * 100).toFixed(2))
      : null;
  const cutN = baseS.n - s.n;
  const loy = {};
  for (const leave of ['2024', '2025', '2026']) {
    const keepY = ['2024', '2025', '2026'].filter((y) => y !== leave);
    const a = summarize(kept.filter((x) => keepY.includes(x.year)));
    const b = summarize(pool.filter((x) => keepY.includes(x.year)));
    loy[leave] = Number((a.usd - b.usd).toFixed(2));
  }
  const months = [...new Set(pool.map((g) => g.month))].sort();
  let monthSum = 0;
  for (const m of months) {
    const a = summarize(kept.filter((x) => x.month === m));
    const b = summarize(pool.filter((x) => x.month === m));
    monthSum += a.usd - b.usd;
  }
  const warmup = 3;
  let expUsd = 0;
  const expByYear = { '2024': 0, '2025': 0, '2026': 0 };
  for (let i = warmup; i < months.length; i++) {
    const m = months[i];
    const a = summarize(kept.filter((x) => x.month === m));
    const b = summarize(pool.filter((x) => x.month === m));
    const d = a.usd - b.usd;
    expUsd += d;
    const y = m.slice(0, 4);
    if (expByYear[y] != null) expByYear[y] += d;
  }
  const fixedPass =
    dUsd >= 50 && (dHrPp ?? -1) >= -0.2 && yearOk(byYear) && cutN >= 5;
  const loyPass = Object.values(loy).every((v) => v >= 0);
  const monthPass = monthSum >= 0;
  const expandingPass =
    expUsd >= 0 &&
    (expByYear['2024'] ?? -999) >= -80 &&
    (expByYear['2025'] ?? -999) >= -80 &&
    (expByYear['2026'] ?? -999) >= -80;
  return {
    id,
    after: s,
    cutN,
    dUsd,
    dHrPp,
    byYear,
    loy,
    monthSum: Number(monthSum.toFixed(2)),
    expanding: {
      dUsd: Math.round(expUsd * 100) / 100,
      byYear: Object.fromEntries(
        Object.entries(expByYear).map(([k, v]) => [k, Number(v.toFixed(2))])
      ),
    },
    gateFixed: fixedPass,
    gateStress: fixedPass && loyPass && monthPass && expandingPass,
  };
}

const trials = [];

// 砍弱路徑
trials.push(
  evalKeep((b) => b.hybridPath !== 'pitcher_debiased_over', 'cut_pitcher_debiased_over')
);
trials.push(
  evalKeep(
    (b) => !(b.side === 'over' && b.park === 'mid'),
    'cut_over_mid_park'
  )
);
trials.push(
  evalKeep(
    (b) => !(b.side === 'over' && b.park === 'pitcher'),
    'cut_over_pitcher_park'
  )
);

// 收緊 raw Over gap（僅砍 over 且 path raw_over 且 gap 過大）
for (const g of [1.15, 1.1, 1.0, 0.9]) {
  trials.push(
    evalKeep(
      (b) =>
        !(
          b.side === 'over' &&
          b.hybridPath === 'raw_over' &&
          Number.isFinite(b.absGap) &&
          b.absGap > g
        ),
      `raw_over_max_abs_gap_${g}`
    )
  );
}

// Over 最低 EV
for (const ev of [0.04, 0.05, 0.06]) {
  trials.push(
    evalKeep(
      (b) => !(b.side === 'over' && Number.isFinite(b.ev) && b.ev < ev),
      `over_min_ev_${ev}`
    )
  );
}

// 低線 Over（非 R1 殘餘）
for (const line of [7, 7.5, 8]) {
  trials.push(
    evalKeep(
      (b) => !(b.side === 'over' && b.line <= line),
      `ban_over_line_le_${line}`
    )
  );
}

// 雙強 ERA + 線≤7.5（比正式 strong-sp 略寬，看增量）
trials.push(
  evalKeep(
    (b) => !(b.side === 'over' && b.bothEraLe425 && b.line <= 7.5),
    'ban_over_bothEra425_line75'
  )
);
trials.push(
  evalKeep(
    (b) => !(b.side === 'over' && b.bothEraLe425 && b.line <= 8),
    'ban_over_bothEra425_line8'
  )
);

// normal×Over 薄邊
trials.push(
  evalKeep(
    (b) =>
      !(
        b.side === 'over' &&
        b.type === 'normal' &&
        Number.isFinite(b.ev) &&
        b.ev < 0.05
      ),
    'cut_normal_over_ev_lt_05'
  )
);

trials.sort((a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999));
const promote = trials.filter((t) => t.gateStress);
const fixedOnly = trials.filter((t) => t.gateFixed && !t.gateStress);

const out = {
  experimentId: 'hybrid-over-quality-on-r1-2026-08-08',
  baseline: baseS,
  promote,
  fixedOnlyTop: fixedOnly.slice(0, 5),
  top: trials.slice(0, 12),
  verdict: promote.length
    ? 'FOUND_HYBRID_OVER_KNIFE'
    : fixedOnly.length
      ? 'FIXED_ONLY_NO_STRESS'
      : 'NO_HYBRID_OVER_KNIFE',
};

fs.writeFileSync(
  new URL('../tmp-hybrid-over-quality-on-r1.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      baseline: baseS,
      promote: promote.map((t) => ({
        id: t.id,
        dUsd: t.dUsd,
        dHrPp: t.dHrPp,
        cutN: t.cutN,
        byYear: t.byYear,
        loy: t.loy,
        monthSum: t.monthSum,
        expanding: t.expanding,
      })),
      best: trials[0]
        ? {
            id: trials[0].id,
            dUsd: trials[0].dUsd,
            dHrPp: trials[0].dHrPp,
            byYear: trials[0].byYear,
            loy: trials[0].loy,
            gateFixed: trials[0].gateFixed,
            gateStress: trials[0].gateStress,
          }
        : null,
      verdict: out.verdict,
    },
    null,
    2
  )
);
