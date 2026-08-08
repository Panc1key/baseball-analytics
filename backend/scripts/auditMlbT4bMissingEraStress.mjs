/**
 * T4b 加壓驗證：固定 λ、按月、expanding WF、leave-one-year、與 strong_home 交叉
 *
 *   node scripts/auditMlbT4bMissingEraStress.mjs
 * 產物: tmp-t4b-missing-era-stress.json
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
import { MLB_MISSING_ERA_SOFT_SPEC } from '../src/services/MlbMissingEraSoftShadow.js';

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const LAMBDAS = [0.03, 0.05, 0.08, 0.12, 0.2];
const FIXED_LAM = MLB_MISSING_ERA_SOFT_SPEC.rankPenaltyLambda || 0.05;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-08-07' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
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
      if (!bestTotals || vig < bestTotals.vig) bestTotals = { line: Number(over.point), vig };
    }
  }
  return { books: out, totalsLine: bestTotals?.line ?? null, homeOdds };
}

function summarize(bets) {
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

function penalize(g, { lambda, scope }) {
  if (!g.unclearWide) return 0;
  if (scope === 'normal_only' && g.formalType !== 'normal') return 0;
  if (scope === 'exclude_strong_home' && g.formalType === 'strong_home') return 0;
  return lambda;
}

function evalPolicy(eligible, baselinePicks, baseline, lambda, scope) {
  const scoreFn = (g) => g.bScore - penalize(g, { lambda, scope });
  const picks = selectDaily(eligible, scoreFn);
  const s = summarize(picks);
  const dropped = baselinePicks.filter(
    (b) => !picks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
  );
  const added = picks.filter(
    (p) => !baselinePicks.some((b) => b.gameId === p.gameId && b.pickHome === p.pickHome)
  );
  return {
    id: `${scope}_lam${lambda}`,
    scope,
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
  };
}

function buildPool() {
  const validation = getLatestMlbExpectedRunsValidation();
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
      if (hs === as) continue;
      const pred = predictMlbGameRuns(validation.model, features, { totalLine: 8.5 });
      const ph = +pred.homeExpectedRuns;
      const pa = +pred.awayExpectedRuns;
      if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;
      const pickHome = ph >= pa;
      const modelProb = pickHome
        ? +pred.markets?.homeWinProbability
        : +pred.markets?.awayWinProbability;
      if (!Number.isFinite(modelProb)) continue;
      const { books: bs, totalsLine, homeOdds } = booksAndTotals(
        row.gameId,
        row.commenceTime,
        row.homeTeam,
        row.awayTeam
      );
      if (bs.length < 2) continue;
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
      const formal = resolveMlbGameType({ features, totalsLine, homeOdds });
      const wide = detectUnclearBreadth(features, { totalsLine, breadth: 'wide' });
      const bScore = scoreMlbMoneylineDailyRank(
        { expectedValue: ev, modelProbability: modelProb },
        B
      );
      const day = hk(row.commenceTime);
      pool.push({
        gameId: row.gameId,
        day,
        month: day.slice(0, 7),
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
      });
    }
  }
  return pool;
}

console.log('[t4b-stress] build…');
const pool = buildPool();
const eligible = selectEligible(pool);
const baselinePicks = selectDaily(eligible, (g) => g.bScore);
const baseline = summarize(baselinePicks);
console.log('eligible', eligible.length, 'baseline', baselinePicks.length);

const scopes = ['all_wide', 'exclude_strong_home', 'normal_only'];
const fixedGrid = [];
for (const scope of scopes) {
  for (const lambda of LAMBDAS) {
    fixedGrid.push(evalPolicy(eligible, baselinePicks, baseline, lambda, scope));
  }
}
fixedGrid.sort((a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999));

const fixedDefault = evalPolicy(
  eligible,
  baselinePicks,
  baseline,
  FIXED_LAM,
  'all_wide'
);

/** 按月固定 λ=0.05 */
const months = [...new Set(eligible.map((g) => g.month))].sort();
const monthly = [];
for (const m of months) {
  const eligM = eligible.filter((g) => g.month === m);
  const baseM = selectDaily(eligM, (g) => g.bScore);
  const softM = selectDaily(
    eligM,
    (g) => g.bScore - penalize(g, { lambda: FIXED_LAM, scope: 'all_wide' })
  );
  const bS = summarize(baseM);
  const sS = summarize(softM);
  monthly.push({
    month: m,
    baseline: bS,
    soft: sS,
    dUsd: Number((sS.usd50 - bS.usd50).toFixed(2)),
    dHrPp:
      sS.hitRate != null && bS.hitRate != null
        ? Number(((sS.hitRate - bS.hitRate) * 100).toFixed(2))
        : null,
    wideN: eligM.filter((g) => g.unclearWide).length,
  });
}
const monthlyPos = monthly.filter((r) => (r.dUsd ?? 0) > 0).length;
const monthlyNeg = monthly.filter((r) => (r.dUsd ?? 0) < 0).length;
const monthlyZero = monthly.filter((r) => (r.dUsd ?? 0) === 0).length;

