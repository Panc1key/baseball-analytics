/**
 * frozen_v1 / min185 底座：放寬 B 門檻掃描（EV / margin / P / maxOdds / earlyExits）
 * 不動正式常數；僅腳本回放。
 * 閘門：合併 usd50 > 基線，且 2025、2026 都正；嚴格：雙窗都不低於基線
 * 產物：tmp-threshold-relax-on-frozen.json
 *
 * 用法: node scripts/auditMlbThresholdRelaxOnFrozen.mjs
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

const FROZEN = MLB_MONEYLINE_RULE_PROFILES.frozen_v1;
const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function hkDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function bestMl(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'h2h');
    if (!market?.outcomes?.length) continue;
    const home =
      market.outcomes.find((o) => o.name === homeTeam) ||
      market.outcomes.find((o) => String(o.name).includes(String(homeTeam).split(' ').pop()));
    const away =
      market.outcomes.find((o) => o.name === awayTeam) ||
      market.outcomes.find((o) => String(o.name).includes(String(awayTeam).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const vig = 1 / home.price + 1 / away.price;
    if (!best || vig < best.vig) best = { homeOdds: Number(home.price), awayOdds: Number(away.price) };
  }
  return best;
}

function summarize(bets) {
  if (!bets.length) return null;
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
  const days = new Set(bets.map((b) => b.day)).size;
  return {
    bets: n,
    bettingDays: days,
    avgBetsPerBettingDay: Number((n / days).toFixed(2)),
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    breakevenAtAvgOdds: Number((1 / (odds / n)).toFixed(4)),
    clearsOwnAvgOdds: hits / n > 1 / (odds / n),
    roi: Number((unit / n).toFixed(4)),
    unitPnl: Number(unit.toFixed(2)),
    usd50: Math.round(unit * 50),
    usd75: Math.round(unit * 75),
  };
}

/** 極寬宇宙：之後由各 variant 再卡門檻 */
function buildUniverse(fromDate, toDate) {
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
    .all(MLB_BASELINE_FEATURE_VERSION, fromDate, toDate);

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
    const ml = bestMl(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (!ml) continue;
    const pickOdds = pickHome ? ml.homeOdds : ml.awayOdds;
    if (!Number.isFinite(pickOdds)) continue;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    const signals = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? Number(signals.homeEarlyExitsLast3) || 0
      : Number(signals.awayEarlyExitsLast3) || 0;
    const oppEarly = pickHome
      ? Number(signals.awayEarlyExitsLast3) || 0
      : Number(signals.homeEarlyExitsLast3) || 0;
    const pitchers = features?.pitchers || {};
    const homeId = pitchers.homeIdentity?.id ?? pitchers.home?.id ?? null;
    const awayId = pitchers.awayIdentity?.id ?? pitchers.away?.id ?? null;
    const bothIds = homeId != null && awayId != null;

    pool.push({
      day: hkDate(row.commenceTime),
      window: fromDate.startsWith('2025') ? '2025' : '2026',
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      pickEarly,
      oppEarly,
      bothIds,
    });
  }
  return pool;
}

function passesVariant(g, v) {
  if (v.requireBothPitcherIdentities && !g.bothIds) return false;
  if (g.ev < v.minimumExpectedValue) return false;
  if (g.margin < v.minimumExpectedRunMargin) return false;
  if (g.modelProb < v.minimumModelProbability) return false;
  if (v.minimumPickOdds != null && g.pickOdds < v.minimumPickOdds) return false;
  if (v.maximumPickOdds != null && g.pickOdds > v.maximumPickOdds) return false;
  if (v.requirePickEarlyExitsNotHigher && g.pickEarly > g.oppEarly) return false;
  return true;
}

function select(pool, v) {
  const byDay = new Map();
  for (const g of pool) {
    if (!passesVariant(g, v)) continue;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({
      ...g,
      score: scoreMlbMoneylineDailyRank(
        { expectedValue: g.ev, modelProbability: g.modelProb },
        { ...FROZEN, ...v }
      ),
    });
  }
  const out = [];
  const topK = v.dailyTopK ?? FROZEN.dailyTopK;
  for (const day of [...byDay.keys()].sort()) {
    out.push(
      ...[...byDay.get(day)]
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return b.margin - a.margin;
        })
        .slice(0, topK)
    );
  }
  return out;
}

