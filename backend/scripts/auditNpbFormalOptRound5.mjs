/**
 * NPB 正式線優化輪 5：日頻／日 TopK／2026 細帳（對齊已接線 formal 模型）
 * 模型：ridge_mu025_if_dev_ge_15 + mid gate（與 NpbPrematchRecommend 同口徑）
 *
 * 用法: node scripts/auditNpbFormalOptRound5.mjs
 * 產物: tmp-npb-formal-opt-round5.json
 *
 * 不燒 Odds；不改 logistic NPB_primary；大小仍 thin 不升格。
 */
import fs from 'fs';
import { createWalkForwardElo } from '../src/services/BaseballElo.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import { loadAsianCompletedGames } from '../src/services/AsianOpeningFoundation.js';
import {
  appendPitcherHistory,
  loadAsianStarterSnapshotMap,
  summarizePitcherHistory,
} from '../src/services/AsianStarterSnapshots.js';
import {
  applyAsianLogisticCalibration,
  exampleFromGameSide,
  poissonHomeWinProb,
  shrinkAsianSideMus,
  trainAsianRunsLinear,
} from '../src/services/AsianExpectedRunsLite.js';
import { NPB_RESEARCH_SHADOW_SPEC } from '../src/services/AsianNpbResearchShadow.js';
import { NPB_FORMAL_PACKAGE } from '../src/services/NpbPrematchRecommend.js';

const STAKE = NPB_FORMAL_PACKAGE.flatStakeUsd;
const LEAGUE = 'NPB';
const GATE = NPB_RESEARCH_SHADOW_SPEC.gates.mid;
const CAL = NPB_FORMAL_PACKAGE.calibrate;
const MIN_DEV = NPB_FORMAL_PACKAGE.minAbsMuDevFromLeague;
const SHRINK_L = NPB_FORMAL_PACKAGE.shrinkToLeague;

function bestH2h(bookmakers, home, away) {
  let best = null;
  for (const book of bookmakers || []) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const ho = m.outcomes.find((o) => o.name === home);
    const ao = m.outcomes.find((o) => o.name === away);
    if (!ho?.price || !ao?.price) continue;
    const homeOdds = Number(ho.price);
    const awayOdds = Number(ao.price);
    if (!Number.isFinite(homeOdds) || !Number.isFinite(awayOdds)) continue;
    const vig = 1 / homeOdds + 1 / awayOdds;
    if (!best || vig < best.vig) {
      const fair = removeVig(
        decimalToImpliedProb(homeOdds),
        decimalToImpliedProb(awayOdds)
      );
      best = { homeOdds, awayOdds, fairHome: fair.fairA, fairAway: fair.fairB, vig };
    }
  }
  return best;
}

function summarize(bets) {
  if (!bets.length) return { bets: 0, decided: 0, hitRate: null, roi: null, usd50: 0 };
  let unit = 0;
  let hits = 0;
  let decided = 0;
  for (const b of bets) {
    decided += 1;
    if (b.hit) {
      hits += 1;
      unit += b.odds - 1;
    } else unit -= 1;
  }
  return {
    bets: bets.length,
    decided,
    hitRate: decided ? Number((hits / decided).toFixed(4)) : null,
    roi: bets.length ? Number((unit / bets.length).toFixed(4)) : null,
    usd50: Math.round(unit * STAKE),
  };
}

function byKey(bets, keyFn) {
  const map = {};
  for (const b of bets) {
    const k = keyFn(b);
    if (!map[k]) map[k] = [];
    map[k].push(b);
  }
  const out = {};
  for (const [k, arr] of Object.entries(map).sort()) out[k] = summarize(arr);
  return out;
}

function passMid(cand) {
  if (cand.odds < GATE.minOdds || cand.odds > GATE.maxOdds) return false;
  if (cand.modelProb < GATE.minProb) return false;
  if (cand.edge < GATE.minEdge) return false;
  if (cand.ev < GATE.minEv) return false;
  return true;
}

function predictSide(ridge, x) {
  if (!ridge?.ok) return 4.2;
  let y = ridge.intercept;
  for (let i = 0; i < ridge.featureKeys.length; i += 1) {
    const k = ridge.featureKeys[i];
    const fullIdx = ridge.featureIndexInFull?.[i] ?? i;
    const raw = Number(x[fullIdx]) || 0;
    y += (ridge.weights[k] || 0) * ((raw - ridge.means[i]) / ridge.scales[i]);
  }
  return Math.max(1.5, Math.min(9.5, y));
}

function dayKey(iso) {
  return String(iso || '').slice(0, 10);
}

