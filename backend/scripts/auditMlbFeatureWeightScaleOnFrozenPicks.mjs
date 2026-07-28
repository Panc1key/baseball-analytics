/**
 * 選注已凍結（ev02_max230 + dropR3 + dropR2）。
 * 本腳本只改「內存克隆」的 ExpectedRuns 權重，不寫庫、不改正式模型。
 * 對照：同一選注規則下，勝率／@$50／雙窗。
 *
 * 產物：tmp-feature-weight-scale-on-frozen-picks.json
 * 用法: node scripts/auditMlbFeatureWeightScaleOnFrozenPicks.mjs
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

const RULES = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3_T = Number(RULES.dropThirdIfMarginBelow) || 0.5;
const DROP_R2_MAX = Number(RULES.dropSecondIfOddsBelow) || 1.95;
const DROP_R2_MIN = Number(RULES.dropSecondIfOddsMin) || 1.85;
const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

const GROUPS = {
  starter_quality: [
    'opponentStarterEraContribution',
    'opponentStarterWhipContribution',
    'opponentStarterKMinusBb9Contribution',
    'opponentStarterRecentEraContribution',
    'opponentStarterExpectedInnings',
  ],
  offense: [
    'offenseRecentRpg',
    'offenseObp',
    'offenseSlg',
    'offenseKMinusBbRate',
    'offenseOpsVsStarterHand',
  ],
  /** Obp 權重為負，單獨試歸零／削弱異常號 */
  offense_obp_only: ['offenseObp'],
  platoon: [
    'opponentStarterOpsVsLhb',
    'opponentStarterOpsVsRhb',
    'opponentStarterIsLefty',
  ],
  rest: ['opponentStarterRestDays'],
  opp_ra: ['opponentRecentRaRpg'],
};

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
  const nB = bets.length;
  return {
    bets: nB,
    hitRate: Number((hits / nB).toFixed(4)),
    avgOdds: Number((odds / nB).toFixed(3)),
    roi: Number((unit / nB).toFixed(4)),
    unitPnl: Number(unit.toFixed(2)),
    usd50: Math.round(unit * 50),
  };
}

function cloneModel(model) {
  return {
    ...model,
    featureKeys: [...(model.featureKeys || [])],
    weights: { ...(model.weights || {}) },
    means: { ...(model.means || {}) },
    scales: { ...(model.scales || {}) },
  };
}

/** scales: [{ keys: string[], factor: number }] 或 { groupName: factor } */
function applyWeightScales(baseModel, scaleSpec) {
  const model = cloneModel(baseModel);
  const applied = [];
  for (const [group, factor] of Object.entries(scaleSpec)) {
    const keys = GROUPS[group];
    if (!keys) continue;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(model.weights, key)) continue;
      const before = model.weights[key];
      model.weights[key] = before * factor;
      applied.push({ key, group, before, after: model.weights[key], factor });
    }
  }
  return { model, applied };
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

function selectFromCandidates(candidates) {
  const byDay = new Map();
  for (const g of candidates) {
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (a, b) => b.score - a.score || b.margin - a.margin
    );
    out.push(...applyHardSlots(arr));
  }
  return out;
}

function buildCandidates(model, from, to) {
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

  const pool = [];
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
    const pred = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const ph = +pred.homeExpectedRuns;
    const pa = +pred.awayExpectedRuns;
    if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;
    const pickHome = ph >= pa;
    const modelProb = pickHome
      ? +pred.markets?.homeWinProbability
      : +pred.markets?.awayWinProbability;
    if (!Number.isFinite(modelProb)) continue;
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? +sig.homeEarlyExitsLast3 || 0
      : +sig.awayEarlyExitsLast3 || 0;
    const oppEarly = pickHome
      ? +sig.awayEarlyExitsLast3 || 0
      : +sig.homeEarlyExitsLast3 || 0;
    const pitchers = features?.pitchers || {};
    const homeId = pitchers.homeIdentity?.id ?? pitchers.home?.id ?? null;
    const awayId = pitchers.awayIdentity?.id ?? pitchers.away?.id ?? null;
    if (homeId == null || awayId == null) continue;
    if (
      ev < RULES.minimumExpectedValue ||
      margin < RULES.minimumExpectedRunMargin ||
      modelProb < RULES.minimumModelProbability ||
      pickOdds < RULES.minimumPickOdds ||
      pickOdds > RULES.maximumPickOdds ||
      best.homeOdds < RULES.minimumEitherSideOdds ||
      best.awayOdds < RULES.minimumEitherSideOdds ||
      (RULES.requirePickEarlyExitsNotHigher && pickEarly > oppEarly)
    ) {
      continue;
    }
    const score = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      RULES
    );
    pool.push({
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      window: from.startsWith('2025') ? '2025' : '2026',
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      score,
      pickHome,
      ph,
      pa,
    });
  }
  return pool;
}