function variant(id, label, overrides) {
  return {
    id,
    label,
    minimumModelProbability: FROZEN.minimumModelProbability,
    minimumExpectedRunMargin: FROZEN.minimumExpectedRunMargin,
    minimumExpectedValue: FROZEN.minimumExpectedValue,
    minimumPickOdds: FROZEN.minimumPickOdds,
    maximumPickOdds: FROZEN.maximumPickOdds,
    requirePickEarlyExitsNotHigher: FROZEN.requirePickEarlyExitsNotHigher,
    requireBothPitcherIdentities: FROZEN.requireBothPitcherIdentities,
    dailyTopK: FROZEN.dailyTopK,
    highEvRankPenaltyLambda: FROZEN.highEvRankPenaltyLambda,
    highEvRankPenaltyMinEv: FROZEN.highEvRankPenaltyMinEv,
    highEvRankPenaltyProbMin: FROZEN.highEvRankPenaltyProbMin,
    highEvRankPenaltyProbMaxExclusive: FROZEN.highEvRankPenaltyProbMaxExclusive,
    ...overrides,
  };
}

const VARIANTS = [
  variant('baseline_frozen_v1', 'frozen_v1 基線', {}),

  // —— 單軸放寬 EV ——
  variant('ev_02', 'EV≥2%', { minimumExpectedValue: 0.02 }),
  variant('ev_01', 'EV≥1%', { minimumExpectedValue: 0.01 }),
  variant('ev_00', 'EV≥0%', { minimumExpectedValue: 0 }),

  // —— 單軸放寬 margin ——
  variant('margin_20', 'margin≥0.20', { minimumExpectedRunMargin: 0.2 }),
  variant('margin_15', 'margin≥0.15', { minimumExpectedRunMargin: 0.15 }),
  variant('margin_10', 'margin≥0.10', { minimumExpectedRunMargin: 0.1 }),
  variant('margin_00', 'margin≥0', { minimumExpectedRunMargin: 0 }),

  // —— 單軸放寬／微抬 P（勝率方向） ——
  variant('p_48', 'P≥48%（放寬）', { minimumModelProbability: 0.48 }),
  variant('p_52', 'P≥52%（收緊，對照勝率）', { minimumModelProbability: 0.52 }),
  variant('p_55', 'P≥55%（收緊，對照勝率）', { minimumModelProbability: 0.55 }),

  // —— maxOdds ——
  variant('max_230', 'maxOdds≤2.30', { maximumPickOdds: 2.3 }),
  variant('max_240', 'maxOdds≤2.40', { maximumPickOdds: 2.4 }),
  variant('max_250', 'maxOdds≤2.50', { maximumPickOdds: 2.5 }),
  variant('max_none', '不卡 maxOdds', { maximumPickOdds: null }),

  // —— earlyExits ——
  variant('no_early_exits', '不卡 earlyExits', { requirePickEarlyExitsNotHigher: false }),

  // —— minOdds 微放（相對正式；僅實驗） ——
  variant('min_180', 'minOdds≥1.80', { minimumPickOdds: 1.8 }),
  variant('min_175', 'minOdds≥1.75', { minimumPickOdds: 1.75 }),

  // —— 少量組合：放寬進場、同時略抬勝率門 ——
  variant('ev02_m20', 'EV≥2% + margin≥0.20', {
    minimumExpectedValue: 0.02,
    minimumExpectedRunMargin: 0.2,
  }),
  variant('ev02_p52', 'EV≥2% + P≥52%', {
    minimumExpectedValue: 0.02,
    minimumModelProbability: 0.52,
  }),
  variant('ev01_m15', 'EV≥1% + margin≥0.15', {
    minimumExpectedValue: 0.01,
    minimumExpectedRunMargin: 0.15,
  }),
  variant('ev02_max230', 'EV≥2% + maxOdds≤2.30', {
    minimumExpectedValue: 0.02,
    maximumPickOdds: 2.3,
  }),
  variant('ev02_no_early', 'EV≥2% + 不卡 earlyExits', {
    minimumExpectedValue: 0.02,
    requirePickEarlyExitsNotHigher: false,
  }),
  variant('margin15_p52', 'margin≥0.15 + P≥52%', {
    minimumExpectedRunMargin: 0.15,
    minimumModelProbability: 0.52,
  }),
  variant('ev02_m15_p52', 'EV≥2% + margin≥0.15 + P≥52%', {
    minimumExpectedValue: 0.02,
    minimumExpectedRunMargin: 0.15,
    minimumModelProbability: 0.52,
  }),
  // 放寬進場換場次，TopK 維持 3
  variant('ev00_m00', 'EV≥0 + margin≥0（僅賠率帶+ID+early+Top3）', {
    minimumExpectedValue: 0,
    minimumExpectedRunMargin: 0,
  }),
];

