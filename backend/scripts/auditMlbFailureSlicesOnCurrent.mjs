/**
 * 現行固定基線選注：失敗模式／毒區描述性切片（不改規則）
 * 底座：ev02_max230 + minimumH2hBookmakers≥2
 * 產物：tmp-failure-slices-on-current.json
 *
 * 用法: node scripts/auditMlbFailureSlicesOnCurrent.mjs
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

const RULES = {
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
      key: book.key || book.title || 'unknown',
      homeOdds,
      awayOdds,
      vig: 1 / homeOdds + 1 / awayOdds,
    });
  }
  return books;
}

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hitRate: null, avgOdds: null, roi: null, unitPnl: null, usd50: null };
  }
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
  };
}

function passes(g) {
  if (RULES.requireBothPitcherIdentities && !g.bothIds) return false;
  if (g.bookCount < RULES.minimumH2hBookmakers) return false;
  if (g.ev < RULES.minimumExpectedValue) return false;
  if (g.margin < RULES.minimumExpectedRunMargin) return false;
  if (g.modelProb < RULES.minimumModelProbability) return false;
  if (g.pickOdds < RULES.minimumPickOdds) return false;
  if (g.pickOdds > RULES.maximumPickOdds) return false;
  if (
    g.homeOdds < RULES.minimumEitherSideOdds ||
    g.awayOdds < RULES.minimumEitherSideOdds
  ) {
    return false;
  }
  if (RULES.requirePickEarlyExitsNotHigher && g.pickEarly > g.oppEarly) return false;
  return true;
}

function buildUniverse(fromDate, toDate, windowKey) {
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
      month: String(row.commenceTime).slice(0, 7),
      window: windowKey,
      pickHome,
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
      bookKey: best.key,
      highEvToxicBand: ev >= 0.12 && modelProb >= 0.53 && modelProb < 0.56,
    });
  }
  return pool;
}

function select(pool) {
  const byDay = new Map();
  for (const g of pool) {
    if (!passes(g)) continue;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({
      ...g,
      score: scoreMlbMoneylineDailyRank(
        { expectedValue: g.ev, modelProbability: g.modelProb },
        RULES
      ),
    });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    out.push(
      ...[...byDay.get(day)]
        .sort((a, b) => b.score - a.score || b.margin - a.margin)
        .slice(0, RULES.dailyTopK)
    );
  }
  return out;
}

function oddsBand(o) {
  if (o < 1.95) return '1.85-1.95';
  if (o < 2.05) return '1.95-2.05';
  if (o < 2.15) return '2.05-2.15';
  if (o <= 2.3) return '2.15-2.30';
  return 'above_2.30';
}

function pBand(p) {
  if (p < 0.52) return '0.50-0.52';
  if (p < 0.55) return '0.52-0.55';
  if (p < 0.58) return '0.55-0.58';
  return '0.58+';
}

function evBand(e) {
  if (e < 0.04) return '0.02-0.04';
  if (e < 0.06) return '0.04-0.06';
  if (e < 0.10) return '0.06-0.10';
  if (e < 0.15) return '0.10-0.15';
  return '0.15+';
}

function sliceBy(bets, keyFn) {
  const map = new Map();
  for (const b of bets) {
    const k = keyFn(b);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(b);
  }
  return [...map.entries()]
    .map(([key, xs]) => ({ key, ...summarize(xs) }))
    .sort((a, b) => (a.usd50 ?? 0) - (b.usd50 ?? 0));
}

function flagToxic(slices, overall) {
  return slices
    .filter((s) => s.bets >= 20 && (s.usd50 ?? 0) < 0)
    .map((s) => ({
      ...s,
      note:
        s.roi != null && overall.roi != null && s.roi < overall.roi - 0.05
          ? 'roi_well_below_overall'
          : 'negative_usd',
    }));
}

console.log('Building…');
const pools = WINDOWS.map((w) => ({
  ...w,
  pool: buildUniverse(w.from, w.to, w.key),
}));
const picks2025 = select(pools[0].pool);
const picks2026 = select(pools[1].pool);
const picks = [...picks2025, ...picks2026];

const overall = summarize(picks);
const byWindow = {
  '2025': summarize(picks2025),
  '2026': summarize(picks2026),
  combined: overall,
};

const slices = {
  byMonth: sliceBy(picks, (b) => b.month),
  byOddsBand: sliceBy(picks, (b) => oddsBand(b.pickOdds)),
  byPBand: sliceBy(picks, (b) => pBand(b.modelProb)),
  byEvBand: sliceBy(picks, (b) => evBand(b.ev)),
  bySide: sliceBy(picks, (b) => (b.pickHome ? 'home' : 'away')),
  byHighEvToxicBand: sliceBy(picks, (b) => (b.highEvToxicBand ? 'in_p2_toxic_band' : 'outside')),
  byBookCount: sliceBy(picks, (b) => (b.bookCount >= 8 ? '8+' : String(b.bookCount))),
  bySelectedBook: sliceBy(picks, (b) => b.bookKey).slice(0, 15),
};

const toxicCandidates = {
  months: flagToxic(slices.byMonth, overall),
  oddsBands: flagToxic(slices.byOddsBand, overall),
  pBands: flagToxic(slices.byPBand, overall),
  evBands: flagToxic(slices.byEvBand, overall),
};

const dualWindowMonthToxic = slices.byMonth
  .filter((m) => m.bets >= 15 && (m.usd50 ?? 0) < 0)
  .map((m) => {
    const y25 = summarize(picks2025.filter((b) => b.month === m.key));
    const y26 = summarize(picks2026.filter((b) => b.month === m.key));
    return { month: m.key, combined: m, y2025: y25, y2026: y26 };
  });

const out = {
  experimentId: 'failure-slices-on-current-2026-07-27',
  generatedAt: new Date().toISOString(),
  baseline: {
    profile: 'ev02_max230',
    minimumH2hBookmakers: 2,
    note: '描述性切片；不改規則',
  },
  overall: byWindow,
  slices,
  toxicCandidates,
  dualWindowMonthToxic,
  interpretation: {
    stableToxicFilterCandidates: Object.entries(toxicCandidates)
      .flatMap(([family, xs]) =>
        xs.map((x) => ({
          family,
          key: x.key,
          bets: x.bets,
          usd50: x.usd50,
          roi: x.roi,
        }))
      )
      .filter((x) => x.bets >= 30),
    verdict:
      Object.values(toxicCandidates).every((xs) => xs.filter((x) => x.bets >= 30).length === 0)
        ? 'no_large_stable_toxic_slice_for_hard_filter'
        : 'has_candidate_slices_need_wf_before_filter',
  },
};

fs.writeFileSync(
  new URL('../tmp-failure-slices-on-current.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log('overall', byWindow);
console.log('toxic large', out.interpretation);
console.log('worst months', slices.byMonth.slice(0, 5));
console.log('odds bands', slices.byOddsBand);
console.log('p bands', slices.byPBand);
console.log('ev bands', slices.byEvBand);
