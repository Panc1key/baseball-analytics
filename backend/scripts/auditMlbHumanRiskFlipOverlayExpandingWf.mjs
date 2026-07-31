/**
 * 人腦風險翻邊規則 Expanding Walk-Forward
 *
 * 目的：
 * - 訓練窗（截至前月）挑選最佳 overlay 參數
 * - 下月 OOS 套用並與 baseline 比較
 *
 * 用法：node scripts/auditMlbHumanRiskFlipOverlayExpandingWf.mjs
 * 產物：tmp-human-risk-flip-overlay-expanding-wf.json
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

const HOME_WIN_PCT_GRID = [0.6, 0.625, 0.65, 0.675];
const AWAY_P_GRID = [0.53, 0.55, 0.57];
const ACTION_GRID = ['flip_to_home', 'skip'];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function ym(iso) {
  return hk(iso).slice(0, 7);
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
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE_USD),
  };
}

function build(windowDef, validation) {
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
      month: ym(row.commenceTime),
      window: windowDef.key,
      homeWon: hs > as,
      pickHome,
      pickOdds,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      modelProb,
      margin,
      ev,
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
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    const slots = applyDrop(arr);
    slots.forEach((x, i) =>
      out.push({ ...x, rank: i + 1, hit: x.pickHome ? x.homeWon : !x.homeWon })
    );
  }
  return out;
}

function runOverlay(bets, cfg) {
  const kept = [];
  let flippedCount = 0;
  let droppedCount = 0;
  for (const b of bets) {
    const isStrongAway = !b.pickHome && (b.homeWinPct ?? 0) >= cfg.homeWinPctThreshold;
    if (!isStrongAway) {
      kept.push(b);
      continue;
    }
    if (b.modelProb >= cfg.awayProbThreshold) {
      droppedCount += 1;
      continue;
    }
    if (cfg.lowProbAction === 'skip') {
      droppedCount += 1;
      continue;
    }
    flippedCount += 1;
    kept.push({
      ...b,
      pickHome: true,
      pickOdds: b.homeOdds,
      hit: b.homeWon,
      flipped: true,
    });
  }
  return { kept, flippedCount, droppedCount };
}

function monthCompare(a, b) {
  return a.localeCompare(b);
}

const validation = getLatestMlbExpectedRunsValidation();
const allPicks = WINDOWS.flatMap((w) => selectB(build(w, validation)));
const baseSummary = summarize(allPicks);

const months = [...new Set(allPicks.map((x) => x.month))].sort(monthCompare);
const monthlyBase = Object.fromEntries(
  months.map((m) => [m, summarize(allPicks.filter((x) => x.month === m))])
);

const cfgs = [];
for (const homeWinPctThreshold of HOME_WIN_PCT_GRID) {
  for (const awayProbThreshold of AWAY_P_GRID) {
    for (const lowProbAction of ACTION_GRID) {
      cfgs.push({ homeWinPctThreshold, awayProbThreshold, lowProbAction });
    }
  }
}

const warmupMonths = 3;
const wfRows = [];
for (let i = warmupMonths; i < months.length; i += 1) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];

  const train = allPicks.filter((x) => trainMonths.has(x.month));
  const test = allPicks.filter((x) => x.month === testMonth);
  if (!train.length || !test.length) continue;

  const trainBase = summarize(train);
  let best = null;
  for (const cfg of cfgs) {
    const run = runOverlay(train, cfg);
    const s = summarize(run.kept);
    const deltaUsd = s.usd50 - trainBase.usd50;
    const deltaHr =
      s.hitRate != null && trainBase.hitRate != null ? (s.hitRate - trainBase.hitRate) * 100 : -999;
    const score = deltaUsd + deltaHr * 20 + (s.bets - trainBase.bets) * 2;
    const cand = {
      ...cfg,
      train: s,
      trainDelta: {
        usd50: deltaUsd,
        hitRatePp: Number(deltaHr.toFixed(2)),
        bets: s.bets - trainBase.bets,
      },
      score: Number(score.toFixed(2)),
    };
    if (!best || cand.score > best.score) best = cand;
  }

  const testBase = summarize(test);
  const testRun = runOverlay(test, best);
  const testSum = summarize(testRun.kept);
  const deltaUsd = testSum.usd50 - testBase.usd50;
  const deltaHr =
    testSum.hitRate != null && testBase.hitRate != null
      ? Number(((testSum.hitRate - testBase.hitRate) * 100).toFixed(2))
      : null;

  wfRows.push({
    month: testMonth,
    selectedCfg: {
      homeWinPctThreshold: best.homeWinPctThreshold,
      awayProbThreshold: best.awayProbThreshold,
      lowProbAction: best.lowProbAction,
    },
    trainDelta: best.trainDelta,
    testBase,
    testOverlay: testSum,
    testDelta: {
      usd50: deltaUsd,
      hitRatePp: deltaHr,
      bets: testSum.bets - testBase.bets,
      beat: deltaUsd > 0,
      hurt: deltaUsd < 0,
    },
    mechanics: {
      droppedCount: testRun.droppedCount,
      flippedCount: testRun.flippedCount,
    },
  });
}

const aggBase = summarize(
  wfRows.flatMap((r) => allPicks.filter((x) => x.month === r.month))
);
const aggOverlay = summarize(
  wfRows.flatMap((r) => runOverlay(allPicks.filter((x) => x.month === r.month), r.selectedCfg).kept)
);

const out = {
  experimentId: 'human-risk-flip-overlay-expanding-wf-2026-07-29',
  note: '訓練窗選參（overlay）-> 下月 OOS',
  baselineAll: baseSummary,
  months,
  monthlyBase,
  warmupMonths,
  candidates: {
    homeWinPctThreshold: HOME_WIN_PCT_GRID,
    awayProbThreshold: AWAY_P_GRID,
    lowProbAction: ACTION_GRID,
    count: cfgs.length,
  },
  wfRows,
  aggregateOnTestMonths: {
    baseline: aggBase,
    overlay: aggOverlay,
    delta: {
      usd50: aggOverlay.usd50 - aggBase.usd50,
      hitRatePp:
        aggOverlay.hitRate != null && aggBase.hitRate != null
          ? Number(((aggOverlay.hitRate - aggBase.hitRate) * 100).toFixed(2))
          : null,
      bets: aggOverlay.bets - aggBase.bets,
    },
    beatMonths: wfRows.filter((r) => r.testDelta.beat).length,
    hurtMonths: wfRows.filter((r) => r.testDelta.hurt).length,
    flatMonths: wfRows.filter((r) => !r.testDelta.beat && !r.testDelta.hurt).length,
  },
};

fs.writeFileSync(
  new URL('../tmp-human-risk-flip-overlay-expanding-wf.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('BASELINE_ALL', out.baselineAll);
console.log('WF_TEST_AGG', out.aggregateOnTestMonths);
for (const r of wfRows) {
  console.log(
    `${r.month} cfg=${r.selectedCfg.lowProbAction},H>=${r.selectedCfg.homeWinPctThreshold},P>=${r.selectedCfg.awayProbThreshold} | Δ$=${r.testDelta.usd50} Δhr=${r.testDelta.hitRatePp}pp Δbets=${r.testDelta.bets}`
  );
}
