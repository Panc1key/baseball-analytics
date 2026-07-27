/**
 * 掃描：A（高勝率短賠）+ B（長賠 EV）合體，目標均賠≈1.8 且勝率上升。
 * 不改 ExpectedRuns 算式；只改選場規則。
 *
 * 用法: node scripts/auditMlbAbHybridLift.mjs [monthsBack]
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const monthsBack = Number(process.argv[2] || 6);
const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) throw new Error('model_missing');

const since = new Date();
since.setUTCMonth(since.getUTCMonth() - monthsBack);
const sinceIso = since.toISOString().slice(0, 10);

const rows = db
  .prepare(
    `
  SELECT f.game_id AS gameId,
         f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
         g.home_team AS homeTeam,
         g.away_team AS awayTeam,
         g.home_score AS homeScore,
         g.away_score AS awayScore
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  WHERE f.feature_version = ?
    AND g.completed = 1
    AND g.home_score IS NOT NULL
    AND g.away_score IS NOT NULL
    AND date(f.commence_time) >= date(?)
  ORDER BY f.commence_time
`
  )
  .all(MLB_BASELINE_FEATURE_VERSION, sinceIso);

function hkDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function bestMl(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'h2h');
    if (!market?.outcomes?.length) continue;
    const home =
      market.outcomes.find((o) => o.name === homeTeam) ||
      market.outcomes.find((o) =>
        String(o.name).includes(String(homeTeam).split(' ').pop())
      );
    const away =
      market.outcomes.find((o) => o.name === awayTeam) ||
      market.outcomes.find((o) =>
        String(o.name).includes(String(awayTeam).split(' ').pop())
      );
    if (!home?.price || !away?.price) continue;
    const vig = 1 / home.price + 1 / away.price;
    if (!best || vig < best.vig) {
      best = { homeOdds: Number(home.price), awayOdds: Number(away.price), vig };
    }
  }
  return best;
}

function summarize(list) {
  const n = list.length;
  const hits = list.filter((g) => g.hit).length;
  const withOdds = list.filter((g) => g.hasOdds);
  let unitPnl = 0;
  let oddsSum = 0;
  for (const g of withOdds) {
    oddsSum += g.pickOdds;
    unitPnl += g.hit ? g.pickOdds - 1 : -1;
  }
  const hitRate = n ? hits / n : null;
  const avgOdds = withOdds.length ? oddsSum / withOdds.length : null;
  const breakevenAtAvgOdds =
    avgOdds != null && avgOdds > 1 ? 1 / avgOdds : null;
  return {
    bets: n,
    hits,
    hitRate: hitRate == null ? null : Number(hitRate.toFixed(4)),
    withOddsN: withOdds.length,
    avgOdds: avgOdds == null ? null : Number(avgOdds.toFixed(3)),
    breakevenAtAvgOdds:
      breakevenAtAvgOdds == null ? null : Number(breakevenAtAvgOdds.toFixed(4)),
    clearsOwnAvgOdds:
      hitRate != null &&
      breakevenAtAvgOdds != null &&
      hitRate >= breakevenAtAvgOdds,
    unitPnl: Number(unitPnl.toFixed(2)),
    roi: withOdds.length ? Number((unitPnl / withOdds.length).toFixed(4)) : null,
  };
}

function gameKey(g) {
  return `${g.day}|${g.commenceTime}|${g.pickOdds}|${g.modelProb}|${g.margin}`;
}

function takeDailyTopK(list, k, rankFn) {
  const byDay = new Map();
  for (const g of list) {
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const selected = [];
  for (const day of [...byDay.keys()].sort()) {
    selected.push(...[...byDay.get(day)].sort(rankFn).slice(0, k));
  }
  return selected;
}

function unionUnique(aList, bList) {
  const m = new Map();
  for (const g of aList) m.set(gameKey(g), g);
  for (const g of bList) m.set(gameKey(g), g);
  return [...m.values()];
}

function intersection(aList, bList) {
  const keys = new Set(bList.map(gameKey));
  return aList.filter((g) => keys.has(gameKey(g)));
}

const games = [];
for (const row of rows) {
  let features;
  try {
    features = JSON.parse(row.featuresJson);
  } catch {
    continue;
  }
  const homeScore = Number(row.homeScore);
  const awayScore = Number(row.awayScore);
  if (homeScore === awayScore) continue;

  const pred = predictMlbGameRuns(model, features, { totalLine: 8.5 });
  const predHome = Number(pred.homeExpectedRuns);
  const predAway = Number(pred.awayExpectedRuns);
  if (!Number.isFinite(predHome) || !Number.isFinite(predAway)) continue;
  const pickHome = predHome >= predAway;
  const modelProb = pickHome
    ? Number(pred.markets?.homeWinProbability)
    : Number(pred.markets?.awayWinProbability);
  if (!Number.isFinite(modelProb)) continue;
  const ml = bestMl(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
  if (!ml) continue;
  const pickOdds = pickHome ? ml.homeOdds : ml.awayOdds;
  if (!Number.isFinite(pickOdds)) continue;
  games.push({
    day: hkDate(row.commenceTime),
    commenceTime: row.commenceTime,
    margin: Math.abs(predHome - predAway),
    modelProb,
    ev: modelProb * (pickOdds - 1) - (1 - modelProb),
    pickOdds,
    hit: pickHome === homeScore > awayScore,
    hasOdds: true,
  });
}

function selectA(pool, minMargin = 1, minProb = 0.55) {
  return pool.filter((g) => g.modelProb >= minProb && g.margin >= minMargin);
}

function selectB(pool, minEv = 0.03, minMargin = 0.25, minProb = 0.5, topK = 3) {
  const cands = pool.filter(
    (g) => g.ev >= minEv && g.margin >= minMargin && g.modelProb >= minProb
  );
  return takeDailyTopK(
    cands,
    topK,
    (a, b) => (b.ev ?? -999) - (a.ev ?? -999) || b.margin - a.margin
  );
}

const A = selectA(games);
const B = selectB(games);
const baseA = summarize(A);
const baseB = summarize(B);

function pack(key, list, extra = {}) {
  const s = summarize(list);
  return {
    key,
    ...extra,
    ...s,
    targetOddsDistance:
      s.avgOdds == null ? null : Number(Math.abs(s.avgOdds - 1.8).toFixed(3)),
    liftHitVsA: s.hitRate == null ? null : Number((s.hitRate - baseA.hitRate).toFixed(4)),
    liftHitVsB: s.hitRate == null ? null : Number((s.hitRate - baseB.hitRate).toFixed(4)),
    liftRoiVsB: s.roi == null ? null : Number((s.roi - baseB.roi).toFixed(4)),
  };
}

function hybridDaily(opts) {
  const key = opts.key;
  const aMargin = opts.aMargin ?? 1;
  const aProb = opts.aProb ?? 0.55;
  const bEv = opts.bEv ?? 0.03;
  const bMargin = opts.bMargin ?? 0.25;
  const bProb = opts.bProb ?? 0.5;
  const dailyK = opts.dailyK ?? 3;
  const preferOddsCenter = opts.preferOddsCenter ?? 1.8;
  const maxAOdds = opts.maxAOdds ?? 1.85;
  const minBOdds = opts.minBOdds ?? 1.7;
  const maxBOdds = opts.maxBOdds ?? 2.3;
  const maxASlots = opts.maxASlots ?? 2;

  const byDay = new Map();
  for (const g of games) {
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const selected = [];
  for (const day of [...byDay.keys()].sort()) {
    const dayGames = byDay.get(day);
    const aCands = dayGames
      .filter((g) => g.modelProb >= aProb && g.margin >= aMargin && g.pickOdds <= maxAOdds)
      .sort((a, b) => b.modelProb - a.modelProb || b.margin - a.margin);
    const bCands = dayGames
      .filter(
        (g) =>
          g.ev >= bEv &&
          g.margin >= bMargin &&
          g.modelProb >= bProb &&
          g.pickOdds >= minBOdds &&
          g.pickOdds <= maxBOdds
      )
      .sort((a, b) => (b.ev ?? -999) - (a.ev ?? -999) || b.margin - a.margin);

    const picked = [];
    const used = new Set();
    for (const g of aCands) {
      if (picked.length >= Math.min(maxASlots, dailyK)) break;
      const k = gameKey(g);
      if (used.has(k)) continue;
      used.add(k);
      picked.push(g);
    }
    for (const g of bCands) {
      if (picked.length >= dailyK) break;
      const k = gameKey(g);
      if (used.has(k)) continue;
      used.add(k);
      picked.push(g);
    }
    if (picked.length < dailyK) {
      const rest = dayGames
        .filter((g) => !used.has(gameKey(g)))
        .sort(
          (a, b) =>
            Math.abs(a.pickOdds - preferOddsCenter) -
              Math.abs(b.pickOdds - preferOddsCenter) ||
            b.modelProb - a.modelProb
        );
      for (const g of rest) {
        if (picked.length >= dailyK) break;
        picked.push(g);
      }
    }
    selected.push(...picked);
  }
  return pack(key, selected, opts);
}

const variants = [
  pack('A_only', A),
  pack('B_only', B),
  pack('intersection_A_and_B', intersection(A, B)),
  pack('union_A_or_B', unionUnique(A, B)),
  pack(
    'union_then_daily_top3_by_prob',
    takeDailyTopK(unionUnique(A, B), 3, (a, b) => b.modelProb - a.modelProb || b.margin - a.margin)
  ),
  pack(
    'union_then_daily_top5_by_prob',
    takeDailyTopK(unionUnique(A, B), 5, (a, b) => b.modelProb - a.modelProb || b.margin - a.margin)
  ),
  pack(
    'union_then_daily_top3_by_ev',
    takeDailyTopK(unionUnique(A, B), 3, (a, b) => (b.ev ?? -999) - (a.ev ?? -999) || b.margin - a.margin)
  ),
  pack(
    'union_odds_band_1.7_2.0',
    unionUnique(A, B).filter((g) => g.pickOdds >= 1.7 && g.pickOdds <= 2.0)
  ),
  pack(
    'union_odds_band_1.7_1.9',
    unionUnique(A, B).filter((g) => g.pickOdds >= 1.7 && g.pickOdds <= 1.9)
  ),
  pack(
    'union_odds_band_1.75_1.95',
    unionUnique(A, B).filter((g) => g.pickOdds >= 1.75 && g.pickOdds <= 1.95)
  ),
  pack('A_minOdds_1.7', A.filter((g) => g.pickOdds >= 1.7)),
  pack('A_odds_1.7_1.95', A.filter((g) => g.pickOdds >= 1.7 && g.pickOdds <= 1.95)),
  pack('B_maxOdds_2.2', selectB(games).filter((g) => g.pickOdds <= 2.2)),
  pack(
    'B_odds_1.7_2.2',
    selectB(games).filter((g) => g.pickOdds >= 1.7 && g.pickOdds <= 2.2)
  ),
  pack(
    'B_odds_1.75_2.1',
    selectB(games).filter((g) => g.pickOdds >= 1.75 && g.pickOdds <= 2.1)
  ),
  pack(
    'A_min17_or_B_max22',
    unionUnique(
      A.filter((g) => g.pickOdds >= 1.7),
      B.filter((g) => g.pickOdds <= 2.2)
    )
  ),
  pack(
    'A_min17_or_B_band175_22_daily3',
    takeDailyTopK(
      unionUnique(
        A.filter((g) => g.pickOdds >= 1.7),
        B.filter((g) => g.pickOdds >= 1.75 && g.pickOdds <= 2.2)
      ),
      3,
      (a, b) =>
        Math.abs(a.pickOdds - 1.8) - Math.abs(b.pickOdds - 1.8) ||
        b.modelProb - a.modelProb
    )
  ),
  hybridDaily({
    key: 'hybrid_daily3_center_1.8',
    dailyK: 3,
    preferOddsCenter: 1.8,
    maxAOdds: 1.85,
    minBOdds: 1.7,
    maxBOdds: 2.3,
  }),
  hybridDaily({
    key: 'hybrid_daily5_center_1.8',
    dailyK: 5,
    preferOddsCenter: 1.8,
    maxAOdds: 1.85,
    minBOdds: 1.7,
    maxBOdds: 2.3,
  }),
  hybridDaily({
    key: 'hybrid_daily3_center_1.8_tight',
    dailyK: 3,
    preferOddsCenter: 1.8,
    maxAOdds: 1.8,
    minBOdds: 1.75,
    maxBOdds: 2.2,
  }),
  hybridDaily({
    key: 'hybrid_daily4_center_1.8',
    dailyK: 4,
    preferOddsCenter: 1.8,
    maxAOdds: 1.85,
    minBOdds: 1.75,
    maxBOdds: 2.2,
  }),
  hybridDaily({
    key: 'hybrid_daily3_aSoft_bSoft',
    aMargin: 0.75,
    aProb: 0.55,
    bEv: 0.03,
    bMargin: 0.25,
    dailyK: 3,
    preferOddsCenter: 1.8,
    maxAOdds: 1.9,
    minBOdds: 1.7,
    maxBOdds: 2.2,
  }),
];

const target = variants
  .filter(
    (v) =>
      v.avgOdds != null &&
      v.avgOdds >= 1.7 &&
      v.avgOdds <= 1.9 &&
      v.clearsOwnAvgOdds &&
      v.bets >= 80
  )
  .sort(
    (a, b) =>
      b.hitRate - a.hitRate ||
      Math.abs(a.avgOdds - 1.8) - Math.abs(b.avgOdds - 1.8) ||
      b.roi - a.roi
  );

const nearTarget = variants
  .filter((v) => v.avgOdds != null && v.bets >= 80)
  .sort(
    (a, b) =>
      Math.abs(a.avgOdds - 1.8) - Math.abs(b.avgOdds - 1.8) ||
      b.hitRate - a.hitRate ||
      b.roi - a.roi
  )
  .slice(0, 12);

const best = target[0] || null;

const out = {
  ok: true,
  modelVersion: validation.modelVersion,
  since: sinceIso,
  universeN: games.length,
  goal: {
    avgOddsAround: 1.8,
    higherHitRateThanB: true,
    keepFavoritesSafer: true,
    keepDogsHittable: true,
  },
  baselines: { A: baseA, B: baseB },
  bestHybridToward18: best,
  targetHits: target.slice(0, 10),
  nearestTo18: nearTarget,
  verdict: best
    ? best.hitRate > baseB.hitRate && best.avgOdds >= 1.7 && best.avgOdds <= 1.9
      ? 'hybrid_can_center_odds_and_lift_hit_rate'
      : 'hybrid_near_target_but_tradeoffs_remain'
    : 'no_hybrid_hits_avgOdds_1.8_with_clear_breakeven',
  note: [
    '合體目標：熱門少下錯 + 冷門可擊中 + 均賠約 1.8 + 勝率上升',
    '不改 ExpectedRuns 算式，只掃選場規則',
  ],
};

fs.writeFileSync('tmp-mlb-ab-hybrid-lift.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
