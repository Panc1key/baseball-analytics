/**
 * 掃描：攻擊狀態 vs 投手 K9 交叉過濾（底座=現行 ev02_max230+≥2庄）
 * 閘門：合併 usd50>基線；雙窗都正；嚴格：雙窗都不低於基線
 * 產物：tmp-offense-k9-cross-on-current.json
 *
 * 用法: node scripts/auditMlbOffenseK9CrossOnCurrent.mjs
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

const R = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
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
function pickSigned(diff, pickHome) {
  if (diff == null) return null;
  return pickHome ? diff : -diff;
}

function enrich(features, pickHome) {
  const v = features.vector || {};
  return {
    advRecentRuns: pickSigned(n(v.recentRunsDiff), pickHome),
    advObp14: pickSigned(n(v.battingObp14Diff), pickHome),
    advSlg14: pickSigned(n(v.battingSlg14Diff), pickHome),
    advPitcherK9: pickSigned(n(v.pitcherK9Diff), pickHome),
  };
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
      ev < R.minimumExpectedValue ||
      margin < R.minimumExpectedRunMargin ||
      modelProb < R.minimumModelProbability ||
      pickOdds < R.minimumPickOdds ||
      pickOdds > R.maximumPickOdds ||
      best.homeOdds < R.minimumEitherSideOdds ||
      best.awayOdds < R.minimumEitherSideOdds ||
      (R.requirePickEarlyExitsNotHigher && pickEarly > oppEarly)
    ) {
      continue;
    }
    const e = enrich(features, pickHome);
    if (e.advRecentRuns == null || e.advPitcherK9 == null) continue;
    pool.push({
      day: hk(row.commenceTime),
      window: from.startsWith('2025') ? '2025' : '2026',
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      ...e,
      score: scoreMlbMoneylineDailyRank(
        { expectedValue: ev, modelProbability: modelProb },
        R
      ),
    });
  }
  return pool;
}

function select(pool, filterFn) {
  const byDay = new Map();
  for (const g of pool) {
    if (!filterFn(g)) continue;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    out.push(
      ...[...byDay.get(day)]
        .sort((a, b) => b.score - a.score || b.margin - a.margin)
        .slice(0, R.dailyTopK)
    );
  }
  return out;
}

const FILTERS = [
  { id: 'baseline', label: '現行基線（無交叉過濾）', fn: () => true },
  {
    id: 'block_cold_offense',
    label: '擋：近期得分優勢 < 0',
    fn: (g) => g.advRecentRuns >= 0,
  },
  {
    id: 'block_cold_offense_m025',
    label: '擋：近期得分優勢 < -0.25',
    fn: (g) => g.advRecentRuns >= -0.25,
  },
  {
    id: 'block_cold_offense_m05',
    label: '擋：近期得分優勢 < -0.5',
    fn: (g) => g.advRecentRuns >= -0.5,
  },
  {
    id: 'block_cold_obp',
    label: '擋：OBP14 優勢 < 0',
    fn: (g) => g.advObp14 == null || g.advObp14 >= 0,
  },
  {
    id: 'block_cold_obp_m01',
    label: '擋：OBP14 優勢 < -0.01',
    fn: (g) => g.advObp14 == null || g.advObp14 >= -0.01,
  },
  {
    id: 'block_high_k9',
    label: '擋：K9 優勢 > 0.5',
    fn: (g) => g.advPitcherK9 <= 0.5,
  },
  {
    id: 'block_high_k9_075',
    label: '擋：K9 優勢 > 0.75',
    fn: (g) => g.advPitcherK9 <= 0.75,
  },
  {
    id: 'cross_cold_and_high_k9',
    label: '擋交叉：得分優勢<0 且 K9優勢>0.3',
    fn: (g) => !(g.advRecentRuns < 0 && g.advPitcherK9 > 0.3),
  },
  {
    id: 'cross_cold_and_high_k9_soft',
    label: '擋交叉：得分優勢<-0.25 且 K9優勢>0.4',
    fn: (g) => !(g.advRecentRuns < -0.25 && g.advPitcherK9 > 0.4),
  },
  {
    id: 'cross_obp_and_high_k9',
    label: '擋交叉：OBP優勢<0 且 K9優勢>0.3',
    fn: (g) => !(g.advObp14 != null && g.advObp14 < 0 && g.advPitcherK9 > 0.3),
  },
  {
    id: 'cross_obp_m01_k9_04',
    label: '擋交叉：OBP優勢<-0.01 且 K9優勢>0.4',
    fn: (g) => !(g.advObp14 != null && g.advObp14 < -0.01 && g.advPitcherK9 > 0.4),
  },
  {
    id: 'require_offense_or_not_high_k9',
    label: '擋交叉：得分優勢<0 且 K9優勢>0.5',
    fn: (g) => !(g.advRecentRuns < 0 && g.advPitcherK9 > 0.5),
  },
];

console.log('Building…');
const pools = WINDOWS.map((w) => ({ ...w, pool: buildUniverse(w.from, w.to) }));
for (const w of pools) console.log(`  ${w.key}: ${w.pool.length}`);
const combined = pools.flatMap((p) => p.pool);

const results = [];
for (const f of FILTERS) {
  const row = { id: f.id, label: f.label, windows: {} };
  for (const w of pools) row.windows[w.key] = summarize(select(w.pool, f.fn));
  row.windows.combined = summarize(select(combined, f.fn));
  // june 2025 only diagnostic
  const junePool = combined.filter((g) => g.day >= '2025-06-01' && g.day <= '2025-06-30');
  row.june2025 = summarize(select(junePool, f.fn));
  results.push(row);
  const c = row.windows.combined;
  console.log(
    `${f.id.padEnd(32)} n=${String(c?.bets ?? 0).padStart(3)} hr=${c?.hitRate} $50=${c?.usd50} jun=${row.june2025?.usd50}`
  );
}

const base = results.find((r) => r.id === 'baseline');
const evaluated = results.map((r) => {
  const c = r.windows.combined;
  const y25 = r.windows['2025'];
  const y26 = r.windows['2026'];
  const bc = base.windows.combined;
  const deltaUsd50 = c && bc ? c.usd50 - bc.usd50 : null;
  const dualPositive = (y25?.usd50 ?? -1) > 0 && (y26?.usd50 ?? -1) > 0;
  const beats = (c?.usd50 ?? -Infinity) > (bc?.usd50 ?? 0);
  const notWorse =
    (y25?.usd50 ?? -Infinity) >= (base.windows['2025']?.usd50 ?? 0) &&
    (y26?.usd50 ?? -Infinity) >= (base.windows['2026']?.usd50 ?? 0);
  const hitUp = c && bc ? c.hitRate >= bc.hitRate : false;
  return {
    id: r.id,
    label: r.label,
    combined: c,
    y2025: y25,
    y2026: y26,
    june2025: r.june2025,
    deltaUsd50VsBase: deltaUsd50,
    deltaBetsVsBase: c && bc ? c.bets - bc.bets : null,
    deltaHitRateVsBase: c && bc ? Number((c.hitRate - bc.hitRate).toFixed(4)) : null,
    dualPositive,
    beatsBaseCombined: beats,
    notWorseBothWindows: notWorse,
    hitRateNotDown: hitUp,
    passGate: Boolean(c) && beats && dualPositive,
    passStrictGate: Boolean(c) && beats && dualPositive && notWorse,
    positiveLift: Boolean(c) && beats && dualPositive && hitUp,
  };
});
evaluated.sort((a, b) => (b.deltaUsd50VsBase ?? -1e9) - (a.deltaUsd50VsBase ?? -1e9));

const passStrict = evaluated.filter((e) => e.passStrictGate && e.id !== 'baseline');
const positive = evaluated.filter((e) => e.positiveLift && e.id !== 'baseline');

const out = {
  experimentId: 'offense-k9-cross-on-current-2026-07-28',
  generatedAt: new Date().toISOString(),
  note: '查缺補漏掃描；未改正式規則',
  baseline: evaluated.find((e) => e.id === 'baseline'),
  passStrictGate: passStrict,
  positiveLift: positive,
  rankedByDeltaUsd50: evaluated,
  recommendation: positive[0]
    ? {
        action: 'consider_add_cross_filter',
        id: positive[0].id,
        label: positive[0].label,
        deltaUsd50: positive[0].deltaUsd50VsBase,
        deltaHitRate: positive[0].deltaHitRateVsBase,
        deltaBets: positive[0].deltaBetsVsBase,
      }
    : passStrict[0]
      ? {
          action: 'weak_dollar_only',
          id: passStrict[0].id,
          note: '總美元過嚴格閘但勝率未升（或持平條件未滿足）',
          deltaUsd50: passStrict[0].deltaUsd50VsBase,
          deltaHitRate: passStrict[0].deltaHitRateVsBase,
        }
      : {
          action: 'do_not_write_into_rules',
          note: '無交叉過濾同時：合併美元>基線、雙窗正且不低於基線；維持現行',
        },
};

fs.writeFileSync(
  new URL('../tmp-offense-k9-cross-on-current.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log('\nrecommendation:', out.recommendation);
console.log(
  'passStrict:',
  passStrict.map((e) => `${e.id} d$=${e.deltaUsd50VsBase} dhr=${e.deltaHitRateVsBase}`)
);
