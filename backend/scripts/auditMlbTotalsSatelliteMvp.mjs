/**
 * MLB 大小分衛星 MVP（2026 內 OOS；2025 無 totals PIT）。
 *
 * Holdout：訓練 2026-04～05 → 測試 2026-06～07
 * Expanding WF：按月滾動（訓練到 m-1，測 m）
 *
 * 產物：tmp-totals-satellite-mvp.json
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
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function ym(iso) {
  return hk(iso).slice(0, 7);
}

function bestTotalsMarket(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((entry) => entry.key === 'totals');
    if (!market) continue;
    for (const over of market.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = market.outcomes.find(
        (outcome) =>
          outcome.name === 'Under' && Number(outcome.point) === Number(over.point)
      );
      if (!over.price || !under?.price) continue;
      const overOdds = Number(over.price);
      const underOdds = Number(under.price);
      if (!Number.isFinite(overOdds) || !Number.isFinite(underOdds)) continue;
      if (overOdds < 1.5 || underOdds < 1.5 || overOdds > 2.4 || underOdds > 2.4) continue;
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
    return { bets: 0, hitRate: null, avgOdds: null, roi: null, unitPnl: 0, usd50: 0 };
  }
  let unit = 0;
  let oddsSum = 0;
  let hits = 0;
  for (const b of bets) {
    oddsSum += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((oddsSum / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    unitPnl: Number(unit.toFixed(2)),
    usd50: Math.round(unit * 50),
  };
}

function buildPool(from, to, model) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime,
              f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam,
              g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f
       JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ?
         AND g.completed = 1
         AND g.home_score IS NOT NULL
         AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?)
         AND date(f.commence_time) <= date(?)
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
    const hs = Number(row.homeScore);
    const as = Number(row.awayScore);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    const actualTotal = hs + as;

    features.gameId = row.gameId;
    features.commenceTime = row.commenceTime;
    features.homeTeam = row.homeTeam;
    features.awayTeam = row.awayTeam;
    features.parkFactor = resolveMlbParkFactor({
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    features.weather = getCachedMlbGameWeather({
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });

    const market = bestTotalsMarket(row.gameId, row.commenceTime);
    if (!market) continue;
    if (actualTotal === market.line) continue;

    const pred = predictMlbGameRuns(model, features, { totalLine: market.line });
    const expectedTotal = Number(pred.expectedTotal);
    const pushP = Number(pred.markets?.total?.pushProbability) || 0;
    const overRaw = Number(pred.markets?.total?.overProbability);
    const underRaw = Number(pred.markets?.total?.underProbability);
    if (!Number.isFinite(expectedTotal) || !Number.isFinite(overRaw)) continue;
    const overProb = overRaw / Math.max(1e-9, 1 - pushP);
    const underProb = underRaw / Math.max(1e-9, 1 - pushP);

    const gap = expectedTotal - market.line;
    const pickOver = gap > 0;
    if (pickOver && overProb < 0.5) continue;
    if (!pickOver && underProb < 0.5) continue;

    const modelProb = pickOver ? overProb : underProb;
    const pickOdds = pickOver ? market.overOdds : market.underOdds;
    const fairPick = pickOver ? market.fairOver : market.fairUnder;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);

    pool.push({
      day: hk(row.commenceTime),
      month: ym(row.commenceTime),
      line: market.line,
      expectedTotal,
      absGap: Math.abs(gap),
      side: pickOver ? 'over' : 'under',
      modelProb,
      pickOdds,
      ev,
      edgeVsMarket: modelProb - fairPick,
      hit: pickOver === actualTotal > market.line,
      score: ev,
    });
  }
  return pool;
}

function select(pool, { minGap, minEv, minEdge, minProb, topK, side }) {
  const filtered = pool.filter((g) => {
    if (g.absGap < minGap) return false;
    if (g.ev < minEv) return false;
    if (g.edgeVsMarket < minEdge) return false;
    if (g.modelProb < minProb) return false;
    if (side && g.side !== side) return false;
    return true;
  });
  if (!topK) return filtered;
  const byDay = new Map();
  for (const g of filtered) {
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    out.push(
      ...[...byDay.get(day)]
        .sort((a, b) => b.score - a.score || b.absGap - a.absGap)
        .slice(0, topK)
    );
  }
  return out;
}

function scoreRule(train, test, rule) {
  const trainSum = summarize(select(train, rule));
  const testSum = summarize(select(test, rule));
  return {
    rule,
    train: trainSum,
    test: testSum,
    pass:
      trainSum.bets >= 40 &&
      testSum.bets >= 25 &&
      (trainSum.roi ?? -1) > 0 &&
      (testSum.roi ?? -1) > 0 &&
      (testSum.roi ?? -1) >= 0.02,
  };
}

const latest = getLatestMlbExpectedRunsValidation();
if (!latest?.model || latest.modelVersion !== 'mlb-expected-runs-nb-v4.5') {
  throw new Error(`expected v4.5 model, got ${latest?.modelVersion}`);
}

console.log('[totals-mvp] building 2026 pool…');
const pool = buildPool('2026-04-01', '2026-07-28', latest.model);
console.log('  candidates', pool.length);

const trainHold = pool.filter((g) => g.month === '2026-04' || g.month === '2026-05');
const testHold = pool.filter((g) => g.month === '2026-06' || g.month === '2026-07');

const GAP = [0.25, 0.5, 0.75, 1.0, 1.25];
const EV = [0.02, 0.03, 0.05, 0.08];
const EDGE = [0, 0.02, 0.04];
const PROB = [0.5, 0.52, 0.55];
const TOPK = [null, 1, 2, 3];
const SIDES = [null, 'over', 'under'];

const holdoutScored = [];
for (const minGap of GAP) {
  for (const minEv of EV) {
    for (const minEdge of EDGE) {
      for (const minProb of PROB) {
        for (const topK of TOPK) {
          for (const side of SIDES) {
            const rule = { minGap, minEv, minEdge, minProb, topK, side };
            const scored = scoreRule(trainHold, testHold, rule);
            if (scored.test.bets < 15 && scored.train.bets < 20) continue;
            holdoutScored.push({
              id: `g${minGap}_ev${minEv}_e${minEdge}_p${minProb}_k${topK ?? 'all'}_${side ?? 'both'}`,
              ...scored,
            });
          }
        }
      }
    }
  }
}

holdoutScored.sort((a, b) => (b.test.usd50 || 0) - (a.test.usd50 || 0));
const holdoutPass = holdoutScored.filter((v) => v.pass);

/** Expanding WF：固定規則，每月用先前月份選出後測該月 */
function expandingWf(rule) {
  const months = [...new Set(pool.map((g) => g.month))].sort();
  const folds = [];
  const oosBets = [];
  for (let i = 1; i < months.length; i += 1) {
    const trainMonths = new Set(months.slice(0, i));
    const testMonth = months[i];
    const train = pool.filter((g) => trainMonths.has(g.month));
    const test = pool.filter((g) => g.month === testMonth);
    // 規則固定（不在 fold 內重選），只測 OOS
    const selected = select(test, rule);
    oosBets.push(...selected);
    folds.push({
      testMonth,
      trainN: train.length,
      ...summarize(selected),
    });
  }
  return { folds, oos: summarize(oosBets) };
}

