/**
 * 強主 × Hybrid 切片／路由 + R1 與 Under 影子交叉
 *
 *   node scripts/auditMlbStrongHomeHybridAndR1Cross.mjs
 * 產物: tmp-strong-home-hybrid-r1-cross.json
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
  matchFragileUnder,
  applyTotalsFragileUnderShadow,
} from '../src/services/MlbTotalsFragileUnderShadow.js';
import {
  matchUnderBlowupGap,
  applyTotalsUnderBlowupGapToCandidate,
} from '../src/services/MlbTotalsUnderBlowupGapShadow.js';
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
  if (!settled.length) return { n: 0, hits: 0, hr: null, roi: null, usd: 0 };
  let unit = 0;
  let hits = 0;
  for (const b of settled) {
    if (b.result === 'win') {
      hits += 1;
      unit += b.odds - 1;
    } else unit -= 1;
  }
  const n = settled.length;
  return {
    n,
    hits,
    hr: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd: Math.round(unit * STAKE * 100) / 100,
  };
}

function delta(after, base) {
  return {
    dHrPp:
      after.hr != null && base.hr != null
        ? Number(((after.hr - base.hr) * 100).toFixed(2))
        : null,
    dUsd: Number((after.usd - base.usd).toFixed(2)),
  };
}

function byYearDelta(pool, keepFn) {
  return Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const base = summarize(pool.filter((b) => b.year === y));
      const after = summarize(pool.filter((b) => b.year === y && keepFn(b)));
      return [y, Number((after.usd - base.usd).toFixed(2))];
    })
  );
}

function yearOk(y) {
  return (
    (y?.['2024'] ?? -999) >= -80 &&
    (y?.['2025'] ?? -999) >= -80 &&
    (y?.['2026'] ?? -999) >= -80
  );
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

function wouldSkipUnderPitcher(cls) {
  // applyTotalsUnderPitcherToCandidate 在 apply 時改 tier；用 compare 思路：重跑 classify 標記
  const tagged = applyTotalsUnderPitcherToCandidate(
    { ...cls, tier: 'actionable' },
    null
  );
  // 上述需要 parkFactor on candidate — 改用影子欄位
  return Boolean(
    tagged?.totalsUnderPitcherShadow?.wouldSkip ||
      tagged?.totalsUnderPitcherShadow?.matched ||
      tagged?.reasons?.includes?.('totals_under_pitcher_park')
  );
}

console.log('[strong-home-hybrid-r1] build…');
const model = getLatestMlbExpectedRunsValidation()?.model;
if (!model) {
  console.error('missing model');
  process.exit(1);
}

const rawPool = []; // Hybrid 原始 actionable（未套 Under 影子、未套 R1）
const formalPool = []; // 套完 Under 影子後仍 actionable

for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
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
    const rawCls = classifyMlbTotalsHybridCandidate({
      prediction: pred,
      totalsMarket: totals,
      parkFactor: features.parkFactor,
      spec: {
        ...MLB_TOTALS_SATELLITE_HYBRID_SPEC,
        rawOverMaxAbsGap: config.mlbTotalsRawOverMaxAbsGap,
      },
    });
    if (rawCls.tier !== 'actionable' || !rawCls.side) continue;

    const layered = buildMlbLayeredDecision({
      features,
      totalsLine: rawCls.line,
      homeOdds,
      gameId: row.gameId,
    });
    const fragile = matchFragileUnder(rawCls, features);
    const blowup = matchUnderBlowupGap(rawCls, features);
    const pitcherTagged = applyTotalsUnderPitcherToCandidate(rawCls, features);
    const pitcherSkip = Boolean(
      pitcherTagged?.tier === 'blocked' ||
        pitcherTagged?.totalsUnderPitcherShadow?.matched ||
        pitcherTagged?.totalsUnderPitcherShadow?.wouldSkip
    );

    const total = +row.homeScore + +row.awayScore;
    const odds = rawCls.side === 'over' ? totals.overOdds : totals.underOdds;
    const result = settle(rawCls.side, rawCls.line, total);
    const type = layered.gameType.type;
    const r1Cut =
      rawCls.side === 'over' && layered.route.bans.includes('totals_over');

    const rowOut = {
      year: w.key,
      side: rawCls.side,
      odds,
      result,
      type,
      strongHome: type === 'strong_home',
      duel: type === 'pitcher_duel',
      r1Cut,
      fragileMatch: Boolean(fragile.matched),
      blowupMatch: Boolean(blowup.matched),
      pitcherSkip,
      anyUnderShadow:
        Boolean(fragile.matched) || Boolean(blowup.matched) || pitcherSkip,
    };
    rawPool.push(rowOut);

    let formal = applyTotalsFragileUnderShadow(rawCls, features);
    formal = applyTotalsUnderBlowupGapToCandidate(formal, features);
    formal = applyTotalsUnderPitcherToCandidate(formal, features);
    if (formal.tier === 'actionable' && formal.side) {
      formalPool.push({
        ...rowOut,
        side: formal.side,
        odds: formal.side === 'over' ? totals.overOdds : totals.underOdds,
        result: settle(formal.side, formal.line ?? rawCls.line, total),
        // R1 基於 type，與 formal side 再算一次
        r1Cut:
          formal.side === 'over' && layered.route.bans.includes('totals_over'),
      });
    }
  }
}

const formalBase = summarize(formalPool);
const formalAfterR1 = summarize(formalPool.filter((b) => !b.r1Cut));
const r1OnFormal = {
  ...delta(formalAfterR1, formalBase),
  cut: summarize(formalPool.filter((b) => b.r1Cut)),
  stillPositive: formalAfterR1.usd - formalBase.usd >= 0,
};

/** —— 強主切片（正式池，已含 Under 影子） —— */
const sh = formalPool.filter((b) => b.strongHome);
const shOver = sh.filter((b) => b.side === 'over');
const shUnder = sh.filter((b) => b.side === 'under');
const strongHomeSlice = {
  n: sh.length,
  all: summarize(sh),
  over: summarize(shOver),
  under: summarize(shUnder),
  shareOfFormal: formalPool.length
    ? Number((sh.length / formalPool.length).toFixed(4))
    : null,
};