console.log('Building universes…');
const pools = WINDOWS.map((w) => {
  const pool = buildUniverse(w.from, w.to);
  console.log(`  ${w.key}: ${pool.length} games with ML`);
  return { ...w, pool };
});
const combinedPool = pools.flatMap((p) => p.pool);

const results = [];
for (const v of VARIANTS) {
  const row = { id: v.id, label: v.label, rules: {
    minimumExpectedValue: v.minimumExpectedValue,
    minimumExpectedRunMargin: v.minimumExpectedRunMargin,
    minimumModelProbability: v.minimumModelProbability,
    minimumPickOdds: v.minimumPickOdds,
    maximumPickOdds: v.maximumPickOdds,
    requirePickEarlyExitsNotHigher: v.requirePickEarlyExitsNotHigher,
    requireBothPitcherIdentities: v.requireBothPitcherIdentities,
    dailyTopK: v.dailyTopK,
  }, windows: {} };
  for (const w of pools) {
    row.windows[w.key] = summarize(select(w.pool, v));
  }
  row.windows.combined = summarize(select(combinedPool, v));
  results.push(row);
  const c = row.windows.combined;
  console.log(
    `${v.id.padEnd(18)} bets=${String(c?.bets ?? 0).padStart(3)} hr=${c?.hitRate ?? '-'} roi=${c?.roi ?? '-'} $50=${c?.usd50 ?? '-'}`
  );
}

const base = results.find((r) => r.id === 'baseline_frozen_v1');
const evaluated = results.map((r) => {
  const c = r.windows.combined;
  const y25 = r.windows['2025'];
  const y26 = r.windows['2026'];
  const bc = base.windows.combined;
  const deltaUsd50 = c && bc ? c.usd50 - bc.usd50 : null;
  const deltaBets = c && bc ? c.bets - bc.bets : null;
  const deltaHit = c && bc ? Number((c.hitRate - bc.hitRate).toFixed(4)) : null;
  const deltaRoi = c && bc ? Number((c.roi - bc.roi).toFixed(4)) : null;
  const dualPositive = (y25?.usd50 ?? -1) > 0 && (y26?.usd50 ?? -1) > 0;
  const beatsBaseCombined = (c?.usd50 ?? -Infinity) > (bc?.usd50 ?? 0);
  const notWorseBoth =
    (y25?.usd50 ?? -Infinity) >= (base.windows['2025']?.usd50 ?? 0) &&
    (y26?.usd50 ?? -Infinity) >= (base.windows['2026']?.usd50 ?? 0);
  const moreVolume = (deltaBets ?? 0) > 0;
  const betterHit = (deltaHit ?? 0) > 0;
  return {
    id: r.id,
    label: r.label,
    rules: r.rules,
    combined: c,
    y2025: y25,
    y2026: y26,
    deltaUsd50VsBase: deltaUsd50,
    deltaBetsVsBase: deltaBets,
    deltaHitRateVsBase: deltaHit,
    deltaRoiVsBase: deltaRoi,
    dualPositive,
    beatsBaseCombined,
    notWorseBothWindows: notWorseBoth,
    moreVolume,
    betterHitRate: betterHit,
    passGate: Boolean(c) && beatsBaseCombined && dualPositive,
    passStrictGate: Boolean(c) && beatsBaseCombined && dualPositive && notWorseBoth,
    // 產品目標：場次或勝率↑，且過美元閘
    interestingForVolumeOrHit:
      Boolean(c) &&
      dualPositive &&
      (beatsBaseCombined || (c.usd50 ?? 0) >= (bc?.usd50 ?? 0) * 0.95) &&
      (moreVolume || betterHit),
  };
});

