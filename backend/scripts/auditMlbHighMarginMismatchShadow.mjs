/**
 * 影子：僅對「高 margin≥0.60 × 先發大錯配」做輕處理
 *
 * A) 軟降排序：不改 P/EV 閘，日內排序 bScore 減分
 * B) 輕收縮 P：P 向 0.5／市場靠攏後重算 EV 再過閘（對照）
 *
 * 用法: node scripts/auditMlbHighMarginMismatchShadow.mjs
 * 產物: tmp-high-margin-mismatch-shadow.json
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
const outPath = path.join(__dirname, '../tmp-high-margin-mismatch-shadow.json');

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
const HIGH_MARGIN = 0.6;
/** 與 auditMlbHighMarginOverconfidenceDiag 對齊的凍結切點 */
const BIG_MISMATCH_ABS_ERA_GAP = 2.37;

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

function isToxicSlice(c) {
  return c.margin >= HIGH_MARGIN && (c.absEraGap ?? 0) >= BIG_MISMATCH_ABS_ERA_GAP;
}

/**
 * @param {'baseline'|'rank_soft'|'p_shrink'} mode
 * @param {{ rankPenalty?: number, shrinkW?: number, pMult?: number }} opts
 */
function selectLockedB(pool, mode = 'baseline', opts = {}) {
  const rankPenalty = opts.rankPenalty ?? 0.15;
  const shrinkW = opts.shrinkW ?? 0.25;
  const pMult = opts.pMult ?? 0.92;
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

    const margin = Math.abs(ph - pa);
    const absEraGap = g.absEraGap;
    const toxic = margin >= HIGH_MARGIN && (absEraGap ?? 0) >= BIG_MISMATCH_ABS_ERA_GAP;

    let gateProb = modelProb;
    let shrinkApplied = false;
    let rankPenalized = false;

    if (mode === 'p_shrink' && toxic) {
      shrinkApplied = true;
      if (opts.modeDetail === 'toward_market') {
        const market = 1 / pickOdds;
        gateProb = modelProb * (1 - shrinkW) + market * shrinkW;
      } else if (opts.modeDetail === 'toward_half') {
        gateProb = modelProb * (1 - shrinkW) + 0.5 * shrinkW;
      } else {
        gateProb = Math.max(0.5, modelProb * pMult);
      }
    }

    const evForGate = gateProb * (pickOdds - 1) - (1 - gateProb);
    if (evForGate < B.minimumExpectedValue) continue;
    if (margin < B.minimumExpectedRunMargin) continue;
    if (gateProb < B.minimumModelProbability) continue;
    if (pickOdds < B.minimumPickOdds || pickOdds > B.maximumPickOdds) continue;

    // 排序分：預設用閘門後的 EV；rank_soft 對毒切片直接扣 λ（不改 EV 閘）
    let bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: evForGate, modelProbability: gateProb },
      B
    );
    if (mode === 'rank_soft' && toxic) {
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
      modelProb: gateProb,
      rawModelProb: modelProb,
      margin,
      absEraGap,
      toxic,
      shrinkApplied,
      rankPenalized,
      ev: evForGate,
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
  const toxicSelected = bets.filter((b) => b.toxic);
  return {
    overall: {
      ...overall,
      deltaUsd: baseAll ? overall.usd50 - baseAll.usd50 : null,
    },
    byWindow,
    toxicSelectedInFinal: summarize(toxicSelected),
    toxicSelectedN: toxicSelected.length,
    dualWindow: {
      mergedGt: baseAll != null && overall.usd50 > baseAll.usd50,
      y2025Ge: byWindow['2025'].deltaUsd != null && byWindow['2025'].deltaUsd >= 0,
      y2026Ge: byWindow['2026'].deltaUsd != null && byWindow['2026'].deltaUsd >= 0,
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

    const homeEra = finite(features?.pitchers?.home?.era);
    const awayEra = finite(features?.pitchers?.away?.era);
    let absEraGap = null;
    if (homeEra != null && homeEra > 0 && awayEra != null && awayEra > 0) {
      absEraGap = Math.abs(awayEra - homeEra);
    }

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
      absEraGap,
    });
  }
}

const baseline = selectLockedB(pool, 'baseline');
const baselineByWindow = {
  '2025': summarize(baseline.filter((b) => b.window === '2025')),
  '2026': summarize(baseline.filter((b) => b.window === '2026')),
  __merged: summarize(baseline),
};
const baselineToxic = baseline.filter((b) => b.toxic);