const banShUnder = {
  id: 'strong_home_ban_under',
  after: summarize(formalPool.filter((b) => !(b.strongHome && b.side === 'under'))),
  cut: summarize(shUnder),
  byYearDeltaUsd: byYearDelta(
    formalPool,
    (b) => !(b.strongHome && b.side === 'under')
  ),
};
banShUnder.dHrPp = delta(banShUnder.after, formalBase).dHrPp;
banShUnder.dUsd = delta(banShUnder.after, formalBase).dUsd;

const banShOver = {
  id: 'strong_home_ban_over',
  after: summarize(formalPool.filter((b) => !(b.strongHome && b.side === 'over'))),
  cut: summarize(shOver),
  byYearDeltaUsd: byYearDelta(
    formalPool,
    (b) => !(b.strongHome && b.side === 'over')
  ),
};
banShOver.dHrPp = delta(banShOver.after, formalBase).dHrPp;
banShOver.dUsd = delta(banShOver.after, formalBase).dUsd;

const shGate = (route) => ({
  need: 'dUsd>=0, dHr>=-0.2, years ok, cut n>=8',
  passed:
    (route.dUsd ?? -1) >= 0 &&
    (route.dHrPp ?? -1) >= -0.2 &&
    yearOk(route.byYearDeltaUsd) &&
    (route.cut?.n || 0) >= 8,
});

/** —— 對決局 Under（R2 lean）在正式池表現 —— */
const duelUnder = formalPool.filter((b) => b.duel && b.side === 'under');
const duelOver = formalPool.filter((b) => b.duel && b.side === 'over');
const duelSlice = {
  under: summarize(duelUnder),
  over: summarize(duelOver),
  note: 'R1 砍的是 over；under 為 R2 lean 對照',
};

/** —— R1 × Under 影子交叉 —— */
const rawBase = summarize(rawPool);
const underCuts = rawPool.filter((b) => b.anyUnderShadow);
const r1CutsRaw = rawPool.filter((b) => b.r1Cut);
const cross = {
  rawN: rawPool.length,
  formalN: formalPool.length,
  underShadowCutsN: underCuts.length,
  underShadowCuts: summarize(underCuts),
  r1CutsOnRaw: summarize(r1CutsRaw),
  /** R1 只砍 Over；與 Under 影子無直接重疊 */
  r1AndUnderShadowOverlapN: r1CutsRaw.filter((b) => b.anyUnderShadow).length,
  /** 若先不套 Under 影子，只套 R1 */
  r1AloneOnRaw: {
    after: summarize(rawPool.filter((b) => !b.r1Cut)),
    ...delta(summarize(rawPool.filter((b) => !b.r1Cut)), rawBase),
  },
  /** 只套 Under 影子（= formal 相對 raw） */
  underShadowsAlone: {
    after: formalBase,
    ...delta(formalBase, rawBase),
    cutN: rawPool.length - formalPool.length,
  },
  /** 兩者都套：formal + R1 */
  both: {
    after: formalAfterR1,
    vsRaw: delta(formalAfterR1, rawBase),
    vsFormal: delta(formalAfterR1, formalBase),
  },
  /** 疊加是否近似可加：R1Δ(on formal) + UnderΔ(raw→formal) ≈ bothΔ(vs raw) */
  additivity: {
    underDeltaUsd: Number((formalBase.usd - rawBase.usd).toFixed(2)),
    r1DeltaUsdOnFormal: Number((formalAfterR1.usd - formalBase.usd).toFixed(2)),
    sumParts: Number(
      (formalBase.usd - rawBase.usd + (formalAfterR1.usd - formalBase.usd)).toFixed(
        2
      )
    ),
    bothVsRaw: Number((formalAfterR1.usd - rawBase.usd).toFixed(2)),
    residual: Number(
      (
        formalAfterR1.usd -
        rawBase.usd -
        (formalBase.usd - rawBase.usd) -
        (formalAfterR1.usd - formalBase.usd)
      ).toFixed(2)
    ),
    note: '殘差應為 0（順序可交換）；非 0 則有交互',
  },
  /** 按類型：Under 影子砍了哪些 type */
  underCutsByType: {},
  r1CutsByType: {},
};

