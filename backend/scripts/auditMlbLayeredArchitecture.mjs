/**
 * MLB 分層架構開測（mlb-layered-arch-v1）
 *
 * 驗證：
 * 1) 行為一致性：resolveMlbGameType(T1) 與舊 detectPitcherDuel 對齊
 * 2) 路由 R1：pitcher_duel → bans 含 totals_over
 * 3) Hybrid 結構錯：對決局還推大 → 若走 route 應被禁；歷史上這些大分是否偏毒
 * 4) 對照：套用 R1 後 vs 基線的勝率/ROI（應≈既有 game-shape 回測）
 *
 *   node scripts/auditMlbLayeredArchitecture.mjs
 * 產物: tmp-layered-architecture-audit.json
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
import { detectPitcherDuel } from '../src/services/MlbGameShapeShadow.js';
import {
  buildMlbLayeredDecision,
  MLB_LAYERED_ARCHITECTURE_VERSION,
  resolveMlbGameType,
  resolveMlbMarketRoute,
} from '../src/services/MlbLayeredArchitecture.js';

const STAKE = 50;
const BASE = MLB_TOTALS_SATELLITE_SPEC.rules;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-08-07' },
];

function finite(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function collectBestLine(gameId, commenceTime) {
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
    return { n: 0, hits: 0, hr: null, roi: null, usd: 0 };
  }
  let hits = 0;
  let unit = 0;
  for (const b of decided) {
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

/** 單元：類型合成與路由契約 */
function unitChecks() {
  const cases = [];
  const duelFeat = {
    pitchers: {
      home: { era: 3.1 },
      away: { era: 3.4 },
      homeIdentity: { name: 'H' },
      awayIdentity: { name: 'A' },
    },
    home: { recentRunsPerGame: 4.1 },
    away: { recentRunsPerGame: 4.0 },
  };
  const d1 = buildMlbLayeredDecision({
    features: duelFeat,
    totalsLine: 7,
    homeOdds: 1.95,
  });
  cases.push({
    id: 'duel_line7_is_pitcher_duel',
    pass: d1.gameType.type === 'pitcher_duel',
    got: d1.gameType.type,
  });
  cases.push({
    id: 'duel_route_bans_over',
    pass: d1.route.bans.includes('totals_over'),
    got: d1.route.bans,
  });
  cases.push({
    id: 'duel_route_has_R1',
    pass: d1.route.actions.includes('R1_ban_totals_over'),
    got: d1.route.actions,
  });

  const strongFeat = {
    pitchers: {
      home: { era: 3.8 },
      away: { era: 4.5 },
      homeIdentity: { name: 'H' },
      awayIdentity: { name: 'A' },
    },
    home: { recentRunsPerGame: 5.2 },
    away: { recentRunsPerGame: 4.0 },
  };
  const d2 = buildMlbLayeredDecision({
    features: strongFeat,
    totalsLine: 9,
    homeOdds: 1.65,
  });
  cases.push({
    id: 'short_home_is_strong_home',
    pass: d2.gameType.type === 'strong_home',
    got: d2.gameType.type,
  });
  cases.push({
    id: 'strong_home_has_R4_action',
    pass: d2.route.actions.includes(
      'R4_moneyline_soft_demote_away_vs_strong_home'
    ),
    got: d2.route.actions,
  });

  const weak = buildMlbLayeredDecision({
    features: {
      pitchers: { home: { era: 5.5 }, away: { era: 5.2 } },
      home: { recentRunsPerGame: 4.5 },
      away: { recentRunsPerGame: 4.4 },
    },
    totalsLine: 9.5,
    homeOdds: 2.1,
  });
  cases.push({
    id: 'plain_is_normal',
    pass: weak.gameType.type === 'normal',
    got: weak.gameType.type,
  });
  cases.push({
    id: 'normal_has_R6',
    pass: weak.route.actions.includes('R6_normal_passthrough'),
    got: weak.route.actions,
  });

  // 高開線不應被 T1 判對決
  const highLine = buildMlbLayeredDecision({
    features: duelFeat,
    totalsLine: 9.5,
    homeOdds: 1.95,
  });
  cases.push({
    id: 'strong_sp_but_line95_not_duel',
    pass: highLine.gameType.type !== 'pitcher_duel',
    got: highLine.gameType.type,
  });

  return {
    n: cases.length,
    passed: cases.filter((c) => c.pass).length,
    failed: cases.filter((c) => !c.pass),
    cases,
  };
}

console.log('[layered-arch] unit checks…');
const units = unitChecks();
console.log(`  unit ${units.passed}/${units.n} pass`);

console.log('[layered-arch] historical hybrid…');
const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) {
  console.error('missing expected runs model');
  process.exit(1);
}

const pool = [];
let agreeDuel = 0;
let disagreeDuel = 0;
let typeCounts = {
  pitcher_duel: 0,
  strong_home: 0,
  offense_game: 0,
  normal: 0,
  unclear: 0,
};

