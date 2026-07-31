/**
 * A 補場加嚴候選：Expanding 月度 WF（不接入）
 * 候選固定集合（不做大網格）：
 *  - base: edge2% + B<2
 *  - odds_lt_175
 *  - margin_ge_125
 *  - margin_ge_150
 * Expanding：訓練窗選「嚴格達標優先，否則 Δ$」→ 套下一月
 * 另報：各候選「固定參數」OOS（已有，此處複核＋expanding）
 *
 * 產物：tmp-a-fill-tighten-expanding-wf.json
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
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const WINDOWS = [
  { from: '2025-04-01', to: '2025-09-30' },
  { from: '2026-04-01', to: '2026-07-22' },
];

const CANDIDATES = [
  { id: 'base_edge02_bLt2', pred: null },
  { id: 'odds_lt_175', pred: (g) => g.pickOdds < 1.75 },
  { id: 'margin_ge_125', pred: (g) => g.margin >= 1.25 },
  { id: 'margin_ge_150', pred: (g) => g.margin >= 1.5 },
  { id: 'odds_165_175', pred: (g) => g.pickOdds >= 1.65 && g.pickOdds < 1.75 },
  { id: 'only_b0', pred: (_g, bn) => bn === 0 },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
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
function summarize(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, avgOdds: null, usd50: 0 };
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
    usd50: Math.round(unit * 50),
  };
}
function build(from, to) {
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
    const homeId = pitchers.homeIdentity?.id ?? pitchers.home?.id ?? null;
    const awayId = pitchers.awayIdentity?.id ?? pitchers.away?.id ?? null;
    if (homeId == null || awayId == null) continue;
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2 || pickEarly > oppEarly) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    pool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      bScore,
      edgeVsBe: modelProb - 1 / pickOdds,
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
function selectB(pool) {
  const map = new Map();
  for (const g of pool) {
    if (
      g.ev < B.minimumExpectedValue ||
      g.margin < B.minimumExpectedRunMargin ||
      g.modelProb < B.minimumModelProbability ||
      g.pickOdds < B.minimumPickOdds ||
      g.pickOdds > B.maximumPickOdds
    ) {
      continue;
    }
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
function selectA(pool, bPicks, pred) {
  const bIds = new Set(bPicks.map((g) => g.gameId));
  const bByDay = new Map();
  for (const g of bPicks) bByDay.set(g.day, (bByDay.get(g.day) || 0) + 1);
  const map = new Map();
  for (const g of pool) {
    if (bIds.has(g.gameId)) continue;
    if (g.modelProb < 0.55 || g.margin < 1) continue;
    if (!(g.pickOdds < 1.85 && g.edgeVsBe >= 0.02)) continue;
    const bn = bByDay.get(g.day) || 0;
    if (bn >= 2) continue;
    if (pred && !pred(g, bn)) continue;
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const top = [...map.get(day)].sort(
      (a, b) => b.edgeVsBe - a.edgeVsBe || b.margin - a.margin
    )[0];
    if (top) out.push(top);
  }
  return out;
}
function run(pool, cand) {
  const b = selectB(pool);
  const a = selectA(pool, b, cand.pred);
  return { b, a, merged: [...b, ...a] };
}
function scoreVsB(pool, cand) {
  const { b, merged } = run(pool, cand);
  const sb = summarize(b);
  const sm = summarize(merged);
  return {
    deltaUsd50: sm.usd50 - sb.usd50,
    deltaHitRate:
      sb.hitRate != null && sm.hitRate != null
        ? Number((sm.hitRate - sb.hitRate).toFixed(4))
        : null,
    deltaBets: sm.bets - sb.bets,
    ok:
      sm.bets > sb.bets &&
      sm.usd50 >= sb.usd50 &&
      (sm.hitRate ?? 0) >= (sb.hitRate ?? 1),
    b: sb,
    merged: sm,
  };
}

console.log('Building…');
const combined = WINDOWS.flatMap((w) => build(w.from, w.to));
const months = [...new Set(combined.map((g) => g.month))].sort();
console.log(`universe=${combined.length} months=${months.join(',')}`);

/** 固定參數 OOS（跳過首月） */
function fixedOos(cand) {
  const folds = [];
  for (let i = 1; i < months.length; i++) {
    const testMonth = months[i];
    const s = scoreVsB(
      combined.filter((g) => g.month === testMonth),
      cand
    );
    folds.push({ testMonth, ...s, aN: s.deltaBets });
  }
  const bAll = folds.flatMap((f) =>
    selectB(combined.filter((g) => g.month === f.testMonth))
  );
  const mAll = folds.flatMap((f) => {
    const pool = combined.filter((g) => g.month === f.testMonth);
    return run(pool, cand).merged;
  });
  const sb = summarize(bAll);
  const sm = summarize(mAll);
  const y = (yy) => {
    const bb = summarize(bAll.filter((g) => g.month.startsWith(yy)));
    const mm = summarize(mAll.filter((g) => g.month.startsWith(yy)));
    return { b: bb, merged: mm, deltaUsd50: mm.usd50 - bb.usd50 };
  };
  const beat = folds.filter((f) => f.deltaUsd50 > 0).length;
  const hurt = folds.filter((f) => f.deltaUsd50 < 0).length;
  const y25 = y('2025');
  const y26 = y('2026');
  return {
    folds,
    oosB: sb,
    oosMerged: sm,
    deltaUsd50: sm.usd50 - sb.usd50,
    deltaHitRate: Number((sm.hitRate - sb.hitRate).toFixed(4)),
    deltaBets: sm.bets - sb.bets,
    monthsBeat: beat,
    monthsHurt: hurt,
    y2025: y25,
    y2026: y26,
    passStrict:
      sm.bets > sb.bets &&
      sm.usd50 >= sb.usd50 &&
      (sm.hitRate ?? 0) >= (sb.hitRate ?? 1) &&
      y25.deltaUsd50 >= 0 &&
      y26.deltaUsd50 >= 0 &&
      beat >= hurt,
  };
}

