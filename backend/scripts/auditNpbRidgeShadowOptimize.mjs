/**
 * NPB 已保存影子優化輪（研究）
 * parent = ridge_poisson_cal_same
 * 變體：去先發／先發核／更強 ridge／μ→聯賽總分收縮／有盤時 μ→市場線
 *
 * 用法: node scripts/auditNpbRidgeShadowOptimize.mjs
 * 產物: tmp-npb-ridge-shadow-optimize.json
 */
import fs from 'fs';
import { createWalkForwardElo } from '../src/services/BaseballElo.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import {
  ASIAN_FOUNDATION_FEATURE_KEYS,
  loadAsianCompletedGames,
} from '../src/services/AsianOpeningFoundation.js';
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
import { NPB_RESEARCH_SHADOW_SPEC, npbShadowPromoteVerdict } from '../src/services/AsianNpbResearchShadow.js';

const STAKE = NPB_RESEARCH_SHADOW_SPEC.stakeUsd;
const LEAGUE = 'NPB';
const GATE = NPB_RESEARCH_SHADOW_SPEC.gates.mid;
const CAL = {
  shrink: NPB_RESEARCH_SHADOW_SPEC.savedPrimaryShadow.shrink,
  temp: NPB_RESEARCH_SHADOW_SPEC.savedPrimaryShadow.temp,
};

const ALL_KEYS = [...ASIAN_FOUNDATION_FEATURE_KEYS];
const NO_PITCHER_KEYS = ALL_KEYS.filter((k) => !/pitcher/i.test(k));
const PITCHER_CORE_KEYS = [
  'isHome',
  'seasonRpg',
  'opponentSeasonRpg',
  'seasonRaRpg',
  'opponentSeasonRaRpg',
  'runDiffPerGame',
  'opponentRunDiffPerGame',
  'recentRpg',
  'opponentRecentRpg',
  'recentRaRpg',
  'opponentRecentRaRpg',
  'eloDiff',
  'eloStrength',
  'restDiff',
  ...ALL_KEYS.filter((k) => /pitcher/i.test(k)),
];

const VARIANTS = [
  { id: 'cal_same_full', featureKeys: ALL_KEYS, ridge: 1e-2, shrinkLeague: 0, shrinkMarket: 0 },
  { id: 'cal_no_pitcher', featureKeys: NO_PITCHER_KEYS, ridge: 1e-2, shrinkLeague: 0, shrinkMarket: 0 },
  { id: 'cal_pitcher_core', featureKeys: PITCHER_CORE_KEYS, ridge: 1e-2, shrinkLeague: 0, shrinkMarket: 0 },
  { id: 'cal_ridge_strong', featureKeys: ALL_KEYS, ridge: 0.1, shrinkLeague: 0, shrinkMarket: 0 },
  { id: 'cal_mu_league_025', featureKeys: ALL_KEYS, ridge: 1e-2, shrinkLeague: 0.25, shrinkMarket: 0 },
  { id: 'cal_mu_league_040', featureKeys: ALL_KEYS, ridge: 1e-2, shrinkLeague: 0.4, shrinkMarket: 0 },
  { id: 'cal_mu_mkt_035', featureKeys: ALL_KEYS, ridge: 1e-2, shrinkLeague: 0.15, shrinkMarket: 0.35 },
  {
    id: 'cal_pitcher_core_mu_league_025',
    featureKeys: PITCHER_CORE_KEYS,
    ridge: 1e-2,
    shrinkLeague: 0.25,
    shrinkMarket: 0,
  },
];

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
  if (!bets.length) return { bets: 0, hitRate: null, roi: null, usd50: 0 };
  let unit = 0;
  let hits = 0;
  for (const b of bets) {
    if (b.push) continue;
    if (b.hit) {
      hits += 1;
      unit += b.odds - 1;
    } else unit -= 1;
  }
  const decided = bets.filter((b) => !b.push).length;
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

function passGate(cand) {
  if (cand.odds < GATE.minOdds || cand.odds > GATE.maxOdds) return false;
  if (cand.modelProb < GATE.minProb) return false;
  if (cand.edge < GATE.minEdge) return false;
  if (cand.ev < GATE.minEv) return false;
  return true;
}

