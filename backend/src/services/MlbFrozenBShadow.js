/**
 * 鎖定 B 疊加層：frozen_b+shrink（2026-07-30 升格為正式）
 *
 * 協定：
 * - 殘差只修客隊均值：a=0，b 來自 2025 前 70% 擬合 × val 選 scale=0.25
 * - 毒切片（客選且 homeWinPct≥65% 且 P≥55%）再 shrink_p55@0.45
 * - 係數凍結；禁止為抬美元再掃 w／scale
 * - 回滾：MLB_LOCKED_B_OVERLAY=false（回到升格前的純 ev02_max230）
 * - 之後新想法另開影子觀察，勿直接改本層常數
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../db/database.js';
import { config } from '../config.js';
import { MLB_BASELINE_FEATURE_VERSION } from './MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
  calibrateMlbScoreMarkets,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
} from './MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from './MlbGameRegimeService.js';
import { resolvePitOdds } from './PitOddsService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, '../../tmp-frozen-b-shadow-report.json');

/** @type {const} */
export const MLB_FROZEN_B_SHADOW_SPEC = Object.freeze({
  id: 'frozen_b+shrink',
  freezeDate: '2026-07-29',
  promotedAt: '2026-07-30',
  lockId: 'B-baseline-2026-07-30',
  role: 'formal_locked',
  wireSuggested: true,
  residual: Object.freeze({
    a: 0,
    /** ab.b * scaleB；來源 auditMlbFrozenShadowBvsAb */
    b: -0.060462727681765915,
    fitWindow: '2025-04-01..2025-09-30',
    fitProtocol: 'ridge50 on first 70%; scale selected on last 30% (mode=b)',
    scale: 0.25,
    abHatB: -0.24185091072706366,
  }),
  shrink: Object.freeze({
    w: 0.45,
    modelProbMin: 0.55,
    strongHomeWinPct: 0.65,
    policy: 'toxic_away_rank_pool_then_p_ge55',
  }),
  selection: Object.freeze({
    profile: 'ev02_max230',
    minimumH2hBookmakers: 2,
    dropThirdIfMarginBelow: 0.5,
    dropSecondIfOddsBelow: 1.95,
    dropSecondIfOddsMin: 1.85,
  }),
  paperEvidenceUsd50: Object.freeze({
    bets: 611,
    hitRate: 0.5532,
    roi: 0.1312,
    usd50: 4007,
    byWindow: Object.freeze({
      '2024': Object.freeze({ bets: 251, hitRate: 0.51, usd50: 602 }),
      '2025': Object.freeze({ bets: 216, hitRate: 0.5648, usd50: 1724 }),
      '2026': Object.freeze({ bets: 144, hitRate: 0.6111, usd50: 1681 }),
    }),
    windowNote: '2024-04～09 + 2025-04～09 + 2026-04～07-22 PIT；相對升格前 B 合計 +$1,033',
  }),
  note:
    '已升格為正式鎖定 B 疊加層；之後優化請另開影子觀察，勿改本常數。回滾：MLB_LOCKED_B_OVERLAY=false',
});

/** @deprecated 別名：與 MLB_FROZEN_B_SHADOW_SPEC 相同（升格後仍保留舊名） */
export const MLB_LOCKED_B_OVERLAY_SPEC = MLB_FROZEN_B_SHADOW_SPEC;

export function isMlbLockedBOverlayEnabled() {
  return config.mlbLockedBOverlayEnabled !== false;
}

const B = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: MLB_FROZEN_B_SHADOW_SPEC.selection.minimumH2hBookmakers,
};
const DROP_R3 = MLB_FROZEN_B_SHADOW_SPEC.selection.dropThirdIfMarginBelow;
const DROP_R2_MAX = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsBelow;
const DROP_R2_MIN = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsMin;
const STAKE = 50;
const STRONG = MLB_FROZEN_B_SHADOW_SPEC.shrink.strongHomeWinPct;
const SHRINK_W = MLB_FROZEN_B_SHADOW_SPEC.shrink.w;
const SHRINK_THR = MLB_FROZEN_B_SHADOW_SPEC.shrink.modelProbMin;
const RES_A = MLB_FROZEN_B_SHADOW_SPEC.residual.a;
const RES_B = MLB_FROZEN_B_SHADOW_SPEC.residual.b;

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

