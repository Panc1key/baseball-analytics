/**
 * 分層下一刀開測：
 * 1) R1 Hybrid 仍正？
 * 2) T4b Locked B 仍正？二者市場正交 → 疊用無衝突？
 * 3) offense_game（T3）分離度 + 路由影子（偏大／降 Under／獨贏軟降）
 *
 *   node scripts/auditMlbLayeredNextRoutes.mjs
 * 產物: tmp-layered-next-routes.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import { getCachedMlbGameWeather } from '../src/services/MlbGameWeatherService.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
} from '../src/services/MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
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
import {
  buildMlbLayeredDecision,
  resolveMlbGameType,
} from '../src/services/MlbLayeredArchitecture.js';
import { detectUnclearBreadth } from '../src/services/MlbUnclearReduceShadow.js';
import { MLB_MISSING_ERA_SOFT_SPEC } from '../src/services/MlbMissingEraSoftShadow.js';

const STAKE = 50;
const BASE = MLB_TOTALS_SATELLITE_SPEC.rules;
const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const T4B_LAM = MLB_MISSING_ERA_SOFT_SPEC.rankPenaltyLambda || 0.05;
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

function mean(arr) {
  if (!arr.length) return null;
  return Number((arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(4));
}

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
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

function summarizeUnits(bets) {
  const settled = bets.filter((b) => b.result !== 'push');
  if (!settled.length) {
    return { n: 0, hits: 0, hr: null, roi: null, usd: 0 };
  }
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

function summarizeMl(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0 };
  let unit = 0;
  let odds = 0;
  let hits = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * 50 * 100) / 100,
  };
}

function matchOutcome(outcomes, teamName) {
  if (!teamName || !outcomes?.length) return null;
  return (
    outcomes.find((o) => o.name === teamName) ||
    outcomes.find((o) => String(o.name).includes(String(teamName).split(' ').pop()))
  );
}

function collectBestLine(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return { totals: null, homeOdds: null, h2hBooks: [] };
  let best = null;
  let homeOdds = null;
  const h2hBooks = [];
  const homeLabel = homeTeam || pit.home_team;
  const awayLabel = awayTeam || pit.away_team;
  for (const book of pit.bookmakers) {
    const h2h = book.markets?.find((m) => m.key === 'h2h');
    if (h2h?.outcomes?.length) {
      const home = matchOutcome(h2h.outcomes, homeLabel);
      const away = matchOutcome(h2h.outcomes, awayLabel);
      if (home?.price && (homeOdds == null || Number(home.price) < homeOdds)) {
        homeOdds = Number(home.price);
      }
      if (home?.price && away?.price) {
        const ho = +home.price;
        const ao = +away.price;
        if (Number.isFinite(ho) && Number.isFinite(ao)) {
          h2hBooks.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao });
        }
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
  return { totals: best, homeOdds, h2hBooks };
}

function applyFormalOverlays(cls, features) {
  let out = applyTotalsFragileUnderShadow(cls, features);
  out = applyTotalsUnderBlowupGapToCandidate(out, features);
  out = applyTotalsUnderPitcherToCandidate(out, features);
  return out;
}

function applyDrop(sorted) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
  if (
    slots.length >= 2 &&
    slots[1].pickOdds >= DROP_R2_MIN &&
    slots[1].pickOdds < DROP_R2_MAX
  ) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}

function selectEligible(pool) {
  return pool.filter(
    (g) =>
      g.ev >= B.minimumExpectedValue &&
      g.margin >= B.minimumExpectedRunMargin &&
      g.modelProb >= B.minimumModelProbability &&
      g.pickOdds >= B.minimumPickOdds &&
      g.pickOdds <= B.maximumPickOdds
  );
}

function selectDaily(eligible, scoreFn) {
  const map = new Map();
  for (const g of eligible) {
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const arr = [...map.get(day)].sort(
      (a, b) => scoreFn(b) - scoreFn(a) || b.margin - a.margin
    );
    out.push(...applyDrop(arr));
  }
  return out;
}

function summarizeSep(rows) {
  return {
    n: rows.length,
    meanTotal: mean(rows.map((r) => r.totalRuns).filter((x) => Number.isFinite(x))),
    homeWinRate: mean(rows.map((r) => r.homeWin)),
    meanLine: mean(rows.map((r) => r.totalsLine).filter((x) => x != null)),
    overHitIfBetOver: (() => {
      const xs = rows.filter((r) => r.totalsLine != null);
      if (!xs.length) return null;
      const hits = xs.filter((r) => r.totalRuns > r.totalsLine).length;
      return Number((hits / xs.length).toFixed(4));
    })(),
  };
}

console.log('[layered-next] build…');
const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) {
  console.error('missing model');
  process.exit(1);
}

const hybridPool = [];
const mlPool = [];
const sepByType = {};
const offenseRows = [];
const notOffenseRows = [];
const t3Diag = [];

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

    const pack = collectBestLine(
      row.gameId,
      row.commenceTime,
      row.homeTeam,
      row.awayTeam
    );
    const hs = +row.homeScore;
    const as = +row.awayScore;
    const totalRuns = hs + as;
    const formal = resolveMlbGameType({
      features,
      totalsLine: pack.totals?.line ?? null,
      homeOdds: pack.homeOdds,
    });
    const homeRpg = finite(
      features?.home?.recentRunsPerGame,
      finite(features?.home?.runsPerGame)
    );
    const awayRpg = finite(
      features?.away?.recentRunsPerGame,
      finite(features?.away?.runsPerGame)
    );
    const avgRpg =
      homeRpg != null && awayRpg != null ? (homeRpg + awayRpg) / 2 : null;
    const homeEra = finite(
      features?.pitchers?.home?.era,
      finite(features?.pitchers?.homeRecent?.recent3Era)
    );
    const awayEra = finite(
      features?.pitchers?.away?.era,
      finite(features?.pitchers?.awayRecent?.recent3Era)
    );
    t3Diag.push({
      year: w.key,
      totalRuns,
      homeWin: hs > as ? 1 : 0,
      totalsLine: pack.totals?.line ?? null,
      avgRpg,
      homeEra,
      awayEra,
      formalType: formal.type,
    });
    const sepRow = {
      year: w.key,
      totalRuns,
      homeWin: hs > as ? 1 : 0,
      totalsLine: pack.totals?.line ?? null,
      type: formal.type,
    };
    if (!sepByType[formal.type]) sepByType[formal.type] = [];
    sepByType[formal.type].push(sepRow);
    if (formal.type === 'offense_game') offenseRows.push(sepRow);
    else notOffenseRows.push(sepRow);

    /** Hybrid + R1 */
    if (pack.totals) {
      const pred = predictMlbGameRuns(model, features, { totalLine: pack.totals.line });
      let cls = classifyMlbTotalsHybridCandidate({
        prediction: pred,
        totalsMarket: pack.totals,
        parkFactor: features.parkFactor,
        spec: {
          ...MLB_TOTALS_SATELLITE_HYBRID_SPEC,
          rawOverMaxAbsGap: config.mlbTotalsRawOverMaxAbsGap,
        },
      });
      cls = applyFormalOverlays(cls, features);
      if (cls.tier === 'actionable' && cls.side) {
        const layered = buildMlbLayeredDecision({
          features,
          totalsLine: cls.line,
          homeOdds: pack.homeOdds,
          gameId: row.gameId,
        });
        const odds = cls.side === 'over' ? pack.totals.overOdds : pack.totals.underOdds;
        const result = settle(cls.side, cls.line, totalRuns);
        const r1Cut =
          cls.side === 'over' && layered.route.bans.includes('totals_over');
        hybridPool.push({
          year: w.key,
          side: cls.side,
          line: cls.line,
          odds,
          result,
          type: layered.gameType.type,
          r1Cut,
          offense: layered.gameType.type === 'offense_game',
        });
      }
    }

    /** Locked B pool + T4b flag */
    if (hs === as) continue;
    const predMl = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const ph = +predMl.homeExpectedRuns;
    const pa = +predMl.awayExpectedRuns;
    if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;
    const pickHome = ph >= pa;
    const modelProb = pickHome
      ? +predMl.markets?.homeWinProbability
      : +predMl.markets?.awayWinProbability;
    if (!Number.isFinite(modelProb) || pack.h2hBooks.length < 2) continue;
    const bs = [...pack.h2hBooks].sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? +sig.homeEarlyExitsLast3 || 0
      : +sig.awayEarlyExitsLast3 || 0;
    const oppEarly = pickHome
      ? +sig.awayEarlyExitsLast3 || 0
      : +sig.homeEarlyExitsLast3 || 0;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2 || pickEarly > oppEarly) continue;
    const wide = detectUnclearBreadth(features, {
      totalsLine: pack.totals?.line ?? null,
      breadth: 'wide',
    });
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    mlPool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      year: w.key,
      hit: pickHome === hs > as,
      pickHome,
      pickOdds,
      ev,
      margin,
      modelProb,
      bScore,
      formalType: formal.type,
      unclearWide: Boolean(wide.matched),
      offense: formal.type === 'offense_game',
    });
  }
}

