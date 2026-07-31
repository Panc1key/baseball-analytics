/**
 * 影子：在 ev02_max230 上單獨／組合放寬
 *   - minimumExpectedRunMargin（分差）
 *   - minimumPickOdds（賠率下限）
 * 不改正式常數。
 *
 * 用法: node scripts/auditMlbMarginMinOddsRelaxShadow.mjs
 * 產物: tmp-margin-minodds-relax-shadow.json
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

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3_T = Number(B.dropThirdIfMarginBelow) || 0.5;
const DROP_R2_MAX = Number(B.dropSecondIfOddsBelow) || 1.95;
const DROP_R2_MIN = Number(B.dropSecondIfOddsMin) || 1.85;

const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-28' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function books(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return [];
  const out = [];
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const home =
      m.outcomes.find((o) => o.name === homeTeam) ||
      m.outcomes.find((o) => String(o.name).includes(String(homeTeam).split(' ').pop()));
    const away =
      m.outcomes.find((o) => o.name === awayTeam) ||
      m.outcomes.find((o) => String(o.name).includes(String(awayTeam).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const ho = Number(home.price);
    const ao = Number(away.price);
    if (!Number.isFinite(ho) || !Number.isFinite(ao)) continue;
    out.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao });
  }
  return out;
}

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hitRate: null, avgOdds: null, roi: null, unitPnl: 0, usd50: 0 };
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
    unitPnl: Number(unit.toFixed(2)),
    usd50: Math.round(unit * 50),
  };
}

/** 寬宇宙：margin≥0.10、minOdds≥1.70、其餘同 B（含硬 early、maxOdds） */
function buildUniverse(from, to) {
  const validation = getLatestMlbExpectedRunsValidation();
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ?
         AND g.completed = 1
         AND g.home_score IS NOT NULL
         AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?)
         AND date(f.commence_time) <= date(?)
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
    const hs = Number(row.homeScore);
    const as = Number(row.awayScore);
    if (hs === as) continue;

    const pred = predictMlbGameRuns(validation.model, features, { totalLine: 8.5 });
    const ph = Number(pred.homeExpectedRuns);
    const pa = Number(pred.awayExpectedRuns);
    if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;
    const pickHome = ph >= pa;
    const modelProb = pickHome
      ? Number(pred.markets?.homeWinProbability)
      : Number(pred.markets?.awayWinProbability);
    if (!Number.isFinite(modelProb)) continue;

    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) continue;

    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (!Number.isFinite(pickOdds) || pickOdds < 1.7 || pickOdds > B.maximumPickOdds) continue;

    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue || modelProb < B.minimumModelProbability) continue;
    if (margin < 0.1) continue;

    const pitchers = features?.pitchers || {};
    const homeId = pitchers.homeIdentity?.id ?? pitchers.home?.id ?? null;
    const awayId = pitchers.awayIdentity?.id ?? pitchers.away?.id ?? null;
    if (homeId == null || awayId == null) continue;

    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? Number(sig.homeEarlyExitsLast3) || 0
      : Number(sig.awayEarlyExitsLast3) || 0;
    const oppEarly = pickHome
      ? Number(sig.awayEarlyExitsLast3) || 0
      : Number(sig.homeEarlyExitsLast3) || 0;
    if (pickEarly > oppEarly) continue;

    const baseScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );

    pool.push({
      day: hk(row.commenceTime),
      window: from.startsWith('2025') ? '2025' : '2026',
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      baseScore,
    });
  }
  return pool;
}

function applyHardSlots(sorted) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3_T) slots = slots.slice(0, 2);
  if (
    slots.length >= 2 &&
    slots[1].pickOdds >= DROP_R2_MIN &&
    slots[1].pickOdds < DROP_R2_MAX
  ) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}

function select(pool, { minMargin, minOdds }) {
  const byDay = new Map();
  for (const g of pool) {
    if (g.margin < minMargin) continue;
    if (g.pickOdds < minOdds) continue;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({ ...g, score: g.baseScore });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = byDay.get(day).sort((a, b) => b.score - a.score || b.margin - a.margin);
    out.push(...applyHardSlots(arr));
  }
  return out;
}

function delta(sum, base) {
  return {
    bets: sum.bets - base.bets,
    hitRatePp: Number((((sum.hitRate ?? 0) - (base.hitRate ?? 0)) * 100).toFixed(2)),
    usd50: sum.usd50 - base.usd50,
    keepPct: base.bets ? Number(((sum.bets / base.bets) * 100).toFixed(1)) : null,
  };
}

const MARGIN_GRID = [0.25, 0.22, 0.2, 0.18, 0.15, 0.12, 0.1];
const MIN_ODDS_GRID = [1.85, 1.8, 1.75, 1.7];

const VARIANTS = [];
for (const minMargin of MARGIN_GRID) {
  VARIANTS.push({
    id: `margin_${String(minMargin).replace('.', '')}_odds185`,
    label: `分差≥${minMargin}（minOdds 維持 1.85）`,
    minMargin,
    minOdds: 1.85,
  });
}
for (const minOdds of MIN_ODDS_GRID) {
  if (minOdds === 1.85) continue;
  VARIANTS.push({
    id: `margin25_odds_${String(minOdds).replace('.', '')}`,
    label: `minOdds≥${minOdds}（分差維持 0.25）`,
    minMargin: 0.25,
    minOdds,
  });
}
// 小組合：只開一點
for (const [minMargin, minOdds] of [
  [0.2, 1.8],
  [0.2, 1.75],
  [0.15, 1.8],
  [0.15, 1.75],
]) {
  VARIANTS.push({
    id: `m${String(minMargin).replace('.', '')}_o${String(minOdds).replace('.', '')}`,
    label: `分差≥${minMargin} + minOdds≥${minOdds}`,
    minMargin,
    minOdds,
  });
}

