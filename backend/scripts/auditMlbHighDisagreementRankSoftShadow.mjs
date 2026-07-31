/**
 * 影子：僅對高分歧（disagreement≥0.08）做日內排序減分
 *
 * disagreement = model_p − 1/pickOdds
 * 不改 P、不改 EV、不過閘重算；只扣 bScore。
 *
 * 用法: node scripts/auditMlbHighDisagreementRankSoftShadow.mjs
 * 產物: tmp-high-disagreement-rank-soft-shadow.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
} from '../src/services/MlbExpectedRunsModel.js';
import {
  applyFrozenResidualToPrediction,
  applyFrozenToxicShrink,
  MLB_FROZEN_B_SHADOW_SPEC,
} from '../src/services/MlbFrozenBShadow.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, '../tmp-high-disagreement-rank-soft-shadow.json');

const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

const B = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: MLB_FROZEN_B_SHADOW_SPEC.selection.minimumH2hBookmakers,
};
const DROP_R3 = MLB_FROZEN_B_SHADOW_SPEC.selection.dropThirdIfMarginBelow;
const DROP_R2_MAX = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsBelow;
const DROP_R2_MIN = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsMin;
const STAKE = 50;
const DIS_CUT = 0.08;
const LAMBDAS = [0.15, 0.25];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function finite(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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
  let hits = 0;
  let unit = 0;
  let odds = 0;
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
    usd50: Math.round(unit * STAKE),
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

function selectLockedB(pool, { rankPenalty = 0 } = {}) {
  const byDay = new Map();
  for (const g of pool) {
    const pred = g.lockedPred;
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? g.homeOdds : g.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    if ((pickHome ? g.homeEarly : g.awayEarly) > (pickHome ? g.awayEarly : g.homeEarly)) {
      continue;
    }
    modelProb = applyFrozenToxicShrink(modelProb, pickOdds, {
      pickHome,
      homeWinPct: g.homeWinPct,
    });
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue) continue;
    if (margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (pickOdds < B.minimumPickOdds || pickOdds > B.maximumPickOdds) continue;

    const marketImplied = 1 / pickOdds;
    const disagreement = modelProb - marketImplied;
    const highDis = disagreement >= DIS_CUT;

    let bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    let rankPenalized = false;
    if (rankPenalty > 0 && highDis) {
      rankPenalized = true;
      bScore -= rankPenalty;
    }

    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({
      gameId: g.gameId,
      day: g.day,
      window: g.window,
      pickHome,
      pickOdds,
      modelProb,
      marketImplied,
      disagreement,
      highDis,
      rankPenalized,
      ev,
      margin,
      bScore,
      hit: pickHome ? g.homeWon : !g.homeWon,
    });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    applyDrop(arr).forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

function pack(bets, baselineByWindow) {
  const byWindow = {};
  for (const w of WINDOWS) {
    const s = summarize(bets.filter((b) => b.window === w.key));
    const base = baselineByWindow[w.key];
    byWindow[w.key] = {
      ...s,
      deltaUsd: base ? s.usd50 - base.usd50 : null,
    };
  }
  const overall = summarize(bets);
  const baseAll = baselineByWindow.__merged;
  const highDisFinal = bets.filter((b) => b.highDis);
  return {
    overall: {
      ...overall,
      deltaUsd: baseAll ? overall.usd50 - baseAll.usd50 : null,
    },
    byWindow,
    highDisInFinal: summarize(highDisFinal),
    highDisInFinalN: highDisFinal.length,
    rankPenalizedInFinalN: bets.filter((b) => b.rankPenalized).length,
    dualWindow: {
      mergedGt: baseAll != null && overall.usd50 > baseAll.usd50,
      y2025Ge: byWindow['2025'].deltaUsd != null && byWindow['2025'].deltaUsd >= 0,
      y2026Ge: byWindow['2026'].deltaUsd != null && byWindow['2026'].deltaUsd >= 0,
      notWorseEither:
        byWindow['2025'].deltaUsd != null &&
        byWindow['2026'].deltaUsd != null &&
        byWindow['2025'].deltaUsd >= 0 &&
        byWindow['2026'].deltaUsd >= 0,
    },
  };
}

function dayDiff(baseline, shadow) {
  const days = [...new Set([...baseline, ...shadow].map((b) => b.day))].sort();
  let changed = 0;
  let deltaUsd = 0;
  for (const day of days) {
    const L = baseline.filter((b) => b.day === day);
    const S = shadow.filter((b) => b.day === day);
    const lKeys = new Set(L.map((b) => `${b.gameId}|${b.pickHome ? 'H' : 'A'}`));
    const sKeys = new Set(S.map((b) => `${b.gameId}|${b.pickHome ? 'H' : 'A'}`));
    const same =
      lKeys.size === sKeys.size && [...lKeys].every((k) => sKeys.has(k));
    if (same) continue;
    changed += 1;
    deltaUsd += summarize(S).usd50 - summarize(L).usd50;
  }
  return { changedDays: changed, sumDeltaUsdOnChangedDays: deltaUsd };
}

const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) throw new Error('missing_formal_v45_model');

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
    features.gameId = row.gameId;
    features.commenceTime = row.commenceTime;
    const hs = +row.homeScore;
    const as = +row.awayScore;
    if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) continue;
    const homeWinPct = finite(features?.home?.homeWinPct);
    if (homeWinPct == null) continue;

    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) continue;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }

    const basePred = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const lockedPred = applyFrozenResidualToPrediction(
      model,
      basePred,
      homeWinPct - 0.5
    );
    const sig = buildPregameRegimeSignals(features);
    pool.push({
      gameId: row.gameId,
      window: w.key,
      day: hk(row.commenceTime),
      homeWon: hs > as,
      homeWinPct,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      homeEarly: +sig.homeEarlyExitsLast3 || 0,
      awayEarly: +sig.awayEarlyExitsLast3 || 0,
      lockedPred,
    });
  }
}

const baseline = selectLockedB(pool, { rankPenalty: 0 });
const baselineByWindow = {
  '2025': summarize(baseline.filter((b) => b.window === '2025')),
  '2026': summarize(baseline.filter((b) => b.window === '2026')),
  __merged: summarize(baseline),
};
const baselineHighDis = baseline.filter((b) => b.highDis);

const results = {};
for (const lambda of LAMBDAS) {
  const bets = selectLockedB(pool, { rankPenalty: lambda });
  results[`rank_soft_λ${lambda}`] = {
    lambda,
    ...pack(bets, baselineByWindow),
    dayDiff: dayDiff(baseline, bets),
  };
}

function interpret() {
  const entries = Object.entries(results);
  const pass = entries.filter(
    ([, r]) => r.dualWindow.mergedGt && r.dualWindow.notWorseEither
  );
  const weakPos = entries.filter(([, r]) => (r.overall.deltaUsd ?? 0) > 0);
  const allNegOrUnstable = entries.every(
    ([, r]) =>
      (r.overall.deltaUsd ?? 0) <= 0 ||
      !r.dualWindow.y2025Ge ||
      !r.dualWindow.y2026Ge
  );

  let verdict;
  if (pass.length) {
    verdict =
      `高分歧排序輕罰有雙窗不差／合併為正候選（${pass.map(([id]) => id).join(', ')}）；可進 Expanding WF 討論，仍不改正式。`;
  } else if (weakPos.length) {
    verdict =
      `有弱正合併但雙窗不穩；暫不接入，保持軟觀察。`;
  } else if (allNegOrUnstable) {
    verdict =
      '僅 Q5／dis≥0.08 排序輕罰影子明顯為負或雙窗不穩：正式收束，只保留「高分歧=軟風險觀察」，不再升級處理。';
  } else {
    verdict = '結果不清晰；預設收束為軟觀察。';
  }

  return {
    verdict,
    passDualWindow: pass.map(([id]) => id),
    weakPositive: weakPos.map(([id, r]) => ({
      id,
      deltaUsd: r.overall.deltaUsd,
      dual: r.dualWindow,
    })),
  };
}

const interpretation = interpret();

const report = {
  generatedAt: new Date().toISOString(),
  modelVersion: validation.modelVersion,
  note:
    '只影子觀察；不改正式。僅 disagreement≥0.08 日內排序減分；P/EV/閘不變。',
  slice: {
    disagreementCut: DIS_CUT,
    disagreement: 'model_p - 1/pickOdds',
    lambdas: LAMBDAS,
  },
  baseline: {
    overall: baselineByWindow.__merged,
    byWindow: {
      '2025': baselineByWindow['2025'],
      '2026': baselineByWindow['2026'],
    },
    highDisInBaseline: summarize(baselineHighDis),
    highDisInBaselineN: baselineHighDis.length,
  },
  results,
  interpretation,
};

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log('=== High-disagreement rank-soft shadow ===');
console.log('baseline', baselineByWindow.__merged, 'highDisN', baselineHighDis.length);
for (const [id, r] of Object.entries(results)) {
  console.log(id, {
    overall: r.overall,
    byWindow: r.byWindow,
    dual: r.dualWindow,
    penalizedFinal: r.rankPenalizedInFinalN,
    highDisFinal: r.highDisInFinalN,
    dayDiff: r.dayDiff,
  });
}
console.log('VERDICT:', interpretation.verdict);
console.log('wrote', outPath);
