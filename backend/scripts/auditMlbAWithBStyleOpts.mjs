/**
 * 舊 A 門檻（P≥55% + margin≥1）套上 B 同款結構優化，看盈虧
 * 對照純 B 基準包。不改正式常數。
 * 用法: node scripts/auditMlbAWithBStyleOpts.mjs
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
const DROP_R3 = Number(B.dropThirdIfMarginBelow) || 0.5;
const DROP_R2_MAX = Number(B.dropSecondIfOddsBelow) || 1.95;
const DROP_R2_MIN = Number(B.dropSecondIfOddsMin) || 1.85;

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
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
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
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2 || pickEarly > oppEarly) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    pool.push({
      day: hk(row.commenceTime),
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      bScore,
    });
  }
  return pool;
}

function byDaySelect(pool, filterFn, sortFn, takeFn) {
  const map = new Map();
  for (const g of pool) {
    if (!filterFn(g)) continue;
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const arr = [...map.get(day)].sort(sortFn);
    out.push(...takeFn(arr));
  }
  return out;
}

function applyDropR3R2(sortedTop) {
  let slots = sortedTop.slice(0, 3);
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

const isA = (g) => g.modelProb >= 0.55 && g.margin >= 1;
const isB = (g) =>
  g.ev >= B.minimumExpectedValue &&
  g.margin >= B.minimumExpectedRunMargin &&
  g.modelProb >= B.minimumModelProbability &&
  g.pickOdds >= B.minimumPickOdds &&
  g.pickOdds <= B.maximumPickOdds;

const VARIANTS = [
  {
    id: 'legacy_a_raw',
    label: '舊A原樣：P55+m1，日內全取（無TopK）',
    fn: (pool) =>
      byDaySelect(
        pool,
        isA,
        (a, b) => b.modelProb - a.modelProb || b.margin - a.margin,
        (arr) => arr
      ),
  },
  {
    id: 'a_topk3_by_prob',
    label: 'A + Top3（按P）',
    fn: (pool) =>
      byDaySelect(
        pool,
        isA,
        (a, b) => b.modelProb - a.modelProb || b.margin - a.margin,
        (arr) => arr.slice(0, 3)
      ),
  },
  {
    id: 'a_topk3_dropR3R2',
    label: 'A + Top3 + dropR3/R2（同B結構）',
    fn: (pool) =>
      byDaySelect(
        pool,
        isA,
        (a, b) => b.modelProb - a.modelProb || b.margin - a.margin,
        applyDropR3R2
      ),
  },
  {
    id: 'a_min185_topk3',
    label: 'A門檻 + B地板minOdds≥1.85 + Top3',
    fn: (pool) =>
      byDaySelect(
        pool,
        (g) => isA(g) && g.pickOdds >= 1.85 && g.pickOdds <= 2.3,
        (a, b) => b.modelProb - a.modelProb || b.margin - a.margin,
        (arr) => arr.slice(0, 3)
      ),
  },
  {
    id: 'a_min185_full_b_structure',
    label: 'A門檻 + min185 + Top3 + P2排序 + dropR3/R2',
    fn: (pool) =>
      byDaySelect(
        pool,
        (g) => isA(g) && g.pickOdds >= 1.85 && g.pickOdds <= 2.3,
        (a, b) => b.bScore - a.bScore || b.margin - a.margin,
        applyDropR3R2
      ),
  },
  {
    id: 'a_min185_ev02_like_b',
    label: 'A門檻 + 再加EV≥2% + 全B結構（幾乎A∩B）',
    fn: (pool) =>
      byDaySelect(
        pool,
        (g) => isA(g) && isB(g),
        (a, b) => b.bScore - a.bScore || b.margin - a.margin,
        applyDropR3R2
      ),
  },
  {
    id: 'b_baseline_locked',
    label: '純B基準包（對照）',
    fn: (pool) =>
      byDaySelect(
        pool,
        isB,
        (a, b) => b.bScore - a.bScore || b.margin - a.margin,
        applyDropR3R2
      ),
  },
];

console.log('Building…');
const pools = WINDOWS.map((w) => {
  const pool = build(w.from, w.to);
  console.log(`  ${w.key}: ${pool.length}`);
  return { ...w, pool };
});

const results = [];
for (const v of VARIANTS) {
  const windows = {};
  const all = [];
  for (const w of pools) {
    const picks = v.fn(w.pool);
    windows[w.key] = summarize(picks);
    all.push(...picks);
  }
  windows.combined = summarize(all);
  results.push({ id: v.id, label: v.label, windows });
  const c = windows.combined;
  console.log(
    `${v.id.padEnd(28)} n=${String(c.bets).padStart(3)} hr=${c.hitRate} avgO=${c.avgOdds} clear=${c.clearsOwn} roi=${c.roi} $50=${c.usd50} | 25$${windows['2025'].usd50} 26$${windows['2026'].usd50}`
  );
}

const out = {
  generatedAt: new Date().toISOString(),
  question: '舊A門檻套B同款優化後盈虧？',
  results,
  verdict: (() => {
    const b = results.find((r) => r.id === 'b_baseline_locked')?.windows.combined;
    const bestAish = results
      .filter((r) => r.id !== 'b_baseline_locked')
      .map((r) => ({
        id: r.id,
        label: r.label,
        ...r.windows.combined,
        y2025: r.windows['2025'].usd50,
        y2026: r.windows['2026'].usd50,
      }))
      .sort((a, b) => (b.usd50 ?? -999) - (a.usd50 ?? -999))[0];
    return {
      bUsd50: b?.usd50,
      bestAStyle: bestAish,
      note:
        bestAish && bestAish.usd50 > 0 && bestAish.y2025 > 0 && bestAish.y2026 > 0
          ? '存在「A門檻+B結構」變體合併為正且雙窗正，但仍需對照是否不如純B'
          : 'A門檻+B結構變體未能穩定雙窗盈利；或盈利遠弱於純B',
      beatsB: bestAish && b ? bestAish.usd50 > b.usd50 : false,
    };
  })(),
};

fs.writeFileSync(
  new URL('../tmp-a-with-b-style-opts.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log('\nverdict:', out.verdict);