const fixed = CANDIDATES.map((c) => {
  const oos = fixedOos(c);
  console.log(
    `fixed ${c.id.padEnd(18)} Δn=${String(oos.deltaBets).padStart(3)} Δhr=${oos.deltaHitRate} Δ$=${oos.deltaUsd50} ${oos.monthsBeat}/${oos.monthsHurt} strict=${oos.passStrict}`
  );
  return { id: c.id, ...oos };
});

/** Expanding：從候選池選（含「純 B」選項：若訓練窗無任何候選 ok，則選 pure_b） */
const PURE_B = { id: 'pure_b', pred: () => false }; // never adds A
const EXPAND_POOL = [...CANDIDATES, PURE_B];

const expandingFolds = [];
for (let i = 1; i < months.length; i++) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];
  const trainPool = combined.filter((g) => trainMonths.has(g.month));
  const testPool = combined.filter((g) => g.month === testMonth);

  let best = null;
  for (const c of EXPAND_POOL) {
    const s = scoreVsB(trainPool, c);
    // pure_b: delta=0, ok=false for bets>；視為「可選安全檔」：deltaUsd50=0, ok=true 特例
    const cand =
      c.id === 'pure_b'
        ? {
            id: c.id,
            cand: c,
            deltaUsd50: 0,
            deltaHitRate: 0,
            deltaBets: 0,
            ok: true,
            isPure: true,
          }
        : { id: c.id, cand: c, ...s, isPure: false };
    if (
      !best ||
      (cand.ok && !best.ok) ||
      (cand.ok === best.ok && cand.deltaUsd50 > best.deltaUsd50) ||
      (cand.ok === best.ok &&
        cand.deltaUsd50 === best.deltaUsd50 &&
        (cand.deltaHitRate ?? -1) > (best.deltaHitRate ?? -1))
    ) {
      best = cand;
    }
  }

  const chosen = best.cand;
  const oos = scoreVsB(testPool, chosen);
  const aN = run(testPool, chosen).a.length;
  expandingFolds.push({
    testMonth,
    chosen: best.id,
    train: {
      deltaUsd50: best.deltaUsd50,
      deltaHitRate: best.deltaHitRate,
      ok: best.ok,
    },
    oos: { ...oos, aN },
  });
  console.log(
    `WF ${testMonth} → ${best.id.padEnd(18)} OOS Δ$=${oos.deltaUsd50} Δhr=${oos.deltaHitRate} aN=${aN}`
  );
}

const expB = expandingFolds.flatMap((f) =>
  selectB(combined.filter((g) => g.month === f.testMonth))
);
const expM = expandingFolds.flatMap((f) => {
  const pool = combined.filter((g) => g.month === f.testMonth);
  const cand = EXPAND_POOL.find((c) => c.id === f.chosen);
  return run(pool, cand).merged;
});
const expSb = summarize(expB);
const expSm = summarize(expM);
const expanding = {
  folds: expandingFolds,
  oosB: expSb,
  oosMerged: expSm,
  deltaUsd50: expSm.usd50 - expSb.usd50,
  deltaHitRate: Number((expSm.hitRate - expSb.hitRate).toFixed(4)),
  deltaBets: expSm.bets - expSb.bets,
  monthsBeat: expandingFolds.filter((f) => f.oos.deltaUsd50 > 0).length,
  monthsHurt: expandingFolds.filter((f) => f.oos.deltaUsd50 < 0).length,
  monthsFlat: expandingFolds.filter((f) => f.oos.deltaUsd50 === 0).length,
  chosenCounts: Object.fromEntries(
    [...new Set(expandingFolds.map((f) => f.chosen))].map((id) => [
      id,
      expandingFolds.filter((f) => f.chosen === id).length,
    ])
  ),
};

