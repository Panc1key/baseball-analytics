/**
 * 攻擊冷 × 高 K9：硬過濾 vs 日內排序軟罰分（月切片對照）
 * 底座：ev02_max230 + ≥2庄；不改正式常數
 * 產物：tmp-offense-k9-soft-vs-hard.json
 *
 * 用法: node scripts/auditMlbOffenseK9SoftVsHard.mjs
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

const R = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];
const MONTHS = [
  '2025-05',
  '2025-06',
  '2025-07',
  '2025-08',
  '2025-09',
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}
function books(g, c, h, a) {
  const pit = resolvePitOdds(g, c);
  if (!pit?.bookmakers?.length) return [];
  const out = [];
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const home =
      m.outcomes.find((o) => o.name === h) ||
      m.outcomes.find((o) => String(o.name).includes(String(h).split(' ').pop()));
    const away =
      m.outcomes.find((o) => o.name === a) ||
      m.outcomes.find((o) => String(o.name).includes(String(a).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const ho = +home.price;
    const ao = +away.price;
    if (!Number.isFinite(ho) || !Number.isFinite(ao)) continue;
    out.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao });
  }
  return out;
}
function pickSigned(diff, pickHome) {
  if (diff == null) return null;
  return pickHome ? diff : -diff;
}

function isToxicCross(g, runsTh = 0, k9Th = 0.3) {
  return g.advRecentRuns < runsTh && g.advPitcherK9 > k9Th;
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
  const nB = bets.length;
  return {
    bets: nB,
    hitRate: Number((hits / nB).toFixed(4)),
    avgOdds: Number((odds / nB).toFixed(3)),
    roi: Number((unit / nB).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}

function buildUniverse(from, to) {
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
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
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
    const homeId = pitchers.homeIdentity?.id ?? pitchers.home?.id ?? null;
    const awayId = pitchers.awayIdentity?.id ?? pitchers.away?.id ?? null;
    if (homeId == null || awayId == null) continue;
    if (
      ev < R.minimumExpectedValue ||
      margin < R.minimumExpectedRunMargin ||
      modelProb < R.minimumModelProbability ||
      pickOdds < R.minimumPickOdds ||
      pickOdds > R.maximumPickOdds ||
      best.homeOdds < R.minimumEitherSideOdds ||
      best.awayOdds < R.minimumEitherSideOdds ||
      (R.requirePickEarlyExitsNotHigher && pickEarly > oppEarly)
    ) {
      continue;
    }
    const v = features.vector || {};
    const advRecentRuns = pickSigned(n(v.recentRunsDiff), pickHome);
    const advPitcherK9 = pickSigned(n(v.pitcherK9Diff), pickHome);
    if (advRecentRuns == null || advPitcherK9 == null) continue;
    const baseScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      R
    );
    pool.push({
      day: hk(row.commenceTime),
      month: String(row.commenceTime).slice(0, 7),
      window: from.startsWith('2025') ? '2025' : '2026',
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      advRecentRuns,
      advPitcherK9,
      toxic: isToxicCross({ advRecentRuns, advPitcherK9 }),
      baseScore,
    });
  }
  return pool;
}

function select(pool, mode) {
  const byDay = new Map();
  for (const g of pool) {
    if (mode.type === 'hard' && g.toxic) continue;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    const score =
      mode.type === 'soft' && g.toxic ? g.baseScore - mode.lambda : g.baseScore;
    byDay.get(g.day).push({ ...g, score });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    out.push(
      ...[...byDay.get(day)]
        .sort((a, b) => b.score - a.score || b.margin - a.margin)
        .slice(0, R.dailyTopK)
    );
  }
  return out;
}

function byMonth(bets) {
  return MONTHS.map((m) => {
    const xs = bets.filter((b) => b.month === m);
    const s = summarize(xs);
    return { month: m, ...s };
  });
}

function evalPolicy(pool, mode) {
  const picks = select(pool, mode);
  const combined = summarize(picks);
  const y25 = summarize(picks.filter((b) => b.window === '2025'));
  const y26 = summarize(picks.filter((b) => b.window === '2026'));
  const months = byMonth(picks);
  const toxicKept = picks.filter((b) => b.toxic).length;
  return { combined, y2025: y25, y2026: y26, months, toxicKept, picks };
}

console.log('Building…');
const pools = WINDOWS.map((w) => ({ ...w, pool: buildUniverse(w.from, w.to) }));
const combinedPool = pools.flatMap((p) => p.pool);
console.log(`universe ${combinedPool.length}, toxic ${combinedPool.filter((g) => g.toxic).length}`);

const MODES = [
  { id: 'baseline', label: '現行（無處理）', type: 'baseline' },
  { id: 'hard_block', label: '硬擋交叉', type: 'hard' },
  { id: 'soft_l005', label: '軟罰分 λ=0.05', type: 'soft', lambda: 0.05 },
  { id: 'soft_l010', label: '軟罰分 λ=0.10', type: 'soft', lambda: 0.1 },
  { id: 'soft_l015', label: '軟罰分 λ=0.15（同 P2 量級）', type: 'soft', lambda: 0.15 },
  { id: 'soft_l020', label: '軟罰分 λ=0.20', type: 'soft', lambda: 0.2 },
  { id: 'soft_l030', label: '軟罰分 λ=0.30', type: 'soft', lambda: 0.3 },
  { id: 'soft_l050', label: '軟罰分 λ=0.50', type: 'soft', lambda: 0.5 },
  { id: 'soft_l100', label: '軟罰分 λ=1.00', type: 'soft', lambda: 1.0 },
  { id: 'soft_sink', label: '軟沉底 λ=10（幾乎等同當日最後）', type: 'soft', lambda: 10 },
];

const results = [];
for (const mode of MODES) {
  const ev = evalPolicy(combinedPool, mode);
  results.push({
    id: mode.id,
    label: mode.label,
    ...mode,
    combined: ev.combined,
    y2025: ev.y2025,
    y2026: ev.y2026,
    months: ev.months,
    toxicKeptInPicks: ev.toxicKept,
  });
  console.log(
    `${mode.id.padEnd(12)} n=${ev.combined.bets} hr=${ev.combined.hitRate} $50=${ev.combined.usd50} toxicKept=${ev.toxicKept}`
  );
}

const base = results.find((r) => r.id === 'baseline');
const hard = results.find((r) => r.id === 'hard_block');

function deltas(r) {
  const bc = base.combined;
  const c = r.combined;
  return {
    deltaUsd50: c.usd50 - bc.usd50,
    deltaBets: c.bets - bc.bets,
    deltaHitRate: Number((c.hitRate - bc.hitRate).toFixed(4)),
    deltaUsd2025: r.y2025.usd50 - base.y2025.usd50,
    deltaUsd2026: r.y2026.usd50 - base.y2026.usd50,
    june: (() => {
      const bm = base.months.find((m) => m.month === '2025-06');
      const rm = r.months.find((m) => m.month === '2025-06');
      return {
        baseUsd50: bm.usd50,
        usd50: rm.usd50,
        deltaUsd50: rm.usd50 - bm.usd50,
        baseHr: bm.hitRate,
        hr: rm.hitRate,
        baseN: bm.bets,
        n: rm.bets,
      };
    })(),
    otherMonthsAbsAvgDeltaUsd: (() => {
      let s = 0;
      let n = 0;
      for (const m of MONTHS) {
        if (m === '2025-06') continue;
        const bm = base.months.find((x) => x.month === m);
        const rm = r.months.find((x) => x.month === m);
        s += Math.abs(rm.usd50 - bm.usd50);
        n += 1;
      }
      return Math.round(s / n);
    })(),
    monthDeltas: MONTHS.map((m) => {
      const bm = base.months.find((x) => x.month === m);
      const rm = r.months.find((x) => x.month === m);
      return {
        month: m,
        dN: rm.bets - bm.bets,
        dHrPp:
          bm.hitRate != null && rm.hitRate != null
            ? Number(((rm.hitRate - bm.hitRate) * 100).toFixed(2))
            : null,
        dUsd50: rm.usd50 - bm.usd50,
        baseUsd50: bm.usd50,
        usd50: rm.usd50,
        baseHr: bm.hitRate,
        hr: rm.hitRate,
      };
    }),
  };
}

const compared = results
  .filter((r) => r.id !== 'baseline')
  .map((r) => {
    const d = deltas(r);
    const dualPositive = r.y2025.usd50 > 0 && r.y2026.usd50 > 0;
    const beats = r.combined.usd50 > base.combined.usd50;
    const notWorseBoth =
      r.y2025.usd50 >= base.y2025.usd50 && r.y2026.usd50 >= base.y2026.usd50;
    const hitUp = r.combined.hitRate >= base.combined.hitRate;
    return {
      id: r.id,
      label: r.label,
      combined: r.combined,
      y2025: r.y2025,
      y2026: r.y2026,
      toxicKeptInPicks: r.toxicKeptInPicks,
      ...d,
      passGate: beats && dualPositive,
      passStrictGate: beats && dualPositive && notWorseBoth,
      positiveLift: beats && dualPositive && hitUp,
      lessCollateralThanHard:
        d.otherMonthsAbsAvgDeltaUsd < deltas(hard).otherMonthsAbsAvgDeltaUsd,
    };
  });

compared.sort((a, b) => b.deltaUsd50 - a.deltaUsd50);

const bestSoft = compared
  .filter((c) => c.id.startsWith('soft_'))
  .sort((a, b) => {
    // prefer strict, then positive lift, then higher combined $, then less collateral
    const as = (a.passStrictGate ? 1000 : 0) + (a.positiveLift ? 100 : 0) + a.deltaUsd50;
    const bs = (b.passStrictGate ? 1000 : 0) + (b.positiveLift ? 100 : 0) + b.deltaUsd50;
    if (bs !== as) return bs - as;
    return a.otherMonthsAbsAvgDeltaUsd - b.otherMonthsAbsAvgDeltaUsd;
  })[0];

const out = {
  experimentId: 'offense-k9-soft-vs-hard-2026-07-28',
  generatedAt: new Date().toISOString(),
  note: '不改正式規則；交叉定義：advRecentRuns<0 且 advPitcherK9>0.3',
  baseline: {
    combined: base.combined,
    y2025: base.y2025,
    y2026: base.y2026,
    months: base.months,
  },
  hard: compared.find((c) => c.id === 'hard_block'),
  softRanked: compared.filter((c) => c.id.startsWith('soft_')),
  allCompared: compared,
  recommendation: bestSoft?.passStrictGate
    ? {
        action: 'soft_penalty_candidate',
        id: bestSoft.id,
        label: bestSoft.label,
        deltaUsd50: bestSoft.deltaUsd50,
        deltaHitRate: bestSoft.deltaHitRate,
        juneDeltaUsd50: bestSoft.june.deltaUsd50,
        otherMonthsAbsAvgDeltaUsd: bestSoft.otherMonthsAbsAvgDeltaUsd,
        note: '軟罰分過嚴格閘；仍建議人工拍板後再進正式',
      }
    : bestSoft?.positiveLift || bestSoft?.passGate
      ? {
          action: 'soft_better_than_hard_but_not_strict',
          id: bestSoft.id,
          label: bestSoft.label,
          deltaUsd50: bestSoft.deltaUsd50,
          deltaHitRate: bestSoft.deltaHitRate,
          juneDeltaUsd50: bestSoft.june.deltaUsd50,
          otherMonthsAbsAvgDeltaUsd: bestSoft.otherMonthsAbsAvgDeltaUsd,
          vsHardCollateral: {
            soft: bestSoft.otherMonthsAbsAvgDeltaUsd,
            hard: deltas(hard).otherMonthsAbsAvgDeltaUsd,
          },
          note: '軟罰分副作用小於硬擋或合併略好，但未過嚴格雙窗；維持不改正式',
        }
      : {
          action: 'keep_baseline_no_change',
          note: '軟／硬皆未形成可升正式的正向方案',
        },
};

fs.writeFileSync(
  new URL('../tmp-offense-k9-soft-vs-hard.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\n=== June & collateral ===');
for (const c of [compared.find((x) => x.id === 'hard_block'), ...compared.filter((x) => x.id.startsWith('soft_'))]) {
  if (!c) continue;
  console.log(
    `${c.id}: d$=${c.deltaUsd50} dhr=${c.deltaHitRate} june d$=${c.june.deltaUsd50} otherAbsAvg$=${c.otherMonthsAbsAvgDeltaUsd} strict=${c.passStrictGate}`
  );
}
console.log('\nrecommendation:', out.recommendation);
