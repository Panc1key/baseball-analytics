/**
 * 清單研究：B 客場 Rank1 + 主隊主場勝率 >= 65%
 *
 * 用法：node scripts/auditMlbAwayRank1StrongHomeList.mjs
 * 產物：tmp-away-rank1-strong-home-list.json
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

function summarize(rows) {
  if (!rows.length) return { bets: 0, hitRate: null, avgOdds: null, usd50: 0 };
  let hits = 0;
  let odds = 0;
  let unit = 0;
  for (const r of rows) {
    odds += r.pickOdds;
    if (r.hit) {
      hits += 1;
      unit += r.pickOdds - 1;
    } else unit -= 1;
  }
  return {
    bets: rows.length,
    hitRate: Number((hits / rows.length).toFixed(4)),
    avgOdds: Number((odds / rows.length).toFixed(3)),
    usd50: Math.round(unit * 50),
  };
}

function build(windowDef) {
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

    pool.push({
      window: windowDef.key,
      gameId: row.gameId,
      day: hk(row.commenceTime),
      matchup: `${row.awayTeam} @ ${row.homeTeam}`,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      homeWon: hs > as,
      pickHome,
      pickOdds,
      modelProb,
      margin,
      ev,
      bScore,
      homeWinPct: +features?.home?.homeWinPct || null,
      score: `${as}-${hs}`,
    });
  }
  return pool;
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
    slots.forEach((x, i) =>
      out.push({ ...x, rank: i + 1, hit: x.pickHome ? x.homeWon : !x.homeWon })
    );
  }
  return out;
}

function probBucket(p) {
  if (p < 0.53) return '[50,53)';
  if (p < 0.55) return '[53,55)';
  if (p < 0.57) return '[55,57)';
  if (p < 0.6) return '[57,60)';
  return '[60,+)';
}

const allPicks = WINDOWS.flatMap((w) => selectB(build(w)));
const subset = allPicks.filter((x) => !x.pickHome && x.rank === 1 && (x.homeWinPct ?? 0) >= 0.65);

const byWindow = {};
for (const w of WINDOWS) {
  const baseW = allPicks.filter((x) => x.window === w.key);
  const subW = subset.filter((x) => x.window === w.key);
  byWindow[w.key] = {
    baseline: summarize(baseW),
    subset: summarize(subW),
    subsetShare: baseW.length ? Number((subW.length / baseW.length).toFixed(3)) : 0,
  };
}

const bucketMap = new Map();
for (const r of subset) {
  const k = `${r.window}|${probBucket(r.modelProb)}`;
  if (!bucketMap.has(k)) bucketMap.set(k, []);
  bucketMap.get(k).push(r);
}
const calibration = [...bucketMap.entries()].map(([k, arr]) => {
  const [window, bucket] = k.split('|');
  const s = summarize(arr);
  const avgP = Number((arr.reduce((a, x) => a + x.modelProb, 0) / arr.length).toFixed(4));
  return { window, bucket, avgModelProb: avgP, ...s };
});
calibration.sort((a, b) => a.window.localeCompare(b.window) || a.bucket.localeCompare(b.bucket));

const out = {
  experimentId: 'away-rank1-strong-home-list-2026-07-29',
  condition: 'B 已選中 + 客場選邊 + rank=1 + 主隊主場勝率>=65%',
  baseline: summarize(allPicks),
  subset: summarize(subset),
  subsetShare: Number((subset.length / allPicks.length).toFixed(3)),
  byWindow,
  calibration,
  rows: subset.map((r) => ({
    window: r.window,
    day: r.day,
    matchup: r.matchup,
    score: r.score,
    pick: r.awayTeam,
    result: r.hit ? 'HIT' : 'MISS',
    odds: Number(r.pickOdds.toFixed(3)),
    modelProb: Number(r.modelProb.toFixed(4)),
    ev: Number(r.ev.toFixed(4)),
    margin: Number(r.margin.toFixed(3)),
    homeWinPct: Number((r.homeWinPct ?? 0).toFixed(4)),
    gameId: r.gameId,
  })),
};

fs.writeFileSync(
  new URL('../tmp-away-rank1-strong-home-list.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('BASELINE', out.baseline);
console.log('SUBSET', out.subset, 'share=', out.subsetShare);
for (const [w, v] of Object.entries(out.byWindow)) {
  console.log(`WINDOW ${w}`, v);
}