const variants = [
  { id: 'rank_soft_p015', mode: 'rank_soft', opts: { rankPenalty: 0.15 } },
  { id: 'rank_soft_p025', mode: 'rank_soft', opts: { rankPenalty: 0.25 } },
  { id: 'rank_soft_p040', mode: 'rank_soft', opts: { rankPenalty: 0.4 } },
  {
    id: 'p_mult_092',
    mode: 'p_shrink',
    opts: { pMult: 0.92, modeDetail: 'mult' },
  },
  {
    id: 'p_toward_market_w025',
    mode: 'p_shrink',
    opts: { shrinkW: 0.25, modeDetail: 'toward_market' },
  },
  {
    id: 'p_toward_half_w025',
    mode: 'p_shrink',
    opts: { shrinkW: 0.25, modeDetail: 'toward_half' },
  },
];

const results = {};
for (const v of variants) {
  const bets = selectLockedB(pool, v.mode, v.opts);
  const packed = pack(bets, baselineByWindow);
  const penalizedInPool = pool.filter((g) => {
    const pred = g.lockedPred;
    const margin = Math.abs(pred.homeExpectedRuns - pred.awayExpectedRuns);
    return margin >= HIGH_MARGIN && (g.absEraGap ?? 0) >= BIG_MISMATCH_ABS_ERA_GAP;
  }).length;
  results[v.id] = {
    ...packed,
    dayDiff: dayDiff(baseline, bets),
    affectedFinalPicksN: bets.filter((b) => b.rankPenalized || b.shrinkApplied).length,
    poolToxicCandidatesApprox: penalizedInPool,
  };
}

function interpret() {
  const preferredOrder = [
    'rank_soft_p015',
    'rank_soft_p025',
    'rank_soft_p040',
    'p_toward_market_w025',
    'p_toward_half_w025',
    'p_mult_092',
  ];
  let best = null;
  for (const id of preferredOrder) {
    const r = results[id];
    if (!r) continue;
    if (!best || (r.overall.deltaUsd ?? -1e9) > (best.overall.deltaUsd ?? -1e9)) {
      best = { id, ...r };
    }
  }
  const anyPass = Object.entries(results).filter(
    ([, r]) => r.dualWindow.mergedGt && r.dualWindow.y2025Ge && r.dualWindow.y2026Ge
  );
  const anyWeakPos = Object.entries(results).filter(
    ([, r]) => (r.overall.deltaUsd ?? 0) > 0
  );

  let verdict;
  if (anyPass.length) {
    verdict =
      `窄切片輕處理有雙窗過閘候選（${anyPass.map(([id]) => id).join(', ')}）；可進入 Expanding WF 複驗，仍不改正式。`;
  } else if (anyWeakPos.length) {
    verdict =
      `有弱正合併 Δ$（${anyWeakPos.map(([id, r]) => `${id}:${r.overall.deltaUsd}`).join(', ')}）但雙窗未全過；暫不接入，可選 WF 再驗或收束。`;
  } else {
    verdict =
      '高 margin×大錯配輕處理影子雙窗／合併皆未改善（或為負）；收束此切片，不再在大錯配上糾纏。';
  }

  return {
    verdict,
    bestByMergedDelta: best
      ? { id: best.id, deltaUsd: best.overall.deltaUsd, dualWindow: best.dualWindow }
      : null,
    passDualWindow: anyPass.map(([id]) => id),
    weakPositive: anyWeakPos.map(([id, r]) => ({ id, deltaUsd: r.overall.deltaUsd })),
  };
}

const interpretation = interpret();

const report = {
  generatedAt: new Date().toISOString(),
  modelVersion: validation.modelVersion,
  note:
    '只影子；正式鎖定B未改。切片：margin≥0.60 且 |ERA gap|≥2.37。優先看 rank_soft（不改 EV 閘）。',
  slice: {
    highMargin: HIGH_MARGIN,
    bigMismatchAbsEraGap: BIG_MISMATCH_ABS_ERA_GAP,
  },
  baseline: {
    overall: baselineByWindow.__merged,
    byWindow: {
      '2025': baselineByWindow['2025'],
      '2026': baselineByWindow['2026'],
    },
    toxicInBaseline: summarize(baselineToxic),
    toxicInBaselineN: baselineToxic.length,
  },
  results,
  interpretation,
};

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log('=== High-margin × big-mismatch shadow ===');
console.log('baseline', baselineByWindow.__merged, 'toxicN', baselineToxic.length);
for (const [id, r] of Object.entries(results)) {
  console.log(id, {
    overall: r.overall,
    byWindow: r.byWindow,
    dual: r.dualWindow,
    affectedFinal: r.affectedFinalPicksN,
    toxicFinal: r.toxicSelectedN,
    dayDiff: r.dayDiff,
  });
}
console.log('VERDICT:', interpretation.verdict);
console.log('wrote', outPath);

// silence unused
void isToxicSlice;
