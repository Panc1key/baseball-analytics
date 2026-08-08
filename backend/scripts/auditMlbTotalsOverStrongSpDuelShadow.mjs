/**
 * 影子審計：雙強先發 + 低開線 → 砍 Hybrid Over
 * 用法: node scripts/auditMlbTotalsOverStrongSpDuelShadow.mjs
 * 產物: tmp-totals-over-strong-sp-duel-shadow.json
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
import {
  matchOverStrongSpDuel,
  MLB_TOTALS_OVER_STRONG_SP_DUEL_SPEC,
  readStarterPair,
} from '../src/services/MlbTotalsOverStrongSpDuelShadow.js';
import { applyTotalsFragileUnderShadow } from '../src/services/MlbTotalsFragileUnderShadow.js';
import { applyTotalsUnderBlowupGapToCandidate } from '../src/services/MlbTotalsUnderBlowupGapShadow.js';
import { applyTotalsUnderPitcherToCandidate } from '../src/services/MlbTotalsUnderPitcherShadow.js';

const STAKE = 50;
const BASE = MLB_TOTALS_SATELLITE_SPEC.rules;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-08-07' },
];

function collectBestLine(gameId, commenceTime) {
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
  return best;
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

function summarize(bets) {
  const decided = bets.filter((b) => b.result === 'win' || b.result === 'loss');
  if (!decided.length) {
    return { n: 0, hits: 0, hr: null, roi: null, usd: 0, avgOdds: null };
  }
  let hits = 0;
  let unit = 0;
  let odds = 0;
  for (const b of decided) {
    odds += b.odds;
    if (b.result === 'win') {
      hits += 1;
      unit += b.odds - 1;
    } else unit -= 1;
  }
  const n = decided.length;
  return {
    n,
    hits,
    hr: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd: Math.round(unit * STAKE * 100) / 100,
    avgOdds: Number((odds / n).toFixed(3)),
  };
}

function applyFormalOverlays(cls, features) {
  return applyTotalsUnderPitcherToCandidate(
    applyTotalsUnderBlowupGapToCandidate(
      applyTotalsFragileUnderShadow(cls, features),
      features
    )
  );
}

console.log('[sp-duel-over] load…');
const model = getLatestMlbExpectedRunsValidation()?.model;
if (!model) throw new Error('no model');

const pool = [];
for (const w of WINDOWS) {
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT f.game_id AS gameId, f.commence_time AS commenceTime,
                f.features_json AS featuresJson,
                g.home_team AS homeTeam, g.away_team AS awayTeam,
                g.home_score AS hs, g.away_score AS ascore
         FROM mlb_historical_feature_rows f
         JOIN games g ON g.id = f.game_id
         WHERE f.feature_version = ?
           AND g.completed = 1
           AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
           AND date(f.commence_time) >= date(?)
           AND date(f.commence_time) <= date(?)`
      )
      .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);
  } catch (e) {
    console.error('DB read failed', e.message);
    process.exit(1);
  }
  console.log(' ', w.key, 'feature rows', rows.length);
  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const total = Number(row.hs) + Number(row.ascore);
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
    const market = collectBestLine(row.gameId, row.commenceTime);
    if (!market) continue;
    if (total === market.line) continue;
    const pred = predictMlbGameRuns(model, features, { totalLine: market.line });
    let cls = classifyMlbTotalsHybridCandidate({
      prediction: pred,
      totalsMarket: market,
      parkFactor: features.parkFactor,
      spec: {
        ...MLB_TOTALS_SATELLITE_HYBRID_SPEC,
        rawOverMaxAbsGap: config.mlbTotalsRawOverMaxAbsGap,
      },
    });
    cls = applyFormalOverlays(cls, features);
    if (cls.tier !== 'actionable' || !cls.side) continue;
    const result = settle(cls.side, cls.line, total);
    if (result === 'push') continue;
    const pair = readStarterPair(features);
    pool.push({
      year: w.key,
      gameId: row.gameId,
      matchup: `${row.awayTeam} @ ${row.homeTeam}`,
      commenceTime: row.commenceTime,
      side: cls.side,
      line: cls.line,
      odds: cls.oddsDecimal,
      path: cls.hybridPath,
      ev: cls.expectedValue,
      mu: pred.expectedTotal,
      total,
      result,
      pair,
    });
  }
}

const baseline = summarize(pool);
const overs = pool.filter((b) => b.side === 'over');
const unders = pool.filter((b) => b.side === 'under');

const GRID = [];
for (const maxEra of [3.8, 4.0, 4.25, 4.5]) {
  for (const maxLine of [7, 7.5, 8]) {
    // k0＝純 ERA；歷史特徵 k9 覆蓋不足，主推薦看 k0
    GRID.push({
      id: `era${maxEra}_line${maxLine}_k0`,
      maxStarterEra: maxEra,
      maxTotalLine: maxLine,
      minK9: 0,
      requireBothK9: false,
    });
  }
}

const gridResults = GRID.map((g) => {
  const spec = {
    ...MLB_TOTALS_OVER_STRONG_SP_DUEL_SPEC,
    maxStarterEra: g.maxStarterEra,
    maxTotalLine: g.maxTotalLine,
    minK9: g.minK9,
    requireBothK9: g.requireBothK9,
  };
  const cut = [];
  const kept = [];
  for (const b of pool) {
    const fakeCls = {
      tier: 'actionable',
      side: b.side,
      line: b.line,
    };
    const features = {
      pitchers: {
        home: { era: b.pair.homeEra, k9: b.pair.homeK9, kPer9: b.pair.homeK9 },
        away: { era: b.pair.awayEra, k9: b.pair.awayK9, kPer9: b.pair.awayK9 },
      },
    };
    const hit = matchOverStrongSpDuel(fakeCls, features, spec);
    if (hit.matched) cut.push(b);
    else kept.push(b);
  }
  const bS = baseline;
  const kS = summarize(kept);
  const cS = summarize(cut);
  return {
    id: g.id,
    ...g,
    cutPct: Number(((100 * cut.length) / Math.max(1, pool.length)).toFixed(2)),
    cut: cS,
    kept: kS,
    dHrPp: kS.hr != null && bS.hr != null ? Number(((kS.hr - bS.hr) * 100).toFixed(2)) : null,
    dRoiPp:
      kS.roi != null && bS.roi != null
        ? Number(((kS.roi - bS.roi) * 100).toFixed(2))
        : null,
    dUsd: Number((kS.usd - bS.usd).toFixed(2)),
    byYearDeltaUsd: Object.fromEntries(
      ['2024', '2025', '2026'].map((y) => {
        const bY = summarize(pool.filter((x) => x.year === y));
        const kY = summarize(kept.filter((x) => x.year === y));
        return [y, Number((kY.usd - bY.usd).toFixed(2))];
      })
    ),
    cutOverOnly: summarize(cut.filter((x) => x.side === 'over')),
  };
});

gridResults.sort(
  (a, b) =>
    (b.dUsd ?? -9999) - (a.dUsd ?? -9999) ||
    (b.dHrPp ?? -999) - (a.dHrPp ?? -999)
);

const defaultSpec = MLB_TOTALS_OVER_STRONG_SP_DUEL_SPEC;
const defaultRow = gridResults.find(
  (r) =>
    r.maxStarterEra === defaultSpec.maxStarterEra &&
    r.maxTotalLine === defaultSpec.maxTotalLine &&
    r.minK9 === defaultSpec.minK9
);

const yesterdayLike = pool.filter((b) => {
  const fakeCls = { tier: 'actionable', side: b.side, line: b.line };
  const features = {
    pitchers: {
      home: { era: b.pair.homeEra, k9: b.pair.homeK9 },
      away: { era: b.pair.awayEra, k9: b.pair.awayK9 },
    },
  };
  return matchOverStrongSpDuel(fakeCls, features, defaultSpec).matched;
});

const out = {
  experimentId: 'totals-over-strong-sp-duel-shadow-2026-08-08',
  plainLanguage:
    '雙強先發＋低開總分線的 Hybrid Over 砍刀影子；不翻小；預設 compare。',
  baseline: {
    all: baseline,
    overs: summarize(overs),
    unders: summarize(unders),
  },
  defaultSpec,
  defaultResult: defaultRow || null,
  topByUsd: gridResults.slice(0, 12),
  recommend:
    gridResults.find(
      (r) =>
        (r.dUsd ?? -1) > 0 &&
        (r.dHrPp ?? -1) >= 0 &&
        r.byYearDeltaUsd['2025'] >= -50 &&
        r.byYearDeltaUsd['2026'] >= -50
    ) || gridResults[0],
  yesterdayPrototypeCatchN: yesterdayLike.length,
  yesterdayPrototypeSample: yesterdayLike.slice(0, 15).map((b) => ({
    year: b.year,
    matchup: b.matchup,
    pick: `${b.side === 'over' ? '大' : '小'} ${b.line}`,
    odds: b.odds,
    mu: Number(b.mu.toFixed(2)),
    total: b.total,
    result: b.result,
    eras: [b.pair.awayEra, b.pair.homeEra],
  })),
  note: '正式 Hybrid 已含 Fragile／blowup／Under×投手公園；本刀只動 Over。',
};

fs.writeFileSync(
  new URL('../tmp-totals-over-strong-sp-duel-shadow.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      baseline: out.baseline,
      defaultResult: out.defaultResult,
      recommend: out.recommend,
      catchN: out.yesterdayPrototypeCatchN,
    },
    null,
    2
  )
);
console.log('wrote tmp-totals-over-strong-sp-duel-shadow.json');