/** Expanding WF：截至前月選最佳 λ（all_wide），測當月 */
const wfMonths = months.filter((m) => m >= '2024-06');
const wfRows = [];
for (const testMonth of wfMonths) {
  const trainElig = eligible.filter((g) => g.month < testMonth);
  const testElig = eligible.filter((g) => g.month === testMonth);
  if (trainElig.length < 40 || testElig.length < 5) continue;
  const trainBase = selectDaily(trainElig, (g) => g.bScore);
  const trainBaseS = summarize(trainBase);
  let bestLam = FIXED_LAM;
  let bestD = -Infinity;
  for (const lam of LAMBDAS) {
    const p = evalPolicy(trainElig, trainBase, trainBaseS, lam, 'all_wide');
    if ((p.dUsd ?? -9999) > bestD) {
      bestD = p.dUsd;
      bestLam = lam;
    }
  }
  const testBase = selectDaily(testElig, (g) => g.bScore);
  const testSoft = selectDaily(
    testElig,
    (g) => g.bScore - penalize(g, { lambda: bestLam, scope: 'all_wide' })
  );
  const tb = summarize(testBase);
  const ts = summarize(testSoft);
  wfRows.push({
    month: testMonth,
    chosenLam: bestLam,
    trainBestDUsd: bestD,
    baseline: tb,
    soft: ts,
    dUsd: Number((ts.usd50 - tb.usd50).toFixed(2)),
    dHrPp:
      ts.hitRate != null && tb.hitRate != null
        ? Number(((ts.hitRate - tb.hitRate) * 100).toFixed(2))
        : null,
  });
}
const wfBeat = wfRows.filter((r) => (r.dUsd ?? 0) > 0).length;
const wfHurt = wfRows.filter((r) => (r.dUsd ?? 0) < 0).length;
const wfFlat = wfRows.filter((r) => (r.dUsd ?? 0) === 0).length;
const wfDeltaUsd = Number(
  wfRows.reduce((s, r) => s + (r.dUsd || 0), 0).toFixed(2)
);

/** Leave-one-year：在另兩年選 λ，測留出年 */
const loy = [];
for (const hold of ['2024', '2025', '2026']) {
  const train = eligible.filter((g) => g.year !== hold);
  const test = eligible.filter((g) => g.year === hold);
  const trainBase = selectDaily(train, (g) => g.bScore);
  const trainBaseS = summarize(trainBase);
  let bestLam = FIXED_LAM;
  let bestD = -Infinity;
  for (const lam of LAMBDAS) {
    const p = evalPolicy(train, trainBase, trainBaseS, lam, 'all_wide');
    if ((p.dUsd ?? -9999) > bestD) {
      bestD = p.dUsd;
      bestLam = lam;
    }
  }
  const testBase = selectDaily(test, (g) => g.bScore);
  const testSoft = selectDaily(
    test,
    (g) => g.bScore - penalize(g, { lambda: bestLam, scope: 'all_wide' })
  );
  const tb = summarize(testBase);
  const ts = summarize(testSoft);
  loy.push({
    holdYear: hold,
    chosenLam: bestLam,
    trainBestDUsd: bestD,
    dUsd: Number((ts.usd50 - tb.usd50).toFixed(2)),
    dHrPp:
      ts.hitRate != null && tb.hitRate != null
        ? Number(((ts.hitRate - tb.hitRate) * 100).toFixed(2))
        : null,
    testBaseline: tb,
    testSoft: ts,
  });
}

