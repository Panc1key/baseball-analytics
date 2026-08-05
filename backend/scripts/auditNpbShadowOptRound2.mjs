/**
 * NPB 影子優化輪 2：edge/結構過濾 + 泊松 totals
 * parent = ridge_poisson_cal_same（可選疊 mu_league_025）
 *
 * 用法: node scripts/auditNpbShadowOptRound2.mjs
 * 產物: tmp-npb-shadow-opt-round2.json
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
  poissonTotalOverUnderProb,
  shrinkAsianSideMus,
  trainAsianRunsLinear,
} from '../src/services/AsianExpectedRunsLite.js';
import {
  NPB_RESEARCH_SHADOW_SPEC,
  npbShadowPromoteVerdict,
} from '../src/services/AsianNpbResearchShadow.js';

const STAKE = NPB_RESEARCH_SHADOW_SPEC.stakeUsd;
const LEAGUE = 'NPB';
const GATE = NPB_RESEARCH_SHADOW_SPEC.gates.mid;
const CAL = {
  shrink: NPB_RESEARCH_SHADOW_SPEC.savedPrimaryShadow.shrink,
  temp: NPB_RESEARCH_SHADOW_SPEC.savedPrimaryShadow.temp,
};

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

function bestTotals(bookmakers) {
  let best = null;
  for (const book of bookmakers || []) {
    const m = book.markets?.find((x) => x.key === 'totals');
    if (!m?.outcomes?.length) continue;
    const over = m.outcomes.find((o) => /over/i.test(o.name));
    const under = m.outcomes.find((o) => /under/i.test(o.name));
    const line = Number(over?.point ?? under?.point);
    const oOdds = Number(over?.price);
    const uOdds = Number(under?.price);
    if (!Number.isFinite(line) || !Number.isFinite(oOdds) || !Number.isFinite(uOdds)) continue;
    const vig = 1 / oOdds + 1 / uOdds;
    if (!best || vig < best.vig) {
      const fair = removeVig(decimalToImpliedProb(oOdds), decimalToImpliedProb(uOdds));
      best = {
        line,
        overOdds: oOdds,
        underOdds: uOdds,
        fairOver: fair.fairA,
        fairUnder: fair.fairB,
        vig,
      };
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
    if (b.push) continue;
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

function byYearSummary(bets) {
  const map = {};
  for (const b of bets) {
    const y = String(b.hold).slice(0, 4);
    if (!map[y]) map[y] = [];
    map[y].push(b);
  }
  const out = {};
  for (const [y, arr] of Object.entries(map).sort()) out[y] = summarize(arr);
  return out;
}

function yearDelta(parentByYear, shadowByYear) {
  const out = {};
  for (const y of new Set([...Object.keys(parentByYear), ...Object.keys(shadowByYear)])) {
    out[y] = {
      parentUsd50: parentByYear[y]?.usd50 ?? 0,
      shadowUsd50: shadowByYear[y]?.usd50 ?? 0,
      deltaUsd50: (shadowByYear[y]?.usd50 ?? 0) - (parentByYear[y]?.usd50 ?? 0),
    };
  }
  return out;
}

function passMid(cand, extra = {}) {
  if (cand.odds < GATE.minOdds || cand.odds > GATE.maxOdds) return false;
  if (cand.modelProb < GATE.minProb) return false;
  if (cand.edge < GATE.minEdge) return false;
  if (cand.ev < GATE.minEv) return false;
  if (extra.maxEdge != null && cand.edge > extra.maxEdge) return false;
  if (extra.maxEv != null && cand.ev > extra.maxEv) return false;
  if (extra.minProb != null && cand.modelProb < extra.minProb) return false;
  if (extra.maxOdds != null && cand.odds > extra.maxOdds) return false;
  if (extra.minOdds != null && cand.odds < extra.minOdds) return false;
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

const ML_FILTERS = [
  { id: 'parent_cal_same', shrinkLeague: 0, extra: {} },
  { id: 'mu_league_025', shrinkLeague: 0.25, extra: {} },
  { id: 'maxEdge_06', shrinkLeague: 0, extra: { maxEdge: 0.06 } },
  { id: 'maxEdge_08', shrinkLeague: 0, extra: { maxEdge: 0.08 } },
  { id: 'maxEv_08', shrinkLeague: 0, extra: { maxEv: 0.08 } },
  { id: 'maxEv_10', shrinkLeague: 0, extra: { maxEv: 0.1 } },
  { id: 'odds_185_215', shrinkLeague: 0, extra: { minOdds: 1.85, maxOdds: 2.15 } },
  { id: 'minProb_54', shrinkLeague: 0, extra: { minProb: 0.54 } },
  { id: 'maxEdge_06_odds_185_215', shrinkLeague: 0, extra: { maxEdge: 0.06, minOdds: 1.85, maxOdds: 2.15 } },
  { id: 'mu025_maxEdge_06', shrinkLeague: 0.25, extra: { maxEdge: 0.06 } },
  { id: 'mu025_maxEv_08', shrinkLeague: 0.25, extra: { maxEv: 0.08 } },
];

const TOTALS_VARIANTS = [
  { id: 'gap_legacy', mode: 'gap' },
  { id: 'poisson_mid', mode: 'poisson', minEdge: 0.02, minEv: 0.02, minOdds: 1.7, maxOdds: 2.2 },
  { id: 'poisson_soft', mode: 'poisson', minEdge: 0.01, minEv: 0.01, minOdds: 1.65, maxOdds: 2.3 },
  { id: 'poisson_edge03', mode: 'poisson', minEdge: 0.03, minEv: 0.03, minOdds: 1.7, maxOdds: 2.2 },
  {
    id: 'poisson_mu025_mid',
    mode: 'poisson',
    shrinkLeague: 0.25,
    minEdge: 0.02,
    minEv: 0.02,
    minOdds: 1.7,
    maxOdds: 2.2,
  },
];

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
    ready: homeEx.ready && awayEx.ready,
    xHome: homeEx.x,
    xAway: awayEx.x,
    yHomeRuns: Number(g.home_score),
    yAwayRuns: Number(g.away_score),
    yWin: Number(g.home_score) > Number(g.away_score) ? 1 : 0,
    mkt: bestH2h(books, g.home_team, g.away_team),
    totals: bestTotals(books),
  });
  for (const team of [g.home_team, g.away_team]) {
    if (!priorIndex.has(team)) priorIndex.set(team, []);
    priorIndex.get(team).push(g);
  }
  elo.applyGame(g.home_team, g.away_team, g.home_score, g.away_score);
  appendPitcherHistory(pitcherHist, homeKey, g.commence_time, g.away_score);
  appendPitcherHistory(pitcherHist, awayKey, g.commence_time, g.home_score);
}

const mlBags = Object.fromEntries(ML_FILTERS.map((v) => [v.id, []]));
const totBags = Object.fromEntries(TOTALS_VARIANTS.map((v) => [v.id, []]));
const maeParent = [];

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
    const actualTotal = row.yHomeRuns + row.yAwayRuns;
    maeParent.push(Math.abs(homeMu0 + awayMu0 - actualTotal));

    for (const v of ML_FILTERS) {
      const sh = shrinkAsianSideMus(homeMu0, awayMu0, {
        leagueTotal,
        shrinkToLeague: v.shrinkLeague,
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
      const cand = { odds, modelProb, edge, ev, hit, hold: row.month };
      if (passMid(cand, v.extra)) mlBags[v.id].push(cand);
    }

    if (row.totals) {
      for (const v of TOTALS_VARIANTS) {
        const sh = shrinkAsianSideMus(homeMu0, awayMu0, {
          leagueTotal,
          shrinkToLeague: v.shrinkLeague || 0,
          marketLine: row.totals.line,
          shrinkToMarket: 0,
        });
        const predTotal = sh.homeMu + sh.awayMu;
        const line = row.totals.line;
        const actualPush = actualTotal === line;

        if (v.mode === 'gap') {
          const pickOver = predTotal > line;
          const gap = Math.abs(predTotal - line);
          const odds = pickOver ? row.totals.overOdds : row.totals.underOdds;
          const fair = pickOver ? row.totals.fairOver : row.totals.fairUnder;
          const modelProb = Math.min(0.72, 0.5 + gap * 0.08);
          const edge = modelProb - fair;
          const ev = modelProb * (odds - 1) - (1 - modelProb);
          const hit = !actualPush && pickOver === actualTotal > line;
          if (
            !actualPush &&
            gap >= 0.35 &&
            odds >= 1.7 &&
            odds <= 2.2 &&
            edge >= 0.02 &&
            ev >= 0.02
          ) {
            totBags[v.id].push({
              odds,
              modelProb,
              edge,
              ev,
              hit,
              hold: row.month,
              push: false,
            });
          }
        } else {
          const dist = poissonTotalOverUnderProb(sh.homeMu, sh.awayMu, line);
          const pickOver = dist.overProb >= dist.underProb;
          const modelProb = pickOver ? dist.overProb : dist.underProb;
          const odds = pickOver ? row.totals.overOdds : row.totals.underOdds;
          const fair = pickOver ? row.totals.fairOver : row.totals.fairUnder;
          const edge = modelProb - fair;
          const ev = modelProb * (odds - 1) - (1 - modelProb);
          const hit = !actualPush && pickOver === actualTotal > line;
          if (
            !actualPush &&
            odds >= (v.minOdds ?? 1.7) &&
            odds <= (v.maxOdds ?? 2.2) &&
            modelProb >= 0.52 &&
            edge >= (v.minEdge ?? 0.02) &&
            ev >= (v.minEv ?? 0.02)
          ) {
            totBags[v.id].push({
              odds,
              modelProb,
              edge,
              ev,
              hit,
              hold: row.month,
              push: false,
            });
          }
        }
      }
    }
  }
}

const parentId = 'parent_cal_same';
const parent = summarize(mlBags[parentId]);
const parentByYear = byYearSummary(mlBags[parentId]);

const moneyline = {};
for (const v of ML_FILTERS) {
  const overall = summarize(mlBags[v.id]);
  const byYear = byYearSummary(mlBags[v.id]);
  const yd = yearDelta(parentByYear, byYear);
  moneyline[v.id] = {
    config: v,
    overall,
    byYear,
    yearDelta: yd,
    deltaUsd50VsParent: overall.usd50 - parent.usd50,
    verdict:
      v.id === parentId
        ? { status: 'parent', promote: false, reason: '已保存主影子' }
        : npbShadowPromoteVerdict({ baseline: parent, shadow: overall, byYear: yd }),
  };
}

const totParentId = 'gap_legacy';
const totParent = summarize(totBags[totParentId]);
const totParentByYear = byYearSummary(totBags[totParentId]);
const totals = {};
for (const v of TOTALS_VARIANTS) {
  const overall = summarize(totBags[v.id]);
  const byYear = byYearSummary(totBags[v.id]);
  const yd = yearDelta(totParentByYear, byYear);
  totals[v.id] = {
    config: v,
    overall,
    byYear,
    yearDelta: yd,
    deltaUsd50VsGapLegacy: overall.usd50 - totParent.usd50,
    verdict:
      v.id === totParentId
        ? { status: 'legacy_control', promote: false }
        : npbShadowPromoteVerdict({ baseline: totParent, shadow: overall, byYear: yd }),
  };
}

const mlRanked = Object.entries(moneyline)
  .filter(([id]) => id !== parentId)
  .sort((a, b) => b[1].deltaUsd50VsParent - a[1].deltaUsd50VsParent)
  .map(([id, v]) => ({
    id,
    deltaUsd50: v.deltaUsd50VsParent,
    bets: v.overall.bets,
    hitRate: v.overall.hitRate,
    roi: v.overall.roi,
    usd50: v.overall.usd50,
    status: v.verdict.status,
  }));

const totRanked = Object.entries(totals)
  .filter(([id]) => id !== totParentId)
  .sort((a, b) => b[1].deltaUsd50VsGapLegacy - a[1].deltaUsd50VsGapLegacy)
  .map(([id, v]) => ({
    id,
    deltaUsd50: v.deltaUsd50VsGapLegacy,
    bets: v.overall.bets,
    hitRate: v.overall.hitRate,
    roi: v.overall.roi,
    usd50: v.overall.usd50,
    status: v.verdict.status,
  }));

const bestMl = mlRanked.find((x) => x.status === 'candidate_discuss_only') || null;
const bestTot = totRanked.find((x) => x.usd50 > 0 && x.bets >= 40) || totRanked[0] || null;

const out = {
  researchOnly: true,
  wiredToFormal: false,
  openedAt: '2026-08-05',
  parentShadow: NPB_RESEARCH_SHADOW_SPEC.savedPrimaryShadow.id,
  parentMl: parent,
  parentMae:
    maeParent.length > 0
      ? Number((maeParent.reduce((a, b) => a + b, 0) / maeParent.length).toFixed(3))
      : null,
  moneyline,
  moneylineRanking: mlRanked,
  totals,
  totalsRanking: totRanked,
  decision: {
    mlKeepParent: !bestMl || bestMl.deltaUsd50 <= 0,
    mlCandidateToSave: bestMl && bestMl.deltaUsd50 > 0 ? bestMl.id : null,
    totalsBetterThanGap: bestTot && bestTot.deltaUsd50 > 0 ? bestTot.id : null,
    note: 'MLB 鎖定不動；NPB 僅影子。升格須人工。',
  },
};

fs.writeFileSync(
  new URL('../tmp-npb-shadow-opt-round2.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      parentMl: out.parentMl,
      parentMae: out.parentMae,
      moneylineRanking: out.moneylineRanking,
      totalsRanking: out.totalsRanking,
      totalsLegacy: totals.gap_legacy?.overall,
      decision: out.decision,
    },
    null,
    2
  )
);
console.log('wrote tmp-npb-shadow-opt-round2.json');
