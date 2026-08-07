/**
 * 勝率優先：對抗「一日兩注、一贏一輸、串關全滅、慢性死亡」
 * 產物：tmp-ml-winrate-first-vs-roi-chase.json
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

const B = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: 2,
};
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
function summarizeBets(bets) {
  if (!bets.length) {
    return { bets: 0, hitRate: null, avgOdds: null, beHr: null, roi: null, usd50: 0 };
  }
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
  const avgOdds = odds / n;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number(avgOdds.toFixed(3)),
    beHr: Number((1 / avgOdds).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}

/** 日帳：幾天是雙中、一贏一輸、全黑；串關（當日前兩腿）命中 */
function dayStats(bets) {
  const byDay = new Map();
  for (const b of bets) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  }
  let days = 0;
  let days2plus = 0;
  let bothHit = 0;
  let split11 = 0;
  let bothMiss = 0;
  let singleOnly = 0;
  let singleHit = 0;
  let parlayN = 0;
  let parlayHit = 0;
  let dayUnit = 0; // flat $50 each bet
  for (const [, list] of byDay) {
    days += 1;
    const sorted = [...list].sort((a, b) => a.rank - b.rank);
    for (const b of sorted) {
      dayUnit += b.hit ? b.pickOdds - 1 : -1;
    }
    if (sorted.length === 1) {
      singleOnly += 1;
      if (sorted[0].hit) singleHit += 1;
      continue;
    }
    days2plus += 1;
    const a = sorted[0];
    const b = sorted[1];
    const h0 = a.hit;
    const h1 = b.hit;
    if (h0 && h1) bothHit += 1;
    else if (h0 !== h1) split11 += 1;
    else bothMiss += 1;
    // 串關：前兩腿
    parlayN += 1;
    if (h0 && h1) parlayHit += 1;
  }
  return {
    days,
    days2plus,
    bothHitRate: days2plus ? Number((bothHit / days2plus).toFixed(4)) : null,
    split11Rate: days2plus ? Number((split11 / days2plus).toFixed(4)) : null,
    bothMissRate: days2plus ? Number((bothMiss / days2plus).toFixed(4)) : null,
    singleOnlyDays: singleOnly,
    singleHitRate: singleOnly ? Number((singleHit / singleOnly).toFixed(4)) : null,
    parlay: {
      tickets: parlayN,
      hitRate: parlayN ? Number((parlayHit / parlayN).toFixed(4)) : null,
      // 均注 $25 串關粗估
      usd25: Math.round(
        [...byDay.values()].reduce((acc, list) => {
          if (list.length < 2) return acc;
          const s = [...list].sort((a, b) => a.rank - b.rank);
          const o = s[0].pickOdds * s[1].pickOdds;
          return acc + (s[0].hit && s[1].hit ? o - 1 : -1);
        }, 0) * 25
      ),
    },
    flatUsd50: Math.round(dayUnit * 50),
  };
}

function selectWithPolicy(candsByDay, policy) {
  const out = [];
  for (const [day, cands] of candsByDay) {
    let pool = cands.filter((c) => {
      if (policy.skipToxicAway && !c.pickHome && c.homeWinPct >= 0.62 && c.ev >= 0.1) {
        return false;
      }
      if (policy.maxOdds != null && c.pickOdds > policy.maxOdds) return false;
      if (policy.minOdds != null && c.pickOdds < policy.minOdds) return false;
      if (policy.minModelProb != null && c.modelProb < policy.minModelProb) return false;
      if (policy.minMargin != null && c.margin < policy.minMargin) return false;
      if (policy.banAway && !c.pickHome) return false;
      return true;
    });
    // 排序：勝率優先可改成 modelProb 或「離打平優勢」
    if (policy.rankBy === 'modelProb') {
      pool = [...pool].sort((a, b) => b.modelProb - a.modelProb || b.ev - a.ev);
    } else if (policy.rankBy === 'oddsMid') {
      // 偏好 1.85–2.05：距 1.95 越近越好，其次 EV
      const dist = (o) => Math.abs(o - 1.95);
      pool = [...pool].sort(
        (a, b) => dist(a.pickOdds) - dist(b.pickOdds) || b.modelProb - a.modelProb
      );
    } else {
      pool = [...pool].sort((a, b) => b.rankScore - a.rankScore);
    }
    const topK = policy.topK ?? 3;
    let slots = pool.slice(0, topK);
    if (policy.useDropRules) slots = applyDrop(slots);
    // 若只要 1 注：只留 rank1
    if (policy.forceTop1) slots = slots.slice(0, 1);
    slots.forEach((b, i) => out.push({ ...b, day, rank: i + 1 }));
  }
  return out;
}

const model = getLatestMlbExpectedRunsValidation()?.model;
if (!model) {
  console.error('no model');
  process.exit(1);
}

