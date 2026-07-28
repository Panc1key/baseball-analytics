/**
 * 第一刀：賠率甜區／微抬 minOdds（底座=ev02_max230+≥2庄）
 * 約束關注：勝率是否→55%+；注數保留是否 ≥85%/≥90%；合併美元與雙窗閘
 * 不改正式常數；產物 tmp-odds-sweet-spot-on-current.json
 *
 * 用法: node scripts/auditMlbOddsSweetSpotOnCurrent.mjs
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

const BASE = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: 2,
};

const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

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
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    breakeven: Number((1 / (odds / n)).toFixed(4)),
    clearsOwn: hits / n > 1 / (odds / n),
    roi: Number((unit / n).toFixed(4)),
    unitPnl: Number(unit.toFixed(2)),
    usd50: Math.round(unit * 50),
  };
}

function buildUniverse(from, to) {
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
    const pred = predictMlbGameRuns(validation.model, features, { totalLine: 8.5 });
    const ph = +pred.homeExpectedRuns;
    const pa = +pred.awayExpectedRuns;
    if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;
    const pickHome = ph >= pa;
    const modelProb = pickHome
      ? +pred.markets?.homeWinProbability
      : +pred.markets?.awayWinProbability;
    if (!Number.isFinite(modelProb)) continue;
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < BASE.minimumH2hBookmakers) continue;
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
    // 極寬：僅卡非賠率門檻；賠率由各 variant 再卡
    if (
      ev < BASE.minimumExpectedValue ||
      margin < BASE.minimumExpectedRunMargin ||
      modelProb < BASE.minimumModelProbability ||
      best.homeOdds < BASE.minimumEitherSideOdds ||
      best.awayOdds < BASE.minimumEitherSideOdds ||
      (BASE.requirePickEarlyExitsNotHigher && pickEarly > oppEarly)
    ) {
      continue;
    }
    // 保留到 max 2.30 宇宙（現行 max）
    if (pickOdds > 2.3 || pickOdds < 1.7) continue;

    pool.push({
      day: hk(row.commenceTime),
      window: from.startsWith('2025') ? '2025' : '2026',
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      score: scoreMlbMoneylineDailyRank(
        { expectedValue: ev, modelProbability: modelProb },
        BASE
      ),
    });
  }
  return pool;
}

function passesOdds(g, rules) {
  if (rules.minOdds != null && g.pickOdds < rules.minOdds) return false;
  if (rules.maxOdds != null && g.pickOdds > rules.maxOdds) return false;
  return true;
}

function select(pool, rules) {
  const byDay = new Map();
  for (const g of pool) {
    if (!passesOdds(g, rules)) continue;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    out.push(
      ...[...byDay.get(day)]
        .sort((a, b) => b.score - a.score || b.margin - a.margin)
        .slice(0, BASE.dailyTopK)
    );
  }
  return out;
}

/** soft：合格後排序對甜區外扣分（不硬擋），再 Top3 */
function selectSoftPrefer(pool, { minOdds, maxOdds, preferMin, preferMax, lambda }) {
  const byDay = new Map();
  for (const g of pool) {
    if (minOdds != null && g.pickOdds < minOdds) continue;
    if (maxOdds != null && g.pickOdds > maxOdds) continue;
    const inSweet = g.pickOdds >= preferMin && g.pickOdds <= preferMax;
    const score = inSweet ? g.score : g.score - lambda;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({ ...g, score });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    out.push(
      ...[...byDay.get(day)]
        .sort((a, b) => b.score - a.score || b.margin - a.margin)
        .slice(0, BASE.dailyTopK)
    );
  }
  return out;
}