/** —— R1 Hybrid —— */
const hybridBase = summarizeUnits(hybridPool);
const hybridAfterR1 = summarizeUnits(hybridPool.filter((b) => !b.r1Cut));
const hybridCut = summarizeUnits(hybridPool.filter((b) => b.r1Cut));
const r1 = {
  baseline: hybridBase,
  afterR1: hybridAfterR1,
  cut: hybridCut,
  dHrPp:
    hybridBase.hr != null && hybridAfterR1.hr != null
      ? Number(((hybridAfterR1.hr - hybridBase.hr) * 100).toFixed(2))
      : null,
  dUsd: Number((hybridAfterR1.usd - hybridBase.usd).toFixed(2)),
  stillPositive: (hybridAfterR1.usd - hybridBase.usd) >= 0,
};

/** —— T4b Locked B —— */
const eligible = selectEligible(mlPool);
const mlBasePicks = selectDaily(eligible, (g) => g.bScore);
const mlT4bPicks = selectDaily(
  eligible,
  (g) => g.bScore - (g.unclearWide ? T4B_LAM : 0)
);
const mlBase = summarizeMl(mlBasePicks);
const mlT4b = summarizeMl(mlT4bPicks);
const t4b = {
  baseline: mlBase,
  afterT4b: mlT4b,
  dHrPp:
    mlBase.hitRate != null && mlT4b.hitRate != null
      ? Number(((mlT4b.hitRate - mlBase.hitRate) * 100).toFixed(2))
      : null,
  dUsd: Number((mlT4b.usd50 - mlBase.usd50).toFixed(2)),
  stillPositiveCompare: (mlT4b.usd50 - mlBase.usd50) >= 50,
};