console.log('[margin-minodds] building…');
const pools = {};
for (const w of WINDOWS) {
  pools[w.key] = buildUniverse(w.from, w.to);
  console.log(`  ${w.key}: ${pools[w.key].length}`);
}
const combined = [...pools['2025'], ...pools['2026']];

const baseline = {
  id: 'baseline_m25_o185',
  label: '基線 分差≥0.25 + minOdds≥1.85',
  minMargin: 0.25,
  minOdds: 1.85,
};
const baselineByWindow = {
  2025: summarize(select(pools['2025'], baseline)),
  2026: summarize(select(pools['2026'], baseline)),
};
const baselineMerged = summarize(select(combined, baseline));

const results = [
  {
    ...baseline,
    byWindow: baselineByWindow,
    merged: baselineMerged,
    deltaMerged: { bets: 0, hitRatePp: 0, usd50: 0, keepPct: 100 },
    gate: { pass: true, dualWindowUsdGeBaseline: true, mergedUsdGeBaseline: true },
  },
];

for (const v of VARIANTS) {
  if (v.minMargin === 0.25 && v.minOdds === 1.85) continue;
  const byWindow = {
    2025: summarize(select(pools['2025'], v)),
    2026: summarize(select(pools['2026'], v)),
  };
  const merged = summarize(select(combined, v));
  const dual =
    byWindow['2025'].usd50 >= baselineByWindow['2025'].usd50 &&
    byWindow['2026'].usd50 >= baselineByWindow['2026'].usd50;
  const mergedOk = merged.usd50 >= baselineMerged.usd50;
  results.push({
    ...v,
    byWindow,
    merged,
    deltaMerged: delta(merged, baselineMerged),
    gate: {
      pass: dual && mergedOk,
      dualWindowUsdGeBaseline: dual,
      mergedUsdGeBaseline: mergedOk,
    },
  });
  console.log(
    `  ${v.id}: n=${merged.bets} hr=${merged.hitRate} $=${merged.usd50} Δn=${merged.bets - baselineMerged.bets} Δ$=${merged.usd50 - baselineMerged.usd50} pass=${dual && mergedOk}`
  );
}

const passing = results
  .filter((r) => r.id !== baseline.id && r.gate.pass)
  .sort(
    (a, b) =>
      b.deltaMerged.usd50 - a.deltaMerged.usd50 || b.deltaMerged.bets - a.deltaMerged.bets
  );
const failingButMoreVolume = results
  .filter((r) => r.id !== baseline.id && r.deltaMerged.bets > 0 && !r.gate.pass)
  .sort((a, b) => b.deltaMerged.bets - a.deltaMerged.bets);

const marginOnly = results.filter((r) => r.minOdds === 1.85 && r.id !== baseline.id);
const oddsOnly = results.filter((r) => r.minMargin === 0.25 && r.id !== baseline.id);

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'shadow_only',
  baselineProfile: 'ev02_max230',
  windows: WINDOWS,
  baseline: results[0],
  variants: results,
  passingSortedByUsd: passing.map((r) => ({
    id: r.id,
    label: r.label,
    delta: r.deltaMerged,
    merged: r.merged,
  })),
  summary: {
    marginAxis: marginOnly.map((r) => ({
      id: r.id,
      pass: r.gate.pass,
      delta: r.deltaMerged,
      y25: r.byWindow['2025'].usd50,
      y26: r.byWindow['2026'].usd50,
    })),
    minOddsAxis: oddsOnly.map((r) => ({
      id: r.id,
      pass: r.gate.pass,
      delta: r.deltaMerged,
      y25: r.byWindow['2025'].usd50,
      y26: r.byWindow['2026'].usd50,
    })),
  },
  verdict: {
    status: passing.length ? 'some_pass_dual_window' : 'all_relaxations_fail_or_no_lift',
    marginRelax: marginOnly.some((r) => r.gate.pass)
      ? 'has_passing_margin_soften'
      : 'margin_soften_negative_or_unstable',
    minOddsRelax: oddsOnly.some((r) => r.gate.pass)
      ? 'has_passing_minodds_soften'
      : 'minodds_soften_negative_or_unstable',
    top: passing.slice(0, 5).map((r) => r.id),
    note:
      '雙窗 $≥基線才算過閘。加場但單窗掉 = 負優化／不穩。歷史台帳亦否決猛放 margin、低 minOdds 毒區。',
  },
};

fs.writeFileSync(
  new URL('../tmp-margin-minodds-relax-shadow.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);
console.log('[margin-minodds] verdict', payload.verdict.status);
console.log(
  '[margin-minodds] margin axis passes:',
  marginOnly.filter((r) => r.gate.pass).map((r) => r.id)
);
console.log(
  '[margin-minodds] minOdds axis passes:',
  oddsOnly.filter((r) => r.gate.pass).map((r) => r.id)
);
console.log('[margin-minodds] top passing', payload.verdict.top);