const VARIANTS = [
  { id: 'baseline_185_230', label: '現行：1.85–2.30', minOdds: 1.85, maxOdds: 2.3 },
  { id: 'min_190_230', label: '微抬 minOdds≥1.90', minOdds: 1.9, maxOdds: 2.3 },
  { id: 'min_195_230', label: 'minOdds≥1.95', minOdds: 1.95, maxOdds: 2.3 },
  { id: 'band_185_220', label: '帶：1.85–2.20', minOdds: 1.85, maxOdds: 2.2 },
  { id: 'band_185_215', label: '帶：1.85–2.15', minOdds: 1.85, maxOdds: 2.15 },
  { id: 'band_190_220', label: '帶：1.90–2.20', minOdds: 1.9, maxOdds: 2.2 },
  { id: 'band_190_215', label: '帶：1.90–2.15', minOdds: 1.9, maxOdds: 2.15 },
  { id: 'band_195_220', label: '甜區硬切：1.95–2.20', minOdds: 1.95, maxOdds: 2.2 },
  { id: 'band_195_215', label: '甜區硬切：1.95–2.15', minOdds: 1.95, maxOdds: 2.15 },
  { id: 'band_195_230', label: '帶：1.95–2.30', minOdds: 1.95, maxOdds: 2.3 },
  {
    id: 'soft_prefer_195_215_l015',
    label: '軟偏好 1.95–2.15（λ=0.15），底座仍 1.85–2.30',
    soft: true,
    minOdds: 1.85,
    maxOdds: 2.3,
    preferMin: 1.95,
    preferMax: 2.15,
    lambda: 0.15,
  },
  {
    id: 'soft_prefer_195_215_l030',
    label: '軟偏好 1.95–2.15（λ=0.30），底座仍 1.85–2.30',
    soft: true,
    minOdds: 1.85,
    maxOdds: 2.3,
    preferMin: 1.95,
    preferMax: 2.15,
    lambda: 0.3,
  },
  {
    id: 'soft_prefer_195_220_l015',
    label: '軟偏好 1.95–2.20（λ=0.15），底座仍 1.85–2.30',
    soft: true,
    minOdds: 1.85,
    maxOdds: 2.3,
    preferMin: 1.95,
    preferMax: 2.2,
    lambda: 0.15,
  },
];

console.log('Building…');
const pools = WINDOWS.map((w) => {
  const pool = buildUniverse(w.from, w.to);
  console.log(`  ${w.key}: ${pool.length}`);
  return { ...w, pool };
});
const combined = pools.flatMap((p) => p.pool);

const results = [];
for (const v of VARIANTS) {
  const pickFn = (pool) =>
    v.soft
      ? selectSoftPrefer(pool, v)
      : select(pool, { minOdds: v.minOdds, maxOdds: v.maxOdds });
  const row = {
    id: v.id,
    label: v.label,
    rules: v,
    windows: {},
  };
  for (const w of pools) row.windows[w.key] = summarize(pickFn(w.pool));
  row.windows.combined = summarize(pickFn(combined));
  results.push(row);
  const c = row.windows.combined;
  console.log(
    `${v.id.padEnd(28)} n=${String(c?.bets ?? 0).padStart(3)} hr=${c?.hitRate} avgO=${c?.avgOdds} $50=${c?.usd50}`
  );
}

const base = results.find((r) => r.id === 'baseline_185_230');
const bc = base.windows.combined;

