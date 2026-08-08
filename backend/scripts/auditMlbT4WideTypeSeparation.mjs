/**
 * T4-wide 類型分離度 + 路由影子（缺任一邊 ERA）
 *
 * 正式 T4 = 缺雙 ERA 且缺線。本腳本只診斷「寬 unclear」是否值得獨立成 type，
 * 不得直接把正式 resolveMlbGameType 改寬。
 *
 *   node scripts/auditMlbT4WideTypeSeparation.mjs
 * 產物: tmp-t4-wide-type-separation.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
} from '../src/services/MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { resolveMlbGameType } from '../src/services/MlbLayeredArchitecture.js';
import { detectUnclearBreadth } from '../src/services/MlbUnclearReduceShadow.js';
import { readStarterEras } from '../src/services/MlbGameShapeShadow.js';

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-08-07' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function mean(arr) {
  if (!arr.length) return null;
  return Number((arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(4));
}

function booksAndTotals(g, c, h, a) {
  const pit = resolvePitOdds(g, c);
  if (!pit?.bookmakers?.length) return { books: [], totalsLine: null, homeOdds: null };
  const out = [];
  let bestTotals = null;
  let homeOdds = null;
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (m?.outcomes?.length) {
      const home =
        m.outcomes.find((o) => o.name === h) ||
        m.outcomes.find((o) => String(o.name).includes(String(h).split(' ').pop()));
      const away =
        m.outcomes.find((o) => o.name === a) ||
        m.outcomes.find((o) => String(o.name).includes(String(a).split(' ').pop()));
      if (home?.price && away?.price) {
        const ho = +home.price;
        const ao = +away.price;
        if (Number.isFinite(ho) && Number.isFinite(ao)) {
          out.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao });
          if (homeOdds == null || ho < homeOdds) homeOdds = ho;
        }
      }
    }
    const tot = book.markets?.find((x) => x.key === 'totals');
    if (!tot) continue;
    for (const over of tot.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = tot.outcomes.find(
        (o) => o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!over.price || !under?.price) continue;
      const oo = +over.price;
      const uo = +under.price;
      if (!Number.isFinite(oo) || !Number.isFinite(uo)) continue;
      const vig = 1 / oo + 1 / uo;
      if (!bestTotals || vig < bestTotals.vig) {
        bestTotals = { line: Number(over.point), vig };
      }
    }
  }
  return { books: out, totalsLine: bestTotals?.line ?? null, homeOdds };
}

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0 };
  }
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

function buildAll() {
  const validation = getLatestMlbExpectedRunsValidation();
  const sepBuckets = {
    formal_type: {},
    wide_flag: { wide: [], not_wide: [] },
    missing_side: { home_only: [], away_only: [], both: [], none: [] },
  };
  const pool = [];

  for (const w of WINDOWS) {
    const rows = db
      .prepare(
        `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
                g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
         FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
         WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
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
      const hs = +row.homeScore;
      const as = +row.awayScore;
      const totalRuns = hs + as;
      const homeWin = hs > as;
      const { books: bs, totalsLine, homeOdds } = booksAndTotals(
        row.gameId,
        row.commenceTime,
        row.homeTeam,
        row.awayTeam
      );
      const formal = resolveMlbGameType({
        features,
        totalsLine,
        homeOdds,
      });
      const eras = readStarterEras(features);
      const wide = detectUnclearBreadth(features, { totalsLine, breadth: 'wide' });
      const strict = detectUnclearBreadth(features, { totalsLine, breadth: 'strict' });

      const sepRow = {
        year: w.key,
        totalRuns,
        homeWin: homeWin ? 1 : 0,
        totalsLine,
        formalType: formal.type,
      };
      if (!sepBuckets.formal_type[formal.type]) sepBuckets.formal_type[formal.type] = [];
      sepBuckets.formal_type[formal.type].push(sepRow);
      (wide.matched ? sepBuckets.wide_flag.wide : sepBuckets.wide_flag.not_wide).push(sepRow);

      const missH = eras.homeEra == null;
      const missA = eras.awayEra == null;
      if (missH && missA) sepBuckets.missing_side.both.push(sepRow);
      else if (missH) sepBuckets.missing_side.home_only.push(sepRow);
      else if (missA) sepBuckets.missing_side.away_only.push(sepRow);
      else sepBuckets.missing_side.none.push(sepRow);

      if (hs === as) continue;
      const pred = predictMlbGameRuns(validation.model, features, { totalLine: 8.5 });
      const ph = +pred.homeExpectedRuns;
      const pa = +pred.awayExpectedRuns;
      if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;
      const pickHome = ph >= pa;
      const modelProb = pickHome
        ? +pred.markets?.homeWinProbability
        : +pred.markets?.awayWinProbability;
      if (!Number.isFinite(modelProb) || bs.length < 2) continue;
      bs.sort((a, b) => a.vig - b.vig);
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
      const bScore = scoreMlbMoneylineDailyRank(
        { expectedValue: ev, modelProbability: modelProb },
        B
      );
      pool.push({
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
        unclearStrict: Boolean(strict.matched),
        /** 若把 wide 提升為 type：覆蓋掉 normal，但不覆蓋 duel/strong_home */
        typeIfWidePromoted:
          wide.matched &&
          formal.type !== 'pitcher_duel' &&
          formal.type !== 'strong_home'
            ? 'unclear_wide'
            : formal.type,
      });
    }
  }
  return { sepBuckets, pool };
}

