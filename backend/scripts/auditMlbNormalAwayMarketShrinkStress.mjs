/**
 * μ 加壓：normal 客勝向市場收縮（expanding WF + leave-one-year）
 *   node scripts/auditMlbNormalAwayMarketShrinkStress.mjs
 * 產物: tmp-normal-away-market-shrink-stress.json
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

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const WS = [0.25, 0.35, 0.45, 0.55];
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-08-07' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function books(g, c, h, a) {
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
  if (!bets.length) return { bets: 0, hitRate: null, roi: null, usd50: 0 };
  let unit = 0;
  let hits = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
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

function selectDaily(eligible) {
  const map = new Map();
  for (const g of eligible) {
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const arr = [...map.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    out.push(...applyDrop(arr));
  }
  return out;
}

function shrinkPool(pool, w) {
  return pool.map((g) => {
    const apply = g.type === 'normal' && !g.pickHome && w > 0;
    const p = apply ? (1 - w) * g.modelProb + w * g.marketP : g.modelProb;
    const ev = p * (g.pickOdds - 1) - (1 - p);
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: p },
      B
    );
    return { ...g, modelProb: p, ev, bScore };
  });
}

function evalShrink(pool, basePicks, baseline, w) {
  const picks = selectDaily(selectEligible(shrinkPool(pool, w)));
  const s = summarize(picks);
  const byYear = Object.fromEntries(
    ['2024', '2025', '2026'].map((y) => {
      const bY = summarize(basePicks.filter((x) => x.year === y));
      const kY = summarize(picks.filter((x) => x.year === y));
      return [y, Number((kY.usd50 - bY.usd50).toFixed(2))];
    })
  );
  return {
    w,
    picks: s,
    dUsd: Number((s.usd50 - baseline.usd50).toFixed(2)),
    dHrPp:
      s.hitRate != null && baseline.hitRate != null
        ? Number(((s.hitRate - baseline.hitRate) * 100).toFixed(2))
        : null,
    byYear,
  };
}

console.log('[normal-away-shrink-stress] build…');
const validation = getLatestMlbExpectedRunsValidation();
const pool = [];
for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
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
    const pack = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (pack.books.length < 2) continue;
    pack.books.sort((a, b) => a.vig - b.vig);
    const best = pack.books[0];
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
    const formal = resolveMlbGameType({
      features,
      totalsLine: pack.totalsLine,
      homeOdds: pack.homeOdds,
    });
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    pool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      year: w.key,
      hit: pickHome === hs > as,
      pickHome,
      pickOdds,
      ev,
      margin,
      modelProb,
      marketP: 1 / pickOdds,
      bScore,
      type: formal.type,
    });
  }
}

const basePicks = selectDaily(selectEligible(pool));
const baseline = summarize(basePicks);
const fixed = WS.map((w) => evalShrink(pool, basePicks, baseline, w));

const months = [...new Set(pool.map((g) => g.month))].sort().filter((m) => m >= '2024-06');
const wf = [];
for (const testMonth of months) {
  const train = pool.filter((g) => g.month < testMonth);
  const test = pool.filter((g) => g.month === testMonth);
  if (train.length < 80 || test.length < 10) continue;
  const trainBase = selectDaily(selectEligible(train));
  const trainBaseS = summarize(trainBase);
  let bestW = 0.45;
  let bestD = -Infinity;
  for (const w of WS) {
    const d =
      summarize(selectDaily(selectEligible(shrinkPool(train, w)))).usd50 - trainBaseS.usd50;
    if (d > bestD) {
      bestD = d;
      bestW = w;
    }
  }
  const tb = summarize(selectDaily(selectEligible(test)));
  const ts = summarize(selectDaily(selectEligible(shrinkPool(test, bestW))));
  wf.push({
    month: testMonth,
    chosenW: bestW,
    dUsd: Number((ts.usd50 - tb.usd50).toFixed(2)),
  });
}
const wfDelta = Number(wf.reduce((s, r) => s + (r.dUsd || 0), 0).toFixed(2));
const wfBeat = wf.filter((r) => (r.dUsd || 0) > 0).length;
const wfHurt = wf.filter((r) => (r.dUsd || 0) < 0).length;

const loy = [];
for (const hold of ['2024', '2025', '2026']) {
  const train = pool.filter((g) => g.year !== hold);
  const test = pool.filter((g) => g.year === hold);
  const trainBase = summarize(selectDaily(selectEligible(train)));
  let bestW = 0.45;
  let bestD = -Infinity;
  for (const w of WS) {
    const d =
      summarize(selectDaily(selectEligible(shrinkPool(train, w)))).usd50 - trainBase.usd50;
    if (d > bestD) {
      bestD = d;
      bestW = w;
    }
  }
  const tb = summarize(selectDaily(selectEligible(test)));
  const ts = summarize(selectDaily(selectEligible(shrinkPool(test, bestW))));
  loy.push({
    holdYear: hold,
    chosenW: bestW,
    dUsd: Number((ts.usd50 - tb.usd50).toFixed(2)),
    dHrPp:
      ts.hitRate != null && tb.hitRate != null
        ? Number(((ts.hitRate - tb.hitRate) * 100).toFixed(2))
        : null,
  });
}

const preferred = fixed.find((f) => f.w === 0.45) || fixed[0];
const stressGates = {
  fixedPositive:
    (preferred?.dUsd ?? -1) >= 50 &&
    (preferred?.dHrPp ?? -1) >= 0 &&
    (preferred?.byYear?.['2024'] ?? -999) >= -80 &&
    (preferred?.byYear?.['2025'] ?? -999) >= -80 &&
    (preferred?.byYear?.['2026'] ?? -999) >= -80,
  expandingNonNeg: wfDelta >= 0 && wfBeat >= wfHurt,
  leaveOneYearAllOk: loy.every((r) => (r.dUsd ?? -1) >= -80),
  leaveOneYearMajorityPos: loy.filter((r) => (r.dUsd ?? 0) > 0).length >= 2,
};
const allPass = Object.values(stressGates).every(Boolean);
const promoteApply = allPass && loy.every((r) => (r.dUsd ?? -1) >= 0);

const out = {
  experimentId: 'normal-away-market-shrink-stress-2026-08-08',
  layer: 'mu',
  baseline,
  fixed,
  preferred,
  expandingWf: { rows: wf, deltaUsd: wfDelta, beat: wfBeat, hurt: wfHurt },
  leaveOneYear: loy,
  stressGates,
  allPass,
  promoteApply,
  verdict: promoteApply
    ? 'PASS_STRESS_MAY_APPLY'
    : allPass
      ? 'PASS_STRESS_KEEP_COMPARE'
      : 'FAIL_STRESS_KEEP_COMPARE',
};

fs.writeFileSync(
  new URL('../tmp-normal-away-market-shrink-stress.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      preferred,
      expandingWf: out.expandingWf,
      leaveOneYear: loy,
      stressGates,
      allPass,
      promoteApply,
      verdict: out.verdict,
    },
    null,
    2
  )
);
