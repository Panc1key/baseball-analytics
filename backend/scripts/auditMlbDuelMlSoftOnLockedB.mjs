/**
 * R3：投手對決 → 獨贏日排序軟降權 vs Locked B
 *
 *   node scripts/auditMlbDuelMlSoftOnLockedB.mjs
 * 產物: tmp-duel-ml-soft-on-locked-b.json
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
import { detectPitcherDuel } from '../src/services/MlbGameShapeShadow.js';
import { MLB_DUEL_ML_SOFT_SPEC } from '../src/services/MlbDuelMlSoftShadow.js';

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
    const duel = detectPitcherDuel(features, {
      totalsLine,
      spec: { pitcherDuel: MLB_DUEL_ML_SOFT_SPEC.pitcherDuel },
    });
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
      duelMatched: Boolean(duel.matched),
      totalsLine,
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

console.log('[duel-ml-soft] build…');
const pool = WINDOWS.flatMap((w) => build(w.from, w.to, w.key));
const eligible = selectEligible(pool);
const baselinePicks = selectDaily(eligible, (g) => g.bScore);
const baseline = summarize(baselinePicks);
const duelInEligible = eligible.filter((g) => g.duelMatched);
const duelInBaseline = baselinePicks.filter((g) => g.duelMatched);
console.log(
  ' eligible',
  eligible.length,
  'duelEligible',
  duelInEligible.length,
  'baseline picks',
  baselinePicks.length,
  'duelInBaseline',
  duelInBaseline.length
);

const grid = [];
for (const lambda of [0.03, 0.05, 0.08, 0.12, 0.18, 0.25, 0.4]) {
  const scoreFn = (g) => g.bScore - (g.duelMatched ? lambda : 0);
  const picks = selectDaily(eligible, scoreFn);
  const s = summarize(picks);
  const droppedVsBase = baselinePicks.filter(
    (b) => !picks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
  );
  const addedVsBase = picks.filter(
    (p) => !baselinePicks.some((b) => b.gameId === p.gameId && b.pickHome === p.pickHome)
  );
  const hardSkipPicks = selectDaily(
    eligible.filter((g) => !g.duelMatched),
    (g) => g.bScore
  );
  const hardS = summarize(hardSkipPicks);
  grid.push({
    id: `lam${lambda}`,
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
    duelLeftInPicks: picks.filter((p) => p.duelMatched).length,
  });
  if (lambda === 0.08) {
    grid.push({
      id: 'hard_skip_duel_ml',
      lambda: null,
      mode: 'hard_skip',
      picks: hardS,
      replacedOut: summarize(
        baselinePicks.filter(
          (b) =>
            !hardSkipPicks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
        )
      ),
      replacedIn: summarize(
        hardSkipPicks.filter(
          (p) =>
            !baselinePicks.some((b) => b.gameId === p.gameId && b.pickHome === p.pickHome)
        )
      ),
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
          !hardSkipPicks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
      ).length,
      duelLeftInPicks: 0,
    });
  }
}

grid.sort((a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999) || (b.dHrPp ?? -999) - (a.dHrPp ?? -999));

const recommend = grid.find(
  (g) =>
    g.mode === 'soft' &&
    (g.dUsd ?? -1) >= 0 &&
    (g.dHrPp ?? -1) >= -0.2 &&
    (g.byYearDeltaUsd?.['2024'] ?? -999) >= -80 &&
    (g.byYearDeltaUsd?.['2025'] ?? -999) >= -80 &&
    (g.byYearDeltaUsd?.['2026'] ?? -999) >= -80 &&
    g.nReplaced >= 5
);

const defaultId = `lam${MLB_DUEL_ML_SOFT_SPEC.rankPenaltyLambda}`;
const defaultRow = grid.find((g) => g.id === defaultId) || null;

const out = {
  experimentId: 'duel-ml-soft-on-locked-b-2026-08-08',
  routeId: 'R3_moneyline_demote_duel',
  plain:
    '對決局獨贏：軟扣日排序分（或硬跳過對照）；看 TopK 換血後勝率/ROI/$ 與年份閘。',
  slice: {
    eligibleN: eligible.length,
    duelEligibleN: duelInEligible.length,
    duelEligibleHr: summarize(duelInEligible).hitRate,
    duelEligibleUsd: summarize(duelInEligible).usd50,
    duelInBaselineN: duelInBaseline.length,
    duelInBaseline: summarize(duelInBaseline),
  },
  baseline,
  defaultRow,
  topByUsd: grid.slice(0, 12),
  recommend: recommend || null,
  recommendFallback: recommend ? null : grid.find((g) => g.mode === 'soft') || grid[0],
  gate: {
    need: 'soft dUsd>=0, dHr roughly non-neg, ALL years 2024/25/26 not badly hurt (<=80$), some replacements',
    passed: Boolean(recommend),
  },
};

fs.writeFileSync(
  new URL('../tmp-duel-ml-soft-on-locked-b.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      slice: out.slice,
      baseline: out.baseline,
      defaultRow: out.defaultRow
        ? {
            id: out.defaultRow.id,
            dHrPp: out.defaultRow.dHrPp,
            dUsd: out.defaultRow.dUsd,
            nReplaced: out.defaultRow.nReplaced,
            byYear: out.defaultRow.byYearDeltaUsd,
          }
        : null,
      recommend: out.recommend
        ? {
            id: out.recommend.id,
            dHrPp: out.recommend.dHrPp,
            dUsd: out.recommend.dUsd,
            nReplaced: out.recommend.nReplaced,
            byYear: out.recommend.byYearDeltaUsd,
          }
        : null,
      bestSoft: {
        id: out.recommendFallback?.id,
        dHrPp: out.recommendFallback?.dHrPp,
        dUsd: out.recommendFallback?.dUsd,
        byYear: out.recommendFallback?.byYearDeltaUsd,
      },
      hardSkip: grid.find((g) => g.id === 'hard_skip_duel_ml')
        ? {
            dHrPp: grid.find((g) => g.id === 'hard_skip_duel_ml').dHrPp,
            dUsd: grid.find((g) => g.id === 'hard_skip_duel_ml').dUsd,
            byYear: grid.find((g) => g.id === 'hard_skip_duel_ml').byYearDeltaUsd,
          }
        : null,
      passed: out.gate.passed,
    },
    null,
    2
  )
);
console.log('wrote tmp-duel-ml-soft-on-locked-b.json');
