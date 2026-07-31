/**
 * 列出 2025-06（香港日）鎖定 B 全部選注明細
 * 產物：tmp-2025-06-locked-b-bets.json
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

const validation = getLatestMlbExpectedRunsValidation();
const rows = db
  .prepare(
    `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
            g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
     FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
     WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
       AND date(f.commence_time) >= date('2025-05-28') AND date(f.commence_time) <= date('2025-07-03')
     ORDER BY f.commence_time`
  )
  .all(MLB_BASELINE_FEATURE_VERSION);

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
  const hit = pickHome === hs > as;
  const pnlUsd = hit ? Math.round((pickOdds - 1) * 50 * 100) / 100 : -50;
  pool.push({
    gameId: row.gameId,
    commenceTime: row.commenceTime,
    day: hk(row.commenceTime),
    month: hk(row.commenceTime).slice(0, 7),
    matchup: `${row.awayTeam} @ ${row.homeTeam}`,
    score: `${as}-${hs}`,
    pickSide: pickHome ? 'home' : 'away',
    pickTeam: pickHome ? row.homeTeam : row.awayTeam,
    pickOdds: Number(pickOdds.toFixed(3)),
    modelProb: Number(modelProb.toFixed(4)),
    ev: Number(ev.toFixed(4)),
    margin: Number(margin.toFixed(3)),
    homeExp: Number(ph.toFixed(2)),
    awayExp: Number(pa.toFixed(2)),
    bScore: Number(bScore.toFixed(4)),
    hit,
    pnlUsd,
  });
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
  return slots.map((g, i) => ({ ...g, dailyRank: i + 1 }));
}

const map = new Map();
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
  if (!map.has(g.day)) map.set(g.day, []);
  map.get(g.day).push(g);
}
const allPicks = [];
for (const day of [...map.keys()].sort()) {
  const arr = [...map.get(day)].sort(
    (a, b) => b.bScore - a.bScore || b.margin - a.margin
  );
  allPicks.push(...applyDrop(arr));
}

const picks = allPicks
  .filter((p) => p.month === '2025-06')
  .sort((a, b) => String(a.commenceTime).localeCompare(String(b.commenceTime)));

let cum = 0;
const rowsOut = picks.map((p, i) => {
  cum += p.pnlUsd;
  return {
    i: i + 1,
    day: p.day,
    matchup: p.matchup,
    score: p.score,
    pick: p.pickTeam,
    side: p.pickSide,
    rank: p.dailyRank,
    odds: p.pickOdds,
    P: p.modelProb,
    EV: p.ev,
    margin: p.margin,
    expAH: `${p.awayExp}/${p.homeExp}`,
    result: p.hit ? 'HIT' : 'MISS',
    pnlUsd: p.pnlUsd,
    cumUsd: Math.round(cum * 100) / 100,
    gameId: p.gameId,
  };
});

const hits = rowsOut.filter((r) => r.result === 'HIT').length;
const misses = rowsOut.filter((r) => r.result === 'MISS');
const out = {
  month: '2025-06',
  tz: 'Asia/Hong_Kong',
  policy: 'locked B ev02_max230 + dropR3/R2',
  n: rowsOut.length,
  hits,
  misses: misses.length,
  hitRate: Number((hits / rowsOut.length).toFixed(4)),
  usd50: Math.round(cum),
  bets: rowsOut,
  missList: misses.map((r) => ({
    i: r.i,
    day: r.day,
    matchup: r.matchup,
    score: r.score,
    pick: r.pick,
    rank: r.rank,
    odds: r.odds,
    P: r.P,
    EV: r.EV,
    margin: r.margin,
  })),
};

fs.writeFileSync(
  new URL('../tmp-2025-06-locked-b-bets.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log(
  `# 2025-06（HK）鎖定B 共 ${out.n} 注｜中 ${hits}｜負 ${misses.length}｜勝率 ${(out.hitRate * 100).toFixed(1)}%｜@$50 ${out.usd50 >= 0 ? '+' : ''}${out.usd50}\n`
);
for (const r of rowsOut) {
  console.log(
    `${String(r.i).padStart(2)}. ${r.day} | ${r.matchup} | ${r.score} | 選 ${r.pick} | R${r.rank} | 賠${r.odds} | P${r.P} | EV${r.EV} | m${r.margin} | ${r.result} | ${r.pnlUsd >= 0 ? '+' : ''}${r.pnlUsd} | 累計${r.cumUsd}`
  );
}
console.log(`\n--- MISS ${misses.length} 場 ---`);
for (const r of misses) {
  console.log(
    `${String(r.i).padStart(2)}. ${r.day} ${r.matchup} 比分${r.score} 選${r.pick} R${r.rank} @${r.odds}`
  );
}
