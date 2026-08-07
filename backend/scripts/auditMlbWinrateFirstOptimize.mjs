/**
 * 勝率優先優化審計：日排改 modelProb / edgeVsBe + 強主禁客
 * 產物：tmp-winrate-first-optimize.json
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
function summarize(bets) {
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
  const hr = hits / n;
  return {
    bets: n,
    hitRate: Number(hr.toFixed(4)),
    avgOdds: Number(avgOdds.toFixed(3)),
    beHr: Number((1 / avgOdds).toFixed(4)),
    edgeVsBePp: Number(((hr - 1 / avgOdds) * 100).toFixed(2)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}
function parlayUsd25(bets) {
  const byDay = new Map();
  for (const b of bets) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  }
  let unit = 0;
  let tickets = 0;
  let hits = 0;
  for (const [, list] of byDay) {
    const s = [...list].sort((a, b) => a.rank - b.rank);
    if (s.length < 2) continue;
    tickets += 1;
    if (s[0].hit && s[1].hit) {
      hits += 1;
      unit += s[0].pickOdds * s[1].pickOdds - 1;
    } else unit -= 1;
  }
  return {
    tickets,
    hitRate: tickets ? Number((hits / tickets).toFixed(4)) : null,
    usd25: Math.round(unit * 25),
  };
}

const model = getLatestMlbExpectedRunsValidation()?.model;
if (!model) {
  console.error('no model');
  process.exit(1);
}

const candsByDay = new Map();
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
    const evRankScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    const edgeVsBe = modelProb - 1 / pickOdds;
    const day = `${w.key}:${hk(row.commenceTime)}`;
    if (!candsByDay.has(day)) candsByDay.set(day, []);
    candsByDay.get(day).push({
      window: w.key,
      pickHome,
      pickOdds,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      homeWinPct,
      ev,
      modelProb,
      margin,
      evRankScore,
      edgeVsBe,
      hit: pickHome ? hs > as : as > hs,
      marketFavHome: best.homeOdds <= best.awayOdds,
    });
  }
}

function select(policy) {
  const out = [];
  for (const [day, cands] of candsByDay) {
    let pool = cands.filter((c) => {
      if (policy.banStrongAway && !c.pickHome && c.homeWinPct >= policy.hwpMin) {
        if (policy.requireEv != null && c.ev < policy.requireEv) return true;
        return false;
      }
      if (
        policy.banAwayVsMarketFav &&
        !c.pickHome &&
        c.marketFavHome &&
        c.homeWinPct >= (policy.hwpMinMarket || 0.55)
      ) {
        return false;
      }
      return true;
    });
    const sorted = [...pool].sort((a, b) => {
      if (policy.rankBy === 'modelProb') {
        return b.modelProb - a.modelProb || b.edgeVsBe - a.edgeVsBe || b.ev - a.ev;
      }
      if (policy.rankBy === 'edgeVsBe') {
        return b.edgeVsBe - a.edgeVsBe || b.modelProb - a.modelProb || b.ev - a.ev;
      }
      // ev (official)
      return b.evRankScore - a.evRankScore || b.margin - a.margin;
    });
    applyDrop(sorted).forEach((b, i) => out.push({ ...b, day, rank: i + 1 }));
  }
  return out;
}

const policies = [
  { id: 'official_ev', rankBy: 'ev' },
  { id: 'rank_modelProb', rankBy: 'modelProb' },
  { id: 'rank_edgeVsBe', rankBy: 'edgeVsBe' },
  {
    id: 'ev_ban_hwp062',
    rankBy: 'ev',
    banStrongAway: true,
    hwpMin: 0.62,
  },
  {
    id: 'ev_ban_hwp062_ev10',
    rankBy: 'ev',
    banStrongAway: true,
    hwpMin: 0.62,
    requireEv: 0.1,
  },
  {
    id: 'modelProb_ban_hwp062',
    rankBy: 'modelProb',
    banStrongAway: true,
    hwpMin: 0.62,
  },
  {
    id: 'edgeVsBe_ban_hwp062',
    rankBy: 'edgeVsBe',
    banStrongAway: true,
    hwpMin: 0.62,
  },
  {
    id: 'edgeVsBe_ban_hwp060',
    rankBy: 'edgeVsBe',
    banStrongAway: true,
    hwpMin: 0.6,
  },
  {
    id: 'edgeVsBe_ban_marketFav_hwp055',
    rankBy: 'edgeVsBe',
    banAwayVsMarketFav: true,
    hwpMinMarket: 0.55,
  },
  {
    id: 'modelProb_ban_marketFav_hwp055',
    rankBy: 'modelProb',
    banAwayVsMarketFav: true,
    hwpMinMarket: 0.55,
  },
  {
    id: 'edgeVsBe_ban_hwp062_and_marketFav',
    rankBy: 'edgeVsBe',
    banStrongAway: true,
    hwpMin: 0.62,
    banAwayVsMarketFav: true,
    hwpMinMarket: 0.55,
  },
];

const baseline = select(policies[0]);
const baseSum = summarize(baseline);
const baseParlay = parlayUsd25(baseline);

const results = policies.map((p) => {
  const bets = select(p);
  const ledger = summarize(bets);
  const parlay = parlayUsd25(bets);
  return {
    id: p.id,
    policy: p,
    ledger,
    parlay,
    deltaHrPp:
      ledger.hitRate != null && baseSum.hitRate != null
        ? Number(((ledger.hitRate - baseSum.hitRate) * 100).toFixed(2))
        : null,
    deltaUsd: ledger.usd50 - baseSum.usd50,
    deltaParlayUsd: parlay.usd25 - baseParlay.usd25,
    packageDelta:
      ledger.usd50 +
      parlay.usd25 -
      (baseSum.usd50 + baseParlay.usd25),
    awayShare: bets.length
      ? Number((bets.filter((b) => !b.pickHome).length / bets.length).toFixed(3))
      : null,
  };
});

// 勝率優先：先要 hitRate 升，再要求美元不太崩，再看串關
results.sort((a, b) => {
  const aOk = (a.deltaHrPp ?? -99) >= 1 && (a.deltaUsd ?? -9999) >= -500;
  const bOk = (b.deltaHrPp ?? -99) >= 1 && (b.deltaUsd ?? -9999) >= -500;
  if (aOk !== bOk) return aOk ? -1 : 1;
  if ((b.deltaHrPp ?? -99) !== (a.deltaHrPp ?? -99)) {
    return (b.deltaHrPp ?? -99) - (a.deltaHrPp ?? -99);
  }
  return (b.deltaUsd ?? -9999) - (a.deltaUsd ?? -9999);
});

const recommend =
  results.find((r) => (r.deltaHrPp ?? 0) >= 1.5 && (r.deltaUsd ?? -9999) >= -400) ||
  results.find((r) => (r.deltaHrPp ?? 0) >= 1 && (r.deltaUsd ?? -9999) >= -500) ||
  results[0];

const report = {
  experimentId: 'winrate-first-optimize-2026-08-07',
  goal: '抬勝率：日排改勝率／相對打平 + 強主禁客（不下）',
  baseline: { ledger: baseSum, parlay: baseParlay },
  ranked: results,
  recommend,
};

fs.writeFileSync(
  new URL('../tmp-winrate-first-optimize.json', import.meta.url),
  JSON.stringify(report, null, 2)
);

console.log('BASE', baseSum, baseParlay);
console.log(
  'TOP',
  results.slice(0, 8).map((r) => ({
    id: r.id,
    hr: r.ledger.hitRate,
    dHr: r.deltaHrPp,
    usd: r.ledger.usd50,
    dUsd: r.deltaUsd,
    parlay: r.parlay,
    dPar: r.deltaParlayUsd,
    away: r.awayShare,
  }))
);
console.log('RECOMMEND', recommend.id, {
  hr: recommend.ledger.hitRate,
  dHr: recommend.deltaHrPp,
  usd: recommend.ledger.usd50,
  dUsd: recommend.deltaUsd,
  parlayHr: recommend.parlay.hitRate,
  dPar: recommend.deltaParlayUsd,
});
