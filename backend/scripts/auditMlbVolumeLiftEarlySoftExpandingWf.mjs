/**
 * Expanding WF：volume-lift 候選（影子，不改正式常數）
 * 主候選：earlyExits 硬擋 → 軟罰 λ
 * 備選：maxOdds≤2.40 + early 軟罰
 *
 * 底座：ev02_max230 的 EV／margin／minOdds／dropR3／dropR2／≥2庄
 * 產物：tmp-volume-lift-early-soft-expanding-wf.json
 *
 * 用法: node scripts/auditMlbVolumeLiftEarlySoftExpandingWf.mjs
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

/** 固定參數複核（影子掃描過閘者） */
const FIXED_CANDIDATES = [
  { id: 'early_soft_l020', maxOdds: 2.3, earlySoftLambda: 0.2, hardEarly: false },
  { id: 'combo_max240_early_soft_l015', maxOdds: 2.4, earlySoftLambda: 0.15, hardEarly: false },
  { id: 'watch_promote_l020', maxOdds: 2.4, earlySoftLambda: 0.05, hardEarly: false, nearMissPromoteLambda: 0.2 },
];

/** Expanding 訓練窗可選網格 */
const EARLY_LAMBDA_GRID = [0.05, 0.1, 0.15, 0.2, 0.25];
const MAX_ODDS_GRID = [2.3, 2.35, 2.4];

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