const VARIANTS = [
  { id: 'baseline_v45', label: '現行 v4.5 權重', scales: {} },
  { id: 'starter_x070', label: '先發品質權重 ×0.70', scales: { starter_quality: 0.7 } },
  { id: 'starter_x050', label: '先發品質權重 ×0.50', scales: { starter_quality: 0.5 } },
  { id: 'starter_x000', label: '先發品質權重 ×0（消融）', scales: { starter_quality: 0 } },
  { id: 'offense_x130', label: '攻擊族權重 ×1.30', scales: { offense: 1.3 } },
  { id: 'offense_x150', label: '攻擊族權重 ×1.50', scales: { offense: 1.5 } },
  { id: 'obp_x000', label: 'offenseObp 權重歸零（現行為負）', scales: { offense_obp_only: 0 } },
  { id: 'obp_x050', label: 'offenseObp 權重 ×0.50', scales: { offense_obp_only: 0.5 } },
  { id: 'opp_ra_x130', label: '對手近期失分權重 ×1.30', scales: { opp_ra: 1.3 } },
  { id: 'opp_ra_x070', label: '對手近期失分權重 ×0.70', scales: { opp_ra: 0.7 } },
  { id: 'platoon_x050', label: '左右／對打權重 ×0.50', scales: { platoon: 0.5 } },
  { id: 'rest_x050', label: '休息日權重 ×0.50', scales: { rest: 0.5 } },
  {
    id: 'starter_x050_offense_x130',
    label: '先發×0.50 + 攻擊×1.30',
    scales: { starter_quality: 0.5, offense: 1.3 },
  },
  {
    id: 'starter_x070_obp_x000',
    label: '先發×0.70 + Obp歸零',
    scales: { starter_quality: 0.7, offense_obp_only: 0 },
  },
  {
    id: 'starter_x050_opp_ra_x130',
    label: '先發×0.50 + 對手RA×1.30',
    scales: { starter_quality: 0.5, opp_ra: 1.3 },
  },
];

const validation = getLatestMlbExpectedRunsValidation();
const baseModel = validation?.model;
if (!baseModel) throw new Error('model_missing');

console.log(
  `Model ${validation.modelVersion || 'unknown'}; featureKeys=${baseModel.featureKeys?.length}`
);
console.log('Selection LOCKED: ev02_max230 + dropR3 + dropR2');

const results = [];
for (const v of VARIANTS) {
  const { model, applied } = applyWeightScales(baseModel, v.scales);
  const windowSummaries = {};
  const allPicks = [];
  for (const w of WINDOWS) {
    const candidates = buildCandidates(model, w.from, w.to);
    const picks = selectFromCandidates(candidates);
    windowSummaries[w.key] = summarize(picks);
    allPicks.push(...picks);
  }
  const combined = summarize(allPicks);
  const row = {
    id: v.id,
    label: v.label,
    scales: v.scales,
    appliedWeights: applied,
    windows: { ...windowSummaries, combined },
  };
  results.push(row);
  console.log(
    `${v.id.padEnd(28)} n=${String(combined?.bets ?? 0).padStart(3)} hr=${combined?.hitRate} $50=${combined?.usd50}`
  );
}

const base = results.find((r) => r.id === 'baseline_v45');
const bc = base.windows.combined;
const b25 = base.windows['2025'];
const b26 = base.windows['2026'];