/** 穩健性：固定參數各候選相對 base 的「月勝差」 */
const baseFolds = fixed.find((r) => r.id === 'base_edge02_bLt2')?.folds || [];
const robustness = fixed.map((r) => {
  const vsBaseMonths = r.folds.map((f, i) => ({
    month: f.testMonth,
    deltaVsBaseUsd: f.deltaUsd50 - (baseFolds[i]?.deltaUsd50 ?? 0),
  }));
  return {
    id: r.id,
    passStrict: r.passStrict,
    fixedDeltaUsd50: r.deltaUsd50,
    fixedDeltaHitRate: r.deltaHitRate,
    fixedDeltaBets: r.deltaBets,
    monthsBeatBase: vsBaseMonths.filter((x) => x.deltaVsBaseUsd > 0).length,
    monthsWorseBase: vsBaseMonths.filter((x) => x.deltaVsBaseUsd < 0).length,
    vsBaseMonths,
  };
});

/**
 * 接入門檻（寫死判斷，本輪只報，不寫碼）：
 * 1) 固定參數嚴格過閘
 * 2) Expanding 合計 Δ$≥0 且 Δhr≥0 且 beat≥hurt
 * 3) Expanding 不得系統性選 pure_b（代表訓練窗常覺得加 A 不划算）
 * 4) 相對 base：固定 Δ$ 更高不算夠；需 monthsBeatBase ≥ monthsWorseBase
 */
function wireGate(id) {
  const f = fixed.find((x) => x.id === id);
  const rob = robustness.find((x) => x.id === id);
  if (!f || !rob) return { id, pass: false, reasons: ['missing'] };
  const reasons = [];
  if (!f.passStrict) reasons.push('fixed_not_strict');
  if (expanding.deltaUsd50 < 0 || expanding.deltaHitRate < 0)
    reasons.push('expanding_pool_negative');
  if (expanding.monthsBeat < expanding.monthsHurt) reasons.push('expanding_months_hurt');
  if ((rob.monthsBeatBase ?? 0) < (rob.monthsWorseBase ?? 0))
    reasons.push('worse_than_base_most_months');
  if (f.deltaBets < 8) reasons.push('too_thin_sample');
  // Expanding 若多數選 pure_b → A 不穩
  const pureN = expanding.chosenCounts.pure_b || 0;
  if (pureN >= expandingFolds.length / 2) reasons.push('expanding_often_prefers_pure_b');
  return {
    id,
    pass: reasons.length === 0 && id !== 'base_edge02_bLt2',
    reasons,
    fixed: {
      deltaUsd50: f.deltaUsd50,
      deltaHitRate: f.deltaHitRate,
      deltaBets: f.deltaBets,
    },
    vsBaseMonths: { beat: rob.monthsBeatBase, worse: rob.monthsWorseBase },
  };
}

const gates = CANDIDATES.filter((c) => c.id !== 'base_edge02_bLt2').map((c) =>
  wireGate(c.id)
);
const anyPass = gates.filter((g) => g.pass);

const verdict = {
  wireNow: false,
  reason: anyPass.length
    ? '有候選過本輪自訂閘，但仍建議人工複核後再談接入（非必須）'
    : '無候選同時過固定嚴格＋相對 base 月穩＋樣本厚度；維持純 B',
  passCandidates: anyPass.map((g) => g.id),
  gates,
  expandingSummary: {
    deltaUsd50: expanding.deltaUsd50,
    deltaHitRate: expanding.deltaHitRate,
    deltaBets: expanding.deltaBets,
    beat: expanding.monthsBeat,
    hurt: expanding.monthsHurt,
    flat: expanding.monthsFlat,
    chosenCounts: expanding.chosenCounts,
  },
};

const out = {
  experimentId: 'a-fill-tighten-expanding-wf-2026-07-28',
  generatedAt: new Date().toISOString(),
  policy: 'analysis_only_do_not_wire',
  fixed,
  expanding,
  robustness,
  verdict,
};

fs.writeFileSync(
  new URL('../tmp-a-fill-tighten-expanding-wf.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\n=== Expanding ===');
console.log(verdict.expandingSummary);
console.log('\n=== Gates ===');
for (const g of gates) {
  console.log(
    `${g.id.padEnd(18)} pass=${g.pass} reasons=${g.reasons.join(',') || '-'} fixedΔ$=${g.fixed.deltaUsd50}`
  );
}
console.log('\nverdict:', verdict.reason, 'pass=', verdict.passCandidates);
