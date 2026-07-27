/**
 * A/B 紙上線歷史複驗（PIT feature rows + PIT 獨贏）。
 *
 * A：勝率線 P≥55% & 分差≥1（無硬 EV）
 * B：ROI 線 EV≥3% & 分差≥0.25 & 每日 Top3
 *
 * 輸出：
 * 1) 同窗整體／按月／按賠率桶
 * 2) A：walk-forward 重選分差
 * 3) B：walk-forward 重選 (minEv, topK, minMargin)
 * 4) 固定規則「前半選／後半測」擴窗對照
 *
 * 用法: node scripts/auditMlbStrictRuleWalkForward.mjs [monthsBack]
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  MLB_MONEYLINE_RECOMMENDATION_RULES,
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const monthsBack = Number(process.argv[2] || 6);
const minBetsSelect = Number(process.env.WF_MIN_BETS_SELECT || 25);
const minBetsReport = Number(process.env.WF_MIN_BETS_REPORT || 15);
const marginGrid = [0.5, 0.75, 1, 1.25, 1.5];
const lineBGrid = {
  minEv: [0.03, 0.05],
  topK: [3, 5],
  minMargin: [0, 0.25, 0.5],
};

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

function hkMonth(iso) {
  return hkDate(iso).slice(0, 7);
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
      best = {
        homeOdds: Number(home.price),
        awayOdds: Number(away.price),
        vig,
      };
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

function rankB(a, b) {
  return (b.ev ?? -999) - (a.ev ?? -999) || b.margin - a.margin;
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

  const margin = Math.abs(predHome - predAway);
  const hit = pickHome === homeScore > awayScore;
  const ml = bestMl(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
  let pickOdds = null;
  let ev = null;
  if (ml) {
    pickOdds = pickHome ? ml.homeOdds : ml.awayOdds;
    if (Number.isFinite(pickOdds)) {
      ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    }
  }

  games.push({
    day: hkDate(row.commenceTime),
    month: hkMonth(row.commenceTime),
    commenceTime: row.commenceTime,
    margin,
    modelProb,
    hit,
    pickOdds,
    ev,
    hasOdds: Number.isFinite(pickOdds),
  });
}

const rules = MLB_MONEYLINE_RECOMMENDATION_RULES;
const minProb = Number(rules.minimumModelProbability ?? 0.55);
const fixedMargin = Number(rules.minimumExpectedRunMargin ?? 1);
const fixedB = { minEv: 0.03, topK: 3, minMargin: 0.25, minProb: 0.5 };

function selectLineA(pool, margin = fixedMargin) {
  return pool.filter((g) => g.modelProb >= minProb && g.margin >= margin);
}

function selectLineB(
  pool,
  {
    minEv = fixedB.minEv,
    topK = fixedB.topK,
    minMargin = fixedB.minMargin,
    minModelProb = fixedB.minProb,
  } = {}
) {
  const cands = pool.filter(
    (g) =>
      g.hasOdds &&
      g.ev != null &&
      g.ev >= minEv &&
      g.margin >= minMargin &&
      g.modelProb >= minModelProb
  );
  return takeDailyTopK(cands, topK, rankB);
}

const months = [...new Set(games.map((g) => g.month))].sort();
const lineAFixed = selectLineA(games);
const lineBFixed = selectLineB(games);

const byMonthA = months.map((month) => ({
  month,
  ...summarize(selectLineA(games.filter((g) => g.month === month))),
}));
const byMonthB = months.map((month) => ({
  month,
  ...summarize(selectLineB(games.filter((g) => g.month === month))),
}));

function oddsBucket(odds) {
  if (!Number.isFinite(odds)) return 'no_odds';
  if (odds <= 1.6) return 'le_1.6';
  if (odds < 1.9) return '1.6_to_1.9';
  return 'ge_1.9';
}

const byOddsA = ['le_1.6', '1.6_to_1.9', 'ge_1.9', 'no_odds'].map((bucket) => ({
  bucket,
  ...summarize(lineAFixed.filter((g) => oddsBucket(g.pickOdds) === bucket)),
}));
const byOddsB = ['le_1.6', '1.6_to_1.9', 'ge_1.9', 'no_odds'].map((bucket) => ({
  bucket,
  ...summarize(lineBFixed.filter((g) => oddsBucket(g.pickOdds) === bucket)),
}));

function pickMarginOnHistory(history) {
  let best = null;
  for (const margin of marginGrid) {
    const stats = summarize(selectLineA(history, margin));
    if (stats.bets < minBetsSelect) continue;
    if (!stats.clearsOwnAvgOdds) continue;
    const score =
      (stats.hitRate ?? 0) * 1000 + stats.bets + (stats.roi ?? 0) * 10;
    if (!best || score > best.score) best = { margin, score, ...stats };
  }
  if (best) return best;
  for (const margin of marginGrid) {
    const stats = summarize(selectLineA(history, margin));
    if (stats.bets < minBetsSelect) continue;
    const score = (stats.hitRate ?? 0) * 1000 + stats.bets;
    if (!best || score > best.score) {
      best = { margin, score, fallback: true, ...stats };
    }
  }
  return best;
}

function pickLineBOnHistory(history) {
  let best = null;
  for (const minEv of lineBGrid.minEv) {
    for (const topK of lineBGrid.topK) {
      for (const minMargin of lineBGrid.minMargin) {
        const params = { minEv, topK, minMargin };
        const stats = summarize(selectLineB(history, params));
        if (stats.bets < minBetsSelect) continue;
        if (!stats.clearsOwnAvgOdds) continue;
        const score =
          (stats.roi ?? -1) * 1000 + (stats.hitRate ?? 0) * 100 + stats.bets;
        if (!best || score > best.score) best = { params, score, ...stats };
      }
    }
  }
  if (best) return best;
  for (const minEv of lineBGrid.minEv) {
    for (const topK of lineBGrid.topK) {
      for (const minMargin of lineBGrid.minMargin) {
        const params = { minEv, topK, minMargin };
        const stats = summarize(selectLineB(history, params));
        if (stats.bets < minBetsSelect) continue;
        const score = (stats.roi ?? -1) * 1000 + stats.bets;
        if (!best || score > best.score) {
          best = { params, score, fallback: true, ...stats };
        }
      }
    }
  }
  return best;
}

const walkForwardA = [];
const walkForwardB = [];
for (let i = 1; i < months.length; i += 1) {
  const testMonth = months[i];
  const historyMonths = months.slice(0, i);
  const history = games.filter((g) => historyMonths.includes(g.month));
  const test = games.filter((g) => g.month === testMonth);

  const selectedA = pickMarginOnHistory(history);
  const appliedMargin = selectedA?.margin ?? fixedMargin;
  walkForwardA.push({
    testMonth,
    historyMonths,
    selectedMargin: appliedMargin,
    selection: selectedA
      ? {
          margin: selectedA.margin,
          bets: selectedA.bets,
          hitRate: selectedA.hitRate,
          roi: selectedA.roi,
          clearsOwnAvgOdds: selectedA.clearsOwnAvgOdds,
          fallback: Boolean(selectedA.fallback),
        }
      : null,
    oos: summarize(selectLineA(test, appliedMargin)),
  });

  const selectedB = pickLineBOnHistory(history);
  const appliedB = selectedB?.params || fixedB;
  walkForwardB.push({
    testMonth,
    historyMonths,
    selectedParams: appliedB,
    selection: selectedB
      ? {
          params: selectedB.params,
          bets: selectedB.bets,
          hitRate: selectedB.hitRate,
          roi: selectedB.roi,
          clearsOwnAvgOdds: selectedB.clearsOwnAvgOdds,
          fallback: Boolean(selectedB.fallback),
        }
      : null,
    oos: summarize(selectLineB(test, appliedB)),
  });
}

const oosA = walkForwardA.flatMap((fold) => {
  const test = games.filter((g) => g.month === fold.testMonth);
  return selectLineA(test, fold.selectedMargin);
});
const oosB = walkForwardB.flatMap((fold) => {
  const test = games.filter((g) => g.month === fold.testMonth);
  return selectLineB(test, fold.selectedParams);
});

const splitAt = Math.max(1, Math.floor(months.length / 2));
const earlyMonths = months.slice(0, splitAt);
const lateMonths = months.slice(splitAt);
const earlyGames = games.filter((g) => earlyMonths.includes(g.month));
const lateGames = games.filter((g) => lateMonths.includes(g.month));
const halfSplit = {
  earlyMonths,
  lateMonths,
  lineA: {
    fixedRuleOnEarly: summarize(selectLineA(earlyGames)),
    fixedRuleOnLate: summarize(selectLineA(lateGames)),
  },
  lineB: {
    fixedRuleOnEarly: summarize(selectLineB(earlyGames)),
    fixedRuleOnLate: summarize(selectLineB(lateGames)),
  },
};

function monthStability(byMonth) {
  const usable = byMonth.filter((m) => m.bets >= minBetsReport);
  const clear = usable.filter((m) => m.clearsOwnAvgOdds);
  return {
    monthsWithEnoughBets: usable.length,
    monthsClearOwn: clear.length,
    shareClear:
      usable.length > 0 ? Number((clear.length / usable.length).toFixed(2)) : null,
  };
}

const stabA = monthStability(byMonthA);
const stabB = monthStability(byMonthB);
const wfAClear = walkForwardA.filter(
  (f) => f.oos.bets >= minBetsReport && f.oos.clearsOwnAvgOdds
).length;
const wfBClear = walkForwardB.filter(
  (f) => f.oos.bets >= minBetsReport && f.oos.clearsOwnAvgOdds
).length;
const wfAEnough = walkForwardA.filter((f) => f.oos.bets >= minBetsReport).length;
const wfBEnough = walkForwardB.filter((f) => f.oos.bets >= minBetsReport).length;

const summaryA = summarize(lineAFixed);
const summaryB = summarize(lineBFixed);
const summaryOosA = summarize(oosA);
const summaryOosB = summarize(oosB);

const verdictA = (() => {
  const fixedOk = summaryA.clearsOwnAvgOdds && stabA.shareClear >= 0.5;
  const wfOk =
    summaryOosA.clearsOwnAvgOdds &&
    wfAEnough > 0 &&
    wfAClear / wfAEnough >= 0.5;
  if (fixedOk && wfOk) return 'A_holds';
  if (fixedOk && !wfOk) return 'A_in_sample_only';
  return 'A_unstable';
})();

const verdictB = (() => {
  const fixedOk = summaryB.clearsOwnAvgOdds && stabB.shareClear >= 0.5;
  const wfOk =
    summaryOosB.clearsOwnAvgOdds &&
    wfBEnough > 0 &&
    wfBClear / wfBEnough >= 0.5;
  const lateOk = halfSplit.lineB.fixedRuleOnLate.clearsOwnAvgOdds;
  if (fixedOk && wfOk && lateOk) return 'B_holds_walk_forward';
  if (fixedOk && (!wfOk || !lateOk)) return 'B_looks_good_but_oos_weak';
  if (!fixedOk && wfOk) return 'B_wf_ok_full_window_thin';
  return 'B_unstable_do_not_trust';
})();

const out = {
  ok: true,
  modelVersion: validation.modelVersion,
  since: sinceIso,
  universeN: games.length,
  rulesApplied: {
    A: { minProb, fixedMargin, minExpectedValue: rules.minimumExpectedValue },
    B: fixedB,
  },
  lineA_winRate: {
    label: `P>=${minProb} & margin>=${fixedMargin} (no hard EV)`,
    overall: summaryA,
    byMonth: byMonthA,
    byOddsBucket: byOddsA,
    monthStability: stabA,
  },
  lineB_roi: {
    label: 'EV>=3% & margin>=0.25 & daily top3',
    overall: summaryB,
    byMonth: byMonthB,
    byOddsBucket: byOddsB,
    monthStability: stabB,
  },
  walkForwardA: {
    method: '每月用此前資料重選分差；只在該月 OOS',
    folds: walkForwardA,
    oosCombined: summaryOosA,
    foldsClearOwn: wfAClear,
    foldsEnoughBets: wfAEnough,
  },
  walkForwardB: {
    method: '每月用此前資料重選 (minEv,topK,minMargin)；只在該月 OOS',
    grid: lineBGrid,
    folds: walkForwardB,
    oosCombined: summaryOosB,
    foldsClearOwn: wfBClear,
    foldsEnoughBets: wfBEnough,
  },
  halfSplit,
  headToHead: {
    sameWindow: { A: summaryA, B: summaryB },
    walkForwardOos: { A: summaryOosA, B: summaryOosB },
    lateHalfFixedRules: {
      A: halfSplit.lineA.fixedRuleOnLate,
      B: halfSplit.lineB.fixedRuleOnLate,
    },
  },
  verdictA,
  verdictB,
  verdict:
    verdictB === 'B_holds_walk_forward'
      ? 'prefer_B_historically'
      : verdictA === 'A_holds'
        ? 'prefer_A_historically'
        : 'neither_line_trustworthy_yet',
  note: [
    '全歷史 PIT；非實時等待',
    'A=勝率 KPI（短賠常見）；B=ROI KPI（較長賠）',
    'walk-forward / 後半窗用來打穿同窗掃參碰巧',
    '非正式投注授權',
  ],
};

fs.writeFileSync('tmp-mlb-ab-walkforward.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
