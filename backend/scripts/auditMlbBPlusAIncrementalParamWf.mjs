/**
 * B+A 增量參數 WF（不接入正式）
 * 網格：edgeBuffer ×（當日 B 場數 < n 才補）× dailyTopK
 * 協議：
 *  1) 固定參數：各格按月 OOS 合計 vs 純 B
 *  2) Expanding：先前月選最佳格，套下一月
 * 閘：OOS 合併 $≥B、勝率≥B、加場>0；嚴格再看雙窗年份
 *
 * 產物：tmp-b-plus-a-incremental-param-wf.json
 * 用法: node scripts/auditMlbBPlusAIncrementalParamWf.mjs
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
const DROP_R3 = Number(B.dropThirdIfMarginBelow) || 0.5;
const DROP_R2_MAX = Number(B.dropSecondIfOddsBelow) || 1.95;
const DROP_R2_MIN = Number(B.dropSecondIfOddsMin) || 1.85;

const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

const EDGE_GRID = [0.015, 0.02, 0.025, 0.03, 0.04];
const B_LT_GRID = [1, 2, 3]; // 當日 B 場數 < n 才補
const TOPK_GRID = [1];

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
      window: from.startsWith('2025') ? '2025' : '2026',
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

function selectA(pool, bPicks, { edgeBuffer, bLt, dailyTopK }) {
  const bIds = new Set(bPicks.map((g) => g.gameId));
  const bByDay = new Map();
  for (const g of bPicks) bByDay.set(g.day, (bByDay.get(g.day) || 0) + 1);
  const map = new Map();
  for (const g of pool) {
    if (bIds.has(g.gameId)) continue;
    if (g.modelProb < 0.55 || g.margin < 1) continue;
    if (!(g.pickOdds < 1.85 && g.edgeVsBe >= edgeBuffer)) continue;
    if ((bByDay.get(g.day) || 0) >= bLt) continue;
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    out.push(
      ...[...map.get(day)]
        .sort((a, b) => b.edgeVsBe - a.edgeVsBe || b.margin - a.margin)
        .slice(0, dailyTopK)
    );
  }
  return out;
}

function runParams(pool, params) {
  const b = selectB(pool);
  const a = selectA(pool, b, params);
  return { b, a, merged: [...b, ...a] };
}

function paramId({ edgeBuffer, bLt, dailyTopK }) {
  return `edge${String(edgeBuffer).replace('0.', '')}_bLt${bLt}_k${dailyTopK}`;
}

const GRID = [];
for (const edgeBuffer of EDGE_GRID) {
  for (const bLt of B_LT_GRID) {
    for (const dailyTopK of TOPK_GRID) {
      GRID.push({ edgeBuffer, bLt, dailyTopK });
    }
  }
}

console.log('Building…');
const pools = WINDOWS.map((w) => ({ ...w, pool: build(w.from, w.to) }));
const combined = pools.flatMap((p) => p.pool);
const months = [...new Set(combined.map((g) => g.month))].sort();
console.log(`universe=${combined.length} months=${months.join(',')}`);

/** 全窗 in-sample（僅對照，不作晉升依據） */
const inSample = [];
for (const p of GRID) {
  const byW = {};
  const allM = [];
  const allB = [];
  for (const w of pools) {
    const { b, merged } = runParams(w.pool, p);
    byW[w.key] = { b: summarize(b), merged: summarize(merged) };
    allM.push(...merged);
    allB.push(...b);
  }
  const bC = summarize(allB);
  const mC = summarize(allM);
  inSample.push({
    id: paramId(p),
    params: p,
    combined: {
      b: bC,
      merged: mC,
      deltaUsd50: mC.usd50 - bC.usd50,
      deltaHitRate: Number((mC.hitRate - bC.hitRate).toFixed(4)),
      deltaBets: mC.bets - bC.bets,
    },
    windows: byW,
  });
}

