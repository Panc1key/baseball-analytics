/**
 * NPB 影子優化輪 4：
 * A) mu_league_025 相對 cal_same 的 2025-04 結構診斷 + 條件收縮敏感度
 * B) 僅 2026 totals 不對稱（over/under、|μ−line|、盤口、edge 閘）
 *
 * 用法: node scripts/auditNpbShadowOptRound4.mjs
 * 產物: tmp-npb-shadow-opt-round4.json
 *
 * 不燒 Odds；不改 NPB_primary；不升格正式。
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
const HURT_FOCUS = '2025-04';
const UNDER_THIN_MIN = 40;

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

function yearDeltaMap(parentByYear, shadowByYear) {
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

function eloAbsBin(v) {
  const a = Math.abs(Number(v) || 0);
  if (a < 50) return 'eloAbs_lt50';
  if (a < 100) return 'eloAbs_50_100';
  return 'eloAbs_ge100';
}

function muDevBin(dev) {
  const a = Math.abs(Number(dev) || 0);
  if (a < 0.5) return 'muDev_lt0.5';
  if (a < 1.0) return 'muDev_0.5_1.0';
  if (a < 1.5) return 'muDev_1.0_1.5';
  return 'muDev_ge1.5';
}

function oddsBand(odds) {
  const o = Number(odds);
  if (o < 1.85) return 'odds_170_185';
  if (o < 2.0) return 'odds_185_200';
  return 'odds_200_230';
}

function edgeBin(edge) {
  const e = Number(edge);
  if (e < 0.04) return 'edge_02_04';
  if (e < 0.06) return 'edge_04_06';
  return 'edge_ge06';
}

function pitcherKnownBin(pk, opk) {
  const a = Number(pk) > 0.5;
  const b = Number(opk) > 0.5;
  if (a && b) return 'pitcher_both';
  if (a || b) return 'pitcher_one';
  return 'pitcher_none';
}

function absGapBin(gap) {
  const a = Math.abs(Number(gap) || 0);
  if (a < 0.5) return 'absGap_lt0.5';
  if (a < 1.0) return 'absGap_0.5_1.0';
  if (a < 1.5) return 'absGap_1.0_1.5';
  return 'absGap_ge1.5';
}

function lineBin(line) {
  const L = Number(line);
  if (L <= 7.5) return 'line_le7.5';
  if (L < 9.5) return 'line_8_9';
  return 'line_ge9.5';
}

function mean(arr) {
  if (!arr.length) return null;
  return Number((arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(4));
}

/** ML：固定 mid gate；條件收縮 = |μ0−league| 大時才套 mu_league */
const ML_VARIANTS = [
  { id: 'cal_same', shrinkLeague: 0, minAbsDev: null },
  { id: 'mu_league_025', shrinkLeague: 0.25, minAbsDev: null },
  { id: 'mu025_if_dev_ge_05', shrinkLeague: 0.25, minAbsDev: 0.5 },
  { id: 'mu025_if_dev_ge_10', shrinkLeague: 0.25, minAbsDev: 1.0 },
  { id: 'mu025_if_dev_ge_15', shrinkLeague: 0.25, minAbsDev: 1.5 },
];