function summarizeSep(rows) {
  return {
    n: rows.length,
    meanTotal: mean(rows.map((r) => r.totalRuns).filter((x) => Number.isFinite(x))),
    homeWinRate: mean(rows.map((r) => r.homeWin)),
    meanLine: mean(rows.map((r) => r.totalsLine).filter((x) => x != null)),
  };
}

console.log('[t4-wide] build…');
const { sepBuckets, pool } = buildAll();
const eligible = selectEligible(pool);
const baselinePicks = selectDaily(eligible, (g) => g.bScore);
const baseline = summarize(baselinePicks);

const formalSep = Object.fromEntries(
  Object.entries(sepBuckets.formal_type).map(([k, rows]) => [k, summarizeSep(rows)])
);
const wideSep = {
  wide: summarizeSep(sepBuckets.wide_flag.wide),
  not_wide: summarizeSep(sepBuckets.wide_flag.not_wide),
};
const missingSep = Object.fromEntries(
  Object.entries(sepBuckets.missing_side).map(([k, rows]) => [k, summarizeSep(rows)])
);

const wideEligible = eligible.filter((g) => g.unclearWide);
const wideInBaseline = baselinePicks.filter((g) => g.unclearWide);
const wideOverlapFormal = {};
for (const g of wideEligible) {
  wideOverlapFormal[g.formalType] = (wideOverlapFormal[g.formalType] || 0) + 1;
}

const routeGrid = [];
for (const lambda of [0.03, 0.05, 0.08, 0.12, 0.2]) {
  const scoreFn = (g) => g.bScore - (g.unclearWide ? lambda : 0);
  const picks = selectDaily(eligible, scoreFn);
  const s = summarize(picks);
  const dropped = baselinePicks.filter(
    (b) => !picks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
  );
  const added = picks.filter(
    (p) => !baselinePicks.some((b) => b.gameId === p.gameId && b.pickHome === p.pickHome)
  );
  routeGrid.push({
    id: `wide_soft_lam${lambda}`,
    lambda,
    picks: s,
    replacedOut: summarize(dropped),
    replacedIn: summarize(added),
    dHrPp:
      s.hitRate != null && baseline.hitRate != null
        ? Number(((s.hitRate - baseline.hitRate) * 100).toFixed(2))
        : null,
    dUsd: Number((s.usd50 - baseline.usd50).toFixed(2)),
    byYearDeltaUsd: Object.fromEntries(
      ['2024', '2025', '2026'].map((y) => {
        const bY = summarize(baselinePicks.filter((x) => x.year === y));
        const kY = summarize(picks.filter((x) => x.year === y));
        return [y, Number((kY.usd50 - bY.usd50).toFixed(2))];
      })
    ),
    nReplaced: dropped.length,
  });
}

routeGrid.sort((a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999));

const yearOk = (y) =>
  (y?.['2024'] ?? -999) >= -80 &&
  (y?.['2025'] ?? -999) >= -80 &&
  (y?.['2026'] ?? -999) >= -80;

