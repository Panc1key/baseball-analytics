/**
 * 診斷：先發質量差（gap）下的模型主勝率校準
 *
 * 只診斷、不改模型、不改選注。
 * 優先代理：pitcher_strength = -ERA；gap = home_strength - away_strength
 *
 * 用法: node scripts/auditMlbPitcherQualityGapCalibration.mjs
 * 產物: tmp-pitcher-quality-gap-calibration.json
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
const outPath = path.join(__dirname, '../tmp-pitcher-quality-gap-calibration.json');

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
  if (!bets.length) return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0 };
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

function strengthNegEra(pitcher) {
  const era = finite(pitcher?.era);
  if (era == null || era <= 0) return null;
  return -era;
}

function strengthNegWhip(pitcher) {
  const whip = finite(pitcher?.whip);
  if (whip == null || whip <= 0) return null;
  return -whip;
}

function assignBuckets(rows) {
  const indexed = rows
    .map((r, i) => ({ i, gap: r.gap }))
    .sort((a, b) => a.gap - b.gap || a.i - b.i);
  const n = indexed.length;
  const bucketOfIndex = new Array(n);
  for (let rank = 0; rank < n; rank += 1) {
    const b = Math.min(N_BUCKETS, Math.floor((rank * N_BUCKETS) / n) + 1);
    bucketOfIndex[indexed[rank].i] = b;
  }
  const gapByBucket = {};
  for (let b = 1; b <= N_BUCKETS; b += 1) gapByBucket[b] = [];
  const out = rows.map((r, i) => {
    const bucket = bucketOfIndex[i];
    gapByBucket[bucket].push(r.gap);
    return { ...r, bucket };
  });
  const gapEdges = {};
  for (let b = 1; b <= N_BUCKETS; b += 1) {
    const g = gapByBucket[b].sort((a, b) => a - b);
    gapEdges[b] = g.length ? { min: g[0], max: g[g.length - 1], n: g.length } : null;
  }
  return { rows: out, gapEdges };
}

function calibStats(rows) {
  if (!rows.length) {
    return {
      n: 0,
      modelPHomeMean: null,
      actualHomeWinRate: null,
      calibrationError: null,
      gapMean: null,
      homeEraMean: null,
      awayEraMean: null,
    };
  }
  let pSum = 0;
  let ySum = 0;
  let gapSum = 0;
  let homeEra = 0;
  let awayEra = 0;
  for (const r of rows) {
    pSum += r.modelPHome;
    ySum += r.homeWon ? 1 : 0;
    gapSum += r.gap;
    homeEra += r.homeEra;
    awayEra += r.awayEra;
  }
  const n = rows.length;
  const modelPHomeMean = pSum / n;
  const actualHomeWinRate = ySum / n;
  return {
    n,
    modelPHomeMean: Number(modelPHomeMean.toFixed(4)),
    actualHomeWinRate: Number(actualHomeWinRate.toFixed(4)),
    calibrationError: Number((actualHomeWinRate - modelPHomeMean).toFixed(4)),
    gapMean: Number((gapSum / n).toFixed(4)),
    homeEraMean: Number((homeEra / n).toFixed(3)),
    awayEraMean: Number((awayEra / n).toFixed(3)),
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
      bucket: g.bucket,
      gap: g.gap,
      pickHome,
      pickOdds,
      modelProb,
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

const games = [];
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
    features.homeTeam = row.homeTeam;
    features.awayTeam = row.awayTeam;
    const hs = +row.homeScore;
    const as = +row.awayScore;
    if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) continue;

    const homeP = features?.pitchers?.home;
    const awayP = features?.pitchers?.away;
    const homeStr = strengthNegEra(homeP);
    const awayStr = strengthNegEra(awayP);
    if (homeStr == null || awayStr == null) continue;

    const homeWhipStr = strengthNegWhip(homeP);
    const awayWhipStr = strengthNegWhip(awayP);

    const base = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const homeWinPct = Number(features?.home?.homeWinPct);
    const xHome = Number.isFinite(homeWinPct) ? homeWinPct - 0.5 : 0;
    const lockedPred = Number.isFinite(homeWinPct)
      ? applyFrozenResidualToPrediction(model, base, xHome)
      : base;

    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    let homeOdds = null;
    let awayOdds = null;
    if (bs.length >= 2) {
      bs.sort((a, b) => a.vig - b.vig);
      homeOdds = bs[0].homeOdds;
      awayOdds = bs[0].awayOdds;
    }
    const sig = buildPregameRegimeSignals(features);

    games.push({
      gameId: row.gameId,
      window: w.key,
      day: hk(row.commenceTime),
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      homeWon: hs > as,
      homeEra: finite(homeP.era),
      awayEra: finite(awayP.era),
      homeStrength: homeStr,
      awayStrength: awayStr,
      gap: homeStr - awayStr,
      gapWhip:
        homeWhipStr != null && awayWhipStr != null
          ? homeWhipStr - awayWhipStr
          : null,
      modelPHome: +lockedPred.markets.homeWinProbability,
      modelPHomeRaw: +base.markets.homeWinProbability,
      homeWinPct: Number.isFinite(homeWinPct) ? homeWinPct : null,
      homeOdds,
      awayOdds,
      homeEarly: +sig.homeEarlyExitsLast3 || 0,
      awayEarly: +sig.awayEarlyExitsLast3 || 0,
      lockedPred,
      hasBooks:
        homeOdds != null &&
        awayOdds != null &&
        homeOdds >= 1.2 &&
        awayOdds >= 1.2 &&
        (features?.pitchers?.homeIdentity?.id ?? features?.pitchers?.home?.id) != null &&
        (features?.pitchers?.awayIdentity?.id ?? features?.pitchers?.away?.id) != null &&
        Number.isFinite(homeWinPct),
    });
  }
}

const { rows: withBuckets, gapEdges } = assignBuckets(games);
const bucketLabels = {
  1: '客投明顯更強（gap 很負）',
  2: '客投略強',
  3: '接近均勢',
  4: '主投略強',
  5: '主投明顯更強（gap 很正）',
};

const byBucket = {};
for (let b = 1; b <= N_BUCKETS; b += 1) {
  const bucketRows = withBuckets.filter((r) => r.bucket === b);
  byBucket[b] = {
    label: bucketLabels[b],
    gapRange: gapEdges[b],
    ...calibStats(bucketRows),
    byWindow: Object.fromEntries(
      WINDOWS.map((w) => [
        w.key,
        calibStats(bucketRows.filter((r) => r.window === w.key)),
      ])
    ),
  };
}

const lockPool = withBuckets.filter((g) => g.hasBooks);
const lockedBets = selectLockedB(lockPool);
const lockedByBucket = {};
for (let b = 1; b <= N_BUCKETS; b += 1) {
  lockedByBucket[b] = {
    label: bucketLabels[b],
    ...summarize(lockedBets.filter((x) => x.bucket === b)),
  };
}

const extreme = {
  bucket1: byBucket[1],
  bucket5: byBucket[5],
  lockedB_bucket1: lockedByBucket[1],
  lockedB_bucket5: lockedByBucket[5],
};

function interpret() {
  const e1 = byBucket[1].calibrationError;
  const e5 = byBucket[5].calibrationError;
  const mid = [2, 3, 4].map((b) => Math.abs(byBucket[b].calibrationError || 0));
  const midMax = Math.max(...mid);
  const extremeOverconfident =
    (e1 != null && e1 < -0.03 && byBucket[1].modelPHomeMean > 0.5) ||
    (e5 != null && e5 < -0.03);
  // 桶1：客強 → 模型主勝 P 應偏低；若實際−P < 0 且 |誤差|大 → 模型高估主隊（對客強不夠敏感）
  // 桶5：主強 → 若實際−P < 0 → 模型高估主隊勝率（過度自信）
  const b1ModelTooHighOnHome = e1 != null && e1 < -0.03; // 實際主勝 < 模型P
  const b5ModelTooHighOnHome = e5 != null && e5 < -0.03;
  const b1ModelTooLowOnHome = e1 != null && e1 > 0.03;
  const b5ModelTooLowOnHome = e5 != null && e5 > 0.03;
  const extremesMessy =
    (Math.abs(e1 || 0) > 0.04 || Math.abs(e5 || 0) > 0.04) && midMax < 0.025;

  let verdict;
  if (b1ModelTooHighOnHome && b5ModelTooHighOnHome) {
    verdict =
      '極端桶兩邊都出現「模型主勝 P > 實際」：大錯配時模型偏自信，可考慮後續輕校准。';
  } else if (b1ModelTooLowOnHome && b5ModelTooLowOnHome) {
    verdict =
      '極端桶兩邊都出現「模型主勝 P < 實際」：大錯配時模型偏保守。';
  } else if (extremesMessy) {
    verdict =
      '中間桶校準尚可、極端桶誤差明顯：均值模型在先發質量尾部表現較差，值得單獨處理。';
  } else if (Math.abs(e1 || 0) < 0.03 && Math.abs(e5 || 0) < 0.03) {
    verdict =
      '各桶（含極端）校準誤差都不大：先發質量差目前不像主要矛盾，可換方向。';
  } else if (b5ModelTooHighOnHome || b1ModelTooHighOnHome) {
    verdict =
      '極端桶存在單側「模型高估主勝」跡象，但非對稱；先發錯配校準有問題、尚未到全面自信偏差。';
  } else if (b5ModelTooLowOnHome || b1ModelTooLowOnHome) {
    verdict =
      '極端桶存在單側「模型低估主勝」跡象；先發錯配校準有偏移，但非全面保守。';
  } else {
    verdict =
      '未見穩定、對稱的極端錯配校准偏差；先發質量差可能不是當前主矛盾。';
  }

  return {
    verdict,
    flags: {
      b1ModelTooHighOnHome,
      b5ModelTooHighOnHome,
      b1ModelTooLowOnHome,
      b5ModelTooLowOnHome,
      extremesMessy,
      extremeOverconfident,
    },
  };
}

const interpretation = interpret();

const report = {
  generatedAt: new Date().toISOString(),
  proxy: {
    strength: 'pitcher_strength = -ERA',
    gap: 'home_strength - away_strength（主投相對客投優勢；正=主投 ERA 更低）',
    buckets: '5 等頻五分位',
    modelP: '鎖定 B 殘差後主勝機率（與正式疊加一致）',
  },
  modelVersion: validation.modelVersion,
  sample: {
    gamesWithEraGap: withBuckets.length,
    lockedBEligiblePool: lockPool.length,
    lockedBets: lockedBets.length,
    windows: WINDOWS,
  },
  byBucket,
  lockedBByBucket: lockedByBucket,
  extreme,
  interpretation,
  note: '只診斷；不改模型、不改選注。',
};

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log('=== Pitcher quality gap calibration ===');
console.log('proxy: -ERA gap; games:', withBuckets.length);
console.log('bucket | n | gapMean | modelP | actual | error(actual-P)');
for (let b = 1; b <= N_BUCKETS; b += 1) {
  const x = byBucket[b];
  console.log(
    `${b} ${x.label} | ${x.n} | ${x.gapMean} | ${x.modelPHomeMean} | ${x.actualHomeWinRate} | ${x.calibrationError}`
  );
}
console.log('--- locked B extreme ---');
console.log('bucket1', lockedByBucket[1]);
console.log('bucket5', lockedByBucket[5]);
console.log('VERDICT:', interpretation.verdict);
console.log('wrote', outPath);
