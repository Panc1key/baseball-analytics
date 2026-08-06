/**
 * NPB 大小 Round8：砍 odds∈[1.85,2.00) 跨變體複驗（不補 Odds、不升正式）
 *
 * 刀口：
 * - 在 mid / edge03 / over / gap-cap / TopK3 上套同賠率閘
 * - 鄰近帶負對照（砍 1.70–1.85、砍 2.00–2.20）防過擬合
 * - 半月／奇偶日穩定性；月度符號；注量門檻
 *
 * 用法: node scripts/auditNpbTotalsOptRound8.mjs
 * 產物: tmp-npb-totals-opt-round8.json
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
const BAND = { min: 1.85, max: 2.0 };

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

function inBand(odds, min, max) {
  const o = Number(odds);
  return o >= min && o < max;
}

function oddsBandKey(odds) {
  const o = Number(odds);
  if (o < 1.85) return 'odds_170_185';
  if (o < 2.0) return 'odds_185_200';
  return 'odds_200_220';
}

function monthSign(byMonth) {
  let pos = 0;
  let neg = 0;
  let flat = 0;
  for (const v of Object.values(byMonth || {})) {
    if (v.usd50 > 0) pos += 1;
    else if (v.usd50 < 0) neg += 1;
    else flat += 1;
  }
  return { pos, neg, flat };
}

function halfSplit(bets) {
  const days = [...new Set(bets.map((b) => b.day))].sort();
  const mid = Math.floor(days.length / 2);
  const firstSet = new Set(days.slice(0, mid));
  const first = bets.filter((b) => firstSet.has(b.day));
  const second = bets.filter((b) => !firstSet.has(b.day));
  return { first: summarize(first), second: summarize(second) };
}

function oddEvenSplit(bets) {
  const odd = bets.filter((b) => {
    const d = Number(String(b.day).slice(-2));
    return d % 2 === 1;
  });
  const even = bets.filter((b) => {
    const d = Number(String(b.day).slice(-2));
    return d % 2 === 0;
  });
  return { odd: summarize(odd), even: summarize(even) };
}

function leaveOneMonth(bets) {
  const months = [...new Set(bets.map((b) => b.hold))].sort();
  const out = {};
  for (const m of months) {
    const kept = bets.filter((b) => b.hold !== m);
    out[m] = {
      droppedMonth: m,
      ...summarize(kept),
      droppedMonthUsd: summarize(bets.filter((b) => b.hold === m)).usd50,
    };
  }
  return out;
}

const BASE_VARIANTS = [
  { id: PARENT_ID, shrinkLeague: 0.25, side: 'both', minEdge: 0.02, minEv: 0.02 },
  {
    id: 'poisson_mu025_edge03',
    shrinkLeague: 0.25,
    side: 'both',
    minEdge: 0.03,
    minEv: 0.03,
  },
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
];

const ODDS_FILTERS = [
  { id: 'none', pass: () => true },
  {
    id: 'drop_odds_185_200',
    pass: (b) => !inBand(b.odds, 1.85, 2.0),
  },
  {
    id: 'drop_odds_170_185',
    pass: (b) => !inBand(b.odds, 1.7, 1.85),
  },
  {
    id: 'drop_odds_200_220',
    pass: (b) => !inBand(b.odds, 2.0, 2.21),
  },
  {
    id: 'keep_odds_200_220',
    pass: (b) => inBand(b.odds, 2.0, 2.21),
  },
];

console.log('[round8] labeling…');
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

console.log('[round8] walk-forward…', { months: months.length, holds: holdMonths.length });
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
      if (v.maxAbsGap != null && absGap >= v.maxAbsGap) continue;

      let pickOver = overP >= underP;
      if (v.side === 'over') pickOver = true;
      if (v.side === 'under') pickOver = false;
      if (v.side === 'over' && underP > overP) continue;
      if (v.side === 'under' && overP > underP) continue;

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
          signedGap,
        });
      }
    }
  }
}

function evalCombo(baseId, bets, filter, topK = null) {
  let pool = bets.filter(filter.pass);
  if (topK) pool = dailyTopK(pool, topK);
  const overall = summarize(pool);
  const byMonth = byKey(pool, (b) => b.hold);
  const byOdds = byKey(bets, (b) => oddsBandKey(b.odds)); // band toxic on raw base
  const baseOverall = summarize(topK ? dailyTopK(bets, topK) : bets);
  const ms = monthSign(byMonth);
  const halves = halfSplit(pool);
  const oe = oddEvenSplit(pool);
  const lom = leaveOneMonth(pool);
  const lomMinUsd = Math.min(...Object.values(lom).map((x) => x.usd50));
  return {
    id: `${baseId}__${filter.id}${topK ? `_topk${topK}` : ''}`,
    baseId,
    filterId: filter.id,
    topK,
    overall,
    byMonth,
    monthSign: ms,
    deltaVsBaseUsd50: overall.usd50 - baseOverall.usd50,
    baseUsd50: baseOverall.usd50,
    baseBets: baseOverall.bets,
    keepRate: baseOverall.bets ? Number((overall.bets / baseOverall.bets).toFixed(3)) : null,
    halfSplit: halves,
    oddEvenSplit: oe,
    leaveOneMonthMinUsd50: lomMinUsd,
    leaveOneMonth: lom,
    bothHalvesPositive: halves.first.usd50 > 0 && halves.second.usd50 > 0,
    bothParityPositive: oe.odd.usd50 > 0 && oe.even.usd50 > 0,
    bandToxicityOnBase: byOdds,
  };
}

const matrix = [];
for (const v of BASE_VARIANTS) {
  const bets = totBags[v.id] || [];
  for (const f of ODDS_FILTERS) {
    matrix.push(evalCombo(v.id, bets, f, null));
    if (v.id === 'edge03_maxAbsGap_lt15' || v.id === 'edge03_over_maxAbsGap_lt15') {
      matrix.push(evalCombo(v.id, bets, f, 3));
    }
  }
}

const drop185Rows = matrix.filter((r) => r.filterId === 'drop_odds_185_200');
const noneRows = matrix.filter((r) => r.filterId === 'none');

function specificityForBase(baseId, topK = null) {
  const rows = matrix.filter((r) => r.baseId === baseId && r.topK === topK);
  const drop185 = rows.find((r) => r.filterId === 'drop_odds_185_200');
  const dropShort = rows.find((r) => r.filterId === 'drop_odds_170_185');
  const dropLong = rows.find((r) => r.filterId === 'drop_odds_200_220');
  if (!drop185) return null;
  return {
    baseId,
    topK,
    drop185Delta: drop185.deltaVsBaseUsd50,
    dropShortDelta: dropShort?.deltaVsBaseUsd50 ?? null,
    dropLongDelta: dropLong?.deltaVsBaseUsd50 ?? null,
    drop185Best:
      drop185.deltaVsBaseUsd50 >
        Math.max(dropShort?.deltaVsBaseUsd50 ?? -1e9, dropLong?.deltaVsBaseUsd50 ?? -1e9) &&
      drop185.deltaVsBaseUsd50 > 0,
    neighborAlsoStrong:
      (dropShort?.deltaVsBaseUsd50 ?? 0) > 200 || (dropLong?.deltaVsBaseUsd50 ?? 0) > 200,
  };
}

const specificity = BASE_VARIANTS.flatMap((v) => {
  const out = [specificityForBase(v.id, null)];
  if (v.id === 'edge03_maxAbsGap_lt15' || v.id === 'edge03_over_maxAbsGap_lt15') {
    out.push(specificityForBase(v.id, 3));
  }
  return out;
}).filter(Boolean);

const passGate = drop185Rows
  .filter(
    (r) =>
      r.deltaVsBaseUsd50 > 0 &&
      r.overall.bets >= 80 &&
      r.monthSign.neg <= r.monthSign.pos &&
      r.bothHalvesPositive &&
      r.leaveOneMonthMinUsd50 > 0
  )
  .sort((a, b) => b.deltaVsBaseUsd50 - a.deltaVsBaseUsd50 || b.overall.usd50 - a.overall.usd50);

const softPass = drop185Rows
  .filter(
    (r) =>
      r.deltaVsBaseUsd50 > 0 &&
      r.overall.bets >= 80 &&
      r.monthSign.neg <= r.monthSign.pos + 1 &&
      (r.bothHalvesPositive || r.bothParityPositive)
  )
  .sort((a, b) => b.deltaVsBaseUsd50 - a.deltaVsBaseUsd50);

const midDrop = drop185Rows.find((r) => r.baseId === PARENT_ID && !r.topK);
const edge03Drop = drop185Rows.find((r) => r.baseId === 'poisson_mu025_edge03' && !r.topK);
const overGapDrop = drop185Rows.find(
  (r) => r.baseId === 'edge03_over_maxAbsGap_lt15' && !r.topK
);
const topkDrop = drop185Rows.find(
  (r) => r.baseId === 'edge03_maxAbsGap_lt15' && r.topK === 3
);

const specificOk = specificity.filter((s) => s.drop185Best && !s.neighborAlsoStrong);
const specificWeak = specificity.filter((s) => s.drop185Delta > 0 && s.neighborAlsoStrong);

const decision = {
  doNotPromoteFormal: true,
  noOddsBackfill: true,
  band: BAND,
  hardPassCount: passGate.length,
  softPassCount: softPass.length,
  hardPassIds: passGate.map((r) => r.id),
  softPassIds: softPass.map((r) => r.id),
  keyTransfer: {
    mid: midDrop
      ? {
          bets: midDrop.overall.bets,
          usd50: midDrop.overall.usd50,
          delta: midDrop.deltaVsBaseUsd50,
          monthSign: midDrop.monthSign,
          halves: midDrop.halfSplit,
          lomMin: midDrop.leaveOneMonthMinUsd50,
        }
      : null,
    edge03: edge03Drop
      ? {
          bets: edge03Drop.overall.bets,
          usd50: edge03Drop.overall.usd50,
          delta: edge03Drop.deltaVsBaseUsd50,
          monthSign: edge03Drop.monthSign,
          halves: edge03Drop.halfSplit,
          lomMin: edge03Drop.leaveOneMonthMinUsd50,
        }
      : null,
    overGap15: overGapDrop
      ? {
          bets: overGapDrop.overall.bets,
          usd50: overGapDrop.overall.usd50,
          delta: overGapDrop.deltaVsBaseUsd50,
          monthSign: overGapDrop.monthSign,
          halves: overGapDrop.halfSplit,
          lomMin: overGapDrop.leaveOneMonthMinUsd50,
        }
      : null,
    edge03Gap15TopK3: topkDrop
      ? {
          bets: topkDrop.overall.bets,
          usd50: topkDrop.overall.usd50,
          delta: topkDrop.deltaVsBaseUsd50,
          monthSign: topkDrop.monthSign,
          halves: topkDrop.halfSplit,
          lomMin: topkDrop.leaveOneMonthMinUsd50,
        }
      : null,
  },
  specificityBestCount: specificOk.length,
  specificityWeakCount: specificWeak.length,
  note:
    passGate.length > 0
      ? `硬門通過 ${passGate.length}：${passGate.map((r) => r.id).join(', ')}；仍 thin-year、不升格`
      : softPass.length > 0
        ? `僅軟門通過（${softPass.map((r) => r.id).join(', ')}）；鄰近帶／半月未全過硬門，維持觀察、不升格`
        : '砍 185–200 未能跨變體穩定通過；降級為弱假設，不升格',
};

const out = {
  researchOnly: true,
  wiredToFormal: false,
  openedAt: '2026-08-06',
  audit: 'scripts/auditNpbTotalsOptRound8.mjs',
  stakeUsd: STAKE,
  band: BAND,
  parentNone: noneRows.find((r) => r.baseId === PARENT_ID),
  matrix: matrix.map((r) => ({
    id: r.id,
    baseId: r.baseId,
    filterId: r.filterId,
    topK: r.topK,
    bets: r.overall.bets,
    hitRate: r.overall.hitRate,
    roi: r.overall.roi,
    usd50: r.overall.usd50,
    deltaVsBaseUsd50: r.deltaVsBaseUsd50,
    keepRate: r.keepRate,
    monthSign: r.monthSign,
    byMonth: r.byMonth,
    halfSplit: r.halfSplit,
    oddEvenSplit: r.oddEvenSplit,
    leaveOneMonthMinUsd50: r.leaveOneMonthMinUsd50,
    bothHalvesPositive: r.bothHalvesPositive,
    bothParityPositive: r.bothParityPositive,
  })),
  drop185Detail: drop185Rows,
  specificity,
  decision,
};

fs.writeFileSync('tmp-npb-totals-opt-round8.json', JSON.stringify(out, null, 2));
console.log(
  JSON.stringify(
    {
      decision,
      drop185Summary: drop185Rows.map((r) => ({
        id: r.id,
        bets: r.overall.bets,
        usd: r.overall.usd50,
        d: r.deltaVsBaseUsd50,
        ms: r.monthSign,
        halves: r.halfSplit,
        lomMin: r.leaveOneMonthMinUsd50,
      })),
      specificity,
    },
    null,
    2
  )
);
console.log('[round8] wrote tmp-npb-totals-opt-round8.json');