/** 疊用：市場正交（R1=totals, T4b=ML）。紙上合計 Δ$ = R1Δ + T4bΔ（T4b 僅 compare） */
const stack = {
  marketsOrthogonal: true,
  note: 'R1 只動 Hybrid 大小；T4b 只動 Locked B 獨贏排序；無選邊衝突。',
  paperDeltaUsdIfBoth: Number((r1.dUsd + t4b.dUsd).toFixed(2)),
  r1ApplySafe: r1.stillPositive,
  t4bCompareOnly: true,
  conflict: false,
};

/** —— offense_game —— */
const typeSep = Object.fromEntries(
  Object.entries(sepByType).map(([k, rows]) => [k, summarizeSep(rows)])
);
const offenseSep = {
  offense: summarizeSep(offenseRows),
  notOffense: summarizeSep(notOffenseRows),
  dMeanTotal:
    offenseRows.length && notOffenseRows.length
      ? Number(
          (
            mean(offenseRows.map((r) => r.totalRuns)) -
            mean(notOffenseRows.map((r) => r.totalRuns))
          ).toFixed(3)
        )
      : null,
  dHomeWinPp:
    offenseRows.length && notOffenseRows.length
      ? Number(
          (
            (mean(offenseRows.map((r) => r.homeWin)) -
              mean(notOffenseRows.map((r) => r.homeWin))) *
            100
          ).toFixed(2)
        )
      : null,
};

const hybridOffense = hybridPool.filter((b) => b.offense);
const hybridOffenseUnder = hybridOffense.filter((b) => b.side === 'under');
const hybridOffenseOver = hybridOffense.filter((b) => b.side === 'over');

/** 路由影子：offense → 砍 Under（偏大） */
const offenseBanUnder = summarizeUnits(
  hybridPool.filter((b) => !(b.offense && b.side === 'under'))
);
const offenseBanUnderCut = summarizeUnits(hybridOffenseUnder);
const offenseRouteTotals = {
  id: 'offense_ban_under',
  after: offenseBanUnder,
  cut: offenseBanUnderCut,
  dHrPp:
    hybridBase.hr != null && offenseBanUnder.hr != null
      ? Number(((offenseBanUnder.hr - hybridBase.hr) * 100).toFixed(2))
      : null,
  dUsd: Number((offenseBanUnder.usd - hybridBase.usd).toFixed(2)),
  byYearDeltaUsd: Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const bY = summarizeUnits(hybridPool.filter((x) => x.year === y));
      const aY = summarizeUnits(
        hybridPool.filter((x) => x.year === y && !(x.offense && x.side === 'under'))
      );
      return [y, Number((aY.usd - bY.usd).toFixed(2))];
    })
  ),
};

