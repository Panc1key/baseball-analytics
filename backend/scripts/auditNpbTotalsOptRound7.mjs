/**
 * NPB 大小 Round7：拆 2026-06 gap-cap Hurt（不砍月、不補 Odds、不升正式）
 *
 * 刀口：
 * - 對 edge03_over + maxAbsGap 在 6 月做線／盤口／absGap／signedGap／EV 切片
 * - 對照非 6 月同切片是否同向有毒
 * - 試結構保護閘（非 drop 2026-06），看 Δ$／月符號
 *
 * 用法: node scripts/auditNpbTotalsOptRound7.mjs
 * 產物: tmp-npb-totals-opt-round7.json
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
const FOCUS_JUNE = '2026-06';

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

function lineBin(line) {
  const L = Number(line);
  if (L <= 7.5) return 'line_le7.5';
  if (L <= 8.5) return 'line_8_85';
  if (L <= 9.5) return 'line_9_95';
  return 'line_ge10';
}

function oddsBin(odds) {
  const o = Number(odds);
  if (o < 1.85) return 'odds_170_185';
  if (o < 2.0) return 'odds_185_200';
  return 'odds_200_220';
}

function absGapBin(gap) {
  const a = Math.abs(Number(gap) || 0);
  if (a < 0.5) return 'absGap_lt0.5';
  if (a < 1.0) return 'absGap_0.5_1.0';
  if (a < 1.25) return 'absGap_1.0_1.25';
  if (a < 1.5) return 'absGap_1.25_1.5';
  return 'absGap_ge1.5';
}

function signedGapBin(sg) {
  const v = Number(sg) || 0;
  if (v <= -1.0) return 'mu_below_line_ge1';
  if (v < -0.5) return 'mu_below_line_0.5_1';
  if (v < 0) return 'mu_below_line_lt0.5';
  if (v < 0.5) return 'mu_above_line_lt0.5';
  if (v < 1.0) return 'mu_above_line_0.5_1';
  return 'mu_above_line_ge1';
}

function evBin(ev) {
  const e = Number(ev) || 0;
  if (e < 0.04) return 'ev_03_04';
  if (e < 0.06) return 'ev_04_06';
  if (e < 0.10) return 'ev_06_10';
  return 'ev_ge10';
}

function slicePack(bets) {
  return {
    overall: summarize(bets),
    byLine: byKey(bets, (b) => lineBin(b.line)),
    byOdds: byKey(bets, (b) => oddsBin(b.odds)),
    byAbsGap: byKey(bets, (b) => absGapBin(b.absGap)),
    bySignedGap: byKey(bets, (b) => signedGapBin(b.signedGap)),
    byEv: byKey(bets, (b) => evBin(b.ev)),
    bySide: byKey(bets, (b) => b.side),
    byHit: byKey(bets, (b) => (b.hit ? 'hit' : 'miss')),
  };
}

function compareSliceMaps(juneMap, otherMap) {
  const keys = [...new Set([...Object.keys(juneMap || {}), ...Object.keys(otherMap || {})])].sort();
  const rows = [];
  for (const k of keys) {
    const j = juneMap[k] || { bets: 0, usd50: 0, hitRate: null, roi: null };
    const o = otherMap[k] || { bets: 0, usd50: 0, hitRate: null, roi: null };
    rows.push({
      slice: k,
      juneBets: j.bets,
      juneUsd: j.usd50,
      juneHit: j.hitRate,
      otherBets: o.bets,
      otherUsd: o.usd50,
      otherHit: o.hitRate,
      juneToxic:
        j.bets >= 8 &&
        j.usd50 <= -80 &&
        (o.bets < 8 || o.usd50 >= -40 || (o.roi != null && o.roi > (j.roi ?? -1) + 0.05)),
      bothToxic: j.bets >= 8 && o.bets >= 8 && j.usd50 < 0 && o.usd50 < 0,
    });
  }
  return rows.sort((a, b) => a.juneUsd - b.juneUsd);
}

const BASE_VARIANTS = [
  { id: PARENT_ID, shrinkLeague: 0.25, side: 'both', minEdge: 0.02, minEv: 0.02 },
  {
    id: 'poisson_mu025_edge03_over',
    shrinkLeague: 0.25,
    side: 'over',
    minEdge: 0.03,
    minEv: 0.03,
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
    id: 'edge03_maxAbsGap_lt15',
    shrinkLeague: 0.25,
    side: 'both',
    minEdge: 0.03,
    minEv: 0.03,
    maxAbsGap: 1.5,
  },
];

console.log('[round7] labeling…');
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

const totBags = Object.fromEntries(BASE_VARIANTS.map((v) => [v.id, []]));
const holdMonths = months.filter((m) => !warmup.has(m));

console.log('[round7] walk-forward…', { months: months.length, holds: holdMonths.length });
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

    for (const v of BASE_VARIANTS) {
      const sh = shrinkAsianSideMus(homeMu0, awayMu0, {
        leagueTotal,
        shrinkToLeague: v.shrinkLeague,
      });
      const muSum = sh.homeMu + sh.awayMu;
      const dist = poissonTotalOverUnderProb(sh.homeMu, sh.awayMu, line);
      const overP = dist.overProb;
      const underP = dist.underProb;
      const signedGap = muSum - line;
      const absGap = Math.abs(signedGap);
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
          fair,
          modelProb,
          edge,
          ev,
          hit,
          hold: row.month,
          day: row.day,
          side: pickOver ? 'over' : 'under',
          line,
          absGap,
          signedGap,
          muSum,
          actualTotal,
          missBy: pickOver ? line - actualTotal : actualTotal - line,
        });
      }
    }
  }
}

const parent = summarize(totBags[PARENT_ID]);
const focusId = 'edge03_over_maxAbsGap_lt15';
const focusBets = totBags[focusId] || [];
const juneBets = focusBets.filter((b) => b.hold === FOCUS_JUNE);
const otherBets = focusBets.filter((b) => b.hold !== FOCUS_JUNE);

const junePack = slicePack(juneBets);
const otherPack = slicePack(otherBets);
const focusPack = slicePack(focusBets);

const toxicCompare = {
  byLine: compareSliceMaps(junePack.byLine, otherPack.byLine),
  byOdds: compareSliceMaps(junePack.byOdds, otherPack.byOdds),
  byAbsGap: compareSliceMaps(junePack.byAbsGap, otherPack.byAbsGap),
  bySignedGap: compareSliceMaps(junePack.bySignedGap, otherPack.bySignedGap),
  byEv: compareSliceMaps(junePack.byEv, otherPack.byEv),
};

const juneMisses = [...juneBets]
  .filter((b) => !b.hit)
  .sort((a, b) => (b.ev || 0) - (a.ev || 0))
  .slice(0, 25)
  .map((b) => ({
    day: b.day,
    line: b.line,
    odds: Number(b.odds.toFixed(3)),
    ev: Number(b.ev.toFixed(4)),
    absGap: Number(b.absGap.toFixed(3)),
    signedGap: Number(b.signedGap.toFixed(3)),
    muSum: Number(b.muSum.toFixed(3)),
    actualTotal: b.actualTotal,
    missBy: Number(b.missBy.toFixed(1)),
  }));

// Structural protective filters hypothesized from toxic June slices (applied to ALL months)
const PROTECT = [
  {
    id: 'drop_line_le75',
    note: '砍低線 ≤7.5',
    pass: (b) => Number(b.line) > 7.5,
  },
  {
    id: 'drop_line_ge10',
    note: '砍高線 ≥10',
    pass: (b) => Number(b.line) < 10,
  },
  {
    id: 'drop_odds_170_185',
    note: '砍短賠 1.70–1.85',
    pass: (b) => Number(b.odds) >= 1.85,
  },
  {
    id: 'drop_odds_185_200',
    note: '砍中賠 1.85–2.00（雙月有毒候選）',
    pass: (b) => !(Number(b.odds) >= 1.85 && Number(b.odds) < 2.0),
  },
  {
    id: 'keep_odds_200_220',
    note: '只打長賠 2.00–2.20',
    pass: (b) => Number(b.odds) >= 2.0,
  },
  {
    id: 'drop_absGap_05_10',
    note: '砍 absGap∈[0.5,1.0)（6 月主毒帶）',
    pass: (b) => !(Number(b.absGap) >= 0.5 && Number(b.absGap) < 1.0),
  },
  {
    id: 'drop_mu_above_05_1',
    note: '砍 μ−line ∈[0.5,1.0)',
    pass: (b) => !(Number(b.signedGap) >= 0.5 && Number(b.signedGap) < 1.0),
  },
  {
    id: 'drop_mu_above_ge1',
    note: '砍 μ−line ≥1（過度看大）',
    pass: (b) => Number(b.signedGap) < 1.0,
  },
  {
    id: 'drop_mu_above_ge05',
    note: '砍 μ−line ≥0.5',
    pass: (b) => Number(b.signedGap) < 0.5,
  },
  {
    id: 'keep_mu_below_only',
    note: '只打 μ < line 的 Over（逆勢 Over）',
    pass: (b) => Number(b.signedGap) < 0,
  },
  {
    id: 'drop_ev_ge10',
    note: '砍超高 EV≥10%',
    pass: (b) => Number(b.ev) < 0.1,
  },
  {
    id: 'drop_absGap_1_125',
    note: '砍 absGap∈[1.0,1.25)（若 6 月毒帶）',
    pass: (b) => !(Number(b.absGap) >= 1.0 && Number(b.absGap) < 1.25),
  },
  {
    id: 'line_8_95_only',
    note: '只打 8–9.5 線',
    pass: (b) => Number(b.line) >= 8 && Number(b.line) <= 9.5,
  },
  {
    id: 'odds_185_220_mu_lt1',
    note: '短賠砍 + μ−line <1',
    pass: (b) => Number(b.odds) >= 1.85 && Number(b.signedGap) < 1.0,
  },
];

function evalProtect(baseBets, protect) {
  const kept = baseBets.filter(protect.pass);
  const overall = summarize(kept);
  const byMonth = byKey(kept, (b) => b.hold);
  const base = summarize(baseBets);
  const baseByMonth = byKey(baseBets, (b) => b.hold);
  const monthDelta = {};
  for (const m of new Set([...Object.keys(baseByMonth), ...Object.keys(byMonth)])) {
    monthDelta[m] = {
      baseUsd: baseByMonth[m]?.usd50 || 0,
      protectUsd: byMonth[m]?.usd50 || 0,
      deltaUsd: (byMonth[m]?.usd50 || 0) - (baseByMonth[m]?.usd50 || 0),
      bets: byMonth[m]?.bets || 0,
    };
  }
  const juneDelta = monthDelta[FOCUS_JUNE]?.deltaUsd ?? 0;
  const otherDelta = Object.entries(monthDelta)
    .filter(([m]) => m !== FOCUS_JUNE)
    .reduce((s, [, x]) => s + x.deltaUsd, 0);
  const negOther = Object.entries(monthDelta).filter(
    ([m, x]) => m !== FOCUS_JUNE && x.deltaUsd < 0
  ).length;
  return {
    id: protect.id,
    note: protect.note,
    overall,
    byMonth,
    deltaVsFocusBaseUsd50: overall.usd50 - base.usd50,
    juneDeltaUsd50: juneDelta,
    otherMonthsDeltaUsd50: otherDelta,
    otherNegMonthCount: negOther,
    looksStructural:
      juneDelta > 50 && otherDelta >= -80 && overall.usd50 > base.usd50 && kept.length >= 80,
    looksJuneCherryPick: juneDelta > 80 && otherDelta < -100,
  };
}

const protectOnFocus = PROTECT.map((p) => evalProtect(focusBets, p)).sort(
  (a, b) => b.deltaVsFocusBaseUsd50 - a.deltaVsFocusBaseUsd50
);

// Also try protect on edge03_maxAbsGap_lt15 + topk3 (round6 stable discuss)
const bothGap = totBags.edge03_maxAbsGap_lt15 || [];
const bothGapTop3 = dailyTopK(bothGap, 3);
const protectOnBothTop3 = PROTECT.map((p) => {
  const kept = bothGapTop3.filter(p.pass);
  return {
    id: p.id,
    note: p.note,
    overall: summarize(kept),
    byMonth: byKey(kept, (b) => b.hold),
    deltaVsTop3Usd50: summarize(kept).usd50 - summarize(bothGapTop3).usd50,
  };
}).sort((a, b) => b.deltaVsTop3Usd50 - a.deltaVsTop3Usd50);

const baseSummaries = {};
for (const v of BASE_VARIANTS) {
  const bets = totBags[v.id];
  baseSummaries[v.id] = {
    overall: summarize(bets),
    byMonth: byKey(bets, (b) => b.hold),
    june: summarize(bets.filter((b) => b.hold === FOCUS_JUNE)),
  };
}

const structural = protectOnFocus.filter((x) => x.looksStructural);
const cherry = protectOnFocus.filter((x) => x.looksJuneCherryPick);
const bestProtect = structural[0] || null;

const decision = {
  doNotPromoteFormal: true,
  noOddsBackfill: true,
  noDropJuneMonth: true,
  focusVariant: focusId,
  juneFocus: {
    ...junePack.overall,
    vsOtherUsd: junePack.overall.usd50 - otherPack.overall.usd50,
  },
  toxicJuneOnlySlices: Object.fromEntries(
    Object.entries(toxicCompare).map(([dim, rows]) => [
      dim,
      rows.filter((r) => r.juneToxic).map((r) => ({
        slice: r.slice,
        juneBets: r.juneBets,
        juneUsd: r.juneUsd,
        otherBets: r.otherBets,
        otherUsd: r.otherUsd,
      })),
    ])
  ),
  bothToxicSlices: Object.fromEntries(
    Object.entries(toxicCompare).map(([dim, rows]) => [
      dim,
      rows.filter((r) => r.bothToxic).map((r) => ({
        slice: r.slice,
        juneUsd: r.juneUsd,
        otherUsd: r.otherUsd,
        juneBets: r.juneBets,
        otherBets: r.otherBets,
      })),
    ])
  ),
  bestStructuralProtect: bestProtect
    ? {
        id: bestProtect.id,
        note: bestProtect.note,
        usd50: bestProtect.overall.usd50,
        deltaVsFocus: bestProtect.deltaVsFocusBaseUsd50,
        juneDelta: bestProtect.juneDeltaUsd50,
        otherDelta: bestProtect.otherMonthsDeltaUsd50,
      }
    : null,
  cherryPickProtectIds: cherry.map((c) => c.id),
  note: bestProtect
    ? `可討論結構保護：${bestProtect.id}（Δ$${bestProtect.deltaVsFocusBaseUsd50} vs focus；6 月 +$${bestProtect.juneDeltaUsd50}）；仍 research_only`
    : cherry.length
      ? `保護閘多為 6 月 cherry-pick（例：${cherry.map((c) => c.id).join(', ')}）；不存主檔、不升格`
      : '未找到穩定結構保護；維持 round6 gap-cap／TopK3 觀察',
};

const out = {
  researchOnly: true,
  wiredToFormal: false,
  openedAt: '2026-08-06',
  audit: 'scripts/auditNpbTotalsOptRound7.mjs',
  stakeUsd: STAKE,
  parent,
  baseSummaries,
  focus: {
    id: focusId,
    overall: focusPack.overall,
    june: junePack,
    otherMonths: otherPack,
    toxicCompare,
    juneMissesTop25: juneMisses,
  },
  protectOnFocus,
  protectOnBothTop3,
  bothGapTop3: {
    overall: summarize(bothGapTop3),
    byMonth: byKey(bothGapTop3, (b) => b.hold),
  },
  decision,
};

fs.writeFileSync('tmp-npb-totals-opt-round7.json', JSON.stringify(out, null, 2));
console.log(
  JSON.stringify(
    {
      decision,
      protectTop5: protectOnFocus.slice(0, 5).map((p) => ({
        id: p.id,
        usd: p.overall.usd50,
        d: p.deltaVsFocusBaseUsd50,
        juneD: p.juneDeltaUsd50,
        otherD: p.otherMonthsDeltaUsd50,
        structural: p.looksStructural,
        cherry: p.looksJuneCherryPick,
      })),
      toxicJune: decision.toxicJuneOnlySlices,
    },
    null,
    2
  )
);
console.log('[round7] wrote tmp-npb-totals-opt-round7.json');