/** 固定參數：按月 OOS（跳過第一月作暖機顯示，合計從第二月起） */
function fixedParamOos(params) {
  const folds = [];
  for (let i = 1; i < months.length; i++) {
    const testMonth = months[i];
    const testPool = combined.filter((g) => g.month === testMonth);
    const { b, a, merged } = runParams(testPool, params);
    const sb = summarize(b);
    const sm = summarize(merged);
    folds.push({
      testMonth,
      aN: a.length,
      b: sb,
      merged: sm,
      deltaUsd50: sm.usd50 - sb.usd50,
      deltaHitRate:
        sb.hitRate != null && sm.hitRate != null
          ? Number((sm.hitRate - sb.hitRate).toFixed(4))
          : null,
    });
  }
  const bAll = folds.flatMap((f) =>
    runParams(
      combined.filter((g) => g.month === f.testMonth),
      params
    ).b
  );
  const mAll = folds.flatMap((f) =>
    runParams(
      combined.filter((g) => g.month === f.testMonth),
      params
    ).merged
  );
  const sb = summarize(bAll);
  const sm = summarize(mAll);
  const monthsBeat = folds.filter((f) => f.deltaUsd50 > 0).length;
  const monthsHurt = folds.filter((f) => f.deltaUsd50 < 0).length;
  // 年份窗：用 OOS 月歸屬
  const y25m = mAll.filter((g) => g.month.startsWith('2025'));
  const y26m = mAll.filter((g) => g.month.startsWith('2026'));
  const y25b = bAll.filter((g) => g.month.startsWith('2025'));
  const y26b = bAll.filter((g) => g.month.startsWith('2026'));
  const s25m = summarize(y25m);
  const s26m = summarize(y26m);
  const s25b = summarize(y25b);
  const s26b = summarize(y26b);
  return {
    folds,
    oosB: sb,
    oosMerged: sm,
    deltaUsd50: sm.usd50 - sb.usd50,
    deltaHitRate: Number((sm.hitRate - sb.hitRate).toFixed(4)),
    deltaBets: sm.bets - sb.bets,
    monthsBeat,
    monthsHurt,
    foldCount: folds.length,
    y2025: { b: s25b, merged: s25m, deltaUsd50: s25m.usd50 - s25b.usd50 },
    y2026: { b: s26b, merged: s26m, deltaUsd50: s26m.usd50 - s26b.usd50 },
    passOos:
      sm.bets > sb.bets &&
      sm.usd50 >= sb.usd50 &&
      (sm.hitRate ?? 0) >= (sb.hitRate ?? 1) &&
      monthsBeat >= monthsHurt,
    passStrictYear:
      sm.bets > sb.bets &&
      sm.usd50 >= sb.usd50 &&
      (sm.hitRate ?? 0) >= (sb.hitRate ?? 1) &&
      s25m.usd50 >= s25b.usd50 &&
      s26m.usd50 >= s26b.usd50 &&
      monthsBeat >= monthsHurt,
  };
}

const fixedResults = GRID.map((p) => {
  const oos = fixedParamOos(p);
  console.log(
    `${paramId(p).padEnd(22)} OOS Δn=${String(oos.deltaBets).padStart(3)} Δhr=${oos.deltaHitRate} Δ$=${oos.deltaUsd50} beat/hurt=${oos.monthsBeat}/${oos.monthsHurt} strictY=${oos.passStrictYear}`
  );
  return { id: paramId(p), params: p, ...oos };
});

/** Expanding：訓練窗選「嚴格達標優先，否則 Δ$ 最大且 Δhr≥0」的參數 */
function scoreTrain(trainPool, params) {
  const { b, merged } = runParams(trainPool, params);
  const sb = summarize(b);
  const sm = summarize(merged);
  return {
    deltaUsd50: sm.usd50 - sb.usd50,
    deltaHitRate: Number((sm.hitRate - sb.hitRate).toFixed(4)),
    deltaBets: sm.bets - sb.bets,
    ok:
      sm.bets > sb.bets &&
      sm.usd50 >= sb.usd50 &&
      (sm.hitRate ?? 0) >= (sb.hitRate ?? 1),
  };
}

const expandingFolds = [];
for (let i = 1; i < months.length; i++) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];
  const trainPool = combined.filter((g) => trainMonths.has(g.month));
  const testPool = combined.filter((g) => g.month === testMonth);
  let best = null;
  for (const p of GRID) {
    const s = scoreTrain(trainPool, p);
    const cand = { params: p, ...s };
    if (
      !best ||
      (cand.ok && !best.ok) ||
      (cand.ok === best.ok && cand.deltaUsd50 > best.deltaUsd50) ||
      (cand.ok === best.ok &&
        cand.deltaUsd50 === best.deltaUsd50 &&
        cand.deltaHitRate > best.deltaHitRate)
    ) {
      best = cand;
    }
  }
  const chosen = best.params;
  const baseB = selectB(testPool);
  const withA = runParams(testPool, chosen);
  const sb = summarize(baseB);
  const sm = summarize(withA.merged);
  expandingFolds.push({
    testMonth,
    chosen: paramId(chosen),
    chosenParams: chosen,
    train: {
      deltaUsd50: best.deltaUsd50,
      deltaHitRate: best.deltaHitRate,
      ok: best.ok,
    },
    oos: {
      b: sb,
      merged: sm,
      deltaUsd50: sm.usd50 - sb.usd50,
      deltaHitRate:
        sb.hitRate != null && sm.hitRate != null
          ? Number((sm.hitRate - sb.hitRate).toFixed(4))
          : null,
      aN: withA.a.length,
    },
  });
  console.log(
    `WF ${testMonth} chosen=${paramId(chosen)} OOS Δ$=${sm.usd50 - sb.usd50} Δhr=${
      sb.hitRate != null && sm.hitRate != null
        ? (sm.hitRate - sb.hitRate).toFixed(4)
        : null
    }`
  );
}