for (const b of underCuts) {
  cross.underCutsByType[b.type] = (cross.underCutsByType[b.type] || 0) + 1;
}
for (const b of r1CutsRaw) {
  cross.r1CutsByType[b.type] = (cross.r1CutsByType[b.type] || 0) + 1;
}

/** 各 Under 影子單獨在 raw 上的貢獻（相對 raw） */
function cutShadow(flag) {
  const after = summarize(rawPool.filter((b) => !b[flag]));
  return {
    cut: summarize(rawPool.filter((b) => b[flag])),
    after,
    ...delta(after, rawBase),
    byYearDeltaUsd: byYearDelta(rawPool, (b) => !b[flag]),
  };
}

const shadowAblation = {
  fragileOnly: cutShadow('fragileMatch'),
  blowupOnly: cutShadow('blowupMatch'),
  pitcherOnly: cutShadow('pitcherSkip'),
  anyUnder: cutShadow('anyUnderShadow'),
  r1Only: cutShadow('r1Cut'),
};

const out = {
  experimentId: 'strong-home-hybrid-r1-cross-2026-08-08',
  r1OnFormal,
  strongHomeSlice,
  strongHomeRoutes: {
    banUnder: { ...banShUnder, gate: shGate(banShUnder) },
    banOver: { ...banShOver, gate: shGate(banShOver) },
  },
  duelSlice,
  cross,
  shadowAblation,
  verdict: {
    r1StillPositiveOnFormal: r1OnFormal.stillPositive,
    strongHomeBanUnder: shGate(banShUnder).passed
      ? 'PROMOTE_COMPARE'
      : 'REJECT',
    strongHomeBanOver: shGate(banShOver).passed ? 'PROMOTE_COMPARE' : 'REJECT',
    r1UnderOrthogonal: cross.r1AndUnderShadowOverlapN === 0,
    additiveOk: Math.abs(cross.additivity.residual) < 0.01,
  },
};

fs.writeFileSync(
  new URL('../tmp-strong-home-hybrid-r1-cross.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log(
  JSON.stringify(
    {
      r1OnFormal: {
        dUsd: r1OnFormal.dUsd,
        dHrPp: r1OnFormal.dHrPp,
        cut: r1OnFormal.cut,
        stillPositive: r1OnFormal.stillPositive,
      },
      strongHomeSlice,
      banShUnder: {
        dUsd: banShUnder.dUsd,
        dHrPp: banShUnder.dHrPp,
        cutN: banShUnder.cut.n,
        cutHr: banShUnder.cut.hr,
        byYear: banShUnder.byYearDeltaUsd,
        passed: shGate(banShUnder).passed,
      },
      banShOver: {
        dUsd: banShOver.dUsd,
        dHrPp: banShOver.dHrPp,
        cutN: banShOver.cut.n,
        cutHr: banShOver.cut.hr,
        byYear: banShOver.byYearDeltaUsd,
        passed: shGate(banShOver).passed,
      },
      duelSlice,
      cross: {
        overlapR1Under: cross.r1AndUnderShadowOverlapN,
        additivity: cross.additivity,
        underCutsByType: cross.underCutsByType,
        r1CutsByType: cross.r1CutsByType,
        bothVsRaw: cross.both.vsRaw,
      },
      shadowAblation: {
        fragile: {
          dUsd: shadowAblation.fragileOnly.dUsd,
          cutN: shadowAblation.fragileOnly.cut.n,
          cutHr: shadowAblation.fragileOnly.cut.hr,
        },
        blowup: {
          dUsd: shadowAblation.blowupOnly.dUsd,
          cutN: shadowAblation.blowupOnly.cut.n,
          cutHr: shadowAblation.blowupOnly.cut.hr,
        },
        pitcher: {
          dUsd: shadowAblation.pitcherOnly.dUsd,
          cutN: shadowAblation.pitcherOnly.cut.n,
          cutHr: shadowAblation.pitcherOnly.cut.hr,
        },
        r1: {
          dUsd: shadowAblation.r1Only.dUsd,
          cutN: shadowAblation.r1Only.cut.n,
          cutHr: shadowAblation.r1Only.cut.hr,
        },
      },
      verdict: out.verdict,
    },
    null,
    2
  )
);
console.log('wrote tmp-strong-home-hybrid-r1-cross.json');