function buildWideUniverse(from, to) {
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
    if (!Number.isFinite(pickOdds) || pickOdds < B.minimumPickOdds || pickOdds > 2.5) continue;

    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue || modelProb < B.minimumModelProbability) continue;
    if (margin < 0.15) continue;

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
    const earlyWorse = pickEarly > oppEarly;
    const baseScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );

    const strictMargin = margin >= B.minimumExpectedRunMargin;
    const strictMax230 = pickOdds <= 2.3;
    const isStrict = strictMargin && strictMax230 && !earlyWorse;
    const nearMargin = !strictMargin && margin >= 0.15;
    const nearMax = pickOdds > 2.3 && pickOdds <= 2.4;
    const nearEarly = earlyWorse && strictMargin && pickOdds <= 2.3;
    const isNearMiss =
      !isStrict &&
      ((nearMax && strictMargin && !earlyWorse) ||
        (nearMargin && strictMax230 && !earlyWorse) ||
        (nearEarly && strictMargin && strictMax230));

    pool.push({
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      window: from.startsWith('2025') ? '2025' : '2026',
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      earlyWorse,
      baseScore,
      isStrict,
      isNearMiss,
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

function selectWithPolicy(pool, policy) {
  const {
    maxOdds = 2.3,
    earlySoftLambda = 0,
    hardEarly = true,
    nearMissPromoteLambda = null,
  } = policy;

  const byDay = new Map();
  for (const g of pool) {
    if (g.margin < B.minimumExpectedRunMargin && nearMissPromoteLambda == null) continue;
    if (g.pickOdds > maxOdds) continue;
    if (hardEarly && g.earlyWorse) continue;

    let admit = true;
    let nearPenalty = 0;
    if (nearMissPromoteLambda != null) {
      const okStrictish =
        g.margin >= B.minimumExpectedRunMargin && g.pickOdds <= maxOdds;
      if (okStrictish) {
        admit = true;
      } else if (g.isNearMiss && g.pickOdds <= maxOdds) {
        admit = true;
        nearPenalty = nearMissPromoteLambda;
      } else {
        admit = false;
      }
    } else if (g.margin < B.minimumExpectedRunMargin) {
      admit = false;
    }
    if (!admit) continue;

    const score =
      g.baseScore -
      (g.earlyWorse && !hardEarly ? earlySoftLambda : 0) -
      nearPenalty;

    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({ ...g, score });
  }

  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = byDay.get(day).sort((a, b) => b.score - a.score || b.margin - a.margin);
    out.push(...applyHardSlots(arr));
  }
  return out;
}

function policyId(p) {
  if (p.nearMissPromoteLambda != null) {
    return `watch_l${String(p.nearMissPromoteLambda).replace('.', '')}_max${String(p.maxOdds).replace('.', '')}_e${String(p.earlySoftLambda).replace('.', '')}`;
  }
  if (p.hardEarly) return `baseline_hard_max${String(p.maxOdds).replace('.', '')}`;
  return `early_soft_l${String(p.earlySoftLambda).replace('.', '')}_max${String(p.maxOdds).replace('.', '')}`;
}

function buildExpandingGrid() {
  const grid = [{ id: 'baseline', maxOdds: 2.3, earlySoftLambda: 0, hardEarly: true }];
  for (const maxOdds of MAX_ODDS_GRID) {
    for (const earlySoftLambda of EARLY_LAMBDA_GRID) {
      grid.push({
        id: policyId({ maxOdds, earlySoftLambda, hardEarly: false }),
        maxOdds,
        earlySoftLambda,
        hardEarly: false,
      });
    }
  }
  // 近緣晉升只試掃描過閘的 λ=0.20，max 維持 2.30／2.40
  for (const maxOdds of [2.3, 2.4]) {
    grid.push({
      id: policyId({ maxOdds, earlySoftLambda: 0.05, hardEarly: false, nearMissPromoteLambda: 0.2 }),
      maxOdds,
      earlySoftLambda: 0.05,
      hardEarly: false,
      nearMissPromoteLambda: 0.2,
    });
  }
  return grid;
}

function pickBestOnTrain(trainPool, grid) {
  let best = null;
  const scored = [];
  for (const p of grid) {
    const s = summarize(selectWithPolicy(trainPool, p));
    scored.push({ policy: p.id, ...s, maxOdds: p.maxOdds, earlySoftLambda: p.earlySoftLambda, hardEarly: p.hardEarly, nearMissPromoteLambda: p.nearMissPromoteLambda ?? null });
    if (s.bets < 25) continue;
    if (!best || s.usd50 > best.train.usd50) {
      best = { ...p, train: s };
    }
  }
  scored.sort((a, b) => b.usd50 - a.usd50);
  return { best, trainTop5: scored.slice(0, 5) };
}

console.log('[early-soft-wf] building universe…');
const pools = {};
for (const w of WINDOWS) {
  pools[w.key] = buildWideUniverse(w.from, w.to);
  console.log(`  ${w.key}: ${pools[w.key].length}`);
}
const combined = [...pools['2025'], ...pools['2026']];
const months = [...new Set(combined.map((g) => g.month))].sort();
const grid = buildExpandingGrid();

const baselinePolicy = { maxOdds: 2.3, earlySoftLambda: 0, hardEarly: true };
const baselineMerged = summarize(selectWithPolicy(combined, baselinePolicy));
const baselineByWindow = {
  2025: summarize(selectWithPolicy(pools['2025'], baselinePolicy)),
  2026: summarize(selectWithPolicy(pools['2026'], baselinePolicy)),
};

console.log(
  `[early-soft-wf] baseline n=${baselineMerged.bets} hr=${baselineMerged.hitRate} $=${baselineMerged.usd50}`
);

const fixedResults = FIXED_CANDIDATES.map((c) => {
  const byWindow = {
    2025: summarize(selectWithPolicy(pools['2025'], c)),
    2026: summarize(selectWithPolicy(pools['2026'], c)),
  };
  const merged = summarize(selectWithPolicy(combined, c));
  const pass =
    merged.usd50 >= baselineMerged.usd50 &&
    byWindow['2025'].usd50 >= baselineByWindow['2025'].usd50 &&
    byWindow['2026'].usd50 >= baselineByWindow['2026'].usd50;
  return {
    id: c.id,
    policy: c,
    merged,
    byWindow,
    delta: {
      bets: merged.bets - baselineMerged.bets,
      hitRatePp: Number((((merged.hitRate ?? 0) - (baselineMerged.hitRate ?? 0)) * 100).toFixed(2)),
      usd50: merged.usd50 - baselineMerged.usd50,
    },
    dualWindowPass: pass,
  };
});

const wfFolds = [];
for (let i = 1; i < months.length; i++) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];
  const trainPool = combined.filter((g) => trainMonths.has(g.month));
  const testPool = combined.filter((g) => g.month === testMonth);
  const { best, trainTop5 } = pickBestOnTrain(trainPool, grid);
  const chosen = best || baselinePolicy;
  const oos = summarize(selectWithPolicy(testPool, chosen));
  const baseOos = summarize(selectWithPolicy(testPool, baselinePolicy));
  const fixedEarlyOos = summarize(
    selectWithPolicy(testPool, FIXED_CANDIDATES[0])
  );
  const fixedComboOos = summarize(
    selectWithPolicy(testPool, FIXED_CANDIDATES[1])
  );
  wfFolds.push({
    testMonth,
    chosen: {
      id: chosen.id || policyId(chosen),
      maxOdds: chosen.maxOdds,
      earlySoftLambda: chosen.earlySoftLambda,
      hardEarly: chosen.hardEarly,
      nearMissPromoteLambda: chosen.nearMissPromoteLambda ?? null,
      trainUsd50: chosen.train?.usd50 ?? null,
    },
    trainTop5,
    oos,
    baseOos,
    fixedEarlyOos,
    fixedComboOos,
    deltaUsdVsBase: oos.usd50 - baseOos.usd50,
    fixedEarlyDeltaUsd: fixedEarlyOos.usd50 - baseOos.usd50,
    fixedComboDeltaUsd: fixedComboOos.usd50 - baseOos.usd50,
  });
  console.log(
    `  fold ${testMonth}: chose ${chosen.id || policyId(chosen)} → OOS Δ$=${oos.usd50 - baseOos.usd50}`
  );
}