const bestRoute = routeGrid[0] || null;
const recommendRoute = routeGrid.find(
  (g) =>
    (g.dUsd ?? -1) >= 50 &&
    (g.dHrPp ?? -1) >= 0 &&
    yearOk(g.byYearDeltaUsd) &&
    g.nReplaced >= 5 &&
    wideEligible.length >= 20
);

/** 分離度：wide vs not_wide 均分差 / 主勝率差 */
const sepLift = {
  dMeanTotal:
    wideSep.wide.meanTotal != null && wideSep.not_wide.meanTotal != null
      ? Number((wideSep.wide.meanTotal - wideSep.not_wide.meanTotal).toFixed(3))
      : null,
  dHomeWinPp:
    wideSep.wide.homeWinRate != null && wideSep.not_wide.homeWinRate != null
      ? Number(((wideSep.wide.homeWinRate - wideSep.not_wide.homeWinRate) * 100).toFixed(2))
      : null,
};

/**
 * 類型門禁：要有足夠 n，且與 not_wide 有可測差異（均分或主勝），才值得獨立標籤。
 * 路由門禁：另看 Locked B 年份穩定。
 */
const typeGate = {
  need: 'wide n>=200 on full sample OR eligible>=20; |dMeanTotal|>=0.15 or |dHomeWinPp|>=1.5',
  passed:
    (wideSep.wide.n >= 200 || wideEligible.length >= 20) &&
    ((sepLift.dMeanTotal != null && Math.abs(sepLift.dMeanTotal) >= 0.15) ||
      (sepLift.dHomeWinPp != null && Math.abs(sepLift.dHomeWinPp) >= 1.5)),
};
const routeGate = {
  need: 'soft dUsd>=50, dHr>=0, all years >= -80, replacements>=5',
  passed: Boolean(recommendRoute),
};

const verdict =
  typeGate.passed && routeGate.passed
    ? 'PROMOTE_COMPARE_SHADOW_ONLY'
    : typeGate.passed && !routeGate.passed
      ? 'TYPE_SEPARATES_BUT_ROUTE_UNSTABLE_OR_WEAK'
      : !typeGate.passed && routeGate.passed
        ? 'ROUTE_HELPS_BUT_TYPE_WEAK_KEEP_FEATURE_FLAG'
        : 'KEEP_RESEARCH_NO_PROMOTE';

const out = {
  experimentId: 't4-wide-type-separation-2026-08-08',
  layer: 'type',
  plain:
    '診斷「缺任一邊 ERA」是否該獨立成 type；通過也只升 compare 影子，不改正式 T4。',
  formalTypeSeparation: formalSep,
  wideVsNot: wideSep,
  missingSideSeparation: missingSep,
  separationLift: sepLift,
  lockedB: {
    baseline,
    wideEligibleN: wideEligible.length,
    wideEligible: summarize(wideEligible),
    wideInBaselineN: wideInBaseline.length,
    wideInBaseline: summarize(wideInBaseline),
    overlapFormalTypesInEligible: wideOverlapFormal,
  },
  routeSoftGridTop: routeGrid.slice(0, 5),
  recommendRoute: recommendRoute || null,
  gates: { typeGate, routeGate },
  verdict,
  policy:
    '禁止把 wide 寫進 resolveMlbGameType 正式分支；若要消費，另開 T4b compare + env，且不覆蓋 pitcher_duel/strong_home。',
};

fs.writeFileSync(
  new URL('../tmp-t4-wide-type-separation.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      wideVsNot: out.wideVsNot,
      sepLift: out.separationLift,
      lockedB: {
        wideEligibleN: out.lockedB.wideEligibleN,
        wideEligible: out.lockedB.wideEligible,
        wideInBaseline: out.lockedB.wideInBaseline,
        overlap: out.lockedB.overlapFormalTypesInEligible,
      },
      bestRoute: bestRoute
        ? {
            id: bestRoute.id,
            dUsd: bestRoute.dUsd,
            dHrPp: bestRoute.dHrPp,
            byYear: bestRoute.byYearDeltaUsd,
          }
        : null,
      recommendRoute: recommendRoute
        ? { id: recommendRoute.id, dUsd: recommendRoute.dUsd, byYear: recommendRoute.byYearDeltaUsd }
        : null,
      gates: out.gates,
      verdict: out.verdict,
    },
    null,
    2
  )
);
console.log('wrote tmp-t4-wide-type-separation.json');
