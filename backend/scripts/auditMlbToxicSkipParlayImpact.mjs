/**
 * Skip 毒客後：同日串關（前兩腿）收益是否增加
 * 產物：tmp-toxic-skip-parlay-impact.json
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
const HWP = 0.62;
const EV_MIN = 0.1;
const PARLAY_STAKE = 25;
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
function isToxic(b) {
  return !b.pickHome && b.homeWinPct >= HWP && b.ev >= EV_MIN;
}
function summarizeSingles(bets) {
  if (!bets.length) {
    return { bets: 0, hitRate: null, usd50: 0 };
  }
  let hits = 0;
  let unit = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  return {
    bets: bets.length,
    hitRate: Number((hits / bets.length).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}

/** 同日前兩腿串關；不足兩腿則無票 */
function parlayStats(bets) {
  const byDay = new Map();
  for (const b of bets) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  }
  let tickets = 0;
  let hits = 0;
  let unit = 0;
  let days2 = 0;
  let split11 = 0;
  let bothHit = 0;
  let bothMiss = 0;
  let toxicInParlayLegs = 0;
  for (const [, list] of byDay) {
    const sorted = [...list].sort((a, b) => a.rank - b.rank);
    if (sorted.length < 2) continue;
    days2 += 1;
    const a = sorted[0];
    const b = sorted[1];
    if (isToxic(a)) toxicInParlayLegs += 1;
    if (isToxic(b)) toxicInParlayLegs += 1;
    tickets += 1;
    const ok = a.hit && b.hit;
    if (ok) {
      hits += 1;
      bothHit += 1;
      unit += a.pickOdds * b.pickOdds - 1;
    } else {
      unit -= 1;
      if (a.hit !== b.hit) split11 += 1;
      else bothMiss += 1;
    }
  }
  return {
    tickets,
    hits,
    hitRate: tickets ? Number((hits / tickets).toFixed(4)) : null,
    roi: tickets ? Number((unit / tickets).toFixed(4)) : null,
    usd25: Math.round(unit * PARLAY_STAKE),
    daysWith2plus: days2,
    split11Rate: days2 ? Number((split11 / days2).toFixed(4)) : null,
    bothHitRate: days2 ? Number((bothHit / days2).toFixed(4)) : null,
    bothMissRate: days2 ? Number((bothMiss / days2).toFixed(4)) : null,
    toxicLegsInTop2: toxicInParlayLegs,
  };
}

function selectOfficial(candsByDay) {
  const out = [];
  for (const [day, cands] of candsByDay) {
    const sorted = [...cands].sort((a, b) => b.rankScore - a.rankScore);
    applyDrop(sorted).forEach((b, i) => out.push({ ...b, day, rank: i + 1 }));
  }
  return out;
}
function selectSkip(candsByDay) {
  const out = [];
  for (const [day, cands] of candsByDay) {
    const filtered = cands.filter((c) => !isToxic(c));
    const sorted = [...filtered].sort((a, b) => b.rankScore - a.rankScore);
    applyDrop(sorted).forEach((b, i) => out.push({ ...b, day, rank: i + 1 }));
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
    const rankScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    const day = `${w.key}:${hk(row.commenceTime)}`;
    if (!candsByDay.has(day)) candsByDay.set(day, []);
    candsByDay.get(day).push({
      window: w.key,
      pickHome,
      pickOdds,
      homeWinPct,
      ev,
      rankScore,
      hit: pickHome ? hs > as : as > hs,
    });
  }
}

const official = selectOfficial(candsByDay);
const skipped = selectSkip(candsByDay);

const officialParlay = parlayStats(official);
const skipParlay = parlayStats(skipped);

function byYearParlay(bets) {
  return Object.fromEntries(
    WINDOWS.map((w) => {
      const subset = bets.filter((b) => b.window === w.key);
      return [w.key, parlayStats(subset)];
    })
  );
}

const report = {
  experimentId: 'toxic-skip-parlay-impact-2026-08-07',
  rule: 'skip away if homeWinPct>=0.62 && EV>=0.10；串關=當日 Top 前兩腿 × $25',
  singles: {
    official: summarizeSingles(official),
    afterSkip: summarizeSingles(skipped),
  },
  parlay: {
    official: officialParlay,
    afterSkip: skipParlay,
    deltaTickets: skipParlay.tickets - officialParlay.tickets,
    deltaHitRatePp:
      skipParlay.hitRate != null && officialParlay.hitRate != null
        ? Number(((skipParlay.hitRate - officialParlay.hitRate) * 100).toFixed(2))
        : null,
    deltaUsd25: skipParlay.usd25 - officialParlay.usd25,
    deltaSplit11Pp:
      skipParlay.split11Rate != null && officialParlay.split11Rate != null
        ? Number(
            ((skipParlay.split11Rate - officialParlay.split11Rate) * 100).toFixed(2)
          )
        : null,
  },
  byYear: {
    official: byYearParlay(official),
    afterSkip: byYearParlay(skipped),
  },
  packageUsd: {
    note: '單場$50 + 串關$25（僅有兩腿日）',
    official:
      summarizeSingles(official).usd50 + officialParlay.usd25,
    afterSkip: summarizeSingles(skipped).usd50 + skipParlay.usd25,
    delta:
      summarizeSingles(skipped).usd50 +
      skipParlay.usd25 -
      (summarizeSingles(official).usd50 + officialParlay.usd25),
  },
  verdict: null,
};

report.verdict = {
  parlayUsdUp: report.parlay.deltaUsd25 > 0,
  parlayHitUp: (report.parlay.deltaHitRatePp ?? 0) > 0,
  packageUsdUp: report.packageUsd.delta > 0,
  plainSpeak: `串關：${officialParlay.tickets}票 ${(officialParlay.hitRate * 100).toFixed(1)}% $${officialParlay.usd25} → skip後 ${skipParlay.tickets}票 ${((skipParlay.hitRate || 0) * 100).toFixed(1)}% $${skipParlay.usd25}（Δ命中${report.parlay.deltaHitRatePp}pp，Δ$${report.parlay.deltaUsd25}）。單+串合計 Δ$${report.packageUsd.delta}。`,
};

fs.writeFileSync(
  new URL('../tmp-toxic-skip-parlay-impact.json', import.meta.url),
  JSON.stringify(report, null, 2)
);
console.log(JSON.stringify(report.parlay, null, 2));
console.log(JSON.stringify(report.packageUsd, null, 2));
console.log(JSON.stringify(report.byYear, null, 2));
console.log(report.verdict.plainSpeak);