/**
 * 對 v4.5 預測套用凍結殘差（a=0,b 固定）並重算市場機率。
 */
export function applyFrozenResidualToPrediction(model, base, xHome, marketOptions = {}) {
  const a = RES_A;
  const b = RES_B;
  if (a === 0 && b === 0) {
    return {
      homeExpectedRuns: base.homeExpectedRuns,
      awayExpectedRuns: base.awayExpectedRuns,
      markets: base.markets,
    };
  }
  const homeMean = Math.max(1.5, base.homeExpectedRuns + a * xHome);
  const awayMean = Math.max(1.5, base.awayExpectedRuns + b * xHome);
  const totalLine = Number(marketOptions.totalLine ?? base.markets?.total?.line ?? 8.5);
  const distribution = buildMlbScoreDistribution({
    homeMean,
    awayMean,
    homeDispersion: model.dispersion,
    awayDispersion: model.dispersion,
  });
  const rawMarkets = deriveMlbScoreMarkets(distribution, { totalLine });
  return {
    homeExpectedRuns: homeMean,
    awayExpectedRuns: awayMean,
    markets: calibrateMlbScoreMarkets(rawMarkets, model.moneylineTemperature),
  };
}

/**
 * 正式路徑：在 predictMlbGameRuns 之後套用鎖定殘差（可由 env 關閉）。
 */
export function applyFormalLockedBResidual(model, prediction, features, marketOptions = {}) {
  if (!prediction || !isMlbLockedBOverlayEnabled()) return prediction;
  const homeWinPct = Number(features?.home?.homeWinPct);
  if (!Number.isFinite(homeWinPct)) {
    return {
      ...prediction,
      lockedBOverlay: {
        id: MLB_FROZEN_B_SHADOW_SPEC.id,
        residualApplied: false,
        reason: 'homeWinPct_missing',
      },
    };
  }
  const xHome = homeWinPct - 0.5;
  const adjusted = applyFrozenResidualToPrediction(model, prediction, xHome, marketOptions);
  return {
    ...prediction,
    homeExpectedRuns: adjusted.homeExpectedRuns,
    awayExpectedRuns: adjusted.awayExpectedRuns,
    expectedTotal: adjusted.homeExpectedRuns + adjusted.awayExpectedRuns,
    markets: adjusted.markets,
    lockedBOverlay: {
      id: MLB_FROZEN_B_SHADOW_SPEC.id,
      residualApplied: true,
      a: RES_A,
      b: RES_B,
      xHome,
      homeWinPct,
    },
  };
}

export function applyFrozenToxicShrink(modelProb, pickOdds, { pickHome, homeWinPct }) {
  const toxicAway = !pickHome && (homeWinPct ?? 0) >= STRONG;
  if (!toxicAway || modelProb < SHRINK_THR) return modelProb;
  const market = 1 / pickOdds;
  return modelProb * (1 - SHRINK_W) + market * SHRINK_W;
}

/**
 * 正式路徑毒切片收縮（可由 env 關閉）。
 */
export function applyFormalToxicAwayShrink(modelProb, pickOdds, ctx) {
  if (!isMlbLockedBOverlayEnabled()) return modelProb;
  return applyFrozenToxicShrink(modelProb, pickOdds, ctx);
}

function loadPool(from, to, model) {
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
  const out = [];
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
    const base = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((x, y) => x.vig - y.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) continue;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    const homeWinPct = Number(features?.home?.homeWinPct);
    if (!Number.isFinite(homeWinPct)) continue;
    const sig = buildPregameRegimeSignals(features);
    out.push({
      gameId: row.gameId,
      window: from.slice(0, 4),
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      homeWon: hs > as,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      homeWinPct,
      xHome: homeWinPct - 0.5,
      base,
      homeEarly: +sig.homeEarlyExitsLast3 || 0,
      awayEarly: +sig.awayEarlyExitsLast3 || 0,
    });
  }
  return out;
}

