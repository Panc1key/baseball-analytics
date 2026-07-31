/**
 * β 診斷：B 客場 Rank1 + 強主場（homeWinPct>=65%）
 *
 * 目標：
 * 1) 檢查此切片是否有機率校準偏差（modelProb vs 實際 hitRate）
 * 2) 檢查 hit/miss 的特徵落差，找重訓優先缺口
 *
 * 用法：node scripts/auditMlbAwayStrongHomeCalibrationAndGaps.mjs
 * 產物：tmp-away-strong-home-calibration-gaps.json
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
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];
const STRONG_HOME = 0.65;

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

function summarize(rows) {
  if (!rows.length) return { bets: 0, hitRate: null, avgOdds: null, usd50: 0 };
  let hits = 0;
  let odds = 0;
  let unit = 0;
  for (const r of rows) {
    odds += r.pickOdds;
    if (r.hit) {
      hits += 1;
      unit += r.pickOdds - 1;
    } else unit -= 1;
  }
  return {
    bets: rows.length,
    hitRate: Number((hits / rows.length).toFixed(4)),
    avgOdds: Number((odds / rows.length).toFixed(3)),
    usd50: Math.round(unit * 50),
  };
}

function mean(rows, key) {
  const vals = rows.map((r) => r[key]).filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4));
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
    const vector = features?.vector || {};
    const home = features?.home || {};
    const away = features?.away || {};
    const awayStarter = features?.pitchers?.away || {};
    const homeStarter = features?.pitchers?.home || {};

    pool.push({
      window: windowDef.key,
      gameId: row.gameId,
      day: hk(row.commenceTime),
      matchup: `${row.awayTeam} @ ${row.homeTeam}`,
      homeWon: hs > as,
      pickHome,
      pickOdds,
      modelProb,
      ev,
      margin,
      bScore,
      homeWinPct: +home.homeWinPct || null,
      homeSeasonWinPct: +home.seasonWinPct || null,
      awaySeasonWinPct: +away.seasonWinPct || null,
      homeLast10: +home.last10WinPct || null,
      awayLast10: +away.last10WinPct || null,
      pitcherEraDiff: Number.isFinite(+vector.pitcherEraDiff) ? +vector.pitcherEraDiff : null,
      pitcherWhipDiff: Number.isFinite(+vector.pitcherWhipDiff) ? +vector.pitcherWhipDiff : null,
      pitcherRecentEraDiff: Number.isFinite(+vector.pitcherRecentEraDiff)
        ? +vector.pitcherRecentEraDiff
        : null,
      awayStarterGames: Number.isFinite(+awayStarter.games) ? +awayStarter.games : null,
      homeStarterGames: Number.isFinite(+homeStarter.games) ? +homeStarter.games : null,
      awayStarterRecentStarts: Number.isFinite(+features?.pitchers?.awayRecent?.startsObserved)
        ? +features.pitchers.awayRecent.startsObserved
        : null,
      homeStarterRecentStarts: Number.isFinite(+features?.pitchers?.homeRecent?.startsObserved)
        ? +features.pitchers.homeRecent.startsObserved
        : null,
      score: `${row.awayScore}-${row.homeScore}`,
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

function probBucket(p) {
  if (p < 0.53) return '[50,53)';
  if (p < 0.55) return '[53,55)';
  if (p < 0.57) return '[55,57)';
  if (p < 0.6) return '[57,60)';
  return '[60,+)';
}

function calibration(rows) {
  const m = new Map();
  for (const r of rows) {
    const key = `${r.window}|${probBucket(r.modelProb)}`;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(r);
  }
  const out = [];
  for (const [k, arr] of m.entries()) {
    const [window, bucket] = k.split('|');
    out.push({
      window,
      bucket,
      bets: arr.length,
      avgModelProb: mean(arr, 'modelProb'),
      hitRate: summarize(arr).hitRate,
      usd50: summarize(arr).usd50,
      calibrationGapPp:
        summarize(arr).hitRate != null && mean(arr, 'modelProb') != null
          ? Number(((summarize(arr).hitRate - mean(arr, 'modelProb')) * 100).toFixed(2))
          : null,
    });
  }
  return out.sort((a, b) => a.window.localeCompare(b.window) || a.bucket.localeCompare(b.bucket));
}

const allPicks = WINDOWS.flatMap((w) => selectB(build(w)));
const awayRank1 = allPicks.filter((x) => !x.pickHome && x.rank === 1);
const strongSubset = awayRank1.filter((x) => (x.homeWinPct ?? 0) >= STRONG_HOME);
const controlSubset = awayRank1.filter((x) => (x.homeWinPct ?? 0) < STRONG_HOME);

const strongHit = strongSubset.filter((x) => x.hit);
const strongMiss = strongSubset.filter((x) => !x.hit);

const gapKeys = [
  'modelProb',
  'ev',
  'margin',
  'pickOdds',
  'homeWinPct',
  'homeSeasonWinPct',
  'awaySeasonWinPct',
  'homeLast10',
  'awayLast10',
  'pitcherEraDiff',
  'pitcherWhipDiff',
  'pitcherRecentEraDiff',
  'awayStarterGames',
  'homeStarterGames',
  'awayStarterRecentStarts',
  'homeStarterRecentStarts',
];

const featureGaps = gapKeys.map((k) => {
  const hitMean = mean(strongHit, k);
  const missMean = mean(strongMiss, k);
  return {
    feature: k,
    hitMean,
    missMean,
    missMinusHit:
      hitMean != null && missMean != null ? Number((missMean - hitMean).toFixed(4)) : null,
  };
});

const byWindow = {};
for (const w of WINDOWS) {
  byWindow[w.key] = {
    awayRank1: summarize(awayRank1.filter((x) => x.window === w.key)),
    strongSubset: summarize(strongSubset.filter((x) => x.window === w.key)),
    controlSubset: summarize(controlSubset.filter((x) => x.window === w.key)),
  };
}

const out = {
  experimentId: 'away-strong-home-calibration-gaps-2026-07-29',
  condition: 'away rank1 + homeWinPct>=65%',
  baseline: {
    allPicks: summarize(allPicks),
    awayRank1: summarize(awayRank1),
    strongSubset: summarize(strongSubset),
    controlSubset: summarize(controlSubset),
    subsetShareInAll: Number((strongSubset.length / allPicks.length).toFixed(3)),
    subsetShareInAwayRank1: Number((strongSubset.length / awayRank1.length).toFixed(3)),
  },
  byWindow,
  calibration: {
    strongSubset: calibration(strongSubset),
    controlSubset: calibration(controlSubset),
  },
  featureGapsHitVsMiss: featureGaps,
  worstMissesTop10ByEv: strongMiss
    .sort((a, b) => b.ev - a.ev)
    .slice(0, 10)
    .map((x) => ({
      window: x.window,
      day: x.day,
      matchup: x.matchup,
      score: x.score,
      odds: Number(x.pickOdds.toFixed(3)),
      modelProb: Number(x.modelProb.toFixed(4)),
      ev: Number(x.ev.toFixed(4)),
      margin: Number(x.margin.toFixed(3)),
      homeWinPct: Number((x.homeWinPct ?? 0).toFixed(4)),
      gameId: x.gameId,
    })),
};

fs.writeFileSync(
  new URL('../tmp-away-strong-home-calibration-gaps.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('ALL', out.baseline.allPicks);
console.log('AWAY_RANK1', out.baseline.awayRank1);
console.log('STRONG', out.baseline.strongSubset);
console.log('CONTROL', out.baseline.controlSubset);
