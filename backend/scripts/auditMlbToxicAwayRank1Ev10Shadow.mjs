/**
 * 影子軌：客+強主場+Rank1 且 EV≥10% → 不下
 * 正式軌仍為鎖定 B；不寫入 mlb_paper_bets
 *
 * 用法：node scripts/auditMlbToxicAwayRank1Ev10Shadow.mjs
 * 產物：tmp-b-toxic-away-rank1-ev10-shadow.json
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
const STRONG = 0.65;
const EV_CUT = 0.1;
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
function summarize(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0 };
  let hits = 0;
  let unit = 0;
  let odds = 0;
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
    usd50: Math.round(unit * 50),
  };
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

function isToxicIllusion(b) {
  return (
    b.pickHome === false &&
    (b.homeWinPct ?? 0) >= STRONG &&
    b.rank === 1 &&
    b.ev >= EV_CUT
  );
}

const validation = getLatestMlbExpectedRunsValidation();
const pool = [];
for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);

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
      window: w.key,
      day: hk(row.commenceTime),
      gameId: row.gameId,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      pickHome,
      pickOdds,
      modelProb,
      ev,
      margin,
      bScore,
      homeWinPct: +features?.home?.homeWinPct || null,
      hit: pickHome ? hs > as : as > hs,
    });
  }
}

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
const official = [];
for (const day of [...byDay.keys()].sort()) {
  const arr = [...byDay.get(day)].sort(
    (a, b) => b.bScore - a.bScore || b.margin - a.margin
  );
  applyDrop(arr).forEach((x, i) => official.push({ ...x, rank: i + 1 }));
}

const dropped = official.filter(isToxicIllusion);
const shadow = official.filter((b) => !isToxicIllusion(b));

const out = {
  experimentId: 'b-toxic-away-rank1-ev10-shadow-2026-07-29',
  rule: '客場 + homeWinPct≥65% + Rank1 + EV≥10% → 影子軌不下；正式仍純 B',
  recommendWire: false,
  reason: 'Expanding WF beat/hurt=2/5，未過穩健閘；僅影子觀察',
  official: summarize(official),
  shadow: summarize(shadow),
  dropped: summarize(dropped),
  deltaUsd50: summarize(shadow).usd50 - summarize(official).usd50,
  byWindow: {
    official: Object.fromEntries(
      WINDOWS.map((w) => [w.key, summarize(official.filter((x) => x.window === w.key))])
    ),
    shadow: Object.fromEntries(
      WINDOWS.map((w) => [w.key, summarize(shadow.filter((x) => x.window === w.key))])
    ),
  },
  droppedRows: dropped.map((b) => ({
    window: b.window,
    day: b.day,
    matchup: `${b.awayTeam} @ ${b.homeTeam}`,
    home: b.homeTeam,
    pick: b.awayTeam,
    hit: b.hit,
    odds: Number(b.pickOdds.toFixed(3)),
    P: Number(b.modelProb.toFixed(4)),
    EV: Number(b.ev.toFixed(4)),
    homeWinPct: Number((b.homeWinPct ?? 0).toFixed(3)),
    gameId: b.gameId,
  })),
};

fs.writeFileSync(
  new URL('../tmp-b-toxic-away-rank1-ev10-shadow.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('official', out.official);
console.log('shadow', out.shadow);
console.log('dropped', out.dropped, 'n=', dropped.length);
console.log('Δ$', out.deltaUsd50, 'recommendWire=', out.recommendWire);