function selectVariant(pool, model, { shadow = false } = {}) {
  const byDay = new Map();
  for (const g of pool) {
    const pred = shadow
      ? applyFrozenResidualToPrediction(model, g.base, g.xHome)
      : {
          homeExpectedRuns: g.base.homeExpectedRuns,
          awayExpectedRuns: g.base.awayExpectedRuns,
          markets: g.base.markets,
        };
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? g.homeOdds : g.awayOdds;
    if (pickOdds < 1.4 || pickOdds > (B.maximumPickOdds ?? 2.5)) continue;
    if ((pickHome ? g.homeEarly : g.awayEarly) > (pickHome ? g.awayEarly : g.homeEarly)) {
      continue;
    }
    if (shadow) {
      modelProb = applyFrozenToxicShrink(modelProb, pickOdds, {
        pickHome,
        homeWinPct: g.homeWinPct,
      });
    }
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
      window: g.window,
      day: g.day,
      month: g.month,
      matchup: `${g.awayTeam} @ ${g.homeTeam}`,
      pickHome,
      pick: pickHome ? g.homeTeam : g.awayTeam,
      pickOdds,
      modelProb,
      ev,
      margin,
      bScore,
      homeWinPct: g.homeWinPct,
      hit: pickHome ? g.homeWon : !g.homeWon,
    });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (x, y) => y.bScore - x.bScore || y.margin - x.margin
    );
    applyDrop(arr).forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

function packSide(bets, rawBets) {
  const byWindow = {};
  for (const y of ['2024', '2025', '2026']) {
    const b = bets.filter((x) => x.window === y);
    const r = rawBets.filter((x) => x.window === y);
    byWindow[y] = {
      ...summarize(b),
      deltaUsd: summarize(b).usd50 - summarize(r).usd50,
    };
  }
  const months = [...new Set(bets.map((b) => b.month))].sort();
  const byMonth = months.map((m) => {
    const b = bets.filter((x) => x.month === m);
    const r = rawBets.filter((x) => x.month === m);
    return {
      month: m,
      locked: summarize(r),
      shadow: summarize(b),
      deltaUsd: summarize(b).usd50 - summarize(r).usd50,
    };
  });
  const oosB = bets.filter((x) => x.window === '2024' || x.window === '2026');
  const oosR = rawBets.filter((x) => x.window === '2024' || x.window === '2026');
  return {
    overall: summarize(bets),
    deltaUsd: summarize(bets).usd50 - summarize(rawBets).usd50,
    byWindow,
    byMonth,
    oos2426: {
      ...summarize(oosB),
      deltaUsd: summarize(oosB).usd50 - summarize(oosR).usd50,
    },
  };
}

function dayDiffs(locked, shadow) {
  const days = [...new Set([...locked, ...shadow].map((b) => b.day))].sort();
  const diffs = [];
  for (const day of days) {
    const L = locked.filter((b) => b.day === day);
    const S = shadow.filter((b) => b.day === day);
    const lKeys = new Set(L.map((b) => `${b.gameId}|${b.pickHome ? 'H' : 'A'}`));
    const sKeys = new Set(S.map((b) => `${b.gameId}|${b.pickHome ? 'H' : 'A'}`));
    const same =
      lKeys.size === sKeys.size && [...lKeys].every((k) => sKeys.has(k));
    if (same) continue;
    diffs.push({
      day,
      locked: L.map((b) => ({
        gameId: b.gameId,
        matchup: b.matchup,
        pick: b.pick,
        odds: b.pickOdds,
        hit: b.hit,
        rank: b.rank,
      })),
      shadow: S.map((b) => ({
        gameId: b.gameId,
        matchup: b.matchup,
        pick: b.pick,
        odds: b.pickOdds,
        hit: b.hit,
        rank: b.rank,
      })),
      lockedUsd: summarize(L).usd50,
      shadowUsd: summarize(S).usd50,
      deltaUsd: summarize(S).usd50 - summarize(L).usd50,
    });
  }
  return diffs;
}

/**
 * 回傳鎖定 B／凍結影子的日內選注清單（供 HR-first 等後處理實驗）。
 */
export function buildFrozenBShadowPickSets({
  windows = [
    { key: '2024', from: '2024-04-01', to: '2024-09-30' },
    { key: '2025', from: '2025-04-01', to: '2025-09-30' },
    { key: '2026', from: '2026-04-01', to: '2026-07-22' },
  ],
} = {}) {
  const validation = getLatestMlbExpectedRunsValidation();
  const model = validation.model;
  const pools = [];
  for (const w of windows) {
    pools.push(
      ...loadPool(w.from, w.to, model).map((x) => ({ ...x, window: w.key }))
    );
  }
  return {
    model,
    locked: selectVariant(pools, model, { shadow: false }),
    shadow: selectVariant(pools, model, { shadow: true }),
  };
}