const TOTALS_VARIANTS = [
  { id: 'poisson_mu025_mid', shrinkLeague: 0.25, side: 'both', minEdge: 0.02, minEv: 0.02 },
  { id: 'poisson_mu025_edge03', shrinkLeague: 0.25, side: 'both', minEdge: 0.03, minEv: 0.03 },
  { id: 'poisson_mu025_edge04', shrinkLeague: 0.25, side: 'both', minEdge: 0.04, minEv: 0.04 },
  { id: 'poisson_mu025_over', shrinkLeague: 0.25, side: 'over', minEdge: 0.02, minEv: 0.02 },
  { id: 'poisson_mu025_under', shrinkLeague: 0.25, side: 'under', minEdge: 0.02, minEv: 0.02 },
  { id: 'poisson_mu025_edge03_over', shrinkLeague: 0.25, side: 'over', minEdge: 0.03, minEv: 0.03 },
  { id: 'poisson_mu025_edge03_under', shrinkLeague: 0.25, side: 'under', minEdge: 0.03, minEv: 0.03 },
  {
    id: 'poisson_mu025_absGap_ge05',
    shrinkLeague: 0.25,
    side: 'both',
    minEdge: 0.02,
    minEv: 0.02,
    minAbsGap: 0.5,
  },
  {
    id: 'poisson_mu025_absGap_ge10',
    shrinkLeague: 0.25,
    side: 'both',
    minEdge: 0.02,
    minEv: 0.02,
    minAbsGap: 1.0,
  },
  {
    id: 'poisson_mu025_absGap_ge15',
    shrinkLeague: 0.25,
    side: 'both',
    minEdge: 0.02,
    minEv: 0.02,
    minAbsGap: 1.5,
  },
  {
    id: 'poisson_mu025_line_le75',
    shrinkLeague: 0.25,
    side: 'both',
    minEdge: 0.02,
    minEv: 0.02,
    lineMax: 7.5,
  },
  {
    id: 'poisson_mu025_line_8_9',
    shrinkLeague: 0.25,
    side: 'both',
    minEdge: 0.02,
    minEv: 0.02,
    lineMin: 8,
    lineMax: 9.25,
  },
  {
    id: 'poisson_mu025_line_ge95',
    shrinkLeague: 0.25,
    side: 'both',
    minEdge: 0.02,
    minEv: 0.02,
    lineMin: 9.5,
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
    gameId: g.id,
    month: String(g.commence_time).slice(0, 7),
    ready: homeEx.ready && awayEx.ready,
    xHome: homeEx.x,
    xAway: awayEx.x,
    feats: homeEx.features || {},
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
/** gameId -> { cal, mu025 } rich records for divergence */
const mlByGame = new Map();

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
    const muTotal0 = homeMu0 + awayMu0;
    const absDev = Math.abs(muTotal0 - leagueTotal);
    const feats = row.feats || {};

    for (const v of ML_VARIANTS) {
      let shrink = v.shrinkLeague;
      if (v.minAbsDev != null && absDev < v.minAbsDev) shrink = 0;
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
      const cand = {
        gameId: row.gameId,
        matchup: `${row.g.away_team} @ ${row.g.home_team}`,
        odds,
        modelProb,
        edge,
        ev,
        hit,
        hold: row.month,
        pickHome,
        pick: pickHome ? 'home' : 'away',
        absDev,
        muTotal0,
        leagueTotal,
        eloDiff: Number(feats.eloDiff) || 0,
        pitcherRaDiff: Number(feats.pitcherRaDiff) || 0,
        pitcherKnown: Number(feats.pitcherKnown) || 0,
        opponentPitcherKnown: Number(feats.opponentPitcherKnown) || 0,
        pitcherRaRpg: Number(feats.pitcherRaRpg) || 0,
        opponentPitcherRaRpg: Number(feats.opponentPitcherRaRpg) || 0,
        restDiff: Number(feats.restDiff) || 0,
        appliedShrink: shrink,
      };
      if (passMid(cand)) {
        mlBags[v.id].push(cand);
        if (v.id === 'cal_same' || v.id === 'mu_league_025') {
          if (!mlByGame.has(row.gameId)) mlByGame.set(row.gameId, {});
          mlByGame.get(row.gameId)[v.id] = cand;
        }
      }
    }

    if (!row.totals) continue;
    const actualTotal = row.yHomeRuns + row.yAwayRuns;
    const line = row.totals.line;
    const actualPush = actualTotal === line;

    for (const v of TOTALS_VARIANTS) {
      if (v.lineMin != null && line < v.lineMin) continue;
      if (v.lineMax != null && line > v.lineMax) continue;

      const sh = shrinkAsianSideMus(homeMu0, awayMu0, {
        leagueTotal,
        shrinkToLeague: v.shrinkLeague,
      });
      const dist = poissonTotalOverUnderProb(sh.homeMu, sh.awayMu, line);
      let overP = dist.overProb;
      let underP = dist.underProb;
      const absGap = Math.abs(sh.homeMu + sh.awayMu - line);
      if (v.minAbsGap != null && absGap < v.minAbsGap) continue;

      let pickOver = overP >= underP;
      if (v.side === 'under') pickOver = false;
      if (v.side === 'over') pickOver = true;
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
          line,
          absGap,
          push: false,
        });
      }
    }
  }
}

// --- ML summaries ---
const parentMl = summarize(mlBags.cal_same);
const parentByYear = byKey(mlBags.cal_same, (b) => String(b.hold).slice(0, 4));
const mlOut = {};
for (const v of ML_VARIANTS) {
  const overall = summarize(mlBags[v.id]);
  const byYear = byKey(mlBags[v.id], (b) => String(b.hold).slice(0, 4));
  const yd = yearDeltaMap(parentByYear, byYear);
  mlOut[v.id] = {
    overall,
    byYear,
    yearDelta: yd,
    deltaVsParent: overall.usd50 - parentMl.usd50,
    verdict:
      v.id === 'cal_same'
        ? { status: 'parent' }
        : npbShadowPromoteVerdict({ baseline: parentMl, shadow: overall, byYear: yd }),
  };
}

