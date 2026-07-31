/**
 * 人腦 overlay 的 expanding WF：只允許 flip_to_home
 *
 * 規則（固定動作）：
 * - 若 pickAway 且 主隊 homeWinPct >= homeWinPctThreshold
 *   - 若 modelProb < awayProbThreshold => flip 到主場
 *   - 若 modelProb >= awayProbThreshold => skip（不下）
 * - 其他場次：沿用 B 的原選邊
 *
 * 用 expanding WF 在訓練窗內挑選 (homeWinPctThreshold, awayProbThreshold)
 * 然後套用到下一個測試月份做 OOS。
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
const STRONG_HOME = 0.65;

const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const STAKE_USD = 50;
const warmupMonths = 3;

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

const HOME_WIN_PCT_GRID = [0.6, 0.625, 0.65, 0.675];
const AWAY_PROB_GRID = [0.52, 0.53, 0.54, 0.55, 0.56, 0.57];

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
  let hits = 0;
  let unit = 0;
  let oddsSum = 0;
  for (const b of bets) {
    oddsSum += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else {
      unit -= 1;
    }
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((oddsSum / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE_USD),
  };
}

function applyDrop(sorted) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
  if (slots.length >= 2 && slots[1].pickOdds >= DROP_R2_MIN && slots[1].pickOdds < DROP_R2_MAX) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}

function buildAllBets() {
  const validation = getLatestMlbExpectedRunsValidation();
  const allCandidates = [];

  for (const w of WINDOWS) {
    const rows = db
      .prepare(
        `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
                g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
         FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
         WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
           AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
         ORDER BY f.commence_time`
      )
      .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);

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
      const modelProb = pickHome ? +pred.markets?.homeWinProbability : +pred.markets?.awayWinProbability;
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

      allCandidates.push({
        gameId: row.gameId,
        day: hk(row.commenceTime),
        month: ym(row.commenceTime),
        window: w.key,
        homeWon: hs > as,
        pickHome,
        modelProb,
        pickOdds,
        homeOdds: best.homeOdds,
        awayOdds: best.awayOdds,
        ev,
        margin,
        homeWinPct: +features?.home?.homeWinPct || null,
      });
    }
  }

  // 套用 locked B selection（原始 P）
  const byDay = new Map();
  for (const c of allCandidates) {
    if (c.ev < B.minimumExpectedValue) continue;
    if (c.margin < B.minimumExpectedRunMargin) continue;
    if (c.modelProb < B.minimumModelProbability) continue;
    if (c.pickOdds < B.minimumPickOdds || c.pickOdds > B.maximumPickOdds) continue;

    const bScore = scoreMlbMoneylineDailyRank({ expectedValue: c.ev, modelProbability: c.modelProb }, B);
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day).push({ ...c, bScore, hit: c.pickHome ? c.homeWon : !c.homeWon });
  }

  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort((a, b) => b.bScore - a.bScore || b.margin - a.margin);
    const slots = applyDrop(arr);
    slots.forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

function applyOverlay(betsB, cfg) {
  const kept = [];
  for (const b of betsB) {
    const strongAway = b.pickHome === false && (b.homeWinPct ?? 0) >= cfg.homeWinPctThreshold;
    if (!strongAway) {
      kept.push({ ...b });
      continue;
    }
    if (b.modelProb >= cfg.awayProbThreshold) {
      // skip
      continue;
    }
    // flip to home
    kept.push({
      ...b,
      pickHome: true,
      pickOdds: b.homeOdds,
      hit: b.homeWon,
      flipped: true,
    });
  }
  return kept;
}

const allB = buildAllBets();
const months = [...new Set(allB.map((x) => x.month))].sort();

const candidates = [];
for (const homeWinPctThreshold of HOME_WIN_PCT_GRID) {
  for (const awayProbThreshold of AWAY_PROB_GRID) {
    candidates.push({ homeWinPctThreshold, awayProbThreshold });
  }
}

const wfRows = [];

for (let i = warmupMonths; i < months.length; i += 1) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];

  const trainB = allB.filter((x) => trainMonths.has(x.month));
  const testB = allB.filter((x) => x.month === testMonth);
  if (!trainB.length || !testB.length) continue;

  const baseTrain = summarize(trainB);
  let best = null;

  for (const cfg of candidates) {
    const run = applyOverlay(trainB, cfg);
    const s = summarize(run);
    const deltaUsd = s.usd50 - baseTrain.usd50;
    const deltaHr =
      s.hitRate != null && baseTrain.hitRate != null ? (s.hitRate - baseTrain.hitRate) * 100 : -999;
    const score = deltaUsd + deltaHr * 10 + (s.bets - baseTrain.bets) * 0.5;
    if (!best || score > best.score) {
      best = { cfg, train: s, deltaUsd, deltaHr, score };
    }
  }

  const baseTest = summarize(testB);
  const overlayTest = applyOverlay(testB, best.cfg);
  const sTest = summarize(overlayTest);

  wfRows.push({
    month: testMonth,
    selected: best.cfg,
    testBase: baseTest,
    testOverlay: sTest,
    delta: {
      usd50: sTest.usd50 - baseTest.usd50,
      hitRatePp:
        sTest.hitRate != null && baseTest.hitRate != null ? (sTest.hitRate - baseTest.hitRate) * 100 : null,
      bets: sTest.bets - baseTest.bets,
    },
  });
}

const aggBase = summarize(wfRows.flatMap((r) => allB.filter((x) => x.month === r.month)));
const aggOverlay = summarize(wfRows.flatMap((r) => applyOverlay(allB.filter((x) => x.month === r.month), r.selected)));

const out = {
  experimentId: 'mlb-human-risk-flip-overlay-expanding-wf-flip-only-grid-2026-07-29',
  rule: {
    strongHomeSlice: `pickAway && homeWinPct>=${STRONG_HOME} (but search over threshold)`,
    action: 'if strongAway && modelProb < thr => flip to home; else skip',
  },
  grids: { homeWinPctThreshold: HOME_WIN_PCT_GRID, awayProbThreshold: AWAY_PROB_GRID },
  warmupMonths,
  wfRows,
  aggregate: {
    baseline: aggBase,
    overlay: aggOverlay,
    deltaUsd50: aggOverlay.usd50 - aggBase.usd50,
    deltaHitRatePp:
      aggOverlay.hitRate != null && aggBase.hitRate != null
        ? Number(((aggOverlay.hitRate - aggBase.hitRate) * 100).toFixed(2))
        : null,
  },
};

fs.writeFileSync(new URL('../tmp-human-risk-flip-overlay-expanding-wf-flip-only-grid.json', import.meta.url), JSON.stringify(out, null, 2));

console.log('AGG baseline', out.aggregate.baseline);
console.log('AGG overlay', out.aggregate.overlay);
console.log('DELTA usd50', out.aggregate.deltaUsd50, 'deltaHrPp', out.aggregate.deltaHitRatePp);

