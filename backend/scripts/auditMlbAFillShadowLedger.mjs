/**
 * A′ 影子帳（非正式、不進紙上選注）
 * 正式軌：鎖定 B（ev02_max230 + dropR3/R2）
 * 影子軌：edge≥2pp + 當日 B&lt;2 + odds&lt;1.75 + Top1（觀察名單第一名）
 *
 * 產物：
 *  - tmp-a-fill-shadow-ledger.json（摘要＋逐筆）
 * 用法: node scripts/auditMlbAFillShadowLedger.mjs
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
const STAKE = 50;
const EDGE = 0.02;
const B_LT = 2;
const MAX_SHADOW_ODDS = 1.75;

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
function pnlUsd(hit, odds, stake = STAKE) {
  return hit ? Math.round((odds - 1) * stake * 100) / 100 : -stake;
}
function summarize(bets) {
  if (!bets.length) {
    return {
      bets: 0,
      hits: 0,
      hitRate: null,
      avgOdds: null,
      breakeven: null,
      clearsOwn: false,
      usd50: 0,
      unit: 0,
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
    hits,
    hitRate: Number(hr.toFixed(4)),
    avgOdds: Number(avg.toFixed(3)),
    breakeven: Number(be.toFixed(4)),
    clearsOwn: hr > be,
    usd50: Math.round(unit * STAKE),
    unit: Number(unit.toFixed(4)),
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
    const hit = pickHome === hs > as;
    pool.push({
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      window: from.startsWith('2025') ? '2025' : '2026',
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      pickSide: pickHome ? 'home' : 'away',
      pickTeam: pickHome ? row.homeTeam : row.awayTeam,
      hit,
      pickOdds,
      ev,
      margin,
      modelProb,
      bScore,
      edgeVsBe: modelProb - 1 / pickOdds,
      pnlUsd: pnlUsd(hit, pickOdds),
    });
  }
  return pool;
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

function selectB(pool) {
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
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const arr = [...map.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    const slots = applyDrop(arr);
    slots.forEach((g, i) => {
      out.push({ ...g, track: 'B_official', dailyRank: i + 1 });
    });
  }
  return out;
}

function selectShadowA(pool, bPicks) {
  const bIds = new Set(bPicks.map((g) => g.gameId));
  const bByDay = new Map();
  for (const g of bPicks) bByDay.set(g.day, (bByDay.get(g.day) || 0) + 1);
  const map = new Map();
  for (const g of pool) {
    if (bIds.has(g.gameId)) continue;
    if (g.modelProb < 0.55 || g.margin < 1) continue;
    if (!(g.pickOdds < MAX_SHADOW_ODDS && g.edgeVsBe >= EDGE)) continue;
    const bn = bByDay.get(g.day) || 0;
    if (bn >= B_LT) continue;
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push({ ...g, bCountThatDay: bn });
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const top = [...map.get(day)].sort(
      (a, b) => b.edgeVsBe - a.edgeVsBe || b.margin - a.margin
    )[0];
    if (top) {
      out.push({
        ...top,
        track: 'A_shadow',
        dailyRank: null,
        shadowPolicy: 'edge02_bLt2_odds_lt_175',
      });
    }
  }
  return out;
}

function cumulativeCurve(betsChrono) {
  let cum = 0;
  return betsChrono.map((b) => {
    cum += b.pnlUsd;
    return {
      day: b.day,
      gameId: b.gameId,
      track: b.track,
      hit: b.hit,
      pickOdds: b.pickOdds,
      pnlUsd: b.pnlUsd,
      cumUsd: Math.round(cum * 100) / 100,
    };
  });
}

function byMonth(bets) {
  const map = new Map();
  for (const b of bets) {
    if (!map.has(b.month)) map.set(b.month, []);
    map.get(b.month).push(b);
  }
  return [...map.keys()]
    .sort()
    .map((m) => ({ month: m, ...summarize(map.get(m)) }));
}

console.log('Building shadow ledger…');
const pools = WINDOWS.map((w) => ({ ...w, pool: build(w.from, w.to) }));

const officialB = [];
const shadowA = [];
for (const w of pools) {
  const b = selectB(w.pool);
  const a = selectShadowA(w.pool, b);
  officialB.push(...b);
  shadowA.push(...a);
}

officialB.sort((a, b) => String(a.commenceTime).localeCompare(String(b.commenceTime)));
shadowA.sort((a, b) => String(a.commenceTime).localeCompare(String(b.commenceTime)));

const hypoMerged = [...officialB, ...shadowA].sort((a, b) =>
  String(a.commenceTime).localeCompare(String(b.commenceTime))
);

const sB = summarize(officialB);
const sA = summarize(shadowA);
const sM = summarize(hypoMerged);

const ledgerRows = shadowA.map((b) => ({
  day: b.day,
  month: b.month,
  window: b.window,
  gameId: b.gameId,
  matchup: `${b.awayTeam} @ ${b.homeTeam}`,
  pickTeam: b.pickTeam,
  pickSide: b.pickSide,
  pickOdds: Number(b.pickOdds.toFixed(3)),
  modelProb: Number(b.modelProb.toFixed(4)),
  edgeVsBe: Number(b.edgeVsBe.toFixed(4)),
  margin: Number(b.margin.toFixed(3)),
  bCountThatDay: b.bCountThatDay,
  hit: b.hit,
  pnlUsd: b.pnlUsd,
  track: 'A_shadow',
  status: 'shadow_only_not_official',
}));

const out = {
  experimentId: 'a-fill-shadow-ledger-odds-lt-175-2026-07-28',
  generatedAt: new Date().toISOString(),
  disclaimer:
    '影子帳僅供觀察；不寫入 mlb_paper_bets、不進正式推薦。正式紙上仍為純 B。',
  policy: {
    official: 'B locked ev02_max230 + dropR3/R2 + ≥2 books',
    shadow:
      'P≥55% ∧ margin≥1 ∧ edge≥2pp ∧ pickOdds<1.75 ∧ day B count <2 ∧ Top1 by edge',
    stakeUsd: STAKE,
  },
  tracks: {
    B_official: sB,
    A_shadow: sA,
    hypo_if_wired_merged: {
      ...sM,
      deltaUsd50VsOfficialB: sM.usd50 - sB.usd50,
      deltaHitRateVsOfficialB: Number((sM.hitRate - sB.hitRate).toFixed(4)),
      deltaBets: sM.bets - sB.bets,
      note: '假設合併；非實際帳本',
    },
  },
  byWindow: {
    '2025': {
      B: summarize(officialB.filter((g) => g.window === '2025')),
      A_shadow: summarize(shadowA.filter((g) => g.window === '2025')),
    },
    '2026': {
      B: summarize(officialB.filter((g) => g.window === '2026')),
      A_shadow: summarize(shadowA.filter((g) => g.window === '2026')),
    },
  },
  monthly: {
    B_official: byMonth(officialB),
    A_shadow: byMonth(shadowA),
    hypo_merged: byMonth(hypoMerged),
  },
  equityCurve: {
    B_official: cumulativeCurve(officialB),
    A_shadow: cumulativeCurve(shadowA),
    hypo_merged: cumulativeCurve(hypoMerged),
  },
  shadowLedger: ledgerRows,
  gateCheck: {
    shadowClearsOwnBreakeven: sA.clearsOwn,
    shadowUsdPositive: sA.usd50 > 0,
    bothWindowsShadowUsdPositive:
      summarize(shadowA.filter((g) => g.window === '2025')).usd50 > 0 &&
      summarize(shadowA.filter((g) => g.window === '2026')).usd50 > 0,
    hypoMergedBeatsOfficialB: sM.usd50 >= sB.usd50 && sM.hitRate >= sB.hitRate,
    sampleBets: sA.bets,
    sampleThin: sA.bets < 20,
    recommendWire: false,
    recommendWireReason:
      '影子觀察中；樣本仍薄且未獲「明確接入」指令。正式維持純 B。',
  },
};

fs.writeFileSync(
  new URL('../tmp-a-fill-shadow-ledger.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('=== Official B ===');
console.log(sB);
console.log('=== Shadow A (odds<1.75) ===');
console.log(sA);
console.log('=== Hypo merged (NOT official) ===');
console.log({
  ...sM,
  deltaUsd: sM.usd50 - sB.usd50,
  deltaHr: Number((sM.hitRate - sB.hitRate).toFixed(4)),
});
console.log('byWindow A', out.byWindow);
console.log('shadow bets:');
for (const r of ledgerRows) {
  console.log(
    `${r.day} ${r.matchup} pick=${r.pickTeam} @${r.pickOdds} edge=${r.edgeVsBe} bN=${r.bCountThatDay} ${r.hit ? 'HIT' : 'MISS'} ${r.pnlUsd >= 0 ? '+' : ''}${r.pnlUsd}`
  );
}
console.log('\ngateCheck', out.gateCheck);