// Sensitivity: drop 2025-04 from both (report only — not a promote path)
const calDrop = summarize(mlBags.cal_same.filter((b) => b.hold !== HURT_FOCUS));
const muDrop = summarize(mlBags.mu_league_025.filter((b) => b.hold !== HURT_FOCUS));
const dropSensitivity = {
  note: '僅報告；禁止以日曆砍倉升格',
  focusMonth: HURT_FOCUS,
  cal_same_withoutFocus: calDrop,
  mu025_withoutFocus: muDrop,
  deltaVsParentWithoutFocus: muDrop.usd50 - calDrop.usd50,
  fullDeltaVsParent: mlOut.mu_league_025.deltaVsParent,
};

// Month compare + divergences in focus month
const parentByMonth = byKey(mlBags.cal_same, (b) => b.hold);
const mu025ByMonth = byKey(mlBags.mu_league_025, (b) => b.hold);
const monthCompare = {};
for (const m of new Set([...Object.keys(parentByMonth), ...Object.keys(mu025ByMonth)])) {
  monthCompare[m] = {
    parent: parentByMonth[m] || { bets: 0, usd50: 0 },
    mu025: mu025ByMonth[m] || { bets: 0, usd50: 0 },
    deltaUsd50: (mu025ByMonth[m]?.usd50 || 0) - (parentByMonth[m]?.usd50 || 0),
  };
}
const hurtMonths = Object.entries(monthCompare)
  .filter(([, v]) => v.deltaUsd50 < 0)
  .sort((a, b) => a[1].deltaUsd50 - b[1].deltaUsd50)
  .map(([m, v]) => ({ month: m, ...v }));

const divergences = [];
for (const [gameId, pair] of mlByGame.entries()) {
  const a = pair.cal_same;
  const b = pair.mu_league_025;
  if (!a && !b) continue;
  if (a && b && a.pick === b.pick) continue;
  const kind = !a ? 'mu025_only' : !b ? 'cal_only' : 'pick_flip';
  const ref = b || a;
  divergences.push({
    gameId,
    month: ref.hold,
    matchup: ref.matchup,
    kind,
    cal: a
      ? { pick: a.pick, odds: a.odds, edge: Number(a.edge.toFixed(4)), hit: a.hit, usd: a.hit ? a.odds - 1 : -1 }
      : null,
    mu025: b
      ? { pick: b.pick, odds: b.odds, edge: Number(b.edge.toFixed(4)), hit: b.hit, usd: b.hit ? b.odds - 1 : -1 }
      : null,
    absDev: Number((ref.absDev || 0).toFixed(3)),
    eloDiff: ref.eloDiff,
    pitcherRaDiff: ref.pitcherRaDiff,
    pitcherKnownBin: pitcherKnownBin(ref.pitcherKnown, ref.opponentPitcherKnown),
  });
}

const focusDiv = divergences.filter((d) => d.month === HURT_FOCUS);
const otherDiv = divergences.filter((d) => d.month !== HURT_FOCUS);

function sliceDiv(list) {
  const bags = {
    elo: {},
    muDev: {},
    pitcher: {},
    kind: {},
  };
  for (const d of list) {
    const ref = d.mu025 || d.cal;
    const push = (bag, key, usd) => {
      if (!bag[key]) bag[key] = { n: 0, unit: 0 };
      bag[key].n += 1;
      bag[key].unit += usd;
    };
    // approximate Δ$ contribution: mu025 pnl - cal pnl on that game
    const calUsd = d.cal ? d.cal.usd * STAKE : 0;
    const muUsd = d.mu025 ? d.mu025.usd * STAKE : 0;
    const delta = muUsd - calUsd;
    push(bags.elo, eloAbsBin(d.eloDiff), delta);
    push(bags.muDev, muDevBin(d.absDev), delta);
    push(bags.pitcher, d.pitcherKnownBin, delta);
    push(bags.kind, d.kind, delta);
  }
  const fmt = (bag) =>
    Object.fromEntries(
      Object.entries(bag)
        .sort((a, b) => a[1].unit - b[1].unit)
        .map(([k, v]) => [
          k,
          { n: v.n, deltaUsd50: Math.round(v.unit), meanDeltaUsd50: v.n ? Math.round(v.unit / v.n) : 0 },
        ])
    );
  return {
    count: list.length,
    byElo: fmt(bags.elo),
    byMuDev: fmt(bags.muDev),
    byPitcher: fmt(bags.pitcher),
    byKind: fmt(bags.kind),
  };
}