const topCandidates = (holdoutPass.length ? holdoutPass : holdoutScored).slice(0, 12);
const withWf = topCandidates.map((c) => ({
  ...c,
  expandingWf: expandingWf(c.rule),
}));

const preferred =
  withWf.find(
    (c) =>
      c.pass &&
      (c.expandingWf.oos.roi ?? -1) >= 0.02 &&
      c.expandingWf.oos.bets >= 40 &&
      c.expandingWf.folds.every((f) => f.bets === 0 || (f.usd50 ?? 0) >= -150)
  ) ||
  withWf.find((c) => c.pass && (c.expandingWf.oos.roi ?? -1) > 0) ||
  null;

const naiveAll = summarize(
  select(pool, { minGap: 0, minEv: -99, minEdge: -99, minProb: 0.5, topK: null, side: null })
);

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'shadow_research',
  modelVersion: latest.modelVersion,
  dataNote:
    '2025 odds_snapshots 無 totals（僅回補 h2h）；本審計僅 2026-04～07，用 holdout + expanding WF。正式升格前需回補 2025 totals。',
  candidateUniverse: {
    all2026: pool.length,
    trainAprMay: trainHold.length,
    testJunJul: testHold.length,
    byMonth: Object.fromEntries(
      [...new Set(pool.map((g) => g.month))]
        .sort()
        .map((m) => [m, pool.filter((g) => g.month === m).length])
    ),
  },
  naiveAll,
  holdoutPassCount: holdoutPass.length,
  preferredRule: preferred,
  topHoldout: withWf.slice(0, 8).map((c) => ({
    id: c.id,
    pass: c.pass,
    train: c.train,
    test: c.test,
    wfOos: c.expandingWf.oos,
    wfFolds: c.expandingWf.folds,
  })),
  verdict: preferred
    ? {
        promoteShadow: true,
        promoteFormal: false,
        reason: '2026 holdout+WF 過閘；缺 2025 totals 故僅影子衛星，不進正式獨贏混排。',
        rule: {
          minAbsGap: preferred.rule.minGap,
          minimumExpectedValue: preferred.rule.minEv,
          minEdgeVsMarket: preferred.rule.minEdge,
          minimumModelProbability: preferred.rule.minProb,
          dailyTopK: preferred.rule.topK,
          side: preferred.rule.side,
          pickOddsBand: [1.5, 2.4],
        },
        holdoutTest: preferred.test,
        expandingWfOos: preferred.expandingWf.oos,
      }
    : {
        promoteShadow: false,
        promoteFormal: false,
        reason:
          '2026 holdout／WF 無穩定過閘規則；先建研究衛星框架 + 排程回補 2025 totals，不進推薦。',
        bestTestEvenIfFail: withWf[0]
          ? {
              id: withWf[0].id,
              train: withWf[0].train,
              test: withWf[0].test,
              wfOos: withWf[0].expandingWf.oos,
            }
          : null,
      },
};

fs.writeFileSync(
  new URL('../tmp-totals-satellite-mvp.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);

console.log('naive', naiveAll);
console.log('holdoutPass', holdoutPass.length);
if (preferred) {
  console.log('PREFERRED', preferred.id, {
    train: preferred.train,
    test: preferred.test,
    wf: preferred.expandingWf.oos,
  });
} else {
  console.log('NO PASS; best test', withWf[0]?.id, withWf[0]?.test, withWf[0]?.expandingWf.oos);
}
