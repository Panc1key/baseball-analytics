/**
 * NPB 影子優化輪 3：mu_league 分月診斷 + totals 泊松穩定性變體
 * 用法: node scripts/auditNpbShadowOptRound3.mjs
 * 產物: tmp-npb-shadow-opt-round3.json
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

/** 對 totals 機率做溫度壓平 + shrink-to-market */
function calibrateSideProb(rawP, fair, { temp = 1, shrink = 0 } = {}) {
  const p0 = Math.max(1e-6, Math.min(1 - 1e-6, Number(rawP)));
  let z = Math.log(p0 / (1 - p0));
  z /= Math.max(0.5, Number(temp) || 1);
  let p = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
  const s = Math.max(0, Math.min(1, Number(shrink) || 0));
  if (s > 0) p = (1 - s) * p + s * Number(fair);
  return Math.max(0.05, Math.min(0.95, p));
}

const ML_VARIANTS = [
  { id: 'cal_same', shrinkLeague: 0 },
  { id: 'mu_league_015', shrinkLeague: 0.15 },
  { id: 'mu_league_025', shrinkLeague: 0.25 },
  { id: 'mu_league_035', shrinkLeague: 0.35 },
];

const TOTALS_VARIANTS = [
  { id: 'poisson_raw_mid', shrinkLeague: 0, shrinkMkt: 0, temp: 1, shrinkFair: 0, side: 'both' },
  { id: 'poisson_mu025_mid', shrinkLeague: 0.25, shrinkMkt: 0, temp: 1, shrinkFair: 0, side: 'both' },
  { id: 'poisson_mu025_mkt02', shrinkLeague: 0.15, shrinkMkt: 0.2, temp: 1, shrinkFair: 0, side: 'both' },
  { id: 'poisson_mu025_cal', shrinkLeague: 0.25, shrinkMkt: 0, temp: 1.25, shrinkFair: 0.35, side: 'both' },
  { id: 'poisson_mu025_under', shrinkLeague: 0.25, shrinkMkt: 0, temp: 1, shrinkFair: 0, side: 'under' },
  { id: 'poisson_mu025_over', shrinkLeague: 0.25, shrinkMkt: 0, temp: 1, shrinkFair: 0, side: 'over' },
  { id: 'poisson_mu025_edge03', shrinkLeague: 0.25, shrinkMkt: 0, temp: 1, shrinkFair: 0, side: 'both', minEdge: 0.03, minEv: 0.03 },
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

const mlBags = Object.fromEntries(ML_VARIANTS.map((v) => [v.id, []]));
const totBags = Object.fromEntries(TOTALS_VARIANTS.map((v) => [v.id, []]));

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

    for (const v of ML_VARIANTS) {
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
      if (passMid(cand)) mlBags[v.id].push(cand);
    }

    if (!row.totals) continue;
    const actualTotal = row.yHomeRuns + row.yAwayRuns;
    const line = row.totals.line;
    const actualPush = actualTotal === line;

    for (const v of TOTALS_VARIANTS) {
      const sh = shrinkAsianSideMus(homeMu0, awayMu0, {
        leagueTotal,
        shrinkToLeague: v.shrinkLeague,
        marketLine: line,
        shrinkToMarket: v.shrinkMkt,
      });
      const dist = poissonTotalOverUnderProb(sh.homeMu, sh.awayMu, line);
      let overP = dist.overProb;
      let underP = dist.underProb;
      overP = calibrateSideProb(overP, row.totals.fairOver, {
        temp: v.temp,
        shrink: v.shrinkFair,
      });
      underP = calibrateSideProb(underP, row.totals.fairUnder, {
        temp: v.temp,
        shrink: v.shrinkFair,
      });
      // renormalize after independent calibration
      const s = overP + underP;
      if (s > 0) {
        overP /= s;
        underP /= s;
      }

      let pickOver = overP >= underP;
      if (v.side === 'under') pickOver = false;
      if (v.side === 'over') pickOver = true;
      // side-restricted: only bet when model prefers that side
      if (v.side === 'under' && overP > underP) continue;
      if (v.side === 'over' && underP > overP) continue;

      const modelProb = pickOver ? overP : underP;
      const odds = pickOver ? row.totals.overOdds : row.totals.underOdds;
      const fair = pickOver ? row.totals.fairOver : row.totals.fairUnder;
      const edge = modelProb - fair;
      const ev = modelProb * (odds - 1) - (1 - modelProb);
      const hit = !actualPush && pickOver === actualTotal > line;
      const minEdge = v.minEdge ?? 0.02;
      const minEv = v.minEv ?? 0.02;
      if (
        !actualPush &&
        odds >= 1.7 &&
        odds <= 2.2 &&
        modelProb >= 0.52 &&
        edge >= minEdge &&
        ev >= minEv
      ) {
        totBags[v.id].push({
          odds,
          modelProb,
          edge,
          ev,
          hit,
          hold: row.month,
          side: pickOver ? 'over' : 'under',
          push: false,
        });
      }
    }
  }
}

