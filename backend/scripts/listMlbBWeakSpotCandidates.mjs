/**
 * B 線弱點候選清單（供人工複核）
 * 挑：客勝掛掉、強主場、高 EV miss、大比分 miss、Rank1 miss
 *
 * 用法：node scripts/listMlbBWeakSpotCandidates.mjs
 * 產物：tmp-b-weakspot-candidates.json
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

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
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

function build(windowDef, validation) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, windowDef.from, windowDef.to);

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
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;

    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome ? +sig.homeEarlyExitsLast3 || 0 : +sig.awayEarlyExitsLast3 || 0;
    const oppEarly = pickHome ? +sig.awayEarlyExitsLast3 || 0 : +sig.homeEarlyExitsLast3 || 0;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2 || pickEarly > oppEarly) continue;

    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );

    const home = features?.home || {};
    const away = features?.away || {};
    const runDiff = Math.abs(hs - as);

    pool.push({
      window: windowDef.key,
      gameId: row.gameId,
      day: hk(row.commenceTime),
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      homeScore: hs,
      awayScore: as,
      score: `${as}-${hs}`,
      pickHome,
      pickTeam: pickHome ? row.homeTeam : row.awayTeam,
      pickSide: pickHome ? 'HOME' : 'AWAY',
      pickOdds,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      modelProb,
      ev,
      margin,
      bScore,
      homeWinPct: +home.homeWinPct || null,
      homeSeasonWinPct: +home.seasonWinPct || null,
      awaySeasonWinPct: +away.seasonWinPct || null,
      homeLast10: +home.last10WinPct || null,
      awayLast10: +away.last10WinPct || null,
      hit: pickHome ? hs > as : as > hs,
      runDiff,
      homeStarterGames: +(pitchers.home?.games ?? null),
      awayStarterGames: +(pitchers.away?.games ?? null),
      homeStarterEra: +(pitchers.home?.era ?? null),
      awayStarterEra: +(pitchers.away?.era ?? null),
    });
  }
  return pool;
}

function selectB(pool) {
  const byDay = new Map();
  for (const g of pool) {
    if (
      g.ev < B.minimumExpectedValue ||
      g.margin < B.minimumExpectedRunMargin ||
      g.modelProb < B.minimumModelProbability ||
      g.pickOdds < B.minimumPickOdds ||
      g.pickOdds > B.maximumPickOdds
    ) {
      continue;
    }
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    const slots = applyDrop(arr);
    slots.forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

function suspicionScore(g) {
  let s = 0;
  if (!g.hit) s += 10;
  if (g.pickSide === 'AWAY') s += 4;
  if ((g.homeWinPct ?? 0) >= 0.65) s += 5;
  if ((g.homeWinPct ?? 0) >= 0.7) s += 2;
  if (g.rank === 1) s += 3;
  if (g.ev >= 0.1) s += 3;
  if (g.ev >= 0.15) s += 2;
  if (g.runDiff >= 8) s += 4;
  if (g.runDiff >= 5) s += 2;
  if (g.modelProb < 0.55 && g.pickSide === 'AWAY') s += 2;
  if ((g.homeStarterGames ?? 99) <= 5) s += 1;
  if ((g.awayStarterGames ?? 99) <= 5) s += 1;
  return s;
}

const validation = getLatestMlbExpectedRunsValidation();
const all = WINDOWS.flatMap((w) => selectB(build(w, validation)));
const misses = all.filter((g) => !g.hit);

const ranked = [...misses]
  .map((g) => ({ ...g, suspicion: suspicionScore(g) }))
  .sort((a, b) => b.suspicion - a.suspicion || b.ev - a.ev);

const top = ranked.slice(0, 40).map((g, i) => ({
  i: i + 1,
  suspicion: g.suspicion,
  window: g.window,
  day: g.day,
  homeTeam: g.homeTeam,
  awayTeam: g.awayTeam,
  matchup: `${g.awayTeam} @ ${g.homeTeam}`,
  score: g.score,
  noteHome: `主場=${g.homeTeam}`,
  pickSide: g.pickSide,
  pickTeam: g.pickTeam,
  rank: g.rank,
  odds: Number(g.pickOdds.toFixed(3)),
  P: Number(g.modelProb.toFixed(4)),
  EV: Number(g.ev.toFixed(4)),
  margin: Number(g.margin.toFixed(3)),
  homeWinPct: g.homeWinPct == null ? null : Number(g.homeWinPct.toFixed(3)),
  homeSeasonWinPct: g.homeSeasonWinPct == null ? null : Number(g.homeSeasonWinPct.toFixed(3)),
  awaySeasonWinPct: g.awaySeasonWinPct == null ? null : Number(g.awaySeasonWinPct.toFixed(3)),
  homeLast10: g.homeLast10 == null ? null : Number(g.homeLast10.toFixed(2)),
  awayLast10: g.awayLast10 == null ? null : Number(g.awayLast10.toFixed(2)),
  runDiff: g.runDiff,
  homeStarterEra: g.homeStarterEra == null ? null : Number(g.homeStarterEra.toFixed(2)),
  awayStarterEra: g.awayStarterEra == null ? null : Number(g.awayStarterEra.toFixed(2)),
  homeStarterGames: g.homeStarterGames,
  awayStarterGames: g.awayStarterGames,
  gameId: g.gameId,
  whySuspicious: [
    g.pickSide === 'AWAY' ? '選客場' : null,
    (g.homeWinPct ?? 0) >= 0.65 ? `強主場 homeWinPct=${(g.homeWinPct * 100).toFixed(0)}%` : null,
    g.rank === 1 ? '當日Rank1' : null,
    g.ev >= 0.1 ? `高EV=${(g.ev * 100).toFixed(1)}%` : null,
    g.runDiff >= 5 ? `大比分差${g.runDiff}` : null,
    g.modelProb < 0.55 && g.pickSide === 'AWAY' ? '薄邊客勝' : null,
  ]
    .filter(Boolean)
    .join('；'),
}));

const out = {
  experimentId: 'b-weakspot-candidates-2026-07-29',
  note: '停止規則掃參；供人工指出「明顯不該選」的模式。格式：客 @ 主，並標注 pickSide。',
  baseline: {
    bets: all.length,
    hits: all.filter((x) => x.hit).length,
    misses: misses.length,
    hitRate: Number((all.filter((x) => x.hit).length / all.length).toFixed(4)),
  },
  splitMiss: {
    awayMiss: misses.filter((x) => x.pickSide === 'AWAY').length,
    homeMiss: misses.filter((x) => x.pickSide === 'HOME').length,
    awayVsStrongHomeMiss: misses.filter(
      (x) => x.pickSide === 'AWAY' && (x.homeWinPct ?? 0) >= 0.65
    ).length,
  },
  top40ForHumanReview: top,
};

fs.writeFileSync(
  new URL('../tmp-b-weakspot-candidates.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('baseline', out.baseline);
console.log('splitMiss', out.splitMiss);
console.log('\n--- TOP 25 供人工複核（客@主；主場已標）---\n');
for (const r of top.slice(0, 25)) {
  console.log(
    `#${String(r.i).padStart(2)} [${r.window}] ${r.day} | ${r.matchup} | 比分 ${r.score}`
  );
  console.log(
    `    主場=${r.homeTeam} | 系統選=${r.pickSide} ${r.pickTeam} (Rank${r.rank}) | odds=${r.odds} P=${r.P} EV=${r.EV}`
  );
  console.log(`    可疑點: ${r.whySuspicious}`);
  console.log('');
}