/**
 * 完整 PIT 對照報表（較慢；供腳本寫入快照）。
 */
export function buildFrozenBShadowPitReport({
  windows = [
    { key: '2024', from: '2024-04-01', to: '2024-09-30' },
    { key: '2025', from: '2025-04-01', to: '2025-09-30' },
    { key: '2026', from: '2026-04-01', to: '2026-07-22' },
  ],
  recentDiffDays = 45,
} = {}) {
  const { locked, shadow } = buildFrozenBShadowPickSets({ windows });
  const lockedPack = packSide(locked, locked);
  const shadowPack = packSide(shadow, locked);

  const allDays = [...new Set([...locked, ...shadow].map((b) => b.day))].sort();
  const cutoff = allDays.slice(-recentDiffDays)[0] || allDays[0];
  const recentLocked = locked.filter((b) => b.day >= cutoff);
  const recentShadow = shadow.filter((b) => b.day >= cutoff);
  const diffs = dayDiffs(recentLocked, recentShadow);

  return {
    mode: 'frozen_b_shadow_observation',
    generatedAt: new Date().toISOString(),
    spec: MLB_FROZEN_B_SHADOW_SPEC,
    stakeUsd: STAKE,
    lockedB: {
      overall: lockedPack.overall,
      byWindow: lockedPack.byWindow,
    },
    shadow: {
      overall: shadowPack.overall,
      deltaUsd: shadowPack.deltaUsd,
      byWindow: shadowPack.byWindow,
      oos2426: shadowPack.oos2426,
      byMonth: shadowPack.byMonth,
    },
    recentDiff: {
      fromDay: cutoff,
      daysCompared: recentDiffDays,
      changedDays: diffs.length,
      sumDeltaUsd: diffs.reduce((s, d) => s + d.deltaUsd, 0),
      days: diffs.slice(-20),
    },
    operatingRules: [
      '影子不寫入 mlb_paper_bets',
      '不改 ev02_max230／v4.5',
      '禁止為抬美元再掃 residual.b／shrink.w',
      '正式下注仍只看鎖定 B',
    ],
  };
}

export function writeFrozenBShadowReportSnapshot(report) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(report, null, 2));
  return SNAPSHOT_PATH;
}

export function loadFrozenBShadowReportSnapshot() {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return null;
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 給 path γ／API 用的輕量摘要（優先讀快照，避免每次 PIT）。
 */
export function getFrozenBShadowObservationSummary() {
  const snap = loadFrozenBShadowReportSnapshot();
  const base = {
    available: true,
    status: 'promoted_to_formal_lock',
    spec: MLB_FROZEN_B_SHADOW_SPEC,
    overlayEnabled: isMlbLockedBOverlayEnabled(),
    note: isMlbLockedBOverlayEnabled()
      ? 'frozen_b+shrink 已是正式鎖定 B 疊加；之後新優化請另開影子。回滾：MLB_LOCKED_B_OVERLAY=false'
      : '疊加已關閉（MLB_LOCKED_B_OVERLAY=false）；目前為升格前純 ev02_max230',
  };
  if (!snap) {
    return {
      ...base,
      snapshotAvailable: false,
      paperEvidence: MLB_FROZEN_B_SHADOW_SPEC.paperEvidenceUsd50,
    };
  }
  return {
    ...base,
    snapshotAvailable: true,
    generatedAt: snap.generatedAt,
    lockedOverall: snap.shadow?.overall ?? snap.lockedB?.overall ?? null,
    legacyRawOverall: snap.lockedB?.overall ?? null,
    deltaUsdVsLegacyRaw: snap.shadow?.deltaUsd ?? null,
    oos2426: snap.shadow?.oos2426 ?? null,
    byWindow: snap.shadow?.byWindow ?? null,
    recentDiff: snap.recentDiff
      ? {
          fromDay: snap.recentDiff.fromDay,
          changedDays: snap.recentDiff.changedDays,
          sumDeltaUsd: snap.recentDiff.sumDeltaUsd,
          latestDays: (snap.recentDiff.days || []).slice(-5),
        }
      : null,
    operatingRules: [
      'frozen_b+shrink 已升格為正式鎖定疊加',
      '禁止再掃 residual.b／shrink.w 當日常調參',
      '新想法另開影子觀察後再談升格',
    ],
  };
}