/** offense → 獨贏軟降權 */
const offenseMlEligible = eligible.filter((g) => g.offense);
const offenseMlRoutes = [];
for (const lam of [0.05, 0.08, 0.12, 0.2]) {
  const picks = selectDaily(
    eligible,
    (g) => g.bScore - (g.offense ? lam : 0)
  );
  const s = summarizeMl(picks);
  offenseMlRoutes.push({
    id: `offense_ml_lam${lam}`,
    lambda: lam,
    picks: s,
    dHrPp:
      mlBase.hitRate != null && s.hitRate != null
        ? Number(((s.hitRate - mlBase.hitRate) * 100).toFixed(2))
        : null,
    dUsd: Number((s.usd50 - mlBase.usd50).toFixed(2)),
    byYearDeltaUsd: Object.fromEntries(
      ['2024', '2025', '2026'].map((y) => {
        const bY = summarizeMl(mlBasePicks.filter((x) => x.year === y));
        const kY = summarizeMl(picks.filter((x) => x.year === y));
        return [y, Number((kY.usd50 - bY.usd50).toFixed(2))];
      })
    ),
    nReplaced: mlBasePicks.filter(
      (b) => !picks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
    ).length,
  });
}
offenseMlRoutes.sort((a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999));

const typeGateOffense = {
  need: 'offense n>=80 and (|dMeanTotal|>=0.25 or over-rate lift)',
  passed:
    offenseSep.offense.n >= 80 &&
    ((offenseSep.dMeanTotal != null && Math.abs(offenseSep.dMeanTotal) >= 0.25) ||
      (offenseSep.offense.overHitIfBetOver != null &&
        offenseSep.notOffense.overHitIfBetOver != null &&
        offenseSep.offense.overHitIfBetOver - offenseSep.notOffense.overHitIfBetOver >=
          0.03)),
};

const yearOk = (y) =>
  (y?.['2024'] ?? -999) >= -80 &&
  (y?.['2025'] ?? -999) >= -80 &&
  (y?.['2026'] ?? -999) >= -80;

const offenseTotalsGate = {
  need: 'ban under: dUsd>=0, dHr roughly non-neg, years ok, cut n>=5',
  passed:
    (offenseRouteTotals.dUsd ?? -1) >= 0 &&
    (offenseRouteTotals.dHrPp ?? -1) >= -0.2 &&
    yearOk(offenseRouteTotals.byYearDeltaUsd) &&
    (offenseRouteTotals.cut?.n || 0) >= 5,
};

const offenseMlBest = offenseMlRoutes[0] || null;
const offenseMlGate = {
  need: 'soft demote: dUsd>=50, years ok, nReplaced>=5, offense eligible>=10',
  passed:
    Boolean(offenseMlBest) &&
    (offenseMlBest.dUsd ?? -1) >= 50 &&
    yearOk(offenseMlBest.byYearDeltaUsd) &&
    (offenseMlBest.nReplaced || 0) >= 5 &&
    offenseMlEligible.length >= 10,
};

/** T3 閾值網格：找更有分離度的高打定義（只診斷，不改正式） */
function matchT3(row, minRpg, minEra) {
  if (row.avgRpg == null || row.avgRpg < minRpg) return false;
  const heOk = row.homeEra == null || row.homeEra >= minEra;
  const aeOk = row.awayEra == null || row.awayEra >= minEra;
  return heOk && aeOk;
}

const t3Grid = [];
for (const minRpg of [5.0, 5.2, 5.4, 5.6, 5.8]) {
  for (const minEra of [4.2, 4.5, 4.8, 5.0]) {
    const hit = t3Diag.filter((r) => matchT3(r, minRpg, minEra));
    const miss = t3Diag.filter((r) => !matchT3(r, minRpg, minEra));
    const hs = summarizeSep(hit);
    const ms = summarizeSep(miss);
    t3Grid.push({
      id: `rpg${minRpg}_era${minEra}`,
      minRpg,
      minEra,
      n: hs.n,
      meanTotal: hs.meanTotal,
      dMeanTotal:
        hs.meanTotal != null && ms.meanTotal != null
          ? Number((hs.meanTotal - ms.meanTotal).toFixed(3))
          : null,
      overRate: hs.overHitIfBetOver,
      dOverPp:
        hs.overHitIfBetOver != null && ms.overHitIfBetOver != null
          ? Number(((hs.overHitIfBetOver - ms.overHitIfBetOver) * 100).toFixed(2))
          : null,
      homeWinRate: hs.homeWinRate,
    });
  }
}
t3Grid.sort(
  (a, b) =>
    (b.dMeanTotal ?? -999) - (a.dMeanTotal ?? -999) ||
    (b.dOverPp ?? -999) - (a.dOverPp ?? -999)
);
const t3Recommend = t3Grid.find(
  (g) =>
    g.n >= 80 &&
    g.n <= 800 &&
    ((g.dMeanTotal ?? 0) >= 0.35 || (g.dOverPp ?? 0) >= 3)
);

