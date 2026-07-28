/**
 * 現行固定基線：庄家參考價／共識價掃描（不改正式選價，除非過嚴格閘）
 * 底座過濾仍用 ev02_max230+≥2庄；僅替換「用哪家價算 EV／進池」
 * 產物：tmp-book-ref-scan-on-current.json
 *
 * 用法: node scripts/auditMlbBookRefScanOnCurrent.mjs
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

const FOCUS_BOOKS = [
  'fanduel',
  'draftkings',
  'betmgm',
  'betonlineag',
  'lowvig',
  'williamhill_us',
  'bovada',
  'betrivers',
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
      key: String(book.key || book.title || 'unknown').toLowerCase(),
      homeOdds,
      awayOdds,
      vig: 1 / homeOdds + 1 / awayOdds,
    });
  }
  return books;
}

function median(nums) {
  if (!nums.length) return null;
  const xs = [...nums].sort((a, b) => a - b);
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
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
  };
}

function buildRaw(fromDate, toDate) {
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

  const out = [];
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
    if (books.length < 2) continue;
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
    if (homeId == null || awayId == null) continue;
    if (RULES.requirePickEarlyExitsNotHigher && pickEarly > oppEarly) continue;

    out.push({
      day: hkDate(row.commenceTime),
      window: fromDate.startsWith('2025') ? '2025' : '2026',
      pickHome,
      hit: pickHome === hs > as,
      modelProb,
      margin: Math.abs(ph - pa),
      books,
    });
  }
  return out;
}

function priceFromPolicy(game, policy) {
  const books = game.books;
  let chosen = null;
  if (policy === 'lowest_vig') {
    chosen = [...books].sort((a, b) => a.vig - b.vig)[0];
  } else if (policy === 'median_pick_odds') {
    const pickOddsList = books.map((b) => (game.pickHome ? b.homeOdds : b.awayOdds));
    const med = median(pickOddsList);
    // 用最接近中位選價的庄；home/away 取該庄雙邊
    chosen = [...books].sort((a, b) => {
      const pa = game.pickHome ? a.homeOdds : a.awayOdds;
      const pb = game.pickHome ? b.homeOdds : b.awayOdds;
      return Math.abs(pa - med) - Math.abs(pb - med);
    })[0];
  } else if (policy.startsWith('book:')) {
    const key = policy.slice(5);
    chosen = books.find((b) => b.key === key) || null;
  }
  if (!chosen) return null;
  const homeOdds = chosen.homeOdds;
  const awayOdds = chosen.awayOdds;
  if (
    homeOdds < RULES.minimumEitherSideOdds ||
    awayOdds < RULES.minimumEitherSideOdds
  ) {
    return null;
  }
  const pickOdds = game.pickHome ? homeOdds : awayOdds;
  if (pickOdds < RULES.minimumPickOdds || pickOdds > RULES.maximumPickOdds) return null;
  const ev = game.modelProb * (pickOdds - 1) - (1 - game.modelProb);
  if (ev < RULES.minimumExpectedValue) return null;
  if (game.margin < RULES.minimumExpectedRunMargin) return null;
  if (game.modelProb < RULES.minimumModelProbability) return null;
  return {
    ...game,
    pickOdds,
    homeOdds,
    awayOdds,
    ev,
    bookKey: chosen.key,
  };
}

function select(priced) {
  const byDay = new Map();
  for (const g of priced) {
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

function evalPolicy(rawPools, policy) {
  const windows = {};
  const combinedPriced = [];
  for (const w of rawPools) {
    const priced = w.raw.map((g) => priceFromPolicy(g, policy)).filter(Boolean);
    windows[w.key] = summarize(select(priced));
    combinedPriced.push(...priced);
  }
  windows.combined = summarize(select(combinedPriced));
  return windows;
}

console.log('Building raw…');
const rawPools = WINDOWS.map((w) => ({
  ...w,
  raw: buildRaw(w.from, w.to),
}));
console.log(rawPools.map((w) => `${w.key}:${w.raw.length}`).join(' '));

const policies = [
  { id: 'lowest_vig', label: '現行：vig 最薄庄' },
  { id: 'median_pick_odds', label: '選邊價最接近多庄中位' },
  ...FOCUS_BOOKS.map((k) => ({ id: `book:${k}`, label: `固定参考价 ${k}` })),
];

const results = [];
for (const p of policies) {
  const windows = evalPolicy(rawPools, p.id);
  results.push({ id: p.id, label: p.label, windows });
  const c = windows.combined;
  console.log(
    `${p.id.padEnd(24)} n=${String(c?.bets ?? 0).padStart(3)} hr=${c?.hitRate} roi=${c?.roi} $50=${c?.usd50}`
  );
}

const base = results.find((r) => r.id === 'lowest_vig');
const evaluated = results.map((r) => {
  const c = r.windows.combined;
  const y25 = r.windows['2025'];
  const y26 = r.windows['2026'];
  const bc = base.windows.combined;
  const beats = (c?.usd50 ?? -Infinity) > (bc?.usd50 ?? 0);
  const dualPos = (y25?.usd50 ?? -1) > 0 && (y26?.usd50 ?? -1) > 0;
  const notWorse =
    (y25?.usd50 ?? -Infinity) >= (base.windows['2025']?.usd50 ?? 0) &&
    (y26?.usd50 ?? -Infinity) >= (base.windows['2026']?.usd50 ?? 0);
  return {
    id: r.id,
    label: r.label,
    combined: c,
    y2025: y25,
    y2026: y26,
    deltaUsd50VsBase: c && bc ? c.usd50 - bc.usd50 : null,
    deltaBetsVsBase: c && bc ? c.bets - bc.bets : null,
    deltaHitRateVsBase: c && bc ? Number((c.hitRate - bc.hitRate).toFixed(4)) : null,
    passGate: Boolean(c) && beats && dualPos,
    passStrictGate: Boolean(c) && beats && dualPos && notWorse,
  };
});
evaluated.sort((a, b) => (b.deltaUsd50VsBase ?? -1e9) - (a.deltaUsd50VsBase ?? -1e9));

const passStrict = evaluated.filter((e) => e.passStrictGate && e.id !== 'lowest_vig');

const out = {
  experimentId: 'book-ref-scan-on-current-2026-07-27',
  generatedAt: new Date().toISOString(),
  note: '不改正式選價除非 passStrict；Bet365 不在資料源內',
  baselinePolicy: 'lowest_vig',
  baseline: evaluated.find((e) => e.id === 'lowest_vig'),
  passStrictGate: passStrict,
  rankedByDeltaUsd50: evaluated,
  recommendation: passStrict[0]
    ? {
        action: 'consider_change_ref_price',
        id: passStrict[0].id,
        deltaUsd50: passStrict[0].deltaUsd50VsBase,
      }
    : {
        action: 'keep_lowest_vig',
        note: '無参考价政策同時過嚴格閘；維持 vig 最薄',
      },
};

fs.writeFileSync(
  new URL('../tmp-book-ref-scan-on-current.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log('\nrecommendation', out.recommendation);