/** Same-slot bets in focus month: slice both books by feature */
function sliceBets(bets) {
  return {
    byElo: byKey(bets, (b) => eloAbsBin(b.eloDiff)),
    byMuDev: byKey(bets, (b) => muDevBin(b.absDev)),
    byOdds: byKey(bets, (b) => oddsBand(b.odds)),
    byEdge: byKey(bets, (b) => edgeBin(b.edge)),
    byPitcher: byKey(bets, (b) => pitcherKnownBin(b.pitcherKnown, b.opponentPitcherKnown)),
  };
}

const focusCal = mlBags.cal_same.filter((b) => b.hold === HURT_FOCUS);
const focusMu = mlBags.mu_league_025.filter((b) => b.hold === HURT_FOCUS);
const focusSlice = {
  month: HURT_FOCUS,
  cal: { overall: summarize(focusCal), slices: sliceBets(focusCal) },
  mu025: { overall: summarize(focusMu), slices: sliceBets(focusMu) },
  deltaUsd50: summarize(focusMu).usd50 - summarize(focusCal).usd50,
  meanAbsDevCal: mean(focusCal.map((b) => b.absDev)),
  meanAbsDevMu: mean(focusMu.map((b) => b.absDev)),
};

// Structural gate candidate: best conditional shrink by Δ$ + verdict
const conditionalRanked = ML_VARIANTS.filter((v) => v.minAbsDev != null)
  .map((v) => ({
    id: v.id,
    minAbsDev: v.minAbsDev,
    deltaUsd50: mlOut[v.id].deltaVsParent,
    bets: mlOut[v.id].overall.bets,
    status: mlOut[v.id].verdict.status,
    yearDelta: mlOut[v.id].yearDelta,
  }))
  .sort((a, b) => b.deltaUsd50 - a.deltaUsd50);

const qualifyImprove =
  conditionalRanked.find(
    (x) =>
      x.status === 'candidate_discuss_only' &&
      x.deltaUsd50 >= 50 &&
      !(Number(x.yearDelta?.['2025']?.deltaUsd50) < NPB_RESEARCH_SHADOW_SPEC.observation.yearDeltaFloorUsd50)
  ) || null;

// Does focus hurt look structural? Compare divergence slice concentration
const focusDivSlice = sliceDiv(focusDiv);
const otherDivSlice = sliceDiv(otherDiv);
const focusHurtLooksStructural = (() => {
  // Structural if one feature bin holds majority of negative Δ$ from divergences
  const bins = [
    ...Object.entries(focusDivSlice.byElo || {}),
    ...Object.entries(focusDivSlice.byMuDev || {}),
    ...Object.entries(focusDivSlice.byPitcher || {}),
  ];
  if (!focusDiv.length) return false;
  const totalNeg = bins.filter(([, v]) => v.deltaUsd50 < 0).reduce((s, [, v]) => s + Math.abs(v.deltaUsd50), 0);
  if (totalNeg < 30) return false;
  const maxShare = Math.max(
    0,
    ...bins.filter(([, v]) => v.deltaUsd50 < 0).map(([, v]) => Math.abs(v.deltaUsd50) / totalNeg)
  );
  return maxShare >= 0.55 && focusDiv.length >= 3;
})();