const out = {
  experimentId: 'layered-next-routes-2026-08-08',
  r1Hybrid: r1,
  t4bLockedB: {
    ...t4b,
    eligibleN: eligible.length,
    wideEligibleN: eligible.filter((g) => g.unclearWide).length,
  },
  stack,
  typeSeparation: typeSep,
  offense: {
    separation: offenseSep,
    hybridSlice: {
      n: hybridOffense.length,
      all: summarizeUnits(hybridOffense),
      under: summarizeUnits(hybridOffenseUnder),
      over: summarizeUnits(hybridOffenseOver),
    },
    mlEligibleN: offenseMlEligible.length,
    mlEligible: summarizeMl(offenseMlEligible),
    routeBanUnder: offenseRouteTotals,
    routeMlSoftTop: offenseMlRoutes.slice(0, 4),
    t3ThresholdGridTop: t3Grid.slice(0, 8),
    t3Recommend: t3Recommend || null,
    gates: {
      typeGateOffense,
      offenseTotalsGate,
      offenseMlGate,
    },
    verdict:
      typeGateOffense.passed && (offenseTotalsGate.passed || offenseMlGate.passed)
        ? 'OFFENSE_PROMOTE_COMPARE'
        : t3Recommend
          ? 'OFFENSE_FORMAL_WEAK_BUT_ALT_THRESHOLD_EXISTS'
          : typeGateOffense.passed
            ? 'OFFENSE_TYPE_OK_ROUTE_WEAK'
            : 'OFFENSE_KEEP_WEAK_PASSTHROUGH',
  },
  overall: {
    r1StillApply: r1.stillPositive,
    stackHarmless: stack.r1ApplySafe && !stack.conflict,
    t4bRemainCompare: true,
    offenseNext: null,
  },
};

out.overall.offenseNext = out.offense.verdict;

fs.writeFileSync(
  new URL('../tmp-layered-next-routes.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log(
  JSON.stringify(
    {
      r1: {
        dUsd: r1.dUsd,
        dHrPp: r1.dHrPp,
        cutN: r1.cut.n,
        stillPositive: r1.stillPositive,
      },
      t4b: {
        eligibleN: out.t4bLockedB.eligibleN,
        wideEligibleN: out.t4bLockedB.wideEligibleN,
        dUsd: t4b.dUsd,
        dHrPp: t4b.dHrPp,
        stillPositiveCompare: t4b.stillPositiveCompare,
      },
      stack: {
        orthogonal: stack.marketsOrthogonal,
        paperDeltaIfBoth: stack.paperDeltaUsdIfBoth,
        conflict: stack.conflict,
      },
      offenseSep: {
        n: offenseSep.offense.n,
        dMeanTotal: offenseSep.dMeanTotal,
        dHomeWinPp: offenseSep.dHomeWinPp,
        meanTotal: offenseSep.offense.meanTotal,
        overRate: offenseSep.offense.overHitIfBetOver,
        notOverRate: offenseSep.notOffense.overHitIfBetOver,
      },
      offenseHybrid: out.offense.hybridSlice,
      offenseBanUnder: {
        dUsd: offenseRouteTotals.dUsd,
        dHrPp: offenseRouteTotals.dHrPp,
        cutN: offenseRouteTotals.cut?.n,
        byYear: offenseRouteTotals.byYearDeltaUsd,
        passed: offenseTotalsGate.passed,
      },
      offenseMlBest: offenseMlBest
        ? {
            id: offenseMlBest.id,
            dUsd: offenseMlBest.dUsd,
            dHrPp: offenseMlBest.dHrPp,
            byYear: offenseMlBest.byYearDeltaUsd,
            nReplaced: offenseMlBest.nReplaced,
            passed: offenseMlGate.passed,
          }
        : null,
      t3Recommend: t3Recommend,
      t3Top: t3Grid.slice(0, 5),
      typeCounts: Object.fromEntries(
        Object.entries(typeSep).map(([k, v]) => [k, v.n])
      ),
      verdict: {
        stackHarmless: out.overall.stackHarmless,
        offense: out.offense.verdict,
      },
    },
    null,
    2
  )
);
console.log('wrote tmp-layered-next-routes.json');
