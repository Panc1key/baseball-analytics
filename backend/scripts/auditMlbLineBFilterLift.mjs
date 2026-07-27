/**
 * B 線優化掃描：在盡量不砍場次下抬高條件勝率。
 *
 * 基線 B：EV≥3% + 分差≥0.25 + 每日 Top3
 * 只做「候選過濾／輕調參數」，不改 ExpectedRuns 算式。
 *
 * 約束（可調 env）：
 * - 場次保留率 ≥ KEEP_RATE（預設 0.90）
 * - 均賠 ≥ MIN_AVG_ODDS（預設 1.90，避免變回短賠 A）
 * - 必須仍 clearsOwnAvgOdds
 *
 * 用法: node scripts/auditMlbLineBFilterLift.mjs [monthsBack]
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolveMlbRegimeMarketPlan } from '../src/services/MlbRegimeMarketRouter.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const monthsBack = Number(process.argv[2] || 6);
const keepRate = Number(process.env.KEEP_RATE || 0.9);
const minAvgOdds = Number(process.env.MIN_AVG_ODDS || 1.9);

const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) throw new Error('model_missing');

const since = new Date();
since.setUTCMonth(since.getUTCMonth() - monthsBack);
const sinceIso = since.toISOString().slice(0, 10);

const rows = db
  .prepare(
    `
  SELECT f.game_id AS gameId,
         f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
         g.home_team AS homeTeam,
         g.away_team AS awayTeam,
         g.home_score AS homeScore,
         g.away_score AS awayScore
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  WHERE f.feature_version = ?
    AND g.completed = 1
    AND g.home_score IS NOT NULL
    AND g.away_score IS NOT NULL
    AND date(f.commence_time) >= date(?)
  ORDER BY f.commence_time
`
  )
  .all(MLB_BASELINE_FEATURE_VERSION, sinceIso);

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
      market.outcomes.find((o) =>
        String(o.name).includes(String(homeTeam).split(' ').pop())
      );
    const away =
      market.outcomes.find((o) => o.name === awayTeam) ||
      market.outcomes.find((o) =>
        String(o.name).includes(String(awayTeam).split(' ').pop())
      );
    if (!home?.price || !away?.price) continue;
    const vig = 1 / home.price + 1 / away.price;
    if (!best || vig < best.vig) {
      best = { homeOdds: Number(home.price), awayOdds: Number(away.price), vig };
    }
  }
  return best;
}

function summarize(list) {
  const n = list.length;
  const hits = list.filter((g) => g.hit).length;
  const withOdds = list.filter((g) => g.hasOdds);
  let unitPnl = 0;
  let oddsSum = 0;
  for (const g of withOdds) {
    oddsSum += g.pickOdds;
    unitPnl += g.hit ? g.pickOdds - 1 : -1;
  }
  const hitRate = n ? hits / n : null;
  const avgOdds = withOdds.length ? oddsSum / withOdds.length : null;
  const breakevenAtAvgOdds =
    avgOdds != null && avgOdds > 1 ? 1 / avgOdds : null;
  return {
    bets: n,
    hits,
    hitRate: hitRate == null ? null : Number(hitRate.toFixed(4)),
    withOddsN: withOdds.length,
    avgOdds: avgOdds == null ? null : Number(avgOdds.toFixed(3)),
    breakevenAtAvgOdds:
      breakevenAtAvgOdds == null ? null : Number(breakevenAtAvgOdds.toFixed(4)),
    clearsOwnAvgOdds:
      hitRate != null &&
      breakevenAtAvgOdds != null &&
      hitRate >= breakevenAtAvgOdds,
    unitPnl: Number(unitPnl.toFixed(2)),
    roi: withOdds.length ? Number((unitPnl / withOdds.length).toFixed(4)) : null,
  };
}

function rankB(a, b) {
  return (b.ev ?? -999) - (a.ev ?? -999) || b.margin - a.margin;
}

function takeDailyTopK(list, k) {
  const byDay = new Map();
  for (const g of list) {
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const selected = [];
  for (const day of [...byDay.keys()].sort()) {
    selected.push(...[...byDay.get(day)].sort(rankB).slice(0, k));
  }
  return selected;
}

const games = [];
for (const row of rows) {
  let features;
  try {
    features = JSON.parse(row.featuresJson);
  } catch {
    continue;
  }
  const homeScore = Number(row.homeScore);
  const awayScore = Number(row.awayScore);
  if (homeScore === awayScore) continue;

  const pred = predictMlbGameRuns(model, features, { totalLine: 8.5 });
  const predHome = Number(pred.homeExpectedRuns);
  const predAway = Number(pred.awayExpectedRuns);
  if (!Number.isFinite(predHome) || !Number.isFinite(predAway)) continue;
  const pickHome = predHome >= predAway;
  const modelProb = pickHome
    ? Number(pred.markets?.homeWinProbability)
    : Number(pred.markets?.awayWinProbability);
  if (!Number.isFinite(modelProb)) continue;

  const ml = bestMl(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
  if (!ml) continue;
  const pickOdds = pickHome ? ml.homeOdds : ml.awayOdds;
  if (!Number.isFinite(pickOdds)) continue;
  const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
  const margin = Math.abs(predHome - predAway);
  const hit = pickHome === homeScore > awayScore;

  const signals = buildPregameRegimeSignals(features);
  const plan = resolveMlbRegimeMarketPlan({ features, signals });
  const homeBlow = Number(signals.homePitchingBlowupRisk) || 0;
  const awayBlow = Number(signals.awayPitchingBlowupRisk) || 0;
  const homeEarly = Number(signals.homeEarlyExitsLast3) || 0;
  const awayEarly = Number(signals.awayEarlyExitsLast3) || 0;
  const homeRest = Number(features?.pitchers?.homeRecent?.restDays);
  const awayRest = Number(features?.pitchers?.awayRecent?.restDays);
  const pickBlow = pickHome ? homeBlow : awayBlow;
  const oppBlow = pickHome ? awayBlow : homeBlow;
  const pickEarly = pickHome ? homeEarly : awayEarly;
  const oppEarly = pickHome ? awayEarly : homeEarly;
  const pickRest = pickHome ? homeRest : awayRest;
  const oppRest = pickHome ? awayRest : homeRest;
  const identityOk =
    features?.pitchers?.identityMode === 'pit_probable' ||
    Boolean(features?.pitchers?.homeIdentity?.id && features?.pitchers?.awayIdentity?.id);

  games.push({
    day: hkDate(row.commenceTime),
    margin,
    modelProb,
    ev,
    pickOdds,
    hit,
    hasOdds: true,
    regime: plan.regimePredicted,
    moneylineAllowed: plan.moneylineAllowed !== false && plan.moneylinePriority !== 'blocked',
    moneylinePriority: plan.moneylinePriority,
    pickBlowLower: pickBlow < oppBlow,
    pickBlowNotHigher: pickBlow <= oppBlow,
    pickEarlyLower: pickEarly < oppEarly,
    pickEarlyNotHigher: pickEarly <= oppEarly,
    pickRestedBetter:
      Number.isFinite(pickRest) &&
      Number.isFinite(oppRest) &&
      pickRest >= oppRest,
    identityOk,
    hasPlatoon: Boolean(features?.platoon),
  });
}

function selectB(pool, cfg) {
  const cands = pool.filter((g) => {
    if (g.ev < cfg.minEv) return false;
    if (g.margin < cfg.minMargin) return false;
    if (g.modelProb < cfg.minProb) return false;
    if (g.pickOdds < cfg.minOdds) return false;
    if (g.pickOdds > cfg.maxOdds) return false;
    if (cfg.requireMlAllowed && !g.moneylineAllowed) return false;
    if (cfg.normalOnly && g.regime !== 'normal') return false;
    if (cfg.excludeDuelHighTotal && (g.regime === 'duel' || g.regime === 'high_total')) {
      return false;
    }
    if (cfg.pickBlowLower && !g.pickBlowLower) return false;
    if (cfg.pickBlowNotHigher && !g.pickBlowNotHigher) return false;
    if (cfg.pickEarlyLower && !g.pickEarlyLower) return false;
    if (cfg.pickEarlyNotHigher && !g.pickEarlyNotHigher) return false;
    if (cfg.pickRestedBetter && !g.pickRestedBetter) return false;
    if (cfg.requireIdentity && !g.identityOk) return false;
    if (cfg.requirePlatoon && !g.hasPlatoon) return false;
    return true;
  });
  return takeDailyTopK(cands, cfg.topK);
}

const baselineCfg = {
  key: 'B_baseline',
  minEv: 0.03,
  minMargin: 0.25,
  minProb: 0.5,
  minOdds: 1.01,
  maxOdds: 99,
  topK: 3,
  requireMlAllowed: false,
  normalOnly: false,
  excludeDuelHighTotal: false,
  pickBlowLower: false,
  pickBlowNotHigher: false,
  pickEarlyLower: false,
  pickEarlyNotHigher: false,
  pickRestedBetter: false,
  requireIdentity: false,
  requirePlatoon: false,
};

const baselineSelected = selectB(games, baselineCfg);
const baseline = summarize(baselineSelected);
const minBets = Math.floor(baseline.bets * keepRate);

const variants = [
  { ...baselineCfg, key: 'B_baseline' },
  { ...baselineCfg, key: 'ml_allowed', requireMlAllowed: true },
  { ...baselineCfg, key: 'exclude_duel_high_total', excludeDuelHighTotal: true },
  { ...baselineCfg, key: 'normal_only', normalOnly: true },
  { ...baselineCfg, key: 'pick_blow_not_higher', pickBlowNotHigher: true },
  { ...baselineCfg, key: 'pick_blow_lower', pickBlowLower: true },
  { ...baselineCfg, key: 'pick_early_not_higher', pickEarlyNotHigher: true },
  { ...baselineCfg, key: 'pick_early_lower', pickEarlyLower: true },
  { ...baselineCfg, key: 'pick_rested_better', pickRestedBetter: true },
  { ...baselineCfg, key: 'identity_ok', requireIdentity: true },
  { ...baselineCfg, key: 'minProb_0.52', minProb: 0.52 },
  { ...baselineCfg, key: 'minProb_0.54', minProb: 0.54 },
  { ...baselineCfg, key: 'minMargin_0.35', minMargin: 0.35 },
  { ...baselineCfg, key: 'minMargin_0.5', minMargin: 0.5 },
  { ...baselineCfg, key: 'minEv_0.04', minEv: 0.04 },
  { ...baselineCfg, key: 'minEv_0.05', minEv: 0.05 },
  { ...baselineCfg, key: 'maxOdds_2.4', maxOdds: 2.4 },
  { ...baselineCfg, key: 'maxOdds_2.2', maxOdds: 2.2 },
  { ...baselineCfg, key: 'minOdds_1.75', minOdds: 1.75 },
  { ...baselineCfg, key: 'topK_4', topK: 4 },
  { ...baselineCfg, key: 'topK_5', topK: 5 },
  // 組合：你提過的場上／投手邏輯（輕量）
  {
    ...baselineCfg,
    key: 'combo_ml_allowed_blow_ok',
    requireMlAllowed: true,
    pickBlowNotHigher: true,
  },
  {
    ...baselineCfg,
    key: 'combo_exclude_duel_ht_blow_ok',
    excludeDuelHighTotal: true,
    pickBlowNotHigher: true,
  },
  {
    ...baselineCfg,
    key: 'combo_ml_allowed_early_ok',
    requireMlAllowed: true,
    pickEarlyNotHigher: true,
  },
  {
    ...baselineCfg,
    key: 'combo_ml_allowed_max24',
    requireMlAllowed: true,
    maxOdds: 2.4,
  },
  {
    ...baselineCfg,
    key: 'combo_ml_blow_max24',
    requireMlAllowed: true,
    pickBlowNotHigher: true,
    maxOdds: 2.4,
  },
  {
    ...baselineCfg,
    key: 'combo_soft_prob52_ml',
    minProb: 0.52,
    requireMlAllowed: true,
  },
  {
    ...baselineCfg,
    key: 'combo_best_stack_max22_ml_early',
    maxOdds: 2.2,
    requireMlAllowed: true,
    pickEarlyNotHigher: true,
  },
  {
    ...baselineCfg,
    key: 'combo_max22_early',
    maxOdds: 2.2,
    pickEarlyNotHigher: true,
  },
];

const results = variants.map((cfg) => {
  const selected = selectB(games, cfg);
  const stats = summarize(selected);
  const keep = baseline.bets ? stats.bets / baseline.bets : 0;
  return {
    key: cfg.key,
    cfg,
    ...stats,
    keepRate: Number(keep.toFixed(3)),
    deltaHitRate:
      stats.hitRate != null && baseline.hitRate != null
        ? Number((stats.hitRate - baseline.hitRate).toFixed(4))
        : null,
    deltaRoi:
      stats.roi != null && baseline.roi != null
        ? Number((stats.roi - baseline.roi).toFixed(4))
        : null,
    meetsKeep: stats.bets >= minBets,
    meetsOdds: stats.avgOdds != null && stats.avgOdds >= minAvgOdds,
    meetsOwnBe: stats.clearsOwnAvgOdds,
  };
});

const eligible = results
  .filter((r) => r.meetsKeep && r.meetsOdds && r.meetsOwnBe)
  .sort(
    (a, b) =>
      b.hitRate - a.hitRate ||
      b.roi - a.roi ||
      b.bets - a.bets
  );

const bestLift = eligible[0] || null;
const nearMiss = results
  .filter((r) => r.clearsOwnAvgOdds && r.hitRate > baseline.hitRate)
  .sort((a, b) => b.hitRate - a.hitRate || b.keepRate - a.keepRate)
  .slice(0, 10);

const out = {
  ok: true,
  modelVersion: validation.modelVersion,
  since: sinceIso,
  universeN: games.length,
  constraints: { keepRate, minAvgOdds, minBets },
  baseline: { key: 'B_baseline', ...baseline },
  bestUnderConstraints: bestLift,
  topEligible: eligible.slice(0, 12),
  nearMissHigherHitButMissConstraints: nearMiss,
  all: results.sort((a, b) => b.hitRate - a.hitRate),
  verdict: bestLift
    ? bestLift.deltaHitRate > 0
      ? 'found_filter_lifts_hit_rate_without_big_volume_cut'
      : 'eligible_but_no_hit_rate_lift'
    : 'no_filter_meets_keep_odds_and_breakeven',
  note: [
    '目標：B 線勝率↑、場次盡量不砍、均賠維持長賠區',
    '使用既有 regime／先發波動訊號，不改 NB 算式',
    '非正式投注授權',
  ],
};

fs.writeFileSync('tmp-mlb-lineb-filter-lift.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
