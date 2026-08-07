/**
 * 與市場同邊／禁「逆市場客」對照
 * 產物：tmp-winrate-market-agree.json
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
import {
  applyFormalLockedBResidual,
  applyFormalToxicAwayShrink,
} from '../src/services/MlbFrozenBShadow.js';

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
function drop(sorted) {
  let s = sorted.slice(0, 3);
  if (s.length >= 3 && s[2].margin < DROP_R3) s = s.slice(0, 2);
  if (
    s.length >= 2 &&
    s[1].pickOdds >= DROP_R2_MIN &&
    s[1].pickOdds < DROP_R2_MAX
  ) {
    s = [s[0], ...s.slice(2)];
  }
  return s;
}
function sum(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, usd50: 0, avgOdds: null };
  let h = 0;
  let u = 0;
  let o = 0;
  for (const b of bets) {
    o += b.pickOdds;
    if (b.hit) {
      h += 1;
      u += b.pickOdds - 1;
    } else u -= 1;
  }
  return {
    bets: bets.length,
    hitRate: Number((h / bets.length).toFixed(4)),
    usd50: Math.round(u * 50),
    avgOdds: Number((o / bets.length).toFixed(3)),
  };
}

const model = getLatestMlbExpectedRunsValidation()?.model;
const byDay = new Map();
for (const w of WINDOWS) {
  console.log('load', w.key);
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS hs, g.away_score AS ascore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);
  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const hs = +row.hs;
    const as = +row.ascore;
    if (hs === as) continue;
    const p = features?.pitchers || {};
    if (
      (p.homeIdentity?.id ?? p.home?.id) == null ||
      (p.awayIdentity?.id ?? p.away?.id) == null
    )
      continue;
    const hwp = +features?.home?.homeWinPct;
    if (!Number.isFinite(hwp)) continue;
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    let pred = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    pred = applyFormalLockedBResidual(model, pred, features, { totalLine: 8.5 });
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    const sig = buildPregameRegimeSignals(features);
    if (
      (pickHome ? sig.homeEarlyExitsLast3 : sig.awayEarlyExitsLast3) >
      (pickHome ? sig.awayEarlyExitsLast3 : sig.homeEarlyExitsLast3)
    )
      continue;
    modelProb = applyFormalToxicAwayShrink(modelProb, pickOdds, {
      pickHome,
      homeWinPct: hwp,
    });
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue) continue;
    if (margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (pickOdds < B.minimumPickOdds || pickOdds > B.maximumPickOdds) continue;
    const score = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    const marketFavHome = best.homeOdds <= best.awayOdds;
    const agree = pickHome === marketFavHome;
    const day = `${w.key}:${hk(row.commenceTime)}`;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({
      score,
      margin,
      pickOdds,
      pickHome,
      agree,
      hit: pickHome ? hs > as : as > hs,
    });
  }
}

function run(filter) {
  const out = [];
  for (const [day, c] of byDay) {
    drop([...c.filter(filter)].sort((a, b) => b.score - a.score || b.margin - a.margin)).forEach(
      (b, i) => out.push({ ...b, day, rank: i + 1 })
    );
  }
  return sum(out);
}

const official = run(() => true);
const agreeOnly = run((c) => c.agree);
const banAwayDisagree = run((c) => c.agree || c.pickHome);

const report = {
  official,
  agreeWithMarketOnly: {
    ...agreeOnly,
    deltaHrPp: Number(((agreeOnly.hitRate - official.hitRate) * 100).toFixed(2)),
    deltaUsd: agreeOnly.usd50 - official.usd50,
  },
  banAwayWhenDisagreeMarket: {
    ...banAwayDisagree,
    deltaHrPp: Number(((banAwayDisagree.hitRate - official.hitRate) * 100).toFixed(2)),
    deltaUsd: banAwayDisagree.usd50 - official.usd50,
  },
};
fs.writeFileSync(
  new URL('../tmp-winrate-market-agree.json', import.meta.url),
  JSON.stringify(report, null, 2)
);
console.log(JSON.stringify(report, null, 2));