const evaluated = results.map((r) => {
  const c = r.windows.combined;
  const y25 = r.windows['2025'];
  const y26 = r.windows['2026'];
  const keepRate = c && bc ? Number((c.bets / bc.bets).toFixed(3)) : null;
  const deltaUsd50 = c && bc ? c.usd50 - bc.usd50 : null;
  const deltaHr = c && bc ? Number((c.hitRate - bc.hitRate).toFixed(4)) : null;
  const dualPositive = (y25?.usd50 ?? -1) > 0 && (y26?.usd50 ?? -1) > 0;
  const beats = (c?.usd50 ?? -Infinity) > (bc?.usd50 ?? 0);
  const notWorseBoth =
    (y25?.usd50 ?? -Infinity) >= (base.windows['2025']?.usd50 ?? 0) &&
    (y26?.usd50 ?? -Infinity) >= (base.windows['2026']?.usd50 ?? 0);
  const hit55 = (c?.hitRate ?? 0) >= 0.55;
  const hit56 = (c?.hitRate ?? 0) >= 0.56;
  const keep85 = keepRate != null && keepRate >= 0.85;
  const keep90 = keepRate != null && keepRate >= 0.9;
  return {
    id: r.id,
    label: r.label,
    combined: c,
    y2025: y25,
    y2026: y26,
    keepRate,
    deltaBetsVsBase: c && bc ? c.bets - bc.bets : null,
    deltaUsd50VsBase: deltaUsd50,
    deltaHitRateVsBase: deltaHr,
    hitRateAtLeast55: hit55,
    hitRateAtLeast56: hit56,
    keepBets85: keep85,
    keepBets90: keep90,
    dualPositive,
    beatsBaseCombined: beats,
    notWorseBothWindows: notWorseBoth,
    passGate: Boolean(c) && beats && dualPositive,
    passStrictGate: Boolean(c) && beats && dualPositive && notWorseBoth,
    // 產品目標：勝率↑且注數不太砍
    fitsUserGoal:
      Boolean(c) &&
      dualPositive &&
      (c.hitRate ?? 0) > bc.hitRate &&
      keep85 &&
      (c.usd50 ?? 0) >= bc.usd50 * 0.95,
    fitsUserGoalStrict:
      Boolean(c) &&
      dualPositive &&
      notWorseBoth &&
      (c.hitRate ?? 0) >= 0.55 &&
      keep85 &&
      (c.usd50 ?? 0) >= bc.usd50,
  };
});

evaluated.sort((a, b) => (b.deltaHitRateVsBase ?? -1) - (a.deltaHitRateVsBase ?? -1));

const goal = evaluated.filter((e) => e.fitsUserGoal && e.id !== 'baseline_185_230');
const goalStrict = evaluated.filter((e) => e.fitsUserGoalStrict && e.id !== 'baseline_185_230');
const passStrict = evaluated.filter((e) => e.passStrictGate && e.id !== 'baseline_185_230');

const out = {
  experimentId: 'odds-sweet-spot-on-current-2026-07-28',
  generatedAt: new Date().toISOString(),
  goal: '勝率往 55%+（期望近 60）；注數盡量保留 ≥85%/90%；不改正式常數',
  baseline: evaluated.find((e) => e.id === 'baseline_185_230'),
  fitsUserGoal: goal,
  fitsUserGoalStrict: goalStrict,
  passStrictGate: passStrict,
  rankedByHitRateLift: evaluated,
  recommendation: goalStrict[0]
    ? {
        action: 'consider_exp_profile',
        id: goalStrict[0].id,
        label: goalStrict[0].label,
        hitRate: goalStrict[0].combined.hitRate,
        keepRate: goalStrict[0].keepRate,
        deltaUsd50: goalStrict[0].deltaUsd50VsBase,
      }
    : goal[0]
      ? {
          action: 'weak_candidate',
          id: goal[0].id,
          label: goal[0].label,
          note: '勝率升且注數保留尚可，但未同時滿足嚴格美元／55%／雙窗',
          hitRate: goal[0].combined.hitRate,
          keepRate: goal[0].keepRate,
          deltaUsd50: goal[0].deltaUsd50VsBase,
        }
      : {
          action: 'no_sweet_spot_meets_wr_and_volume',
          note: '第一刀未找到「勝率明顯升 + 注數≥85% + 賬不垮」的方案；維持現行',
        },
};

fs.writeFileSync(
  new URL('../tmp-odds-sweet-spot-on-current.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\n=== goal fits ===');
for (const e of goal) {
  console.log(
    `${e.id}: hr=${e.combined.hitRate} keep=${e.keepRate} d$=${e.deltaUsd50VsBase} strictGoal=${e.fitsUserGoalStrict}`
  );
}
console.log('\nrecommendation:', out.recommendation);