function toCand(pHome, row) {
  const pickHome = pHome >= 0.5;
  const modelProb = pickHome ? pHome : 1 - pHome;
  const odds = pickHome ? row.mkt.homeOdds : row.mkt.awayOdds;
  const fair = pickHome ? row.mkt.fairHome : row.mkt.fairAway;
  const edge = modelProb - fair;
  const ev = modelProb * (odds - 1) - (1 - modelProb);
  const hit = pickHome === (row.yWin === 1);
  return { odds, modelProb, edge, ev, hit, hold: row.month };
}

function predictSide(ridge, x) {
  if (!ridge?.ok) return 4.2;
  let y = ridge.intercept;
  for (let i = 0; i < ridge.featureKeys.length; i += 1) {
    const k = ridge.featureKeys[i];
    const fullIdx = ridge.featureIndexInFull?.[i] ?? ALL_KEYS.indexOf(k);
    const raw = Number(x[fullIdx]) || 0;
    y += (ridge.weights[k] || 0) * ((raw - ridge.means[i]) / ridge.scales[i]);
  }
  return Math.max(1.5, Math.min(9.5, y));
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

const bags = Object.fromEntries(VARIANTS.map((v) => [v.id, []]));
const maeBags = Object.fromEntries(VARIANTS.map((v) => [v.id, []]));
const totalsBags = Object.fromEntries(VARIANTS.map((v) => [v.id, []]));

for (const hold of months.filter((m) => !warmup.has(m))) {
  const trainRows = labeled.filter((r) => r.month < hold && r.ready);
  const leagueTotal =
    trainRows.length > 0
      ? trainRows.reduce((s, r) => s + r.yHomeRuns + r.yAwayRuns, 0) / trainRows.length
      : 8.2;

  const models = {};
  for (const v of VARIANTS) {
    models[v.id] = trainAsianRunsLinear(
      trainRows.flatMap((r) => [
        { x: r.xHome, y: r.yHomeRuns },
        { x: r.xAway, y: r.yAwayRuns },
      ]),
      { ridge: v.ridge, featureKeys: v.featureKeys }
    );
  }

  for (const row of labeled) {
    if (row.month !== hold || !row.ready || !row.mkt) continue;
    const actualTotal = row.yHomeRuns + row.yAwayRuns;

    for (const v of VARIANTS) {
      const ridge = models[v.id];
      if (!ridge?.ok) continue;
      let homeMu = predictSide(ridge, row.xHome);
      let awayMu = predictSide(ridge, row.xAway);
      const shrunk = shrinkAsianSideMus(homeMu, awayMu, {
        leagueTotal,
        shrinkToLeague: v.shrinkLeague,
        marketLine: row.totals?.line ?? null,
        shrinkToMarket: row.totals ? v.shrinkMarket : 0,
      });
      homeMu = shrunk.homeMu;
      awayMu = shrunk.awayMu;
      const predTotal = homeMu + awayMu;
      maeBags[v.id].push(Math.abs(predTotal - actualTotal));

      const rawP = poissonHomeWinProb(homeMu, awayMu).homeWinProb;
      const calP = applyAsianLogisticCalibration(rawP, {
        fromLogit: false,
        shrink: CAL.shrink,
        temp: CAL.temp,
        fairHome: row.mkt.fairHome,
      });
      const cand = toCand(calP, row);
      if (passGate(cand)) bags[v.id].push(cand);

      if (row.totals) {
        const line = row.totals.line;
        const pickOver = predTotal > line;
        const gap = Math.abs(predTotal - line);
        const odds = pickOver ? row.totals.overOdds : row.totals.underOdds;
        const fair = pickOver ? row.totals.fairOver : row.totals.fairUnder;
        const modelProb = Math.min(0.72, 0.5 + gap * 0.08);
        const edge = modelProb - fair;
        const ev = modelProb * (odds - 1) - (1 - modelProb);
        const push = actualTotal === line;
        const hit = !push && pickOver === actualTotal > line;
        if (!push && gap >= 0.35 && odds >= 1.7 && odds <= 2.2 && edge >= 0.02 && ev >= 0.02) {
          totalsBags[v.id].push({ odds, modelProb, edge, ev, hit, hold: row.month, push: false });
        }
      }
    }
  }
}

const parentId = 'cal_same_full';
const parent = summarize(bags[parentId]);
const parentByYear = byYearSummary(bags[parentId]);

const variantsOut = {};
for (const v of VARIANTS) {
  const overall = summarize(bags[v.id]);
  const byYear = byYearSummary(bags[v.id]);
  const yearDelta = {};
  for (const y of new Set([...Object.keys(parentByYear), ...Object.keys(byYear)])) {
    yearDelta[y] = {
      parentUsd50: parentByYear[y]?.usd50 ?? 0,
      shadowUsd50: byYear[y]?.usd50 ?? 0,
      deltaUsd50: (byYear[y]?.usd50 ?? 0) - (parentByYear[y]?.usd50 ?? 0),
    };
  }
  const maeArr = maeBags[v.id];
  const mae =
    maeArr.length > 0
      ? Number((maeArr.reduce((a, b) => a + b, 0) / maeArr.length).toFixed(3))
      : null;
  variantsOut[v.id] = {
    config: {
      nFeatures: v.featureKeys.length,
      ridge: v.ridge,
      shrinkLeague: v.shrinkLeague,
      shrinkMarket: v.shrinkMarket,
    },
    moneyline: overall,
    byYear,
    yearDelta,
    deltaUsd50VsParent: overall.usd50 - parent.usd50,
    maeTotal: mae,
    maeDeltaVsParent:
      mae != null && variantsOut[parentId]?.maeTotal != null
        ? Number((mae - variantsOut[parentId].maeTotal).toFixed(3))
        : null,
    totalsGated: summarize(totalsBags[v.id]),
    verdict:
      v.id === parentId
        ? { status: 'parent_saved_shadow', promote: false, reason: '已保存主影子對照' }
        : npbShadowPromoteVerdict({
            baseline: parent,
            shadow: overall,
            byYear: yearDelta,
          }),
  };
}

// fill maeDelta after parent mae known
const parentMae = variantsOut[parentId].maeTotal;
for (const id of Object.keys(variantsOut)) {
  const mae = variantsOut[id].maeTotal;
  variantsOut[id].maeDeltaVsParent =
    mae != null && parentMae != null ? Number((mae - parentMae).toFixed(3)) : null;
}

const ranked = Object.entries(variantsOut)
  .filter(([id]) => id !== parentId)
  .sort((a, b) => b[1].deltaUsd50VsParent - a[1].deltaUsd50VsParent);

const best = ranked[0] || null;
const bestOk =
  best &&
  best[1].deltaUsd50VsParent > 0 &&
  best[1].verdict.status === 'candidate_discuss_only';

const out = {
  researchOnly: true,
  wiredToFormal: false,
  parentShadow: NPB_RESEARCH_SHADOW_SPEC.savedPrimaryShadow.id,
  parentAlias: parentId,
  note: 'saved cal_same 實際已用 foundation 全特徵（含先發）；本輪做消融＋μ收縮',
  parent: { moneyline: parent, byYear: parentByYear, maeTotal: parentMae },
  variants: variantsOut,
  rankingByDeltaUsd: ranked.map(([id, v]) => ({
    id,
    deltaUsd50: v.deltaUsd50VsParent,
    bets: v.moneyline.bets,
    roi: v.moneyline.roi,
    maeTotal: v.maeTotal,
    maeDelta: v.maeDeltaVsParent,
    status: v.verdict.status,
  })),
  decision: {
    keepSavedParent: !bestOk,
    candidateToSave: bestOk ? best[0] : null,
    reason: bestOk
      ? `${best[0]} 相對已保存影子有正 Δ$ 且分年未踩線；可討論是否另存為下一條影子`
      : '無變體明確勝過已保存 cal_same；維持 savedPrimaryShadow',
  },
};

fs.writeFileSync(
  new URL('../tmp-npb-ridge-shadow-optimize.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify({
  parent: out.parent.moneyline,
  parentMae: out.parent.maeTotal,
  ranking: out.rankingByDeltaUsd,
  decision: out.decision,
  totalsParent: variantsOut[parentId].totalsGated,
}, null, 2));
console.log('wrote tmp-npb-ridge-shadow-optimize.json');
