/**
 * 舊 A（P≥55% + margin≥1）+ 賠率地板實驗：1.70–1.85
 * 用法: node scripts/auditMlbLegacyAOddsBand170185.mjs
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

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
  if (!bets.length) {
    return {
      bets: 0,
      hitRate: null,
      avgOdds: null,
      breakeven: null,
      clearsOwn: false,
      roi: null,
      usd50: 0,
    };
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
  const avg = odds / n;
  const hr = hits / n;
  const be = 1 / avg;
  return {
    bets: n,
    hitRate: Number(hr.toFixed(4)),
    avgOdds: Number(avg.toFixed(3)),
    breakeven: Number(be.toFixed(4)),
    clearsOwn: hr > be,
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}

function build(from, to) {
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
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2 || pickEarly > oppEarly) continue;
    if (modelProb < 0.55 || margin < 1) continue;
    pool.push({
      day: hk(row.commenceTime),
      hit: pickHome === hs > as,
      pickOdds,
      margin,
      modelProb,
    });
  }
  return pool;
}

function selectTopK(pool, minO, maxO, k) {
  const byDay = new Map();
  for (const g of pool) {
    if (g.pickOdds < minO || g.pickOdds > maxO) continue;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    out.push(
      ...[...byDay.get(day)]
        .sort((a, b) => b.modelProb - a.modelProb || b.margin - a.margin)
        .slice(0, k)
    );
  }
  return out;
}

console.log('Building…');
const pools = WINDOWS.map((w) => {
  const pool = build(w.from, w.to);
  console.log(`  ${w.key}: ${pool.length}`);
  return { ...w, pool };
});

const variants = [
  { id: 'legacy_a_wide', label: '舊A無地板（對照）', min: 1.4, max: 3.0, k: 3 },
  { id: 'a_170_185_k3', label: '1.70–1.85 Top3', min: 1.7, max: 1.85, k: 3 },
  { id: 'a_170_185_k2', label: '1.70–1.85 Top2', min: 1.7, max: 1.85, k: 2 },
  { id: 'a_170_185_k1', label: '1.70–1.85 Top1', min: 1.7, max: 1.85, k: 1 },
  { id: 'a_170_1849_k1', label: '1.70–1.849 Top1（不碰B）', min: 1.7, max: 1.849, k: 1 },
];

const out = {
  generatedAt: new Date().toISOString(),
  rule: 'P>=0.55 & margin>=1 + odds band',
  variants: [],
};

for (const v of variants) {
  const windows = {};
  const all = [];
  for (const w of pools) {
    const picks = selectTopK(w.pool, v.min, v.max, v.k);
    windows[w.key] = summarize(picks);
    all.push(...picks);
  }
  windows.combined = summarize(all);
  out.variants.push({ ...v, windows });
  const c = windows.combined;
  console.log(
    `${v.id.padEnd(20)} n=${String(c.bets).padStart(3)} hr=${c.hitRate} avgO=${c.avgOdds} be=${c.breakeven} clear=${c.clearsOwn} roi=${c.roi} $50=${c.usd50} | 2025$${windows['2025'].usd50} 2026$${windows['2026'].usd50}`
  );
}

fs.writeFileSync(
  new URL('../tmp-legacy-a-odds-170-185.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
