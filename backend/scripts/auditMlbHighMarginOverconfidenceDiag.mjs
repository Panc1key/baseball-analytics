/**
 * 診斷：鎖定 B「高 margin≥0.60」為何自信卻打不準？
 *
 * 只診斷、不改正式。
 * 維度：1) 主選 vs 客選  2) 先發 ERA gap 大錯配  3) 賠率帶 vs 分差
 *
 * 用法: node scripts/auditMlbHighMarginOverconfidenceDiag.mjs
 * 產物: tmp-high-margin-overconfidence-diag.json
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
const outPath = path.join(__dirname, '../tmp-high-margin-overconfidence-diag.json');

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
/** |gap| 超過全體高 margin 單的上三分位 → 大錯配（可回放） */
const BIG_MISMATCH_ABS_GAP_FALLBACK = 2.0;

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

function oddsBand(odds) {
  if (odds < 1.9) return '1.85-1.90';
  if (odds < 2.05) return '1.90-2.05';
  if (odds < 2.15) return '2.05-2.15';
  return '2.15-2.30';
}

function pack(bets) {
  if (!bets.length) {
    return {
      n: 0,
      modelP: null,
      actualHitRate: null,
      calibrationError: null,
      avgOdds: null,
      avgEv: null,
      avgMargin: null,
      avgAbsEraGap: null,
      usd50: 0,
      roi: null,
    };
  }
  let hits = 0;
  let unit = 0;
  let p = 0;
  let odds = 0;
  let ev = 0;
  let margin = 0;
  let absGap = 0;
  let gapN = 0;
  for (const b of bets) {
    p += b.modelProb;
    odds += b.pickOdds;
    ev += b.ev;
    margin += b.margin;
    if (b.absEraGap != null) {
      absGap += b.absEraGap;
      gapN += 1;
    }
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  const modelP = p / n;
  const actualHitRate = hits / n;
  return {
    n,
    modelP: Number(modelP.toFixed(4)),
    actualHitRate: Number(actualHitRate.toFixed(4)),
    calibrationError: Number((actualHitRate - modelP).toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    avgEv: Number((ev / n).toFixed(4)),
    avgMargin: Number((margin / n).toFixed(4)),
    avgAbsEraGap: gapN ? Number((absGap / gapN).toFixed(3)) : null,
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
    usd50PerBet: Number(((unit * STAKE) / n).toFixed(2)),
  };
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
      homeExpectedRuns: ph,
      awayExpectedRuns: pa,
      eraGap: g.eraGap,
      absEraGap: g.absEraGap,
      marketImpliedPick: 1 / pickOdds,
      modelMinusMarket: modelProb - 1 / pickOdds,
      oddsBand: oddsBand(pickOdds),
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
    let eraGap = null;
    let absEraGap = null;
    if (homeEra != null && homeEra > 0 && awayEra != null && awayEra > 0) {
      // strength = -ERA；gap = home_strength - away_strength = awayEra - homeEra
      eraGap = awayEra - homeEra;
      absEraGap = Math.abs(eraGap);
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
      eraGap,
      absEraGap,
    });
  }
}

const allBets = selectLockedB(pool);
const high = allBets.filter((b) => b.margin >= HIGH_MARGIN);
const lowGate = allBets.filter((b) => b.margin >= 0.25 && b.margin < 0.4);

const absGaps = high.map((b) => b.absEraGap).filter((x) => x != null).sort((a, b) => a - b);
const bigMismatchCut =
  absGaps.length >= 3
    ? absGaps[Math.floor((absGaps.length * 2) / 3)]
    : BIG_MISMATCH_ABS_GAP_FALLBACK;

for (const b of high) {
  b.bigMismatch = b.absEraGap != null && b.absEraGap >= bigMismatchCut;
}

const homePicks = high.filter((b) => b.pickHome);
const awayPicks = high.filter((b) => !b.pickHome);
const bigMis = high.filter((b) => b.bigMismatch);
const notBigMis = high.filter((b) => b.absEraGap != null && !b.bigMismatch);

const requiredTable = {
  '高margin × 主選': pack(homePicks),
  '高margin × 客選': pack(awayPicks),
  '高margin × 大錯配': pack(bigMis),
  '高margin × 非大錯配': pack(notBigMis),
};

const byOddsBand = {};
for (const band of ['1.85-1.90', '1.90-2.05', '2.05-2.15', '2.15-2.30']) {
  byOddsBand[band] = pack(high.filter((b) => b.oddsBand === band));
}

// 模型分差大但市場不極端：挑邊隱含機率仍接近 0.5（賠率 1.9–2.2）
const softMarketLargeMargin = high.filter(
  (b) => b.pickOdds >= 1.9 && b.pickOdds <= 2.2
);
const extremeMarket = high.filter((b) => b.pickOdds < 1.9 || b.pickOdds > 2.2);