function applyDailyTopK(bets, k) {
  if (!k || k <= 0) return bets;
  const byDay = new Map();
  for (const b of bets) {
    const d = b.day;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(b);
  }
  const out = [];
  for (const [, arr] of byDay) {
    arr
      .slice()
      .sort((a, b) => b.ev - a.ev || b.edge - a.edge)
      .slice(0, k)
      .forEach((x) => out.push(x));
  }
  return out;
}

function dailyFreqStats(bets) {
  const byDay = new Map();
  for (const b of bets) {
    const d = b.day;
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  const counts = [...byDay.values()];
  if (!counts.length) {
    return {
      daysWithBets: 0,
      meanPerActiveDay: null,
      medianPerActiveDay: null,
      hist: {},
    };
  }
  counts.sort((a, b) => a - b);
  const hist = {};
  for (const c of counts) hist[String(c)] = (hist[String(c)] || 0) + 1;
  const mid = Math.floor(counts.length / 2);
  const median =
    counts.length % 2 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;
  return {
    daysWithBets: counts.length,
    meanPerActiveDay: Number(
      (counts.reduce((s, x) => s + x, 0) / counts.length).toFixed(2)
    ),
    medianPerActiveDay: median,
    hist,
  };
}

const games = loadAsianCompletedGames(LEAGUE).filter(
  (g) => Number(g.home_score) !== Number(g.away_score)
);
const months = [...new Set(games.map((g) => String(g.commence_time).slice(0, 7)))].sort();
const warmup = new Set(months.slice(0, 2));
const starterMap = loadAsianStarterSnapshotMap(LEAGUE);
const priorIndex = new Map();
const pitcherHist = new Map();
const elo = createWalkForwardElo(LEAGUE, { seedFromRating: false });
const labeled = [];

for (const g of games) {
  const snap = starterMap.get(g.id) || null;
  const homeKey = snap?.home?.key || null;
  const awayKey = snap?.away?.key || null;
  const opts = {
    priorIndex,
    eloLookup: (t) => elo.get(t),
    homePitcherHist: summarizePitcherHistory(pitcherHist.get(homeKey), g.commence_time),
    awayPitcherHist: summarizePitcherHistory(pitcherHist.get(awayKey), g.commence_time),
  };
  const homeEx = exampleFromGameSide(g, 'home', opts);
  const awayEx = exampleFromGameSide(g, 'away', opts);
  const pit = resolvePitOdds(g.id, g.commence_time);
  let books = pit?.bookmakers;
  if (!books?.length) {
    try {
      books = JSON.parse(g.raw_odds || '[]');
    } catch {
      books = [];
    }
  }
  labeled.push({
    g,
    month: String(g.commence_time).slice(0, 7),
    day: dayKey(g.commence_time),
    ready: homeEx.ready && awayEx.ready,
    xHome: homeEx.x,
    xAway: awayEx.x,
    yHomeRuns: Number(g.home_score),
    yAwayRuns: Number(g.away_score),
    yWin: Number(g.home_score) > Number(g.away_score) ? 1 : 0,
    mkt: bestH2h(books, g.home_team, g.away_team),
  });
  for (const team of [g.home_team, g.away_team]) {
    if (!priorIndex.has(team)) priorIndex.set(team, []);
    priorIndex.get(team).push(g);
  }
  elo.applyGame(g.home_team, g.away_team, g.home_score, g.away_score);
  appendPitcherHistory(pitcherHist, homeKey, g.commence_time, g.away_score);
  appendPitcherHistory(pitcherHist, awayKey, g.commence_time, g.home_score);
}

/** unlimited formal bag */
const formalBets = [];

for (const hold of months.filter((m) => !warmup.has(m))) {
  const trainRows = labeled.filter((r) => r.month < hold && r.ready);
  const leagueTotal =
    trainRows.length > 0
      ? trainRows.reduce((s, r) => s + r.yHomeRuns + r.yAwayRuns, 0) / trainRows.length
      : 8.2;
  const ridge = trainAsianRunsLinear(
    trainRows.flatMap((r) => [
      { x: r.xHome, y: r.yHomeRuns },
      { x: r.xAway, y: r.yAwayRuns },
    ])
  );
  if (!ridge.ok) continue;

  for (const row of labeled) {
    if (row.month !== hold || !row.ready || !row.mkt) continue;
    const homeMu0 = predictSide(ridge, row.xHome);
    const awayMu0 = predictSide(ridge, row.xAway);
    const absDev = Math.abs(homeMu0 + awayMu0 - leagueTotal);
    const shrink = absDev >= MIN_DEV ? SHRINK_L : 0;
    const sh = shrinkAsianSideMus(homeMu0, awayMu0, {
      leagueTotal,
      shrinkToLeague: shrink,
    });
    const rawP = poissonHomeWinProb(sh.homeMu, sh.awayMu).homeWinProb;
    const pHome = applyAsianLogisticCalibration(rawP, {
      fromLogit: false,
      shrink: CAL.shrink,
      temp: CAL.temp,
      fairHome: row.mkt.fairHome,
    });
    const pickHome = pHome >= 0.5;
    const modelProb = pickHome ? pHome : 1 - pHome;
    const odds = pickHome ? row.mkt.homeOdds : row.mkt.awayOdds;
    const fair = pickHome ? row.mkt.fairHome : row.mkt.fairAway;
    const edge = modelProb - fair;
    const ev = modelProb * (odds - 1) - (1 - modelProb);
    const hit = pickHome === (row.yWin === 1);
    const cand = { odds, modelProb, edge, ev, hit };
    if (!passMid(cand)) continue;
    formalBets.push({
      ...cand,
      hold: row.month,
      day: row.day,
      year: row.month.slice(0, 4),
      appliedShrink: shrink,
      absDev,
    });
  }
}

const parent = summarize(formalBets);
const TOPK = [0, 2, 3, 4];
const topkOut = {};
for (const k of TOPK) {
  const id = k === 0 ? 'unlimited' : `topk_${k}`;
  const bag = applyDailyTopK(formalBets, k);
  const overall = summarize(bag);
  const byYear = byKey(bag, (b) => b.year);
  const byMonth2026 = byKey(
    bag.filter((b) => b.year === '2026'),
    (b) => b.hold
  );
  topkOut[id] = {
    k: k || null,
    overall,
    byYear,
    byMonth2026,
    deltaVsUnlimited: overall.usd50 - parent.usd50,
    freq: dailyFreqStats(bag),
  };
}

const ranked = Object.entries(topkOut)
  .filter(([id]) => id !== 'unlimited')
  .map(([id, v]) => ({
    id,
    k: v.k,
    bets: v.overall.bets,
    hitRate: v.overall.hitRate,
    roi: v.overall.roi,
    usd50: v.overall.usd50,
    deltaUsd50: v.deltaVsUnlimited,
    meanPerActiveDay: v.freq.meanPerActiveDay,
  }))
  .sort((a, b) => b.deltaUsd50 - a.deltaUsd50 || b.roi - a.roi);

/** 升格日 TopK 條件：Δ$≥0 且 ROI 不低於 unlimited，且注量仍 ≥80 */
const qualifyTopK = ranked.find(
  (x) =>
    x.deltaUsd50 >= 0 &&
    x.roi != null &&
    parent.roi != null &&
    x.roi + 1e-9 >= parent.roi &&
    x.bets >= NPB_RESEARCH_SHADOW_SPEC.observation.minShadowBets
);

const y2026 = formalBets.filter((b) => b.year === '2026');
const shrinkShare =
  formalBets.length === 0
    ? null
    : Number(
        (
          formalBets.filter((b) => b.appliedShrink > 0).length / formalBets.length
        ).toFixed(3)
      );

const decision = {
  keepFormalModel: NPB_FORMAL_PACKAGE.modelId,
  adoptDailyTopK: qualifyTopK?.k || null,
  reason: qualifyTopK
    ? `日 TopK=${qualifyTopK.k} Δ$${qualifyTopK.deltaUsd50} 且 ROI≥unlimited；可寫入 formal`
    : '日 TopK 未同時滿足 Δ$≥0 與 ROI≥unlimited（或不夠注量）— 維持不限 TopK',
  doNotPromoteTotals: true,
  note: '不燒 Odds；大小仍 thin-year',
};

const out = {
  researchOnlyExtras: true,
  wiredToFormal: true,
  openedAt: '2026-08-05',
  formalPackageId: NPB_FORMAL_PACKAGE.id,
  modelId: NPB_FORMAL_PACKAGE.modelId,
  gate: GATE,
  formalUnlimited: {
    overall: parent,
    byYear: byKey(formalBets, (b) => b.year),
    byMonth2026: byKey(y2026, (b) => b.hold),
    freq: dailyFreqStats(formalBets),
    conditionalShrinkShare: shrinkShare,
  },
  topK: topkOut,
  topKRanking: ranked,
  decision,
};

fs.writeFileSync(
  new URL('../tmp-npb-formal-opt-round5.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log(
  JSON.stringify(
    {
      formal: out.formalUnlimited.overall,
      freq: out.formalUnlimited.freq,
      shrinkShare,
      byYear: out.formalUnlimited.byYear,
      topKRanking: ranked,
      decision,
    },
    null,
    2
  )
);
console.log('wrote tmp-npb-formal-opt-round5.json');