const parentMl = summarize(mlBags.cal_same);
const parentByMonth = byKey(mlBags.cal_same, (b) => b.hold);
const mu025ByMonth = byKey(mlBags.mu_league_025, (b) => b.hold);
const monthCompare = {};
for (const m of new Set([...Object.keys(parentByMonth), ...Object.keys(mu025ByMonth)])) {
  monthCompare[m] = {
    parent: parentByMonth[m] || { bets: 0, usd50: 0 },
    mu025: mu025ByMonth[m] || { bets: 0, usd50: 0 },
    deltaUsd50:
      (mu025ByMonth[m]?.usd50 || 0) - (parentByMonth[m]?.usd50 || 0),
  };
}
const hurtMonths = Object.entries(monthCompare)
  .filter(([, v]) => v.deltaUsd50 < 0)
  .sort((a, b) => a[1].deltaUsd50 - b[1].deltaUsd50);

const mlOut = {};
for (const v of ML_VARIANTS) {
  const overall = summarize(mlBags[v.id]);
  const byYear = byKey(mlBags[v.id], (b) => String(b.hold).slice(0, 4));
  const yearDelta = {};
  const parentByYear = byKey(mlBags.cal_same, (b) => String(b.hold).slice(0, 4));
  for (const y of new Set([...Object.keys(parentByYear), ...Object.keys(byYear)])) {
    yearDelta[y] = {
      parentUsd50: parentByYear[y]?.usd50 ?? 0,
      shadowUsd50: byYear[y]?.usd50 ?? 0,
      deltaUsd50: (byYear[y]?.usd50 ?? 0) - (parentByYear[y]?.usd50 ?? 0),
    };
  }
  mlOut[v.id] = {
    overall,
    byYear,
    yearDelta,
    deltaVsParent: overall.usd50 - parentMl.usd50,
    verdict:
      v.id === 'cal_same'
        ? { status: 'parent' }
        : npbShadowPromoteVerdict({ baseline: parentMl, shadow: overall, byYear: yearDelta }),
  };
}

const totParent = summarize(totBags.poisson_mu025_mid);
const totOut = {};
for (const v of TOTALS_VARIANTS) {
  const overall = summarize(totBags[v.id]);
  const byYear = byKey(totBags[v.id], (b) => String(b.hold).slice(0, 4));
  const bySide = byKey(totBags[v.id], (b) => b.side || 'na');
  const parentByYear = byKey(totBags.poisson_mu025_mid, (b) => String(b.hold).slice(0, 4));
  const yearDelta = {};
  for (const y of new Set([...Object.keys(parentByYear), ...Object.keys(byYear)])) {
    yearDelta[y] = {
      parentUsd50: parentByYear[y]?.usd50 ?? 0,
      shadowUsd50: byYear[y]?.usd50 ?? 0,
      deltaUsd50: (byYear[y]?.usd50 ?? 0) - (parentByYear[y]?.usd50 ?? 0),
    };
  }
  totOut[v.id] = {
    overall,
    byYear,
    bySide,
    yearDelta,
    deltaVsSavedTotals: overall.usd50 - totParent.usd50,
    verdict:
      v.id === 'poisson_mu025_mid'
        ? { status: 'saved_totals_parent' }
        : npbShadowPromoteVerdict({
            baseline: totParent,
            shadow: overall,
            byYear: yearDelta,
          }),
  };
}

const totRanked = Object.entries(totOut)
  .filter(([id]) => id !== 'poisson_mu025_mid')
  .sort((a, b) => b[1].deltaVsSavedTotals - a[1].deltaVsSavedTotals)
  .map(([id, v]) => ({
    id,
    deltaUsd50: v.deltaVsSavedTotals,
    bets: v.overall.bets,
    hitRate: v.overall.hitRate,
    roi: v.overall.roi,
    usd50: v.overall.usd50,
    status: v.verdict.status,
    bySide: v.bySide,
  }));

const bestTot = totRanked.find((x) => x.status === 'candidate_discuss_only' && x.deltaUsd50 > 0);

const out = {
  researchOnly: true,
  wiredToFormal: false,
  openedAt: '2026-08-05',
  parentMl: 'ridge_poisson_cal_same',
  savedTotals: 'totals_poisson_mu025_mid',
  moneyline: mlOut,
  mu025MonthDiag: {
    hurtMonths: hurtMonths.slice(0, 12).map(([m, v]) => ({ month: m, ...v })),
    helpMonths: Object.entries(monthCompare)
      .filter(([, v]) => v.deltaUsd50 > 0)
      .sort((a, b) => b[1].deltaUsd50 - a[1].deltaUsd50)
      .slice(0, 8)
      .map(([m, v]) => ({ month: m, ...v })),
    allMonths: monthCompare,
  },
  totals: totOut,
  totalsRanking: totRanked,
  decision: {
    ml: 'keep cal_same; mu_league_025 still marginal — see month diag',
    totalsKeepSaved: !bestTot,
    totalsCandidate: bestTot?.id || null,
    note: '不燒 Odds 額度；歷史 totals 仍偏 2026',
  },
};

fs.writeFileSync(
  new URL('../tmp-npb-shadow-opt-round3.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      mlDeltas: Object.fromEntries(
        Object.entries(mlOut).map(([k, v]) => [k, { ...v.overall, delta: v.deltaVsParent, status: v.verdict.status }])
      ),
      hurtMonths: out.mu025MonthDiag.hurtMonths.slice(0, 6),
      helpMonths: out.mu025MonthDiag.helpMonths.slice(0, 4),
      totalsRanking: totRanked,
      savedTotals: totOut.poisson_mu025_mid.overall,
      decision: out.decision,
    },
    null,
    2
  )
);
console.log('wrote tmp-npb-shadow-opt-round3.json');
