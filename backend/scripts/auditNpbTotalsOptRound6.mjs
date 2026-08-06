/**
 * NPB 大小 Round6（僅優化 2026 盈利，不補歷史、不燒 Odds、不升正式）
 *
 * 刀口：
 * - 砍 absGap≥1.5 厚邊
 * - edge03 / over-only / gap 甜蜜帶
 * - 日 TopK 2/3
 * - 2026 月擴展 OOS（hold 月，訓練僅更早月）
 *
 * 用法: node scripts/auditNpbTotalsOptRound6.mjs
 * 產物: tmp-npb-totals-opt-round6.json
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
  poissonTotalOverUnderProb,
  shrinkAsianSideMus,
  trainAsianRunsLinear,
  exampleFromGameSide,
} from '../src/services/AsianExpectedRunsLite.js';
import { NPB_RESEARCH_SHADOW_SPEC } from '../src/services/AsianNpbResearchShadow.js';

const STAKE = NPB_RESEARCH_SHADOW_SPEC.stakeUsd;
const LEAGUE = 'NPB';
const PARENT_ID = 'poisson_mu025_mid';

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

function dailyTopK(bets, k) {
  if (!k) return bets;
  const byDay = new Map();
  for (const b of bets) {
    const day = String(b.day || b.hold);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(b);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    out.push(
      ...[...byDay.get(day)]
        .sort((a, b) => (b.ev || 0) - (a.ev || 0) || (b.absGap || 0) - (a.absGap || 0))
        .slice(0, k)
    );
  }
  return out;
}

const TOTALS_VARIANTS = [
  { id: PARENT_ID, shrinkLeague: 0.25, side: 'both', minEdge: 0.02, minEv: 0.02 },
  { id: 'poisson_mu025_edge03', shrinkLeague: 0.25, side: 'both', minEdge: 0.03, minEv: 0.03 },
  {
    id: 'poisson_mu025_edge03_over',
    shrinkLeague: 0.25,
    side: 'over',
    minEdge: 0.03,
    minEv: 0.03,
  },
  {
    id: 'mid_maxAbsGap_lt15',
    shrinkLeague: 0.25,
    side: 'both',
    minEdge: 0.02,
    minEv: 0.02,
    maxAbsGap: 1.5,
  },
  {
    id: 'mid_maxAbsGap_lt125',
    shrinkLeague: 0.25,
    side: 'both',
    minEdge: 0.02,
    minEv: 0.02,
    maxAbsGap: 1.25,
  },
  {
    id: 'edge03_maxAbsGap_lt15',
    shrinkLeague: 0.25,
    side: 'both',
    minEdge: 0.03,
    minEv: 0.03,
    maxAbsGap: 1.5,
  },
  {
    id: 'edge03_over_maxAbsGap_lt15',
    shrinkLeague: 0.25,
    side: 'over',
    minEdge: 0.03,
    minEv: 0.03,
    maxAbsGap: 1.5,
  },
  {
    id: 'edge03_over_maxAbsGap_lt125',
    shrinkLeague: 0.25,
    side: 'over',
    minEdge: 0.03,
    minEv: 0.03,
    maxAbsGap: 1.25,
  },
  {
    id: 'gap_band_10_15',
    shrinkLeague: 0.25,
    side: 'both',
    minEdge: 0.02,
    minEv: 0.02,
    minAbsGap: 1.0,
    maxAbsGap: 1.5,
  },
  {
    id: 'gap_band_10_15_over',
    shrinkLeague: 0.25,
    side: 'over',
    minEdge: 0.03,
    minEv: 0.03,
    minAbsGap: 1.0,
    maxAbsGap: 1.5,
  },
  {
    id: 'edge05_over',
    shrinkLeague: 0.25,
    side: 'over',
    minEdge: 0.05,
    minEv: 0.05,
  },
];

console.log('[round6] labeling…');
const games = loadAsianCompletedGames(LEAGUE);
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
    day: String(g.commence_time).slice(0, 10),
    ready: homeEx.ready && awayEx.ready,
    xHome: homeEx.x,
    xAway: awayEx.x,
    yHomeRuns: Number(g.home_score),
    yAwayRuns: Number(g.away_score),
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

const totBags = Object.fromEntries(TOTALS_VARIANTS.map((v) => [v.id, []]));
const holdMonths = months.filter((m) => !warmup.has(m));

console.log('[round6] walk-forward…', { months: months.length, holds: holdMonths.length });
for (const hold of holdMonths) {
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
    if (row.month !== hold || !row.ready || !row.totals) continue;
    if (!String(hold).startsWith('2026')) continue;

    const homeMu0 = predictSide(ridge, row.xHome);
    const awayMu0 = predictSide(ridge, row.xAway);
    const actualTotal = row.yHomeRuns + row.yAwayRuns;
    const line = row.totals.line;
    const actualPush = actualTotal === line;

    for (const v of TOTALS_VARIANTS) {
      const sh = shrinkAsianSideMus(homeMu0, awayMu0, {
        leagueTotal,
        shrinkToLeague: v.shrinkLeague,
      });
      const dist = poissonTotalOverUnderProb(sh.homeMu, sh.awayMu, line);
      const overP = dist.overProb;
      const underP = dist.underProb;
      const absGap = Math.abs(sh.homeMu + sh.awayMu - line);
      if (v.minAbsGap != null && absGap < v.minAbsGap) continue;
      if (v.maxAbsGap != null && absGap >= v.maxAbsGap) continue;

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
          gameId: row.gameId,
          odds,
          modelProb,
          edge,
          ev,
          hit,
          hold: row.month,
          day: row.day,
          side: pickOver ? 'over' : 'under',
          line,
          absGap,
          push: false,
        });
      }
    }
  }
}

const parent = summarize(totBags[PARENT_ID]);
const parentByMonth = byKey(totBags[PARENT_ID], (b) => b.hold);

const variants = {};
for (const v of TOTALS_VARIANTS) {
  const bets = totBags[v.id];
  const overall = summarize(bets);
  const byMonth = byKey(bets, (b) => b.hold);
  const bySide = byKey(bets, (b) => b.side);
  const monthDelta = {};
  for (const m of new Set([...Object.keys(parentByMonth), ...Object.keys(byMonth)])) {
    monthDelta[m] = {
      parentUsd: parentByMonth[m]?.usd50 || 0,
      shadowUsd: byMonth[m]?.usd50 || 0,
      deltaUsd: (byMonth[m]?.usd50 || 0) - (parentByMonth[m]?.usd50 || 0),
      bets: byMonth[m]?.bets || 0,
    };
  }
  const negMonths = Object.values(monthDelta).filter((x) => x.deltaUsd < 0).length;
  const posMonths = Object.values(monthDelta).filter((x) => x.deltaUsd > 0).length;
  variants[v.id] = {
    overall,
    byMonth,
    bySide,
    deltaVsParentUsd50: overall.usd50 - parent.usd50,
    monthSign: { pos: posMonths, neg: negMonths },
    underBets: bySide.under?.bets || 0,
  };
}

// TopK on best structural candidates
const topKBases = [
  'edge03_maxAbsGap_lt15',
  'edge03_over_maxAbsGap_lt15',
  'edge03_over_maxAbsGap_lt125',
  'gap_band_10_15_over',
  'poisson_mu025_edge03_over',
];
const topKOut = {};
for (const base of topKBases) {
  for (const k of [2, 3]) {
    const id = `${base}_topk${k}`;
    const bets = dailyTopK(totBags[base] || [], k);
    const overall = summarize(bets);
    topKOut[id] = {
      base,
      k,
      overall,
      deltaVsParentUsd50: overall.usd50 - parent.usd50,
      deltaVsBaseUsd50: overall.usd50 - (variants[base]?.overall.usd50 || 0),
      byMonth: byKey(bets, (b) => b.hold),
    };
  }
}

const ranked = [
  ...Object.entries(variants).map(([id, v]) => ({
    id,
    kind: 'gate',
    bets: v.overall.bets,
    hitRate: v.overall.hitRate,
    roi: v.overall.roi,
    usd50: v.overall.usd50,
    deltaUsd50: v.deltaVsParentUsd50,
    monthSign: v.monthSign,
    underBets: v.underBets,
  })),
  ...Object.entries(topKOut).map(([id, v]) => ({
    id,
    kind: 'topk',
    bets: v.overall.bets,
    hitRate: v.overall.hitRate,
    roi: v.overall.roi,
    usd50: v.overall.usd50,
    deltaUsd50: v.deltaVsParentUsd50,
    deltaVsBaseUsd50: v.deltaVsBaseUsd50,
  })),
]
  .filter((x) => x.id !== PARENT_ID)
  .sort((a, b) => b.deltaUsd50 - a.deltaUsd50 || b.usd50 - a.usd50);

const best = ranked[0] || null;
const bestStable = ranked.find(
  (x) =>
    x.deltaUsd50 > 0 &&
    x.bets >= 80 &&
    (x.monthSign ? x.monthSign.neg <= x.monthSign.pos + 1 : true) &&
    (x.underBets == null || x.underBets === 0 || x.underBets >= 40 || x.id.includes('over'))
);

const decision = {
  doNotPromoteFormal: true,
  noOddsBackfill: true,
  evalWindow: '2026 hold months only (walk-forward train on earlier months)',
  parent: { id: PARENT_ID, ...parent },
  bestByDelta: best,
  bestStableDiscuss: bestStable || null,
  note:
    bestStable && bestStable.deltaUsd50 >= 50
      ? `可存影子邊際：${bestStable.id}（Δ$${bestStable.deltaUsd50}）；仍 research_only、不接正式`
      : best && best.deltaUsd50 > 0
        ? `有正 Δ$ 但穩定性／注量不足或過砍：${best.id}；繼續觀察、不升格`
        : '無明確優於 mid 的穩定刀；維持 mid／edge03 影子',
};

const out = {
  researchOnly: true,
  wiredToFormal: false,
  openedAt: '2026-08-06',
  audit: 'scripts/auditNpbTotalsOptRound6.mjs',
  stakeUsd: STAKE,
  parent,
  variants,
  topK: topKOut,
  ranked: ranked.slice(0, 15),
  decision,
};

fs.writeFileSync('tmp-npb-totals-opt-round6.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ decision, top5: ranked.slice(0, 5) }, null, 2));
console.log('[round6] wrote tmp-npb-totals-opt-round6.json');