for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id, f.commence_time, f.features_json,
              g.home_team, g.away_team, g.home_score, g.away_score
       FROM mlb_historical_feature_rows f
       JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ?
         AND f.commence_time >= ? AND f.commence_time <= ?
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, w.from, `${w.to}T23:59:59`);
  console.log(`  ${w.key} rows`, rows.length);
  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.features_json);
    } catch {
      continue;
    }
    features.parkFactor = resolveMlbParkFactor({
      venueName: features.venueName,
      homeTeam: row.home_team,
    });
    features.weather = getCachedMlbGameWeather(row.game_id)?.weather || null;
    const marketPack = collectBestLine(row.game_id, row.commence_time);
    const linePack = marketPack.totals;
    if (!linePack) continue;
    const pred = predictMlbGameRuns(model, features, {
      totalLine: linePack.line,
    });
    let cls = classifyMlbTotalsHybridCandidate({
      prediction: pred,
      totalsMarket: linePack,
      parkFactor: features.parkFactor,
      spec: {
        ...MLB_TOTALS_SATELLITE_HYBRID_SPEC,
        rawOverMaxAbsGap: config.mlbTotalsRawOverMaxAbsGap,
      },
    });
    cls = applyFormalOverlays(cls, features);
    if (cls.tier !== 'actionable' || !cls.side) continue;

    const layered = buildMlbLayeredDecision({
      features,
      totalsLine: cls.line,
      homeOdds: marketPack.homeOdds,
      gameId: row.game_id,
    });
    const oldDuel = detectPitcherDuel(features, { totalsLine: cls.line });
    const newDuel = layered.gameType.type === 'pitcher_duel';
    if (oldDuel.matched === newDuel) agreeDuel += 1;
    else disagreeDuel += 1;
    typeCounts[layered.gameType.type] =
      (typeCounts[layered.gameType.type] || 0) + 1;

    const total = Number(row.home_score) + Number(row.away_score);
    const result = settle(cls.side, cls.line, total);
    const odds = cls.side === 'over' ? linePack.overOdds : linePack.underOdds;
    const structureError =
      cls.side === 'over' &&
      layered.gameType.type === 'pitcher_duel' &&
      layered.route.bans.includes('totals_over');
    const wouldKeep = !(
      cls.side === 'over' && layered.route.bans.includes('totals_over')
    );

    pool.push({
      year: w.key,
      matchup: `${row.away_team} @ ${row.home_team}`,
      side: cls.side,
      line: cls.line,
      odds,
      total,
      result,
      type: layered.gameType.type,
      routeBans: layered.route.bans,
      structureErrorWouldBlock: structureError,
      wouldKeep,
      lowTotal: total <= 6,
    });
  }
}

const baseline = summarize(pool);
const kept = pool.filter((b) => b.wouldKeep);
const cut = pool.filter((b) => !b.wouldKeep);
const structureBlocked = pool.filter((b) => b.structureErrorWouldBlock);
const after = summarize(kept);
const cutSum = summarize(cut);

const out = {
  experimentId: 'layered-architecture-open-test-2026-08-08',
  version: MLB_LAYERED_ARCHITECTURE_VERSION,
  unitChecks: units,
  consistency: {
    duelAgree: agreeDuel,
    duelDisagree: disagreeDuel,
    agreeRate:
      agreeDuel + disagreeDuel > 0
        ? Number((agreeDuel / (agreeDuel + disagreeDuel)).toFixed(4))
        : null,
    note: 'T1 pitcher_duel 應與舊 detectPitcherDuel 一致（行為不變重構）',
  },
  typeMixOnHybridActionable: typeCounts,
  hybrid: {
    baseline,
    afterR1Route: after,
    cutByR1: cutSum,
    dHrPp:
      after.hr != null && baseline.hr != null
        ? Number(((after.hr - baseline.hr) * 100).toFixed(2))
        : null,
    dRoiPp:
      after.roi != null && baseline.roi != null
        ? Number(((after.roi - baseline.roi) * 100).toFixed(2))
        : null,
    dUsd: Number((after.usd - baseline.usd).toFixed(2)),
  },
  previousProblemChecks: {
    problem: '投手對決還推大分（結構錯）',
    layeredWouldBlockN: structureBlocked.length,
    blockedSlice: cutSum,
    blockedLowTotalShare:
      cut.length === 0
        ? null
        : Number((cut.filter((b) => b.lowTotal).length / cut.length).toFixed(3)),
    verdict:
      cut.length > 0 &&
      cutSum.hr != null &&
      cutSum.hr < baseline.hr &&
      (after.hr ?? 0) >= (baseline.hr ?? 0) - 0.001
        ? 'PASS_route_blocks_toxic_overs'
        : cut.length === 0
          ? 'WARN_no_cuts'
          : 'REVIEW',
  },
  sampleBlocked: structureBlocked.slice(0, 10).map((b) => ({
    year: b.year,
    matchup: b.matchup,
    pick: `大 ${b.line}`,
    total: b.total,
    result: b.result,
    type: b.type,
  })),
  gates: {
    unitAllPass: units.failed.length === 0,
    duelConsistency: disagreeDuel === 0,
    r1HelpsOrNonNegative:
      (after.usd ?? 0) >= (baseline.usd ?? 0) - 1 &&
      (after.hr ?? 0) + 1e-9 >= (baseline.hr ?? 0),
    blocksStructuralOver: structureBlocked.length > 0,
  },
};

out.overallPass =
  out.gates.unitAllPass &&
  out.gates.duelConsistency &&
  out.gates.r1HelpsOrNonNegative &&
  out.gates.blocksStructuralOver;

fs.writeFileSync(
  new URL('../tmp-layered-architecture-audit.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log(
  JSON.stringify(
    {
      overallPass: out.overallPass,
      unit: `${units.passed}/${units.n}`,
      duelAgreeRate: out.consistency.agreeRate,
      typeMix: typeCounts,
      hybrid: {
        baselineHr: baseline.hr,
        afterHr: after.hr,
        dHrPp: out.hybrid.dHrPp,
        dUsd: out.hybrid.dUsd,
        cutN: cut.length,
        cutHr: cutSum.hr,
      },
      previousProblem: out.previousProblemChecks.verdict,
      gates: out.gates,
    },
    null,
    2
  )
);
console.log('wrote tmp-layered-architecture-audit.json');
process.exitCode = out.overallPass ? 0 : 2;