function collectOos(selectPolicyFn) {
  return wfFolds.flatMap((f) =>
    selectWithPolicy(
      combined.filter((g) => g.month === f.testMonth),
      selectPolicyFn(f)
    )
  );
}

const wfChosenAll = summarize(
  collectOos((f) => ({
    maxOdds: f.chosen.maxOdds,
    earlySoftLambda: f.chosen.earlySoftLambda,
    hardEarly: f.chosen.hardEarly,
    nearMissPromoteLambda: f.chosen.nearMissPromoteLambda,
  }))
);
const wfBaseAll = summarize(collectOos(() => baselinePolicy));
const wfFixedEarlyAll = summarize(collectOos(() => FIXED_CANDIDATES[0]));
const wfFixedComboAll = summarize(collectOos(() => FIXED_CANDIDATES[1]));

const beatMonths = wfFolds.filter((f) => f.deltaUsdVsBase > 0).length;
const hurtMonths = wfFolds.filter((f) => f.deltaUsdVsBase < 0).length;
const fixedEarlyBeat = wfFolds.filter((f) => f.fixedEarlyDeltaUsd > 0).length;
const fixedEarlyHurt = wfFolds.filter((f) => f.fixedEarlyDeltaUsd < 0).length;
const fixedComboBeat = wfFolds.filter((f) => f.fixedComboDeltaUsd > 0).length;
const fixedComboHurt = wfFolds.filter((f) => f.fixedComboDeltaUsd < 0).length;

const holdoutTune = pickBestOnTrain(pools['2025'], grid);
const holdout = {
  tunedOn2025: holdoutTune.best
    ? {
        id: holdoutTune.best.id || policyId(holdoutTune.best),
        maxOdds: holdoutTune.best.maxOdds,
        earlySoftLambda: holdoutTune.best.earlySoftLambda,
        hardEarly: holdoutTune.best.hardEarly,
        nearMissPromoteLambda: holdoutTune.best.nearMissPromoteLambda ?? null,
        train: holdoutTune.best.train,
      }
    : null,
  trainTop5: holdoutTune.trainTop5,
  base2026: baselineByWindow['2026'],
  oos2026_tuned: holdoutTune.best
    ? summarize(selectWithPolicy(pools['2026'], holdoutTune.best))
    : null,
  oos2026_fixed_early_soft_l020: summarize(
    selectWithPolicy(pools['2026'], FIXED_CANDIDATES[0])
  ),
  oos2026_fixed_combo: summarize(selectWithPolicy(pools['2026'], FIXED_CANDIDATES[1])),
};