const evaluated = results.map((r) => {
  const c = r.windows.combined;
  const y25 = r.windows['2025'];
  const y26 = r.windows['2026'];
  const keepRate = c && bc ? Number((c.bets / bc.bets).toFixed(3)) : null;
  return {
    id: r.id,
    label: r.label,
    scales: r.scales,
    combined: c,
    y2025: y25,
    y2026: y26,
    keepRate,
    deltaBets: c && bc ? c.bets - bc.bets : null,
    deltaUsd50: c && bc ? c.usd50 - bc.usd50 : null,
    deltaHitRate: c && bc ? Number((c.hitRate - bc.hitRate).toFixed(4)) : null,
    dualPositive: (y25?.usd50 ?? -1) > 0 && (y26?.usd50 ?? -1) > 0,
    keep90: keepRate != null && keepRate >= 0.9,
    passStrict:
      Boolean(c) &&
      (c.usd50 ?? -Infinity) > bc.usd50 &&
      (y25?.usd50 ?? -1) > 0 &&
      (y26?.usd50 ?? -1) > 0 &&
      (y25?.usd50 ?? -Infinity) >= b25.usd50 &&
      (y26?.usd50 ?? -Infinity) >= b26.usd50 &&
      keepRate >= 0.9 &&
      (c.hitRate ?? 0) >= bc.hitRate,
    fitsLift:
      Boolean(c) &&
      keepRate >= 0.9 &&
      (c.hitRate ?? 0) > bc.hitRate &&
      (c.usd50 ?? 0) >= bc.usd50 &&
      (y25?.usd50 ?? -1) > 0 &&
      (y26?.usd50 ?? -1) > 0,
  };
});

evaluated.sort((a, b) => (b.deltaUsd50 ?? -1) - (a.deltaUsd50 ?? -1));
const strict = evaluated.filter((e) => e.passStrict && e.id !== 'baseline_v45');
const lift = evaluated.filter((e) => e.fitsLift && e.id !== 'baseline_v45');

const out = {
  experimentId: 'feature-weight-scale-on-frozen-picks-2026-07-28',
  generatedAt: new Date().toISOString(),
  selectionFreeze:
    'ev02_max230 + dropThirdIfMarginBelow=0.5 + dropSecondIfOddsBelow=1.95（本輪不改）',
  modelVersion: validation.modelVersion || null,
  modelFeatureKeys: baseModel.featureKeys,
  groups: GROUPS,
  baseline: evaluated.find((e) => e.id === 'baseline_v45'),
  passStrictGate: strict,
  fitsLift: lift,
  rankedByUsd50Lift: evaluated,
  recommendation: strict[0]
    ? {
        action: 'consider_retrain_or_shadow_weights',
        id: strict[0].id,
        label: strict[0].label,
        note: '權重縮放過嚴格閘；正式接入需另開 retrain／影子驗證，勿直接改庫內 v4.5',
        hitRate: strict[0].combined.hitRate,
        deltaUsd50: strict[0].deltaUsd50,
        keepRate: strict[0].keepRate,
      }
    : lift[0]
      ? {
          action: 'weak_weight_candidate',
          id: lift[0].id,
          label: lift[0].label,
          note: '合併有升但未過雙窗嚴格閘；不改正式權重',
        }
      : {
          action: 'keep_v45_weights',
          note: '權重縮放未勝過現行 v4.5；維持模型，選注繼續凍結',
        },
};

fs.writeFileSync(
  new URL('../tmp-feature-weight-scale-on-frozen-picks.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\n=== passStrict ===');
for (const e of strict) {
  console.log(
    `${e.id}: hr=${e.combined.hitRate} keep=${e.keepRate} d$=${e.deltaUsd50} dhr=${e.deltaHitRate}`
  );
}
console.log('\n=== fitsLift ===');
for (const e of lift) {
  console.log(
    `${e.id}: hr=${e.combined.hitRate} keep=${e.keepRate} d$=${e.deltaUsd50}`
  );
}
console.log('\nrecommendation:', out.recommendation);
