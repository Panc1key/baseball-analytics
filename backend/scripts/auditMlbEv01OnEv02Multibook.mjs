/**
 * 現行底座（ev02_max230 + minH2hBooks≥2）上試 EV≥1%
 * 閘門：合併 usd50 > 基線，且 2025、2026 都正；嚴格：雙窗都不低於基線
 * 產物：tmp-ev01-on-ev02-multibook.json
 *
 * 用法: node scripts/auditMlbEv01OnEv02Multibook.mjs
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

const CURRENT = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: 2,
};

const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function hkDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function collectH2hBooks(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return [];
  const books = [];
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
    const homeOdds = Number(home.price);
    const awayOdds = Number(away.price);
    if (!Number.isFinite(homeOdds) || !Number.isFinite(awayOdds)) continue;
    books.push({
      homeOdds,
      awayOdds,
      vig: 1 / homeOdds + 1 / awayOdds,
    });
  }
  return books;
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
    roi: Number((unit / n).toFixed(4)),
    unitPnl: Number(unit.toFixed(2)),
    usd50: Math.round(unit * 50),
    usd75: Math.round(unit * 75),
  };
}

function passesRules(g, rules) {
  if (rules.requireBothPitcherIdentities && !g.bothIds) return false;
  if (g.bookCount < (rules.minimumH2hBookmakers || 0)) return false;
  if (g.ev < rules.minimumExpectedValue) return false;
  if (g.margin < rules.minimumExpectedRunMargin) return false;
  if (g.modelProb < rules.minimumModelProbability) return false;
  if (rules.minimumPickOdds != null && g.pickOdds < rules.minimumPickOdds) return false;
  if (rules.maximumPickOdds != null && g.pickOdds > rules.maximumPickOdds) return false;
  if (
    rules.minimumEitherSideOdds != null &&
    (g.homeOdds < rules.minimumEitherSideOdds || g.awayOdds < rules.minimumEitherSideOdds)
  ) {
    return false;
  }
  if (rules.requirePickEarlyExitsNotHigher && g.pickEarly > g.oppEarly) return false;
  return true;
}

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
    const books = collectH2hBooks(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (!books.length) continue;
    books.sort((a, b) => a.vig - b.vig);
    const best = books[0];
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
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

    pool.push({
      day: hkDate(row.commenceTime),
      hit: pickHome === hs > as,
      pickOdds,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      ev,
      margin,
      modelProb,
      pickEarly,
      oppEarly,
      bothIds: homeId != null && awayId != null,
      bookCount: books.length,
    });
  }
  return pool;
}

function select(pool, rules) {
  const byDay = new Map();
  for (const g of pool) {
    if (!passesRules(g, rules)) continue;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({
      ...g,
      score: scoreMlbMoneylineDailyRank(
        { expectedValue: g.ev, modelProbability: g.modelProb },
        rules
      ),
    });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    out.push(
      ...[...byDay.get(day)]
        .sort((a, b) => b.score - a.score || b.margin - a.margin)
        .slice(0, rules.dailyTopK)
    );
  }
  return out;
}

const VARIANTS = [
  {
    id: 'baseline_ev02_books2',
    label: '現行：EV≥2% + maxOdds≤2.30 + ≥2庄',
    rules: { ...CURRENT, minimumExpectedValue: 0.02 },
  },
  {
    id: 'ev01_max230_books2',
    label: '實驗：EV≥1% + maxOdds≤2.30 + ≥2庄',
    rules: { ...CURRENT, minimumExpectedValue: 0.01 },
  },
  {
    id: 'ev00_max230_books2',
    label: '對照：EV≥0% + maxOdds≤2.30 + ≥2庄',
    rules: { ...CURRENT, minimumExpectedValue: 0 },
  },
  {
    id: 'ev01_max220_books2',
    label: '實驗：EV≥1% + maxOdds≤2.20 + ≥2庄',
    rules: { ...CURRENT, minimumExpectedValue: 0.01, maximumPickOdds: 2.2 },
  },
];

console.log('Building universes…');
const pools = WINDOWS.map((w) => {
  const pool = buildUniverse(w.from, w.to);
  console.log(`  ${w.key}: ${pool.length}`);
  return { ...w, pool };
});
const combined = pools.flatMap((p) => p.pool);

const results = [];
for (const v of VARIANTS) {
  const row = { id: v.id, label: v.label, windows: {} };
  for (const w of pools) row.windows[w.key] = summarize(select(w.pool, v.rules));
  row.windows.combined = summarize(select(combined, v.rules));
  results.push(row);
  const c = row.windows.combined;
  console.log(
    `${v.id.padEnd(22)} n=${String(c?.bets ?? 0).padStart(3)} hr=${c?.hitRate} roi=${c?.roi} $50=${c?.usd50}`
  );
}

const base = results.find((r) => r.id === 'baseline_ev02_books2');
const evaluated = results.map((r) => {
  const c = r.windows.combined;
  const y25 = r.windows['2025'];
  const y26 = r.windows['2026'];
  const bc = base.windows.combined;
  const deltaUsd50 = c && bc ? c.usd50 - bc.usd50 : null;
  const dualPositive = (y25?.usd50 ?? -1) > 0 && (y26?.usd50 ?? -1) > 0;
  const beatsBase = (c?.usd50 ?? -Infinity) > (bc?.usd50 ?? 0);
  const notWorseBoth =
    (y25?.usd50 ?? -Infinity) >= (base.windows['2025']?.usd50 ?? 0) &&
    (y26?.usd50 ?? -Infinity) >= (base.windows['2026']?.usd50 ?? 0);
  return {
    id: r.id,
    label: r.label,
    combined: c,
    y2025: y25,
    y2026: y26,
    deltaUsd50VsBase: deltaUsd50,
    deltaBetsVsBase: c && bc ? c.bets - bc.bets : null,
    deltaHitRateVsBase: c && bc ? Number((c.hitRate - bc.hitRate).toFixed(4)) : null,
    dualPositive,
    beatsBaseCombined: beatsBase,
    notWorseBothWindows: notWorseBoth,
    passGate: Boolean(c) && beatsBase && dualPositive,
    passStrictGate: Boolean(c) && beatsBase && dualPositive && notWorseBoth,
  };
});

const passStrict = evaluated.filter((e) => e.passStrictGate && e.id !== 'baseline_ev02_books2');
const out = {
  experimentId: 'ev01-on-ev02-multibook-2026-07-27',
  generatedAt: new Date().toISOString(),
  note: '三家庄不如兩家庄；本掃描在 ≥2 庄底座上試再放寬 EV',
  baseline: evaluated.find((e) => e.id === 'baseline_ev02_books2'),
  passStrictGate: passStrict,
  rankedByDeltaUsd50: evaluated.sort(
    (a, b) => (b.deltaUsd50VsBase ?? -1e9) - (a.deltaUsd50VsBase ?? -1e9)
  ),
  recommendation: passStrict[0]
    ? {
        action: 'consider_profile',
        id: passStrict[0].id,
        deltaUsd50: passStrict[0].deltaUsd50VsBase,
        deltaBets: passStrict[0].deltaBetsVsBase,
      }
    : {
        action: 'keep_ev02_max230_books2',
        note: 'EV≥1% 未同時過嚴格閘；維持現行',
      },
};

fs.writeFileSync(
  new URL('../tmp-ev01-on-ev02-multibook.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log('\nrecommendation:', out.recommendation);
