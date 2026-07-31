/**
 * 近 N 個月：型態路由 v2 大小球 lean vs 獨贏方向（研究用）。
 * 均值用 v4.5；不靠 soft 調分，只看「該看哪個盤」。
 * v2：僅在 totalsLean 非空時計入大小球命中；one_sided／unclear 不下 lean。
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  attachMlbRegimeMarketPlan,
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const months = Number(process.argv[2] || 3);
const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) throw new Error('model_missing');

const since = new Date();
since.setUTCMonth(since.getUTCMonth() - months);
const sinceIso = since.toISOString().slice(0, 10);

const rows = db.prepare(`
  SELECT f.game_id AS gameId,
         f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
         g.home_score AS homeScore,
         g.away_score AS awayScore,
         g.home_team AS homeTeam,
         g.away_team AS awayTeam
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  WHERE f.feature_version = ?
    AND g.completed = 1
    AND g.home_score IS NOT NULL
    AND date(f.commence_time) >= date(?)
  ORDER BY f.commence_time
`).all(MLB_BASELINE_FEATURE_VERSION, sinceIso);

function bestTotalsLine(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'totals');
    if (!market) continue;
    for (const over of market.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = market.outcomes.find((o) =>
        o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!under?.price || !over.price) continue;
      const vig = 1 / over.price + 1 / under.price;
      if (!best || vig < best.vig) {
        best = {
          line: Number(over.point),
          overOdds: Number(over.price),
          underOdds: Number(under.price),
          vig,
          fairOver: removeVig(
            decimalToImpliedProb(over.price),
            decimalToImpliedProb(under.price)
          ).fairA,
        };
      }
    }
  }
  return best;
}

function empty() {
  return { n: 0, hits: 0, pushes: 0 };
}

const moneylineAll = empty();
const totalsLeanDecided = empty();
const totalsUnder = empty();
const totalsOver = empty();
const moneylineWhenBlocked = empty();
const byRegime = {};
const byReason = {};

let routedTotalsPrimary = 0;
let routedMoneyline = 0;
let routedMargin = 0;
let leanNull = 0;

for (const row of rows) {
  let features;
  try {
    features = JSON.parse(row.featuresJson);
  } catch {
    continue;
  }
  const homeScore = Number(row.homeScore);
  const awayScore = Number(row.awayScore);
  const actualTotal = homeScore + awayScore;
  const market = bestTotalsLine(row.gameId, row.commenceTime);
  const line = market?.line ?? 8.5;
  const base = predictMlbGameRuns(model, features, { totalLine: line });
  const routed = attachMlbRegimeMarketPlan(base, features, { totalLine: line });
  const plan = routed.marketPlan;
  const regime = plan?.regimePredicted || 'unknown';
  if (!byRegime[regime]) byRegime[regime] = { n: 0, leanN: 0, leanHits: 0 };
  byRegime[regime].n += 1;

  if (homeScore !== awayScore) {
    moneylineAll.n += 1;
    const predHome = base.homeExpectedRuns >= base.awayExpectedRuns;
    if (predHome === (homeScore > awayScore)) moneylineAll.hits += 1;
  }

  if (plan.primaryMarket === 'moneyline') {
    routedMoneyline += 1;
    continue;
  }
  if (plan.primaryMarket === 'margin') {
    routedMargin += 1;
  } else if (plan.primaryMarket === 'totals') {
    routedTotalsPrimary += 1;
  }

  const lean = plan.totalsLean;
  if (!lean) {
    leanNull += 1;
    continue;
  }

  const reason = plan.reason || 'unknown';
  if (!byReason[reason]) byReason[reason] = empty();
  byRegime[regime].leanN += 1;

  if (actualTotal === line) {
    totalsLeanDecided.pushes += 1;
    byReason[reason].pushes += 1;
    continue;
  }
  const hit = lean === 'over' ? actualTotal > line : actualTotal < line;
  totalsLeanDecided.n += 1;
  byReason[reason].n += 1;
  if (hit) {
    totalsLeanDecided.hits += 1;
    byReason[reason].hits += 1;
    byRegime[regime].leanHits += 1;
  }
  if (lean === 'under') {
    totalsUnder.n += 1;
    if (hit) totalsUnder.hits += 1;
  } else if (lean === 'over') {
    totalsOver.n += 1;
    if (hit) totalsOver.hits += 1;
  }

  if (plan.moneylinePriority === 'blocked' && homeScore !== awayScore) {
    moneylineWhenBlocked.n += 1;
    const predHome = base.homeExpectedRuns >= base.awayExpectedRuns;
    if (predHome === (homeScore > awayScore)) moneylineWhenBlocked.hits += 1;
  }
}

function rate(b) {
  return {
    decided: b.n,
    pushes: b.pushes || 0,
    hits: b.hits,
    hitRate: b.n ? Number((b.hits / b.n).toFixed(4)) : null,
  };
}

const out = {
  ok: true,
  routerVersion: 'mlb-regime-market-router-v2',
  windowMonths: months,
  since: sinceIso,
  modelVersion: validation.modelVersion,
  games: rows.length,
  routing: {
    primaryTotals: routedTotalsPrimary,
    primaryMoneyline: routedMoneyline,
    primaryMargin: routedMargin,
    leanNullNoBet: leanNull,
    totalsLeanShare: rows.length
      ? Number((totalsLeanDecided.n / rows.length).toFixed(3))
      : null,
  },
  moneylineAllGames: rate(moneylineAll),
  totalsWhenLeanDecided: rate(totalsLeanDecided),
  totalsUnderOnly: rate(totalsUnder),
  totalsOverOnly: rate(totalsOver),
  moneylineOnBlockedRegimeGames: rate(moneylineWhenBlocked),
  byRegime: Object.fromEntries(
    Object.entries(byRegime).map(([k, v]) => [
      k,
      {
        games: v.n,
        leanDecided: v.leanN,
        leanHitRate: v.leanN ? Number((v.leanHits / v.leanN).toFixed(4)) : null,
      },
    ])
  ),
  byReason: Object.fromEntries(
    Object.entries(byReason).map(([k, v]) => [k, rate(v)])
  ),
  note: [
    'v2：僅 totalsLean 非空才計大小球命中（one_sided／unclear 不下 lean）',
    '單邊崩主市場為分差觀察，不再自動押大',
    '均值模型未改；非正式投注建議',
  ],
};

fs.writeFileSync('tmp-regime-market-route-recent.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
