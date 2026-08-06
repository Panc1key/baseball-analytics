/**
 * NPB Round10：效果總覽（正式獨贏 + 大小研究影子）
 * - 刷新 totals 紙上重放／ledger／日更
 * - 重跑正式獨贏 OOS（與日推同口徑 + TopK3）
 * - 產出現況摘要（不升 totals、不補 Odds）
 *
 * 用法: node scripts/auditNpbStatusRound10.mjs
 * 產物: tmp-npb-totals-opt-round10.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
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
import { getNpbPrematchSlate, NPB_FORMAL_PACKAGE } from '../src/services/NpbPrematchRecommend.js';
import {
  NPB_TOTALS_RESEARCH_SHADOW_PACKAGE,
  replayNpbTotalsResearchShadowPaper,
  syncNpbTotalsShadowReplayToDb,
  settleNpbTotalsShadowPaperBets,
  ensureNpbTotalsShadowPaperFills,
  getNpbTotalsShadowPaperLedgerSummary,
  getNpbTotalsResearchShadowSlate,
  npbTotalsShadowPromoteVerdict,
} from '../src/services/NpbTotalsResearchShadow.js';

const STAKE = NPB_FORMAL_PACKAGE.flatStakeUsd;
const LEAGUE = 'NPB';
const GATE = NPB_RESEARCH_SHADOW_SPEC.gates.mid;
const CAL = NPB_FORMAL_PACKAGE.calibrate;
const MIN_DEV = NPB_FORMAL_PACKAGE.minAbsMuDevFromLeague;
const SHRINK_L = NPB_FORMAL_PACKAGE.shrinkToLeague;
const TOP_K = NPB_FORMAL_PACKAGE.dailyTopK || 3;

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
      const fair = removeVig(decimalToImpliedProb(homeOdds), decimalToImpliedProb(awayOdds));
      best = { homeOdds, awayOdds, fairHome: fair.fairA, fairAway: fair.fairB, vig };
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
  const byDay = new Map();
  for (const b of bets) {
    const day = String(b.day);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(b);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    out.push(
      ...[...byDay.get(day)]
        .sort((a, b) => (b.ev || 0) - (a.ev || 0) || (b.edge || 0) - (a.edge || 0))
        .slice(0, k)
    );
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

console.log('[round10] formal ML walk-forward…');
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
    day: String(g.commence_time).slice(0, 10),
    year: String(g.commence_time).slice(0, 4),
    ready: homeEx.ready && awayEx.ready,
    xHome: homeEx.x,
    xAway: awayEx.x,
    yHome: Number(g.home_score),
    yAway: Number(g.away_score),
    h2h: bestH2h(books, g.home_team, g.away_team),
  });
  for (const team of [g.home_team, g.away_team]) {
    if (!priorIndex.has(team)) priorIndex.set(team, []);
    priorIndex.get(team).push(g);
  }
  elo.applyGame(g.home_team, g.away_team, g.home_score, g.away_score);
  appendPitcherHistory(pitcherHist, homeKey, g.commence_time, g.away_score);
  appendPitcherHistory(pitcherHist, awayKey, g.commence_time, g.home_score);
}

const mlBets = [];
for (const hold of months.filter((m) => !warmup.has(m))) {
  const trainRows = labeled.filter((r) => r.month < hold && r.ready);
  const leagueTotal =
    trainRows.length > 0
      ? trainRows.reduce((s, r) => s + r.yHome + r.yAway, 0) / trainRows.length
      : 8.2;
  const ridge = trainAsianRunsLinear(
    trainRows.flatMap((r) => [
      { x: r.xHome, y: r.yHome },
      { x: r.xAway, y: r.yAway },
    ])
  );
  if (!ridge.ok) continue;

  for (const row of labeled) {
    if (row.month !== hold || !row.ready || !row.h2h) continue;
    const homeMu0 = predictSide(ridge, row.xHome);
    const awayMu0 = predictSide(ridge, row.xAway);
    const absDev = Math.abs(homeMu0 + awayMu0 - leagueTotal);
    const shrink =
      Number.isFinite(MIN_DEV) && absDev >= MIN_DEV ? SHRINK_L : 0;
    const sh = shrinkAsianSideMus(homeMu0, awayMu0, {
      leagueTotal,
      shrinkToLeague: shrink,
    });
    const rawP = poissonHomeWinProb(sh.homeMu, sh.awayMu).homeWinProb;
    const pHome = applyAsianLogisticCalibration(rawP, {
      fromLogit: false,
      shrink: CAL.shrink,
      temp: CAL.temp,
      fairHome: row.h2h.fairHome,
    });
    const pickHome = pHome >= 0.5;
    const modelProb = pickHome ? pHome : 1 - pHome;
    const odds = pickHome ? row.h2h.homeOdds : row.h2h.awayOdds;
    const fair = pickHome ? row.h2h.fairHome : row.h2h.fairAway;
    const edge = modelProb - fair;
    const ev = modelProb * (odds - 1) - (1 - modelProb);
    const homeWon = row.yHome > row.yAway;
    const hit = pickHome === homeWon;
    if (passMid({ odds, modelProb, edge, ev })) {
      mlBets.push({
        gameId: row.gameId,
        day: row.day,
        hold: row.month,
        year: row.year,
        odds,
        modelProb,
        edge,
        ev,
        hit,
        pick: pickHome ? 'home' : 'away',
      });
    }
  }
}

const mlUnlimited = summarize(mlBets);
const mlTopK = dailyTopK(mlBets, TOP_K);
const mlFormal = summarize(mlTopK);
const mlByYear = byKey(mlTopK, (b) => b.year);
const mlByMonth2026 = byKey(
  mlTopK.filter((b) => b.year === '2026'),
  (b) => b.hold
);

console.log('[round10] totals shadow refresh…');
const replay = replayNpbTotalsResearchShadowPaper();
const sync = syncNpbTotalsShadowReplayToDb(replay);
const settled = settleNpbTotalsShadowPaperBets();
const fills = ensureNpbTotalsShadowPaperFills();
const ledger = getNpbTotalsShadowPaperLedgerSummary();
const totSlate = getNpbTotalsResearchShadowSlate();
const mlSlate = getNpbPrematchSlate();
const promote = npbTotalsShadowPromoteVerdict({
  replayOverall: replay.overall,
  yearCoverage: { '2026': true },
});

const upcoming = db
  .prepare(
    `SELECT id, commence_time, home_team, away_team
     FROM games
     WHERE league = ?
       AND completed = 0
       AND datetime(commence_time) >= datetime('now')
     ORDER BY datetime(commence_time) ASC
     LIMIT 12`
  )
  .all(LEAGUE);

const decision = {
  doNotPromoteTotalsFormal: true,
  noOddsBackfill: true,
  moneyline: {
    status: 'formal_live',
    refreshedOosTopK3: mlFormal,
    unlimited: mlUnlimited,
    byYear: mlByYear,
    byMonth2026: mlByMonth2026,
    vsPackageNote:
      '相對正式包存檔（TopK3 +$1826／未限 +$1688）：本次重算以本機庫為準',
  },
  totals: {
    status: 'research_paper_shadow',
    overall: replay.overall,
    byMonth: replay.byMonth,
    pace: replay.pace,
    promote,
  },
  liveBoard: {
    upcomingN: upcoming.length,
    mlActionable: mlSlate.dailyTop?.length || 0,
    mlHeld: mlSlate.heldUntilRelease?.length || 0,
    totalsActionable: totSlate.dailyTop?.length || 0,
    totalsHeld: totSlate.heldUntilRelease?.length || 0,
  },
  note:
    mlFormal.usd50 > 0 && replay.overall.usd50 > 0
      ? '獨贏正式 OOS 仍正；大小影子紙上仍正但 thin-year／未達 150，不升格'
      : '請看分項；升格條件未變',
};

const out = {
  researchOnlyTotals: true,
  openedAt: '2026-08-06',
  audit: 'scripts/auditNpbStatusRound10.mjs',
  stakeUsd: STAKE,
  formalScope: NPB_RESEARCH_SHADOW_SPEC.formalScope,
  moneylineFormal: {
    packageId: NPB_FORMAL_PACKAGE.id,
    packageEvidence: NPB_FORMAL_PACKAGE.paperEvidenceUsd50,
    refreshed: {
      unlimited: mlUnlimited,
      topK3: mlFormal,
      byYear: mlByYear,
      byMonth2026: mlByMonth2026,
    },
    live: {
      actionable: (mlSlate.dailyTop || []).map((r) => ({
        matchup: r.matchup,
        pick: r.pick,
        odds: r.odds,
        ev: r.expectedValue,
      })),
      held: mlSlate.heldUntilRelease || [],
    },
  },
  totalsResearch: {
    packageId: NPB_TOTALS_RESEARCH_SHADOW_PACKAGE.id,
    replay: {
      overall: replay.overall,
      byMonth: replay.byMonth,
      pace: replay.pace,
    },
    ledger: {
      rows: ledger.rowCount,
      overall: ledger.overall,
      pending: ledger.pending,
      byMonth: ledger.byMonth,
    },
    db: { sync, settled, fillInserted: fills.inserted },
    live: {
      actionable: totSlate.dailyTop || [],
      held: totSlate.heldUntilRelease || [],
    },
    promote,
  },
  upcoming,
  decision,
};

fs.writeFileSync('tmp-npb-totals-opt-round10.json', JSON.stringify(out, null, 2));
console.log(
  JSON.stringify(
    {
      decision,
      mlTopK3: mlFormal,
      mlByYear,
      ml2026months: mlByMonth2026,
      totals: replay.overall,
      totalsMonths: replay.byMonth,
      pace: replay.pace,
      promote,
      live: decision.liveBoard,
    },
    null,
    2
  )
);
console.log('[round10] wrote tmp-npb-totals-opt-round10.json');