const expandingPass =
  wfChosenAll.usd50 >= wfBaseAll.usd50 && beatMonths >= hurtMonths;
const fixedEarlyPass =
  fixedResults[0].dualWindowPass &&
  wfFixedEarlyAll.usd50 >= wfBaseAll.usd50 &&
  fixedEarlyBeat >= fixedEarlyHurt;
const fixedComboPass =
  fixedResults[1].dualWindowPass &&
  wfFixedComboAll.usd50 >= wfBaseAll.usd50 &&
  fixedComboBeat >= fixedComboHurt;

const verdict = {
  expandingChosen: expandingPass ? 'pass' : 'fail',
  fixed_early_soft_l020: fixedEarlyPass ? 'pass' : 'fail',
  fixed_combo_max240_early_soft_l015: fixedComboPass ? 'pass' : 'fail',
  recommendation: fixedEarlyPass
    ? 'shadow_keep_early_soft_l020_pending_formal_review'
    : fixedComboPass
      ? 'shadow_keep_combo_pending_formal_review'
      : expandingPass
        ? 'expanding_chose_variable_params_unstable_for_lock'
        : 'no_promote',
  note: '通過僅代表影子 WF；接入前須人工確認且不得直接改 ev02_max230 正式常數',
};

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'shadow_expanding_wf',
  baselineProfile: 'ev02_max230',
  windows: WINDOWS,
  months,
  baseline: { merged: baselineMerged, byWindow: baselineByWindow },
  fixedCandidates: fixedResults,
  expanding: {
    folds: wfFolds,
    oosChosen: wfChosenAll,
    oosBaseline: wfBaseAll,
    oosFixedEarly: wfFixedEarlyAll,
    oosFixedCombo: wfFixedComboAll,
    deltaChosenVsBase: {
      bets: wfChosenAll.bets - wfBaseAll.bets,
      hitRatePp: Number(
        (((wfChosenAll.hitRate ?? 0) - (wfBaseAll.hitRate ?? 0)) * 100).toFixed(2)
      ),
      usd50: wfChosenAll.usd50 - wfBaseAll.usd50,
    },
    deltaFixedEarlyVsBase: {
      bets: wfFixedEarlyAll.bets - wfBaseAll.bets,
      hitRatePp: Number(
        (((wfFixedEarlyAll.hitRate ?? 0) - (wfBaseAll.hitRate ?? 0)) * 100).toFixed(2)
      ),
      usd50: wfFixedEarlyAll.usd50 - wfBaseAll.usd50,
    },
    deltaFixedComboVsBase: {
      bets: wfFixedComboAll.bets - wfBaseAll.bets,
      hitRatePp: Number(
        (((wfFixedComboAll.hitRate ?? 0) - (wfBaseAll.hitRate ?? 0)) * 100).toFixed(2)
      ),
      usd50: wfFixedComboAll.usd50 - wfBaseAll.usd50,
    },
    beatMonths,
    hurtMonths,
    fixedEarlyBeat,
    fixedEarlyHurt,
    fixedComboBeat,
    fixedComboHurt,
  },
  holdout2025to2026: holdout,
  verdict,
};

const outPath = new URL('../tmp-volume-lift-early-soft-expanding-wf.json', import.meta.url);
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`[early-soft-wf] wrote ${outPath.pathname}`);
console.log('[early-soft-wf] verdict', JSON.stringify(verdict, null, 2));
console.log(
  `[early-soft-wf] expanding chosen Δ$=${payload.expanding.deltaChosenVsBase.usd50} beat/hurt=${beatMonths}/${hurtMonths}`
);
console.log(
  `[early-soft-wf] fixed early_soft_l020 Δ$=${payload.expanding.deltaFixedEarlyVsBase.usd50} beat/hurt=${fixedEarlyBeat}/${fixedEarlyHurt} dual=${fixedResults[0].dualWindowPass}`
);
console.log(
  `[early-soft-wf] fixed combo Δ$=${payload.expanding.deltaFixedComboVsBase.usd50} beat/hurt=${fixedComboBeat}/${fixedComboHurt} dual=${fixedResults[1].dualWindowPass}`
);
