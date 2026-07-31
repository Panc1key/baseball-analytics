/**
 * 診斷：鎖定 B 入選單「模型 vs 市場分歧度」
 *
 * disagreement = model_p − market_implied_p
 * market_implied_p = 1 / pickOdds（選邊隱含；可回放）
 *
 * 分桶：按 disagreement 五等頻；並標「高分歧」= 上五分位
 *
 * 用法: node scripts/auditMlbModelMarketDisagreementDiag.mjs
 * 產物: tmp-model-market-disagreement-diag.json
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
const outPath = path.join(__dirname, '../tmp-model-market-disagreement-diag.json');

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
const N_BUCKETS = 5;

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
    return {
      bets: 0,
      hitRate: null,
      avgOdds: null,
      avgModelP: null,
      avgMarketP: null,
      avgDisagreement: null,
      calibrationError: null,
      avgEv: null,
      avgMargin: null,
      homePickShare: null,
      roi: null,
      usd50: 0,
      usd50PerBet: null,
    };
  }
  let hits = 0;
  let unit = 0;
  let odds = 0;
  let modelP = 0;
  let marketP = 0;
  let dis = 0;
  let ev = 0;
  let margin = 0;
  let home = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    modelP += b.modelProb;
    marketP += b.marketImplied;
    dis += b.disagreement;
    ev += b.ev;
    margin += b.margin;
    if (b.pickHome) home += 1;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  const avgModelP = modelP / n;
  const actualHitRate = hits / n;
  return {
    bets: n,
    hitRate: Number(actualHitRate.toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    avgModelP: Number(avgModelP.toFixed(4)),
    avgMarketP: Number((marketP / n).toFixed(4)),
    avgDisagreement: Number((dis / n).toFixed(4)),
    calibrationError: Number((actualHitRate - avgModelP).toFixed(4)),
    avgEv: Number((ev / n).toFixed(4)),
    avgMargin: Number((margin / n).toFixed(4)),
    homePickShare: Number((home / n).toFixed(4)),
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

function assignQuintiles(rows, valueKey) {
  const indexed = rows
    .map((r, i) => ({ i, v: r[valueKey] }))
    .sort((a, b) => a.v - b.v || a.i - b.i);
  const n = indexed.length;
  const bucketOfIndex = new Array(n);
  for (let rank = 0; rank < n; rank += 1) {
    bucketOfIndex[indexed[rank].i] = Math.min(
      N_BUCKETS,
      Math.floor((rank * N_BUCKETS) / n) + 1
    );
  }
  const ranges = {};
  for (let b = 1; b <= N_BUCKETS; b += 1) ranges[b] = [];
  const out = rows.map((r, i) => {
    const bucket = bucketOfIndex[i];
    ranges[bucket].push(r[valueKey]);
    return { ...r, bucket };
  });
  const edges = {};
  for (let b = 1; b <= N_BUCKETS; b += 1) {
    const g = ranges[b].sort((a, c) => a - c);
    edges[b] = g.length
      ? {
          min: Number(g[0].toFixed(4)),
          max: Number(g[g.length - 1].toFixed(4)),
          n: g.length,
        }
      : null;
  }
  return { rows: out, edges };
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
    const marketImplied = 1 / pickOdds;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({
      gameId: g.gameId,
      day: g.day,
      window: g.window,
      pickHome,
      pickOdds,
      modelProb,
      marketImplied,
      disagreement: modelProb - marketImplied,
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
const { rows: bucketed, edges } = assignQuintiles(bets, 'disagreement');

const labels = {
  1: '最低分歧（模型相對市場最不自信／甚至更悲觀）',
  2: '偏低分歧',
  3: '中等分歧',
  4: '偏高分歧',
  5: '最高分歧（模型明顯比市場更自信）',
};

const byBucket = {};
for (let b = 1; b <= N_BUCKETS; b += 1) {
  const subset = bucketed.filter((x) => x.bucket === b);
  byBucket[b] = {
    label: labels[b],
    disagreementRange: edges[b],
    overall: summarize(subset),
    byWindow: Object.fromEntries(
      WINDOWS.map((w) => [
        w.key,
        summarize(subset.filter((x) => x.window === w.key)),
      ])
    ),
    bySide: {
      home: summarize(subset.filter((x) => x.pickHome)),
      away: summarize(subset.filter((x) => !x.pickHome)),
    },
  };
}

const baseline = summarize(bets);
const high = byBucket[5].overall;
const low = byBucket[1].overall;
const mid = summarize(bucketed.filter((x) => x.bucket >= 2 && x.bucket <= 4));

// 固定切點對照：disagreement ≥ 0.08 / ≥ 0.10（若樣本允許）
const fixedCuts = {
  'dis>=0.05': summarize(bets.filter((b) => b.disagreement >= 0.05)),
  'dis>=0.08': summarize(bets.filter((b) => b.disagreement >= 0.08)),
  'dis>=0.10': summarize(bets.filter((b) => b.disagreement >= 0.1)),
  'dis<0.02': summarize(bets.filter((b) => b.disagreement < 0.02)),
};

function isMateriallyWorse(tier, base) {
  if (!tier?.bets || tier.bets < 25) return { worse: false, reason: 'thin' };
  const hrGap = (base.hitRate ?? 0) - (tier.hitRate ?? 0);
  const usdGap = (base.usd50PerBet ?? 0) - (tier.usd50PerBet ?? 0);
  const worse = hrGap >= 0.04 || usdGap >= 5;
  return {
    worse,
    hrGap: Number(hrGap.toFixed(4)),
    usdPerBetGap: Number(usdGap.toFixed(2)),
  };
}

const highJudge = isMateriallyWorse(high, baseline);
const lowJudge = isMateriallyWorse(low, baseline);
// 單調：桶5每注$ 是否明顯低於桶1
const monotonicDrag =
  high.usd50PerBet != null &&
  low.usd50PerBet != null &&
  low.usd50PerBet - high.usd50PerBet >= 5;

function interpret() {
  let verdict;
  if (highJudge.worse && monotonicDrag) {
    verdict =
      '高分歧桶穩定更差（相對基線＋相對低分歧桶）：模型相對市場過度自信有拖累，可討論是否當軟風險信號（先影子）。';
  } else if (highJudge.worse && !monotonicDrag) {
    verdict =
      '高分歧桶相對基線偏弱，但與低分歧對比不乾淨；可當弱信號，暫不急著處理。';
  } else if (!highJudge.worse) {
    verdict =
      '高分歧桶沒有穩定更差：模型−市場分歧度不是當前主要拖累，本條可快速收束。';
  } else {
    verdict = '分歧度分桶未給出清晰拖累；收束。';
  }
  return {
    verdict,
    flags: {
      highDisagreementWorseVsBaseline: highJudge.worse,
      highJudge,
      lowJudge,
      monotonicHighWorseThanLow: monotonicDrag,
      highPerBet: high.usd50PerBet,
      lowPerBet: low.usd50PerBet,
      baselinePerBet: baseline.usd50PerBet,
    },
  };
}

const interpretation = interpret();

const report = {
  generatedAt: new Date().toISOString(),
  modelVersion: validation.modelVersion,
  note:
    '只診斷；不改選注／模型。disagreement = model_p − 1/pickOdds（鎖B殘差+毒縮後的選邊P）。',
  spec: {
    disagreement: 'model_p - market_implied_p',
    marketImplied: '1 / pickOdds',
    buckets: '5 等頻五分位（1=最低分歧，5=最高分歧／模型更自信）',
    worseRule: '相對基線：勝率低≥4pp 或 每注@$50 低≥$5；且 n≥25',
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
  byDisagreementQuintile: byBucket,
  contrasts: {
    highDisagreement_q5: high,
    lowDisagreement_q1: low,
    mid_q2_to_q4: mid,
    fixedCuts,
  },
  interpretation,
};

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log('=== Model−market disagreement diagnostic ===');
console.log('baseline', baseline);
for (let b = 1; b <= N_BUCKETS; b += 1) {
  const x = byBucket[b];
  console.log(
    `Q${b} ${x.disagreementRange.min}..${x.disagreementRange.max}`,
    x.overall
  );
}
console.log('fixedCuts', fixedCuts);
console.log('VERDICT:', interpretation.verdict);
console.log('flags:', interpretation.flags);
console.log('wrote', outPath);