const modelVsMarket = {
  avgModelP: pack(high).modelP,
  avgMarketImplied: high.length
    ? Number(
        (high.reduce((s, b) => s + b.marketImpliedPick, 0) / high.length).toFixed(4)
      )
    : null,
  avgModelMinusMarket: high.length
    ? Number(
        (high.reduce((s, b) => s + b.modelMinusMarket, 0) / high.length).toFixed(4)
      )
    : null,
  softMarket_odds_1_90_to_2_20: pack(softMarketLargeMargin),
  moreExtremeOdds: pack(extremeMarket),
  // 對照：剛過閘檔的 model−market
  lowMarginGate_modelMinusMarket: lowGate.length
    ? Number(
        (
          lowGate.reduce((s, b) => s + (b.modelProb - 1 / b.pickOdds), 0) /
          lowGate.length
        ).toFixed(4)
      )
    : null,
};

function interpret() {
  const home = requiredTable['高margin × 主選'];
  const away = requiredTable['高margin × 客選'];
  const big = requiredTable['高margin × 大錯配'];
  const notBig = requiredTable['高margin × 非大錯配'];
  const overall = pack(high);

  const sideHomeWorse =
    home.n >= 15 &&
    home.calibrationError != null &&
    home.calibrationError < -0.04 &&
    (away.calibrationError == null || home.calibrationError < away.calibrationError - 0.03);
  const sideAwayWorse =
    away.n >= 30 &&
    away.calibrationError != null &&
    away.calibrationError < -0.04 &&
    (home.calibrationError == null || away.calibrationError < home.calibrationError - 0.03);
  const mismatchConcentrated =
    big.n >= 20 &&
    big.calibrationError != null &&
    notBig.calibrationError != null &&
    big.calibrationError < notBig.calibrationError - 0.04;
  const bothSidesWeak =
    home.calibrationError != null &&
    away.calibrationError != null &&
    home.calibrationError < -0.03 &&
    away.calibrationError < -0.03;
  const softMarketIssue =
    softMarketLargeMargin.length >= 40 &&
    pack(softMarketLargeMargin).calibrationError < -0.04;

  let primary;
  if (mismatchConcentrated && !bothSidesWeak) {
    primary = '大錯配先發切片';
  } else if (sideAwayWorse) {
    primary = '客選';
  } else if (sideHomeWorse) {
    primary = '主選';
  } else if (bothSidesWeak && softMarketIssue) {
    primary =
      '各邊都偏弱＋「分差大但賠率仍接近均勢」：高分差整體校准／市場對齊問題';
  } else if (bothSidesWeak) {
    primary = '主客選都偏弱：更像高分差整體过度自信，非單一選邊';
  } else if (softMarketIssue) {
    primary = '高 margin 但賠率不極端（模型比市場自信）';
  } else {
    primary = '未見單一主導切片；高 margin 整體偏弱但來源分散';
  }

  const verdict =
    `高 margin 過度自信主要來自「${primary}」。` +
    ` 整體誤差 ${overall.calibrationError}（P ${overall.modelP} vs 實際 ${overall.actualHitRate}）。`;

  return {
    verdict,
    primarySource: primary,
    flags: {
      sideHomeWorse,
      sideAwayWorse,
      bothSidesWeak,
      mismatchConcentrated,
      softMarketIssue,
      bigMismatchCutAbsEraGap: bigMismatchCut,
    },
  };
}

const interpretation = interpret();

const report = {
  generatedAt: new Date().toISOString(),
  modelVersion: validation.modelVersion,
  note: '只診斷；不改模型／選注。eraGap = awayERA − homeERA（= home_strength − away_strength，strength=-ERA）。大錯配 = |gap| ≥ 高margin樣本上三分位。',
  sample: {
    lockedBets: allBets.length,
    highMarginN: high.length,
    lowMarginGateN: lowGate.length,
    bigMismatchCutAbsEraGap: Number(bigMismatchCut.toFixed(4)),
    bigMismatchN: bigMis.length,
    windows: WINDOWS,
  },
  highMarginOverall: pack(high),
  lowMarginGateContrast: pack(lowGate),
  requiredTable,
  byOddsBand,
  modelVsMarket,
  byWindow: Object.fromEntries(
    WINDOWS.map((w) => [w.key, pack(high.filter((b) => b.window === w.key))])
  ),
  interpretation,
};

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log('=== High-margin overconfidence diagnostic ===');
console.log('high n=', high.length, 'overall', pack(high));
console.log('contrast low-gate', pack(lowGate));
console.log('bigMismatchCut |eraGap|≥', bigMismatchCut.toFixed(3));
console.log('--- required table ---');
for (const [k, v] of Object.entries(requiredTable)) {
  console.log(k, v);
}
console.log('--- odds bands ---');
console.log(byOddsBand);
console.log('--- model vs market ---');
console.log(modelVsMarket);
console.log('VERDICT:', interpretation.verdict);
console.log('wrote', outPath);
