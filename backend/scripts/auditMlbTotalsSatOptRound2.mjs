/**
 * 大小分衛星：在現行 preferred 閘門上做下一輪優化掃描（僅 2026）。
 * 產物：tmp-totals-sat-opt-round2.json
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
import { MLB_TOTALS_SATELLITE_SPEC } from '../src/services/MlbTotalsSatellite.js';

const BASE = MLB_TOTALS_SATELLITE_SPEC.rules;

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function ym(iso) {
  return hk(iso).slice(0, 7);
}

function bestTotals(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'totals');
    if (!market) continue;
    for (const over of market.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = market.outcomes.find(
        (o) => o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!over.price || !under?.price) continue;
      const overOdds = Number(over.price);
      const underOdds = Number(under.price);
      if (overOdds < 1.5 || underOdds < 1.5 || overOdds > 2.4 || underOdds > 2.4) continue;
      const vig = 1 / overOdds + 1 / underOdds;
      if (!best || vig < best.vig) {
        const fair = removeVig(decimalToImpliedProb(overOdds), decimalToImpliedProb(underOdds));
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
  if (!bets.length) return { bets: 0, hitRate: null, roi: null, usd50: 0 };
  let unit = 0;
  let hits = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  return {
    bets: bets.length,
    hitRate: Number((hits / bets.length).toFixed(4)),
    roi: Number((unit / bets.length).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}

function buildPool(model) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date('2026-04-01')
         AND date(f.commence_time) <= date('2026-07-28')
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION);

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
    const actualTotal = hs + as;
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
    const market = bestTotals(row.gameId, row.commenceTime);
    if (!market || actualTotal === market.line) continue;
    const pred = predictMlbGameRuns(model, features, { totalLine: market.line });
    const expectedTotal = Number(pred.expectedTotal);
    const pushP = Number(pred.markets?.total?.pushProbability) || 0;
    const overProb =
      Number(pred.markets?.total?.overProbability) / Math.max(1e-9, 1 - pushP);
    const underProb =
      Number(pred.markets?.total?.underProbability) / Math.max(1e-9, 1 - pushP);
    const gap = expectedTotal - market.line;
    const pickOver = gap > 0;
    if (pickOver && overProb < 0.5) continue;
    if (!pickOver && underProb < 0.5) continue;
    const modelProb = pickOver ? overProb : underProb;
    const pickOdds = pickOver ? market.overOdds : market.underOdds;
    const fair = pickOver ? market.fairOver : market.fairUnder;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const park = Number(features.parkFactor) || 1;
    pool.push({
      day: hk(row.commenceTime),
      month: ym(row.commenceTime),
      side: pickOver ? 'over' : 'under',
      absGap: Math.abs(gap),
      modelProb,
      pickOdds,
      ev,
      edgeVsMarket: modelProb - fair,
      line: market.line,
      park,
      hit: pickOver === actualTotal > market.line,
      score: ev,
    });
  }
  return pool;
}

function select(pool, extra = {}) {
  const {
    topK = BASE.dailyTopK,
    side = null,
    minGap = BASE.minAbsGap,
    minEv = BASE.minimumExpectedValue,
    minEdge = BASE.minEdgeVsMarket,
    minProb = BASE.minimumModelProbability,
    maxPark = null,
    maxLine = null,
    minLine = null,
  } = extra;
  const filtered = pool.filter((g) => {
    if (g.absGap < minGap) return false;
    if (g.ev < minEv) return false;
    if (g.edgeVsMarket < minEdge) return false;
    if (g.modelProb < minProb) return false;
    if (side && g.side !== side) return false;
    if (maxPark != null && g.park >= maxPark) return false;
    if (maxLine != null && g.line > maxLine) return false;
    if (minLine != null && g.line < minLine) return false;
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

function holdout(pool, extra) {
  const train = pool.filter((g) => g.month === '2026-04' || g.month === '2026-05');
  const test = pool.filter((g) => g.month === '2026-06' || g.month === '2026-07');
  return { train: summarize(select(train, extra)), test: summarize(select(test, extra)) };
}

function wf(pool, extra) {
  const months = [...new Set(pool.map((g) => g.month))].sort();
  const oos = [];
  const folds = [];
  for (let i = 1; i < months.length; i += 1) {
    const test = pool.filter((g) => g.month === months[i]);
    const picked = select(test, extra);
    oos.push(...picked);
    folds.push({ month: months[i], ...summarize(picked) });
  }
  return { folds, oos: summarize(oos) };
}

const latest = getLatestMlbExpectedRunsValidation();
console.log('[totals-opt2] building…');
const pool = buildPool(latest.model);
console.log('pool', pool.length);

const variants = [
  { id: 'current_sat', label: '現行衛星（無 TopK）', extra: {} },
  { id: 'topk1', label: '日內 Top1', extra: { topK: 1 } },
  { id: 'topk2', label: '日內 Top2', extra: { topK: 2 } },
  { id: 'topk3', label: '日內 Top3', extra: { topK: 3 } },
  { id: 'under_only', label: '只押小', extra: { side: 'under' } },
  { id: 'over_only', label: '只押大', extra: { side: 'over' } },
  { id: 'under_topk2', label: '只押小 + Top2', extra: { side: 'under', topK: 2 } },
  { id: 'no_coors', label: '排除高 park(≥1.15，含 Coors)', extra: { maxPark: 1.15 } },
  { id: 'line_le_10', label: '盤口 ≤10', extra: { maxLine: 10 } },
  { id: 'line_ge_8', label: '盤口 ≥8', extra: { minLine: 8 } },
  { id: 'tighter_gap075', label: '差距 ≥0.75', extra: { minGap: 0.75 } },
  { id: 'tighter_ev05', label: 'EV≥5%', extra: { minEv: 0.05 } },
  { id: 'tighter_edge06', label: 'edge≥6%', extra: { minEdge: 0.06 } },
  { id: 'combo_under_gap075_topk2', label: '小+gap0.75+Top2', extra: { side: 'under', minGap: 0.75, topK: 2 } },
];

const rows = variants.map((v) => {
  const h = holdout(pool, v.extra);
  const w = wf(pool, v.extra);
  const pass =
    h.train.bets >= 30 &&
    h.test.bets >= 25 &&
    (h.train.roi ?? -1) > 0 &&
    (h.test.roi ?? -1) > 0 &&
    (w.oos.roi ?? -1) > 0;
  return {
    id: v.id,
    label: v.label,
    holdoutTrain: h.train,
    holdoutTest: h.test,
    wfOos: w.oos,
    wfFolds: w.folds,
    pass,
    deltaTestUsdVsCurrent: null,
  };
});

const current = rows.find((r) => r.id === 'current_sat');
for (const r of rows) {
  r.deltaTestUsdVsCurrent = (r.holdoutTest.usd50 || 0) - (current?.holdoutTest.usd50 || 0);
  r.deltaWfUsdVsCurrent = (r.wfOos.usd50 || 0) - (current?.wfOos.usd50 || 0);
}

rows.sort((a, b) => (b.wfOos.usd50 || 0) - (a.wfOos.usd50 || 0));

const promoteCandidates = rows.filter(
  (r) =>
    r.pass &&
    r.id !== 'current_sat' &&
    (r.holdoutTest.usd50 || 0) >= (current?.holdoutTest.usd50 || 0) &&
    (r.wfOos.usd50 || 0) >= (current?.wfOos.usd50 || 0)
);

const payload = {
  generatedAt: new Date().toISOString(),
  baseRule: BASE,
  note: '僅 2026；相對現行衛星比 holdout 測窗 + WF。雙升才建議改影子規格。',
  current: current,
  promoteCandidates,
  all: rows,
  verdict: promoteCandidates[0]
    ? {
        changeShadow: true,
        to: promoteCandidates[0].id,
        reason: 'holdout 測窗與 WF 皆≥現行且雙正',
      }
    : {
        changeShadow: false,
        reason: '無變體同時抬 holdout 測窗與 WF；維持現行衛星規格，優先回補 2025。',
      },
};

fs.writeFileSync(
  new URL('../tmp-totals-sat-opt-round2.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);

console.log('CURRENT', current?.holdoutTest, current?.wfOos);
for (const r of rows) {
  console.log(
    `${r.id}: testHR=${r.holdoutTest.hitRate} test$=${r.holdoutTest.usd50} wfHR=${r.wfOos.hitRate} wf$=${r.wfOos.usd50} Δtest=${r.deltaTestUsdVsCurrent} Δwf=${r.deltaWfUsdVsCurrent} pass=${r.pass}`
  );
}
console.log('VERDICT', payload.verdict);
