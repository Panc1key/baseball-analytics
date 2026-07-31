/**
 * 診斷：鎖定 B 入選單是否被「剛過閘」的低 margin／低 EV 邊緣單拖累？
 *
 * 只診斷、不改選注。
 *
 * 分檔（規格凍結）：
 *   margin: [0.25,0.40) | [0.40,0.60) | [0.60,∞)
 *   EV:     [0.02,0.05) | [0.05,0.10) | [0.10,∞)
 * 閘門對照：鎖定 B minimumExpectedRunMargin=0.25、minimumExpectedValue=0.02
 *
 * 用法: node scripts/auditMlbLockedBEdgeTierDiag.mjs
 * 產物: tmp-locked-b-edge-tier-diag.json
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
const outPath = path.join(__dirname, '../tmp-locked-b-edge-tier-diag.json');

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

const MARGIN_TIERS = [
  { key: 'm_gate_025_040', label: '剛過閘 margin [0.25,0.40)', lo: 0.25, hi: 0.4 },
  { key: 'm_mid_040_060', label: '中檔 margin [0.40,0.60)', lo: 0.4, hi: 0.6 },
  { key: 'm_high_060_plus', label: '高檔 margin ≥0.60', lo: 0.6, hi: Infinity },
];

const EV_TIERS = [
  { key: 'ev_gate_02_05', label: '剛過閘 EV [0.02,0.05)', lo: 0.02, hi: 0.05 },
  { key: 'ev_mid_05_10', label: '中檔 EV [0.05,0.10)', lo: 0.05, hi: 0.1 },
  { key: 'ev_high_10_plus', label: '高檔 EV ≥0.10', lo: 0.1, hi: Infinity },
];

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
    return { bets: 0, hitRate: null, avgOdds: null, avgEv: null, avgMargin: null, avgModelProb: null, roi: null, usd50: 0 };
  }
  let hits = 0;
  let unit = 0;
  let odds = 0;
  let ev = 0;
  let margin = 0;
  let p = 0;
  let home = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    ev += b.ev;
    margin += b.margin;
    p += b.modelProb;
    if (b.pickHome) home += 1;
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
    avgEv: Number((ev / n).toFixed(4)),
    avgMargin: Number((margin / n).toFixed(4)),
    avgModelProb: Number((p / n).toFixed(4)),
    homePickShare: Number((home / n).toFixed(4)),
    awayPickShare: Number(((n - home) / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
    usd50PerBet: Number(((unit * STAKE) / n).toFixed(2)),
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

function tierOf(value, tiers) {
  for (const t of tiers) {
    if (value >= t.lo && value < t.hi) return t.key;
  }
  // ≥ last open end already covered by Infinity; fallback
  return tiers[tiers.length - 1].key;
}

function selectLockedB(pool) {
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
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({
      gameId: g.gameId,
      day: g.day,
      window: g.window,
      pickHome,
      pickOdds,
      modelProb,
      homeWinPct: g.homeWinPct,
      ev,
      margin,
      bScore,
      hit: pickHome ? g.homeWon : !g.homeWon,
      marginTier: tierOf(margin, MARGIN_TIERS),
      evTier: tierOf(ev, EV_TIERS),
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

function packTiers(bets, tiers, keyField) {
  const out = {};
  for (const t of tiers) {
    const subset = bets.filter((b) => b[keyField] === t.key);
    out[t.key] = {
      label: t.label,
      range: { lo: t.lo, hi: t.hi === Infinity ? null : t.hi },
      overall: summarize(subset),
      byWindow: Object.fromEntries(
        WINDOWS.map((w) => [
          w.key,
          summarize(subset.filter((b) => b.window === w.key)),
        ])
      ),
      bySide: {
        home: summarize(subset.filter((b) => b.pickHome)),
        away: summarize(subset.filter((b) => !b.pickHome)),
      },
    };
  }
  return out;
}

/** 對照：若砍掉剛過閘檔，剩餘單的紙上表現（非重選，只是子集） */
function counterfactualDropGateTier(bets, dropMarginGate, dropEvGate) {
  let kept = bets;
  if (dropMarginGate) kept = kept.filter((b) => b.marginTier !== 'm_gate_025_040');
  if (dropEvGate) kept = kept.filter((b) => b.evTier !== 'ev_gate_02_05');
  return {
    kept: summarize(kept),
    dropped: summarize(bets.filter((b) => !kept.includes(b))),
    byWindow: Object.fromEntries(
      WINDOWS.map((w) => [
        w.key,
        {
          kept: summarize(kept.filter((b) => b.window === w.key)),
          baseline: summarize(bets.filter((b) => b.window === w.key)),
        },
      ])
    ),
  };
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

const bets = selectLockedB(pool);
const baseline = summarize(bets);
const byMargin = packTiers(bets, MARGIN_TIERS, 'marginTier');
const byEv = packTiers(bets, EV_TIERS, 'evTier');

const cf = {
  dropMarginGateOnly: counterfactualDropGateTier(bets, true, false),
  dropEvGateOnly: counterfactualDropGateTier(bets, false, true),
  dropBothGateTiers: counterfactualDropGateTier(bets, true, true),
};

function isMateriallyWorse(tierSummary, baselineSummary) {
  if (!tierSummary?.bets || tierSummary.bets < 20) return { worse: false, reason: 'thin' };
  const hrGap = (baselineSummary.hitRate ?? 0) - (tierSummary.hitRate ?? 0);
  const usdPerGap =
    (baselineSummary.usd50PerBet ?? 0) - (tierSummary.usd50PerBet ?? 0);
  // 明顯更差：勝率低 ≥4pp 或 每注美元低 ≥$5
  const worse = hrGap >= 0.04 || usdPerGap >= 5;
  return { worse, hrGap: Number(hrGap.toFixed(4)), usdPerGap: Number(usdPerGap.toFixed(2)) };
}

const marginGate = byMargin.m_gate_025_040.overall;
const evGate = byEv.ev_gate_02_05.overall;
const marginJudge = isMateriallyWorse(marginGate, baseline);
const evJudge = isMateriallyWorse(evGate, baseline);

const cfMarginDelta =
  (cf.dropMarginGateOnly.kept.usd50 ?? 0) - (baseline.usd50 ?? 0);
const cfEvDelta =
  (cf.dropEvGateOnly.kept.usd50 ?? 0) - (baseline.usd50 ?? 0);

function interpret() {
  const marginDrag = marginJudge.worse;
  const evDrag = evJudge.worse;
  const dropMarginHelps =
    cfMarginDelta > 50 &&
    (cf.dropMarginGateOnly.byWindow['2025'].kept.usd50 ?? 0) >=
      (cf.dropMarginGateOnly.byWindow['2025'].baseline.usd50 ?? 0) &&
    (cf.dropMarginGateOnly.byWindow['2026'].kept.usd50 ?? 0) >=
      (cf.dropMarginGateOnly.byWindow['2026'].baseline.usd50 ?? 0);
  const dropEvHelps =
    cfEvDelta > 50 &&
    (cf.dropEvGateOnly.byWindow['2025'].kept.usd50 ?? 0) >=
      (cf.dropEvGateOnly.byWindow['2025'].baseline.usd50 ?? 0) &&
    (cf.dropEvGateOnly.byWindow['2026'].kept.usd50 ?? 0) >=
      (cf.dropEvGateOnly.byWindow['2026'].baseline.usd50 ?? 0);

  let verdict;
  if (!marginDrag && !evDrag) {
    verdict =
      '剛過閘的 margin／EV 檔與整體差異不大：當前閘門較均衡，邊緣二次過濾優先級低，優化空間宜另找。';
  } else if ((marginDrag && dropMarginHelps) || (evDrag && dropEvHelps)) {
    verdict =
      '剛過閘檔明顯拖累，且「砍掉該檔」的反事實雙窗不傷／有幫助：值得影子試驗更嚴的二次過濾（先不改正式）。';
  } else if (marginDrag || evDrag) {
    verdict =
      '剛過閘檔表現偏弱，但反事實砍檔未能穩定改善雙窗：可能是相關混淆或日內排序效應，不宜直接抬閘，需再拆。';
  } else {
    verdict = '邊緣分檔未給出清晰拖累訊號；選注閘門暫可維持。';
  }

  return {
    verdict,
    flags: {
      marginGateWorse: marginDrag,
      evGateWorse: evDrag,
      marginJudge,
      evJudge,
      cfMarginDeltaUsd: cfMarginDelta,
      cfEvDeltaUsd: cfEvDelta,
      dropMarginHelpsDualWindow: dropMarginHelps,
      dropEvHelpsDualWindow: dropEvHelps,
    },
  };
}

const interpretation = interpret();

const report = {
  generatedAt: new Date().toISOString(),
  modelVersion: validation.modelVersion,
  note: '只診斷；不改鎖定B。反事實=從已入選單剔除邊緣檔（非重新過日內TopK）。',
  spec: {
    marginTiers: MARGIN_TIERS.map((t) => ({ key: t.key, label: t.label, lo: t.lo, hi: t.hi })),
    evTiers: EV_TIERS.map((t) => ({ key: t.key, label: t.label, lo: t.lo, hi: t.hi })),
    gates: {
      minimumExpectedRunMargin: B.minimumExpectedRunMargin,
      minimumExpectedValue: B.minimumExpectedValue,
    },
    worseRule: '相對基線：勝率低≥4pp 或 每注@$50 低≥$5；且該檔 n≥20',
  },
  sample: {
    pool: pool.length,
    lockedBets: bets.length,
    windows: WINDOWS,
  },
  baseline: {
    overall: baseline,
    byWindow: Object.fromEntries(
      WINDOWS.map((w) => [w.key, summarize(bets.filter((b) => b.window === w.key))])
    ),
  },
  byMarginTier: byMargin,
  byEvTier: byEv,
  counterfactualDropGateTier: {
    dropMarginGateOnly: {
      deltaUsdVsBaseline: cfMarginDelta,
      ...cf.dropMarginGateOnly,
    },
    dropEvGateOnly: {
      deltaUsdVsBaseline: cfEvDelta,
      ...cf.dropEvGateOnly,
    },
    dropBothGateTiers: {
      deltaUsdVsBaseline:
        (cf.dropBothGateTiers.kept.usd50 ?? 0) - (baseline.usd50 ?? 0),
      ...cf.dropBothGateTiers,
    },
  },
  interpretation,
};

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log('=== Locked B edge-tier diagnostic ===');
console.log('baseline', baseline);
console.log('--- margin tiers ---');
for (const t of MARGIN_TIERS) {
  const x = byMargin[t.key].overall;
  console.log(t.label, x);
}
console.log('--- EV tiers ---');
for (const t of EV_TIERS) {
  const x = byEv[t.key].overall;
  console.log(t.label, x);
}
console.log('--- counterfactual drop gate tier ---');
console.log('drop margin gate Δ$', cfMarginDelta, cf.dropMarginGateOnly.kept);
console.log('drop EV gate Δ$', cfEvDelta, cf.dropEvGateOnly.kept);
console.log('VERDICT:', interpretation.verdict);
console.log('flags:', interpretation.flags);
console.log('wrote', outPath);
