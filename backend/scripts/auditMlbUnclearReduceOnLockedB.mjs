/**
 * R5：unclear 減倉 vs Locked B（嚴格 T4 + 寬缺 ERA 影子）
 *
 *   node scripts/auditMlbUnclearReduceOnLockedB.mjs
 * 產物: tmp-unclear-reduce-on-locked-b.json
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
import {
  detectUnclearBreadth,
  MLB_UNCLEAR_REDUCE_SPEC,
} from '../src/services/MlbUnclearReduceShadow.js';

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

function booksAndTotals(g, c, h, a) {
  const pit = resolvePitOdds(g, c);
  if (!pit?.bookmakers?.length) return { books: [], totalsLine: null };
  const out = [];
  let bestTotals = null;
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
  return { books: out, totalsLine: bestTotals?.line ?? null };
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

function build(from, to, yearKey) {
  const validation = getLatestMlbExpectedRunsValidation();
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, from, to);
  const pool = [];
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
    const { books: bs, totalsLine } = booksAndTotals(
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
    const strict = detectUnclearBreadth(features, { totalsLine, breadth: 'strict' });
    const wide = detectUnclearBreadth(features, { totalsLine, breadth: 'wide' });
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    pool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      year: yearKey,
      hit: pickHome === hs > as,
      pickHome,
      pickOdds,
      ev,
      margin,
      modelProb,
      bScore,
      unclearStrict: Boolean(strict.matched),
      unclearWide: Boolean(wide.matched),
      matchup: `${row.awayTeam} @ ${row.homeTeam}`,
    });
  }
  return pool;
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

function evalPolicy(eligible, baselinePicks, baseline, flagKey, lambdas) {
  const flagged = eligible.filter((g) => g[flagKey]);
  const rows = [];
  for (const lambda of lambdas) {
    const scoreFn = (g) => g.bScore - (g[flagKey] ? lambda : 0);
    const picks = selectDaily(eligible, scoreFn);
    const s = summarize(picks);
    const droppedVsBase = baselinePicks.filter(
      (b) => !picks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
    );
    const addedVsBase = picks.filter(
      (p) => !baselinePicks.some((b) => b.gameId === p.gameId && b.pickHome === p.pickHome)
    );
    rows.push({
      id: `${flagKey}_lam${lambda}`,
      breadth: flagKey,
      lambda,
      mode: 'soft',
      picks: s,
      replacedOut: summarize(droppedVsBase),
      replacedIn: summarize(addedVsBase),
      dHrPp:
        s.hitRate != null && baseline.hitRate != null
          ? Number(((s.hitRate - baseline.hitRate) * 100).toFixed(2))
          : null,
      dRoiPp:
        s.roi != null && baseline.roi != null
          ? Number(((s.roi - baseline.roi) * 100).toFixed(2))
          : null,
      dUsd: Number((s.usd50 - baseline.usd50).toFixed(2)),
      byYearDeltaUsd: Object.fromEntries(
        ['2024', '2025', '2026'].map((y) => {
          const bY = summarize(baselinePicks.filter((x) => x.year === y));
          const kY = summarize(picks.filter((x) => x.year === y));
          return [y, Number((kY.usd50 - bY.usd50).toFixed(2))];
        })
      ),
      nReplaced: droppedVsBase.length,
      flaggedLeft: picks.filter((p) => p[flagKey]).length,
    });
  }
  const hardSkipPicks = selectDaily(
    eligible.filter((g) => !g[flagKey]),
    (g) => g.bScore
  );
  const hardS = summarize(hardSkipPicks);
  rows.push({
    id: `${flagKey}_hard_skip`,
    breadth: flagKey,
    lambda: null,
    mode: 'hard_skip',
    picks: hardS,
    dHrPp:
      hardS.hitRate != null && baseline.hitRate != null
        ? Number(((hardS.hitRate - baseline.hitRate) * 100).toFixed(2))
        : null,
    dRoiPp:
      hardS.roi != null && baseline.roi != null
        ? Number(((hardS.roi - baseline.roi) * 100).toFixed(2))
        : null,
    dUsd: Number((hardS.usd50 - baseline.usd50).toFixed(2)),
    byYearDeltaUsd: Object.fromEntries(
      ['2024', '2025', '2026'].map((y) => {
        const bY = summarize(baselinePicks.filter((x) => x.year === y));
        const kY = summarize(hardSkipPicks.filter((x) => x.year === y));
        return [y, Number((kY.usd50 - bY.usd50).toFixed(2))];
      })
    ),
    nReplaced: baselinePicks.filter(
      (b) =>
        !hardSkipPicks.some((p) => p.gameId === b.gameId && b.pickHome === p.pickHome)
    ).length,
    flaggedLeft: 0,
    flaggedSlice: summarize(flagged),
  });
  return { flaggedN: flagged.length, flaggedSummary: summarize(flagged), rows };
}

console.log('[unclear-reduce] build…');
const pool = WINDOWS.flatMap((w) => build(w.from, w.to, w.key));
const eligible = selectEligible(pool);
const baselinePicks = selectDaily(eligible, (g) => g.bScore);
const baseline = summarize(baselinePicks);
console.log(' eligible', eligible.length, 'baseline', baselinePicks.length);

const lambdas = [0.05, 0.08, 0.12, 0.2, 0.35];
const strictEval = evalPolicy(eligible, baselinePicks, baseline, 'unclearStrict', lambdas);
const wideEval = evalPolicy(eligible, baselinePicks, baseline, 'unclearWide', lambdas);

const allRows = [...strictEval.rows, ...wideEval.rows].sort(
  (a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999)
);

const recommend = allRows.find(
  (g) =>
    g.mode === 'soft' &&
    g.breadth === 'unclearStrict' &&
    (g.dUsd ?? -1) >= 0 &&
    (g.dHrPp ?? -1) >= -0.2 &&
    (g.byYearDeltaUsd?.['2025'] ?? -999) >= -80 &&
    (g.byYearDeltaUsd?.['2026'] ?? -999) >= -80 &&
    g.nReplaced >= 5 &&
    strictEval.flaggedN >= 20
);

const out = {
  experimentId: 'unclear-reduce-on-locked-b-2026-08-08',
  routeId: 'R5_unclear_reduce_volume',
  plain:
    '嚴格 T4 unclear（缺雙 ERA+缺線）樣本通常極少；寬 unclear（缺任一邊 ERA）僅影子診斷，不改正式 type。',
  baseline,
  inventory: {
    strictInEligible: strictEval.flaggedN,
    strictSummary: strictEval.flaggedSummary,
    wideInEligible: wideEval.flaggedN,
    wideSummary: wideEval.flaggedSummary,
    strictInBaseline: baselinePicks.filter((b) => b.unclearStrict).length,
    wideInBaseline: baselinePicks.filter((b) => b.unclearWide).length,
  },
  topByUsd: allRows.slice(0, 15),
  recommend: recommend || null,
  gate: {
    need: 'strict soft: enough n, dUsd>=0, year stable',
    passed: Boolean(recommend),
    note:
      strictEval.flaggedN < 20
        ? '嚴格 unclear 樣本不足，R5 維持 compare，禁止升 apply'
        : null,
  },
  defaultLambda: MLB_UNCLEAR_REDUCE_SPEC.rankPenaltyLambda,
};

fs.writeFileSync(
  new URL('../tmp-unclear-reduce-on-locked-b.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      inventory: out.inventory,
      baseline: out.baseline,
      recommend: out.recommend
        ? { id: out.recommend.id, dUsd: out.recommend.dUsd, dHrPp: out.recommend.dHrPp }
        : null,
      bestOverall: {
        id: allRows[0]?.id,
        dUsd: allRows[0]?.dUsd,
        dHrPp: allRows[0]?.dHrPp,
        byYear: allRows[0]?.byYearDeltaUsd,
      },
      passed: out.gate.passed,
      gateNote: out.gate.note,
    },
    null,
    2
  )
);
console.log('wrote tmp-unclear-reduce-on-locked-b.json');
