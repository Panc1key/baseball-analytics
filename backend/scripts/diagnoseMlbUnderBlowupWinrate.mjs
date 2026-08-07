/**
 * 小分被「超大分」打爆診斷 + 勝率屏蔽刀
 * 產物：tmp-under-blowup-winrate.json
 *
 * 原則：不下脆弱小分；不翻大。
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import { getCachedMlbGameWeather } from '../src/services/MlbGameWeatherService.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { MLB_TOTALS_SATELLITE_SPEC } from '../src/services/MlbTotalsSatellite.js';

const R = MLB_TOTALS_SATELLITE_SPEC.rules;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-28' },
];
const BLOWUP_GE = 3; // 實際總分 − 線 ≥ 3：超大分打爆

function bestTotals(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'totals');
    if (!market) continue;
    for (const over of market.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = market.outcomes.find(
        (o) => o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!over.price || !under?.price) continue;
      const overOdds = Number(over.price);
      const underOdds = Number(under.price);
      if (overOdds < R.pickOddsMin || underOdds < R.pickOddsMin) continue;
      if (overOdds > R.pickOddsMax || underOdds > R.pickOddsMax) continue;
      const vig = 1 / overOdds + 1 / underOdds;
      if (!best || vig < best.vig) {
        const fair = removeVig(
          decimalToImpliedProb(overOdds),
          decimalToImpliedProb(underOdds)
        );
        best = {
          line: Number(over.point),
          overOdds,
          underOdds,
          fairOver: fair.fairA,
          fairUnder: fair.fairB,
          vig,
        };
      }
    }
  }
  return best;
}

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hitRate: null, roi: null, usd50: 0, blowupRate: null };
  }
  let unit = 0;
  let hits = 0;
  let blowups = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else {
      unit -= 1;
      if (b.overshoot >= BLOWUP_GE) blowups += 1;
    }
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * 50),
    blowupN: blowups,
    blowupRate: Number((blowups / n).toFixed(4)),
  };
}

function maxFinite(...xs) {
  const a = xs.filter((x) => Number.isFinite(x));
  return a.length ? Math.max(...a) : null;
}

const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) {
  console.error('no model');
  process.exit(1);
}

const underBets = [];
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
    features.parkFactor = resolveMlbParkFactor({
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    const weather = getCachedMlbGameWeather(row.gameId);
    if (weather) features.weather = weather;

    let pred;
    try {
      pred = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    } catch {
      continue;
    }
    const market = bestTotals(row.gameId, row.commenceTime);
    if (!market) continue;

    const mu = Number(pred.expectedTotal);
    const gap = mu - market.line;
    // Under only: μ below line
    if (!(gap < 0) || Math.abs(gap) < R.minAbsGap) continue;
    if (market.line > R.maxTotalLine) continue;

    const dist = buildMlbScoreDistribution({
      homeMean: Number(pred.homeExpectedRuns),
      awayMean: Number(pred.awayExpectedRuns),
      homeDispersion: Number(pred.dispersion ?? 3.5),
      awayDispersion: Number(pred.dispersion ?? 3.5),
    });
    const mk = deriveMlbScoreMarkets(dist, { totalLine: market.line });
    const pushP = Number(mk.total?.pushProbability) || 0;
    const underRaw = Number(mk.total?.underProbability);
    if (!Number.isFinite(underRaw)) continue;
    const modelProb = underRaw / Math.max(1e-9, 1 - pushP);
    const pickOdds = market.underOdds;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const edge = modelProb - market.fairUnder;
    if (ev < R.minimumExpectedValue) continue;
    if (edge < R.minEdgeVsMarket) continue;
    if (modelProb < R.minimumModelProbability) continue;
    if (pickOdds < R.pickOddsMin || pickOdds > R.pickOddsMax) continue;

    const homeR3 = Number(features?.pitchers?.homeRecent?.recent3Era);
    const awayR3 = Number(features?.pitchers?.awayRecent?.recent3Era);
    const homeEra = Number(features?.pitchers?.home?.era);
    const awayEra = Number(features?.pitchers?.away?.era);
    const homeBp = Number(features?.recentBoxscore?.home?.bullpen?.era);
    const awayBp = Number(features?.recentBoxscore?.away?.bullpen?.era);
    const park = Number(features.parkFactor);

    const total = Number(row.hs) + Number(row.ascore);
    if (total === market.line) continue;
    const hit = total < market.line;
    const overshoot = total - market.line; // >0 means over the line

    underBets.push({
      window: w.key,
      pickOdds,
      hit,
      overshoot,
      blowup: !hit && overshoot >= BLOWUP_GE,
      absGap: Math.abs(gap),
      maxR3: maxFinite(homeR3, awayR3),
      maxEra: maxFinite(homeEra, awayEra),
      maxBp: maxFinite(homeBp, awayBp),
      park,
      line: market.line,
      mu,
      actual: total,
    });
  }
}

const base = summarize(underBets);
const losses = underBets.filter((b) => !b.hit);
const blowups = underBets.filter((b) => b.blowup);

function bucket(xs, key, edges) {
  const out = {};
  for (const e of edges) out[e.id] = [];
  for (const x of xs) {
    const v = x[key];
    for (const e of edges) {
      if (v >= e.lo && v < e.hi) {
        out[e.id].push(x);
        break;
      }
    }
  }
  return Object.fromEntries(
    Object.entries(out).map(([id, arr]) => [
      id,
      { n: arr.length, share: xs.length ? Number((arr.length / xs.length).toFixed(3)) : null },
    ])
  );
}

const lossOvershoot = bucket(losses, 'overshoot', [
  { id: '0_1', lo: 0, hi: 1 },
  { id: '1_2', lo: 1, hi: 2 },
  { id: '2_3', lo: 2, hi: 3 },
  { id: '3_5', lo: 3, hi: 5 },
  { id: '5_plus', lo: 5, hi: 99 },
]);

const policies = [
  { id: 'skip_era_ge50', test: (b) => (b.maxEra ?? -1) >= 5 },
  { id: 'skip_era_ge48', test: (b) => (b.maxEra ?? -1) >= 4.8 },
  { id: 'skip_r3_ge55', test: (b) => (b.maxR3 ?? -1) >= 5.5 },
  { id: 'skip_r3_ge50', test: (b) => (b.maxR3 ?? -1) >= 5 },
  { id: 'skip_bp_ge55', test: (b) => (b.maxBp ?? -1) >= 5.5 },
  { id: 'skip_park_ge105', test: (b) => (b.park ?? 0) >= 1.05 },
  { id: 'skip_gap_lt08', test: (b) => b.absGap < 0.8 },
  {
    id: 'skip_era50_or_r355',
    test: (b) => (b.maxEra ?? -1) >= 5 || (b.maxR3 ?? -1) >= 5.5,
  },
  {
    id: 'skip_era48_and_gap_lt10',
    test: (b) => (b.maxEra ?? -1) >= 4.8 && b.absGap < 1,
  },
  {
    id: 'skip_fragile_combo',
    test: (b) =>
      ((b.maxEra ?? -1) >= 4.8 || (b.maxR3 ?? -1) >= 5.5) && b.absGap < 1.1,
  },
  {
    id: 'skip_blowup_proxy_v1',
    // 高 ERA 或近況差 + 打者公園：對準超大分尾部
    test: (b) =>
      ((b.maxEra ?? -1) >= 5 || (b.maxR3 ?? -1) >= 6) &&
      (b.park ?? 0) >= 1.0,
  },
].map((p) => {
  const dropped = underBets.filter(p.test);
  const kept = underBets.filter((b) => !p.test(b));
  const s = summarize(kept);
  const d = summarize(dropped);
  const blowDropped = dropped.filter((b) => b.blowup).length;
  return {
    id: p.id,
    droppedN: dropped.length,
    droppedHr: d.hitRate,
    blowupsCaught: blowDropped,
    blowupCatchRate: blowups.length
      ? Number((blowDropped / blowups.length).toFixed(3))
      : null,
    ledger: s,
    deltaHrPp:
      s.hitRate != null && base.hitRate != null
        ? Number(((s.hitRate - base.hitRate) * 100).toFixed(2))
        : null,
    deltaUsd: s.usd50 - base.usd50,
    deltaBlowupPp:
      s.blowupRate != null && base.blowupRate != null
        ? Number(((s.blowupRate - base.blowupRate) * 100).toFixed(2))
        : null,
  };
});

policies.sort((a, b) => {
  // 優先：勝率升、爆分率降、美元不太崩
  const aOk = (a.deltaHrPp ?? -99) > 0 && (a.deltaBlowupPp ?? 99) < 0 && (a.deltaUsd ?? -9999) >= -250;
  const bOk = (b.deltaHrPp ?? -99) > 0 && (b.deltaBlowupPp ?? 99) < 0 && (b.deltaUsd ?? -9999) >= -250;
  if (aOk !== bOk) return aOk ? -1 : 1;
  if ((b.deltaHrPp ?? -99) !== (a.deltaHrPp ?? -99)) return (b.deltaHrPp ?? -99) - (a.deltaHrPp ?? -99);
  return (b.deltaUsd ?? -9999) - (a.deltaUsd ?? -9999);
});

const recommend =
  policies.find(
    (p) =>
      (p.deltaHrPp ?? 0) >= 0.5 &&
      (p.deltaBlowupPp ?? 0) < 0 &&
      (p.deltaUsd ?? -9999) >= -250
  ) ||
  policies.find((p) => (p.deltaHrPp ?? 0) > 0 && (p.deltaBlowupPp ?? 0) < 0) ||
  policies[0];

const report = {
  experimentId: 'under-blowup-winrate-2026-08-07',
  note: {
    jaysCubs:
      '2026-08-06 藍鳥@小熊紙上是獨贏藍鳥輸 2-3（晚局翻盤），不是大小分。mlb_paper_bets 無 totals；hybrid freeze 表目前 0 列。',
    principle: '晚局獨贏翻盤屬噪音；小分被超大分打爆才是可擋的勝率問題。不翻大。',
  },
  baseline: base,
  losses: {
    n: losses.length,
    overshootBuckets: lossOvershoot,
    blowupGe3: {
      n: blowups.length,
      shareOfUnders: Number((blowups.length / underBets.length).toFixed(3)),
      shareOfLosses: losses.length
        ? Number((blowups.length / losses.length).toFixed(3))
        : null,
      avgOvershoot: blowups.length
        ? Number(
            (
              blowups.reduce((s, b) => s + b.overshoot, 0) / blowups.length
            ).toFixed(2)
          )
        : null,
    },
  },
  policies,
  recommend,
};

fs.writeFileSync(
  new URL('../tmp-under-blowup-winrate.json', import.meta.url),
  JSON.stringify(report, null, 2)
);
console.log('baseline', base);
console.log('loss overshoot', lossOvershoot);
console.log('blowups', report.losses.blowupGe3);
console.log('top policies', policies.slice(0, 5));
console.log('recommend', recommend);