// --- Totals ---
const totParent = summarize(totBags.poisson_mu025_mid);
const totParentByYear = byKey(totBags.poisson_mu025_mid, (b) => String(b.hold).slice(0, 4));
const totOut = {};
for (const v of TOTALS_VARIANTS) {
  const overall = summarize(totBags[v.id]);
  const byYear = byKey(totBags[v.id], (b) => String(b.hold).slice(0, 4));
  const bySide = byKey(totBags[v.id], (b) => b.side || 'na');
  const byAbsGap = byKey(totBags[v.id], (b) => absGapBin(b.absGap));
  const byLine = byKey(totBags[v.id], (b) => lineBin(b.line));
  const yd = yearDeltaMap(totParentByYear, byYear);
  const underN = bySide.under?.bets || 0;
  const thinUnder = underN > 0 && underN < UNDER_THIN_MIN;
  totOut[v.id] = {
    overall,
    byYear,
    bySide,
    byAbsGap,
    byLine,
    yearDelta: yd,
    deltaVsSavedTotals: overall.usd50 - totParent.usd50,
    thinUnder,
    verdict:
      v.id === 'poisson_mu025_mid'
        ? { status: 'saved_totals_parent' }
        : thinUnder
          ? {
              status: 'thin_under_leg',
              promote: false,
              wiredToFormal: false,
              reason: `under 腿 ${underN} < ${UNDER_THIN_MIN}；禁止升格`,
              deltaUsd50: overall.usd50 - totParent.usd50,
            }
          : npbShadowPromoteVerdict({
              baseline: totParent,
              shadow: overall,
              byYear: yd,
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
    thinUnder: v.thinUnder,
  }));

const bestTot = totRanked.find(
  (x) => x.status === 'candidate_discuss_only' && x.deltaUsd50 > 0 && !x.thinUnder
);

const midBySide = totOut.poisson_mu025_mid.bySide;
const edge03 = totOut.poisson_mu025_edge03;

const mlKeep =
  !qualifyImprove && !focusHurtLooksStructural
    ? 'keep cal_same; mu_league_025 still marginal (2025-04 looks single-month noise)'
    : qualifyImprove
      ? `discuss conditional ${qualifyImprove.id} (Δ$${qualifyImprove.deltaUsd50}); still research_only`
      : 'keep cal_same; focus hurt may have structure but no qualifyImprove ≥+$50 — see divergence slices';

const decision = {
  mlKeep,
  mlQualifyImproveId: qualifyImprove?.id || null,
  focusHurtLooksStructural,
  totalsCandidate: bestTot?.id || null,
  totalsKeepSaved: !bestTot,
  edge03VsMid: edge03.deltaVsSavedTotals,
  doNotPromote: true,
  note: '不燒 Odds；不改 NPB_primary；日曆砍倉敏感度僅報告',
};

const out = {
  researchOnly: true,
  wiredToFormal: false,
  openedAt: '2026-08-05',
  parentMl: 'ridge_poisson_cal_same',
  savedImprove: 'ridge_cal_mu_league_025',
  savedTotals: 'totals_poisson_mu025_mid',
  moneyline: mlOut,
  dropSensitivity,
  mu025MonthDiag: {
    hurtMonths: hurtMonths.slice(0, 12),
    helpMonths: Object.entries(monthCompare)
      .filter(([, v]) => v.deltaUsd50 > 0)
      .sort((a, b) => b[1].deltaUsd50 - a[1].deltaUsd50)
      .slice(0, 8)
      .map(([m, v]) => ({ month: m, ...v })),
  },
  focusApril2025: {
    ...focusSlice,
    divergences: {
      focusCount: focusDiv.length,
      otherCount: otherDiv.length,
      focusSample: focusDiv.slice(0, 20),
      focusSlices: focusDivSlice,
      otherSlices: otherDivSlice,
    },
  },
  conditionalShrinkRanking: conditionalRanked,
  totals: totOut,
  totalsRanking: totRanked,
  totalsAsymmetry: {
    midBySide,
    edge03BySide: edge03.bySide,
    underLegsMid: midBySide.under?.bets || 0,
    underLegsEdge03: edge03.bySide?.under?.bets || 0,
    coverageNote: '仍幾乎僅 2026；under 腿過少則 thin',
  },
  decision,
};

const outPath = new URL('../tmp-npb-shadow-opt-round4.json', import.meta.url);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(
  JSON.stringify(
    {
      mlDeltas: Object.fromEntries(
        Object.entries(mlOut).map(([k, v]) => [
          k,
          { ...v.overall, delta: v.deltaVsParent, status: v.verdict.status },
        ])
      ),
      dropSensitivity: {
        deltaWithoutFocus: dropSensitivity.deltaVsParentWithoutFocus,
        fullDelta: dropSensitivity.fullDeltaVsParent,
      },
      hurtMonths: hurtMonths.slice(0, 6),
      focusApril: {
        deltaUsd50: focusSlice.deltaUsd50,
        divCount: focusDiv.length,
        structural: focusHurtLooksStructural,
      },
      conditionalRanked,
      totalsRanking: totRanked.slice(0, 8),
      totalsAsymmetry: out.totalsAsymmetry,
      decision,
    },
    null,
    2
  )
);
console.log('wrote tmp-npb-shadow-opt-round4.json');
