/**
 * 測試人腦風險層（翻邊版）
 *
 * 規則：
 * - 僅作用在「原本 B 已選中」的投注
 * - 若為客場選邊且主隊主場勝率 >= 65%
 *   - modelProb >= 55% -> 不下
 *   - modelProb < 55%  -> 反手改押主場
 *
 * 產物：tmp-human-risk-flip-overlay.json
 * 用法：node scripts/auditMlbHumanRiskFlipOverlay.mjs
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
const STAKE_USD = 50;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

const RULE = Object.freeze({
  strongHomeThreshold: 0.65,
  awayProbThreshold: 0.55,
});

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
  if (!bets.length) {
    return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0, breakeven: null };
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
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number(avg.toFixed(3)),
    breakeven: Number((1 / avg).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE_USD),
  };
}

function build(windowDef) {
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
    .all(MLB_BASELINE_FEATURE_VERSION, windowDef.from, windowDef.to);

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
      gameId: row.gameId,
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      window: windowDef.key,
      homeWon: hs > as,
      pickHome,
      pickOdds,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      ev,
      margin,
      modelProb,
      bScore,
      homeWinPct: +features?.home?.homeWinPct || null,
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
    out.push(...applyDrop(arr));
  }
  return out;
}

function applyOverlay(bets) {
  const kept = [];
  const dropped = [];
  const flipped = [];

  for (const b of bets) {
    const isAwayPick = !b.pickHome;
    const strongHome = (b.homeWinPct ?? 0) >= RULE.strongHomeThreshold;

    if (isAwayPick && strongHome && b.modelProb >= RULE.awayProbThreshold) {
      dropped.push({ ...b, reason: 'away_ge55_vs_strong_home_skip' });
      continue;
    }

    if (isAwayPick && strongHome && b.modelProb < RULE.awayProbThreshold) {
      const next = {
        ...b,
        pickHome: true,
        pickOdds: b.homeOdds,
        hit: b.homeWon,
        flippedFromAway: true,
        reason: 'away_lt55_vs_strong_home_flip_to_home',
      };
      kept.push(next);
      flipped.push(next);
      continue;
    }

    kept.push({ ...b, hit: b.pickHome ? b.homeWon : !b.homeWon, flippedFromAway: false });
  }

  return { kept, dropped, flipped };
}

const basePicks = WINDOWS.flatMap((w) => selectB(build(w)));
const baseResolved = basePicks.map((b) => ({
  ...b,
  hit: b.pickHome ? b.homeWon : !b.homeWon,
  flippedFromAway: false,
}));

const overlay = applyOverlay(basePicks);

const byWindow = {};
for (const w of WINDOWS) {
  byWindow[w.key] = {
    baseline: summarize(baseResolved.filter((x) => x.window === w.key)),
    overlay: summarize(overlay.kept.filter((x) => x.window === w.key)),
    dropped: summarize(overlay.dropped.filter((x) => x.window === w.key)),
    flipped: summarize(overlay.flipped.filter((x) => x.window === w.key)),
  };
}

const out = {
  experimentId: 'human-risk-flip-overlay-2026-07-29',
  rule: {
    text: '客勝且主隊主場勝率>=65%：若客隊模型P>=55%則不下；若<55%則改押主場',
    strongHomeThreshold: RULE.strongHomeThreshold,
    awayProbThreshold: RULE.awayProbThreshold,
  },
  baseline: summarize(baseResolved),
  overlay: summarize(overlay.kept),
  delta: {
    bets: overlay.kept.length - baseResolved.length,
    hitRatePp:
      summarize(overlay.kept).hitRate != null && summarize(baseResolved).hitRate != null
        ? Number(
            ((summarize(overlay.kept).hitRate - summarize(baseResolved).hitRate) * 100).toFixed(2)
          )
        : null,
    usd50: summarize(overlay.kept).usd50 - summarize(baseResolved).usd50,
  },
  mechanics: {
    droppedCount: overlay.dropped.length,
    flippedCount: overlay.flipped.length,
    droppedSummary: summarize(overlay.dropped),
    flippedSummary: summarize(overlay.flipped),
  },
  byWindow,
};

fs.writeFileSync(
  new URL('../tmp-human-risk-flip-overlay.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('BASE', out.baseline);
console.log('OVERLAY', out.overlay);
console.log('DELTA', out.delta);
console.log('MECHANICS', out.mechanics);
for (const [k, v] of Object.entries(out.byWindow)) {
  console.log(`WINDOW ${k}`, v);
}