const expB = expandingFolds.flatMap((f) =>
  selectB(combined.filter((g) => g.month === f.testMonth))
);
const expM = expandingFolds.flatMap((f) => {
  const pool = combined.filter((g) => g.month === f.testMonth);
  return runParams(pool, f.chosenParams).merged;
});
const expSb = summarize(expB);
const expSm = summarize(expM);
const expandingSummary = {
  folds: expandingFolds,
  oosB: expSb,
  oosMerged: expSm,
  deltaUsd50: expSm.usd50 - expSb.usd50,
  deltaHitRate: Number((expSm.hitRate - expSb.hitRate).toFixed(4)),
  deltaBets: expSm.bets - expSb.bets,
  monthsBeat: expandingFolds.filter((f) => f.oos.deltaUsd50 > 0).length,
  monthsHurt: expandingFolds.filter((f) => f.oos.deltaUsd50 < 0).length,
};

fixedResults.sort((a, b) => b.deltaUsd50 - a.deltaUsd50);
const passStrict = fixedResults.filter((r) => r.passStrictYear);
const passOos = fixedResults.filter((r) => r.passOos);

const baselineCandidate = fixedResults.find((r) => r.id === 'edge02_bLt2_k1');

const recommendation =
  passStrict.length > 0
    ? {
        action: 'params_ok_consider_wire_after_review',
        best: passStrict[0].id,
        params: passStrict[0].params,
        oosDeltaUsd50: passStrict[0].deltaUsd50,
        oosDeltaHitRate: passStrict[0].deltaHitRate,
        note: '固定參數 OOS 過嚴格年窗閘；仍建議人工看 folds 後再接入',
      }
    : passOos.length > 0
      ? {
          action: 'params_weak_oos_only',
          best: passOos[0].id,
          params: passOos[0].params,
          note: '僅過普通 OOS，年窗或勝率未穩；暫不接入',
        }
      : {
          action: 'do_not_wire',
          note: '參數網格固定 OOS 無穩健過閘者；維持純 B',
          expandingDeltaUsd50: expandingSummary.deltaUsd50,
        };

const out = {
  experimentId: 'b-plus-a-incremental-param-wf-2026-07-28',
  generatedAt: new Date().toISOString(),
  grid: { EDGE_GRID, B_LT_GRID, TOPK_GRID },
  priorCandidate: baselineCandidate
    ? {
        id: baselineCandidate.id,
        passStrictYear: baselineCandidate.passStrictYear,
        passOos: baselineCandidate.passOos,
        deltaUsd50: baselineCandidate.deltaUsd50,
        deltaHitRate: baselineCandidate.deltaHitRate,
        monthsBeat: baselineCandidate.monthsBeat,
        monthsHurt: baselineCandidate.monthsHurt,
        y2025: baselineCandidate.y2025,
        y2026: baselineCandidate.y2026,
      }
    : null,
  passStrictYear: passStrict.map((r) => ({
    id: r.id,
    params: r.params,
    deltaUsd50: r.deltaUsd50,
    deltaHitRate: r.deltaHitRate,
    deltaBets: r.deltaBets,
    monthsBeat: r.monthsBeat,
    monthsHurt: r.monthsHurt,
  })),
  passOosOnly: passOos
    .filter((r) => !r.passStrictYear)
    .map((r) => ({
      id: r.id,
      params: r.params,
      deltaUsd50: r.deltaUsd50,
      deltaHitRate: r.deltaHitRate,
    })),
  fixedRankedByOosUsd: fixedResults.map((r) => ({
    id: r.id,
    params: r.params,
    deltaUsd50: r.deltaUsd50,
    deltaHitRate: r.deltaHitRate,
    deltaBets: r.deltaBets,
    monthsBeat: r.monthsBeat,
    monthsHurt: r.monthsHurt,
    passOos: r.passOos,
    passStrictYear: r.passStrictYear,
    y2025Delta: r.y2025.deltaUsd50,
    y2026Delta: r.y2026.deltaUsd50,
  })),
  expanding: expandingSummary,
  inSampleTop5: inSample
    .sort(
      (a, b) => b.combined.deltaUsd50 - a.combined.deltaUsd50
    )
    .slice(0, 5),
  recommendation,
};

fs.writeFileSync(
  new URL('../tmp-b-plus-a-incremental-param-wf.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\n=== passStrictYear ===');
for (const r of passStrict) {
  console.log(
    `${r.id}: Δ$=${r.deltaUsd50} Δhr=${r.deltaHitRate} Δn=${r.deltaBets} ${r.monthsBeat}/${r.monthsHurt}`
  );
}
console.log('\nprior edge02_bLt2_k1:', out.priorCandidate);
console.log('expanding:', {
  deltaUsd50: expandingSummary.deltaUsd50,
  deltaHitRate: expandingSummary.deltaHitRate,
  beat: expandingSummary.monthsBeat,
  hurt: expandingSummary.monthsHurt,
});
console.log('\nrecommendation:', recommendation);