const yearOk = (y) =>
  (y?.['2024'] ?? -999) >= -80 &&
  (y?.['2025'] ?? -999) >= -80 &&
  (y?.['2026'] ?? -999) >= -80;

const stressGates = {
  fixedStillPositive:
    (fixedDefault.dUsd ?? -1) >= 50 &&
    (fixedDefault.dHrPp ?? -1) >= 0 &&
    yearOk(fixedDefault.byYearDeltaUsd),
  monthlyBeatGeHurt: monthlyPos >= monthlyNeg,
  expandingDeltaNonNeg: wfDeltaUsd >= 0 && wfBeat >= wfHurt,
  leaveOneYearAllNonNeg: loy.every((r) => (r.dUsd ?? -1) >= -80),
  leaveOneYearMajorityPos: loy.filter((r) => (r.dUsd ?? 0) > 0).length >= 2,
};

const allStressPass = Object.values(stressGates).every(Boolean);
const promoteApply =
  allStressPass &&
  stressGates.expandingDeltaNonNeg &&
  loy.every((r) => (r.dUsd ?? -1) >= 0);

const out = {
  experimentId: 't4b-missing-era-stress-2026-08-08',
  plain:
    'T4b 加壓：固定λ、按月、expanding WF、leave-one-year、scope 對照。過全閘才談 apply。',
  baseline,
  fixedDefault,
  fixedTop: fixedGrid.slice(0, 8),
  monthly: {
    rows: monthly,
    pos: monthlyPos,
    neg: monthlyNeg,
    flat: monthlyZero,
    sumDUsd: Number(monthly.reduce((s, r) => s + (r.dUsd || 0), 0).toFixed(2)),
  },
  expandingWf: {
    rows: wfRows,
    beat: wfBeat,
    hurt: wfHurt,
    flat: wfFlat,
    deltaUsd: wfDeltaUsd,
  },
  leaveOneYear: loy,
  stressGates,
  allStressPass,
  promoteApply,
  verdict: promoteApply
    ? 'PASS_STRESS_MAY_APPLY'
    : allStressPass
      ? 'PASS_STRESS_KEEP_COMPARE'
      : 'FAIL_STRESS_KEEP_COMPARE',
};

fs.writeFileSync(
  new URL('../tmp-t4b-missing-era-stress.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log(
  JSON.stringify(
    {
      baseline: out.baseline,
      fixedDefault: {
        id: fixedDefault.id,
        dUsd: fixedDefault.dUsd,
        dHrPp: fixedDefault.dHrPp,
        byYear: fixedDefault.byYearDeltaUsd,
        nReplaced: fixedDefault.nReplaced,
        outHr: fixedDefault.replacedOut?.hitRate,
        inHr: fixedDefault.replacedIn?.hitRate,
      },
      bestScope: {
        id: fixedGrid[0]?.id,
        dUsd: fixedGrid[0]?.dUsd,
        dHrPp: fixedGrid[0]?.dHrPp,
        byYear: fixedGrid[0]?.byYearDeltaUsd,
      },
      monthly: {
        pos: monthlyPos,
        neg: monthlyNeg,
        flat: monthlyZero,
        sumDUsd: out.monthly.sumDUsd,
        worst: [...monthly].sort((a, b) => (a.dUsd ?? 0) - (b.dUsd ?? 0))[0],
        best: [...monthly].sort((a, b) => (b.dUsd ?? 0) - (a.dUsd ?? 0))[0],
      },
      expandingWf: {
        beatHurtFlat: `${wfBeat}/${wfHurt}/${wfFlat}`,
        deltaUsd: wfDeltaUsd,
      },
      leaveOneYear: loy.map((r) => ({
        hold: r.holdYear,
        lam: r.chosenLam,
        dUsd: r.dUsd,
        dHrPp: r.dHrPp,
      })),
      stressGates,
      allStressPass,
      promoteApply,
      verdict: out.verdict,
    },
    null,
    2
  )
);
console.log('wrote tmp-t4b-missing-era-stress.json');