const candsByDay = new Map();
for (const w of WINDOWS) {
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
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    const homeWinPct = Number(features?.home?.homeWinPct);
    if (!Number.isFinite(homeWinPct)) continue;
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) continue;

    let pred = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    pred = applyFormalLockedBResidual(model, pred, features, { totalLine: 8.5 });
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < 1.4 || pickOdds > (B.maximumPickOdds ?? 2.5)) continue;
    const sig = buildPregameRegimeSignals(features);
    if (
      (pickHome ? sig.homeEarlyExitsLast3 : sig.awayEarlyExitsLast3) >
      (pickHome ? sig.awayEarlyExitsLast3 : sig.homeEarlyExitsLast3)
    ) {
      continue;
    }
    modelProb = applyFormalToxicAwayShrink(modelProb, pickOdds, {
      pickHome,
      homeWinPct,
    });
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue) continue;
    if (margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (pickOdds < B.minimumPickOdds || pickOdds > B.maximumPickOdds) continue;
    const rankScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    const day = hk(row.commenceTime);
    const key = `${w.key}:${day}`;
    if (!candsByDay.has(key)) candsByDay.set(key, []);
    candsByDay.get(key).push({
      window: w.key,
      day: key,
      pickHome,
      pickOdds,
      homeWinPct,
      ev,
      margin,
      modelProb,
      rankScore,
      hit: pickHome ? hs > as : as > hs,
    });
  }
}

const policies = [
  {
    id: 'official_lockedB',
    skipToxicAway: false,
    useDropRules: true,
    topK: 3,
    rankBy: 'ev',
  },
  {
    id: 'skip_toxic_away',
    skipToxicAway: true,
    useDropRules: true,
    topK: 3,
    rankBy: 'ev',
  },
  {
    id: 'winrate_odds_cap210',
    skipToxicAway: true,
    useDropRules: true,
    topK: 3,
    maxOdds: 2.1,
    rankBy: 'ev',
  },
  {
    id: 'winrate_odds_band_185_205',
    skipToxicAway: true,
    useDropRules: true,
    topK: 3,
    minOdds: 1.85,
    maxOdds: 2.05,
    rankBy: 'ev',
  },
  {
    id: 'winrate_top1_only',
    skipToxicAway: true,
    useDropRules: false,
    forceTop1: true,
    topK: 1,
    rankBy: 'modelProb',
  },
  {
    id: 'winrate_top1_odds_cap210',
    skipToxicAway: true,
    forceTop1: true,
    topK: 1,
    maxOdds: 2.1,
    rankBy: 'modelProb',
  },
  {
    id: 'winrate_top2_modelProb',
    skipToxicAway: true,
    useDropRules: true,
    topK: 2,
    rankBy: 'modelProb',
  },
  {
    id: 'winrate_minProb55_top2',
    skipToxicAway: true,
    useDropRules: true,
    topK: 2,
    minModelProb: 0.55,
    rankBy: 'modelProb',
  },
  {
    id: 'winrate_prefer_midodds_top2',
    skipToxicAway: true,
    useDropRules: true,
    topK: 2,
    maxOdds: 2.1,
    rankBy: 'oddsMid',
  },
];

const results = policies.map((p) => {
  const bets = selectWithPolicy(candsByDay, p);
  const ledger = summarizeBets(bets);
  const days = dayStats(bets);
  return {
    id: p.id,
    ledger,
    days,
    // 慢性死亡指標：有兩注以上的日子裡，一贏一輸占比
    chronicDeathScore: days.split11Rate,
    parlayHit: days.parlay.hitRate,
  };
});

// 排序：先降 split11，再升單場勝率，再升串關勝率
results.sort((a, b) => {
  const as = a.chronicDeathScore ?? 99;
  const bs = b.chronicDeathScore ?? 99;
  if (as !== bs) return as - bs;
  const ah = a.ledger.hitRate ?? 0;
  const bh = b.ledger.hitRate ?? 0;
  if (bh !== ah) return bh - ah;
  return (b.parlayHit ?? 0) - (a.parlayHit ?? 0);
});

const baseline = results.find((r) => r.id === 'official_lockedB');
const best = results[0];

const report = {
  experimentId: 'ml-winrate-first-vs-roi-chase-2026-08-07',
  userPain:
    '每一注未中=本金沒了；一日兩注一贏一輸 → 串關死；追高賠客 ROI = 慢性死亡',
  math: {
    singleAt205: '均賠 2.05 打平約需 48.8% 勝率',
    twoLegParlay: '兩腿各 55% 獨立 → 串關約 30%；若日帳常 1-1，串關命中趨近 0 的體感',
    whyRoiAwayKills:
      '高賠客抬 ROI，但不抬「兩腿同日雙中」；split 1-1 日子多 → 單場勉強、串關全滅',
  },
  baseline,
  rankedByAntiChronicDeath: results,
  recommend: results.find(
    (r) =>
      (r.ledger.hitRate ?? 0) >= (baseline?.ledger.hitRate ?? 0) &&
      (r.chronicDeathScore ?? 1) <= (baseline?.days.split11Rate ?? 1) &&
      (r.ledger.usd50 ?? -99999) >= (baseline?.ledger.usd50 ?? 0) * 0.7
  ) || best,
};

fs.writeFileSync(
  new URL('../tmp-ml-winrate-first-vs-roi-chase.json', import.meta.url),
  JSON.stringify(report, null, 2)
);

console.log('BASELINE', JSON.stringify(baseline, null, 2));
console.log(
  'TOP',
  JSON.stringify(
    results.slice(0, 6).map((r) => ({
      id: r.id,
      hr: r.ledger.hitRate,
      usd: r.ledger.usd50,
      split11: r.chronicDeathScore,
      parlayHr: r.parlayHit,
      bets: r.ledger.bets,
      days2: r.days.days2plus,
    })),
    null,
    2
  )
);
console.log('RECOMMEND', report.recommend?.id, {
  hr: report.recommend?.ledger.hitRate,
  split11: report.recommend?.chronicDeathScore,
  parlay: report.recommend?.parlayHit,
  usd: report.recommend?.ledger.usd50,
});