evaluated.sort((a, b) => (b.deltaUsd50VsBase ?? -1e9) - (a.deltaUsd50VsBase ?? -1e9));

const pass = evaluated.filter((e) => e.passGate && e.id !== 'baseline_frozen_v1');
const passStrict = evaluated.filter((e) => e.passStrictGate && e.id !== 'baseline_frozen_v1');
const volumeOrHit = evaluated.filter(
  (e) => e.interestingForVolumeOrHit && e.id !== 'baseline_frozen_v1'
);

const out = {
  experimentId: 'threshold-relax-on-frozen-2026-07-27',
  generatedAt: new Date().toISOString(),
  note: 'frozen_v1 不動；本掃描僅腳本回放。KPI=合併總美元；場次／勝率為次要目標。',
  baseRules: {
    id: FROZEN.id,
    freezeId: FROZEN.freezeId,
    minimumExpectedValue: FROZEN.minimumExpectedValue,
    minimumExpectedRunMargin: FROZEN.minimumExpectedRunMargin,
    minimumModelProbability: FROZEN.minimumModelProbability,
    minimumPickOdds: FROZEN.minimumPickOdds,
    maximumPickOdds: FROZEN.maximumPickOdds,
    requirePickEarlyExitsNotHigher: FROZEN.requirePickEarlyExitsNotHigher,
    requireBothPitcherIdentities: FROZEN.requireBothPitcherIdentities,
    dailyTopK: FROZEN.dailyTopK,
  },
  universeSizes: Object.fromEntries(pools.map((p) => [p.key, p.pool.length])),
  baseline: evaluated.find((e) => e.id === 'baseline_frozen_v1'),
  passGate: pass,
  passStrictGate: passStrict,
  interestingForVolumeOrHit: volumeOrHit,
  rankedByDeltaUsd50: evaluated,
  recommendation: passStrict[0]
    ? {
        action: 'consider_exp_profile',
        id: passStrict[0].id,
        label: passStrict[0].label,
        deltaUsd50: passStrict[0].deltaUsd50VsBase,
        deltaBets: passStrict[0].deltaBetsVsBase,
        deltaHitRate: passStrict[0].deltaHitRateVsBase,
        note: '過嚴格閘；可另開實驗 profile，勿覆蓋 frozen_v1',
      }
    : pass[0]
      ? {
          action: 'weak_candidate_recheck',
          id: pass[0].id,
          label: pass[0].label,
          note: '合併贏基線且雙窗正，但至少一窗低於基線',
          deltaUsd50: pass[0].deltaUsd50VsBase,
        }
      : volumeOrHit[0]
        ? {
            action: 'no_dollar_gate_pass_but_see_volume_hit',
            note: '無方案同時過美元嚴格閘；下列為場次／勝率方向觀察',
            top: volumeOrHit.slice(0, 5).map((e) => ({
              id: e.id,
              deltaUsd50: e.deltaUsd50VsBase,
              deltaBets: e.deltaBetsVsBase,
              deltaHit: e.deltaHitRateVsBase,
            })),
          }
        : {
            action: 'keep_frozen_v1',
            note: '放寬門檻未同時改善總美元與雙窗；維持 frozen_v1',
          },
};

const outPath = new URL('../tmp-threshold-relax-on-frozen.json', import.meta.url);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('\nWrote', outPath.pathname);
console.log('passStrict:', passStrict.map((e) => e.id));
console.log('passGate:', pass.map((e) => e.id));
console.log('recommendation:', out.recommendation);
