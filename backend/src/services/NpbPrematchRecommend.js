/**
 * NPB 正式日推（research → formal）
 * 模型：ridge_mu025_if_dev_ge_15（主影子 cal_same + 條件 μ→league）
 * 閘門：mid（與影子 OOS 同口徑）；開賽前 8h 才放出選邊
 * 不寫 mlb_paper_*；KBO 不接；大小仍 research thin-year 不進主倉
 */
import db from '../db/database.js';
import { config } from '../config.js';
import { createWalkForwardElo } from './BaseballElo.js';
import { resolvePitOdds } from './PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../utils/odds.js';
import { loadAsianCompletedGames } from './AsianOpeningFoundation.js';
import {
  appendPitcherHistory,
  loadAsianStarterSnapshotMap,
  summarizePitcherHistory,
} from './AsianStarterSnapshots.js';
import {
  applyAsianLogisticCalibration,
  exampleFromGameSide,
  poissonHomeWinProb,
  shrinkAsianSideMus,
  trainAsianRunsLinear,
} from './AsianExpectedRunsLite.js';
import { NPB_RESEARCH_SHADOW_SPEC } from './AsianNpbResearchShadow.js';

const LEAGUE = 'NPB';
const GATE = NPB_RESEARCH_SHADOW_SPEC.gates.mid;
const PRIMARY = NPB_RESEARCH_SHADOW_SPEC.savedPrimaryShadow;
const IMPROVE = NPB_RESEARCH_SHADOW_SPEC.savedImproveShadow;

export const NPB_FORMAL_PACKAGE = Object.freeze({
  id: 'npb_formal_mu025_if_dev_ge15_topk3_v2026-08-05',
  label: 'NPB 正式獨贏',
  lockedAt: '2026-08-05',
  wiredToFormal: true,
  modelId: IMPROVE.id,
  parentShadowId: PRIMARY.id,
  head: 'ridge_poisson',
  features: 'foundation_full_with_pitcher',
  calibrate: { shrink: IMPROVE.shrink, temp: IMPROVE.temp },
  shrinkToLeague: IMPROVE.shrinkToLeague,
  minAbsMuDevFromLeague: IMPROVE.minAbsMuDevFromLeague ?? 1.5,
  gate: 'mid',
  flatStakeUsd: NPB_RESEARCH_SHADOW_SPEC.stakeUsd,
  /** Round5：日 TopK=3（OOS Δ$+$138、ROI 優於不限） */
  dailyTopK: 3,
  releaseHoursBefore: Math.max(
    0,
    Number(config.npbFormalReleaseHoursBefore ?? config.mlbLockedBReleaseHoursBefore) || 8
  ),
  paperEvidenceUsd50: Object.freeze({
    ...(IMPROVE.paperEvidenceUsd50 || {}),
    dailyTopK: 3,
    topKNote: 'auditNpbFormalOptRound5：日 TopK=3 → 238 注 ROI 15.3% @$50=+1826（Δ+$138 vs 不限）',
  }),
  note:
    '正式日推：條件 μ→league（|μ−league|≥1.5）；mid gate；日 TopK=3；開賽前放出選邊；大小不進主倉；KBO 仍 pause',
});

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

function passMid(cand) {
  if (cand.odds < GATE.minOdds || cand.odds > GATE.maxOdds) return false;
  if (cand.modelProb < GATE.minProb) return false;
  if (cand.edge < GATE.minEdge) return false;
  if (cand.ev < GATE.minEv) return false;
  return true;
}

function loadUpcomingNpb({ fromIso } = {}) {
  const from = fromIso || new Date().toISOString();
  return db
    .prepare(
      `SELECT id, league, commence_time, home_team, away_team, raw_odds, completed
       FROM games
       WHERE league = ?
         AND completed = 0
         AND datetime(commence_time) >= datetime(?)
       ORDER BY datetime(commence_time) ASC`
    )
    .all(LEAGUE, from);
}

/** 今日（UTC 日界）已開賽、尚未完賽 — 僅狀態提示，不進可下 */
function loadStartedTodayNpb() {
  return db
    .prepare(
      `SELECT id, commence_time, home_team, away_team
       FROM games
       WHERE league = ?
         AND completed = 0
         AND date(commence_time) = date('now')
         AND datetime(commence_time) < datetime('now')
       ORDER BY datetime(commence_time) ASC`
    )
    .all(LEAGUE);
}

function hoursUntil(commenceTime) {
  const t = Date.parse(commenceTime);
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / 3600000;
}

function rejectionReasons(cand) {
  const reasons = [];
  if (!cand) return ['no_candidate'];
  if (!Number.isFinite(cand.odds)) reasons.push('odds_missing');
  else {
    if (cand.odds < GATE.minOdds) reasons.push('pick_odds_below_minimum');
    if (cand.odds > GATE.maxOdds) reasons.push('pick_odds_above_maximum');
  }
  if (cand.modelProb < GATE.minProb) reasons.push('model_probability_below_threshold');
  if (cand.edge < GATE.minEdge) reasons.push('edge_vs_market_below_threshold');
  if (cand.ev < GATE.minEv) reasons.push('expected_value_below_threshold');
  return reasons;
}

const reasonLabels = {
  pick_odds_below_minimum: '賠率低於下限',
  pick_odds_above_maximum: '賠率高於上限',
  model_probability_below_threshold: '模型勝率不足',
  edge_vs_market_below_threshold: '相對市場優勢不足',
  expected_value_below_threshold: 'EV 不足',
  odds_missing: '缺獨贏盤',
  features_not_ready: '特徵未齊',
  no_candidate: '無法評估',
  daily_topk_cut: '日 TopK 未入選',
};

/** @type {{ key: string, ridge: object, leagueTotal: number, builtAt: number } | null} */
let modelCache = null;
const MODEL_TTL_MS = 20 * 60 * 1000;

function buildTrainState() {
  const completed = loadAsianCompletedGames(LEAGUE);
  const cacheKey = `${completed.length}:${completed[completed.length - 1]?.id || 'none'}`;
  if (
    modelCache &&
    modelCache.key === cacheKey &&
    Date.now() - modelCache.builtAt < MODEL_TTL_MS
  ) {
    return modelCache;
  }

  const starterMap = loadAsianStarterSnapshotMap(LEAGUE);
  const priorIndex = new Map();
  const pitcherHist = new Map();
  const elo = createWalkForwardElo(LEAGUE, { seedFromRating: false });
  const trainRows = [];

  for (const g of completed) {
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
    if (homeEx.ready && awayEx.ready) {
      trainRows.push({
        xHome: homeEx.x,
        xAway: awayEx.x,
        yHomeRuns: Number(g.home_score),
        yAwayRuns: Number(g.away_score),
      });
    }
    for (const team of [g.home_team, g.away_team]) {
      if (!priorIndex.has(team)) priorIndex.set(team, []);
      priorIndex.get(team).push(g);
    }
    elo.applyGame(g.home_team, g.away_team, g.home_score, g.away_score);
    appendPitcherHistory(pitcherHist, homeKey, g.commence_time, g.away_score);
    appendPitcherHistory(pitcherHist, awayKey, g.commence_time, g.home_score);
  }

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

  modelCache = {
    key: cacheKey,
    ridge,
    leagueTotal,
    priorIndex,
    pitcherHist,
    elo,
    starterMap,
    trainN: trainRows.length,
    builtAt: Date.now(),
  };
  return modelCache;
}

function scoreUpcomingGame(g, state) {
  const { ridge, leagueTotal, priorIndex, pitcherHist, elo, starterMap } = state;
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
  const ready = homeEx.ready && awayEx.ready;

  let books = null;
  const pit = resolvePitOdds(g.id, g.commence_time);
  if (pit?.bookmakers?.length) books = pit.bookmakers;
  if (!books?.length) {
    try {
      books = JSON.parse(g.raw_odds || '[]');
    } catch {
      books = [];
    }
  }
  const mkt = bestH2h(books, g.home_team, g.away_team);
  const hours = hoursUntil(g.commence_time);
  const releaseH = NPB_FORMAL_PACKAGE.releaseHoursBefore;
  const inReleaseWindow = releaseH <= 0 || (hours != null && hours <= releaseH);

  const base = {
    gameId: g.id,
    matchup: `${g.away_team} @ ${g.home_team}`,
    homeTeam: g.home_team,
    awayTeam: g.away_team,
    commenceTime: g.commence_time,
    hoursUntilCommence: hours != null ? Number(hours.toFixed(2)) : null,
    ready,
    hasOdds: Boolean(mkt),
  };

  if (!ready || !mkt || !ridge?.ok) {
    return {
      ...base,
      passedGate: false,
      inReleaseWindow,
      reasons: !ready
        ? ['features_not_ready']
        : !mkt
          ? ['odds_missing']
          : ['no_candidate'],
    };
  }

  const homeMu0 = predictSide(ridge, homeEx.x);
  const awayMu0 = predictSide(ridge, awayEx.x);
  const absDev = Math.abs(homeMu0 + awayMu0 - leagueTotal);
  const minDev = NPB_FORMAL_PACKAGE.minAbsMuDevFromLeague;
  const shrinkLeague =
    Number.isFinite(minDev) && absDev >= minDev ? NPB_FORMAL_PACKAGE.shrinkToLeague : 0;
  const sh = shrinkAsianSideMus(homeMu0, awayMu0, {
    leagueTotal,
    shrinkToLeague: shrinkLeague,
  });
  const rawP = poissonHomeWinProb(sh.homeMu, sh.awayMu).homeWinProb;
  const pHome = applyAsianLogisticCalibration(rawP, {
    fromLogit: false,
    shrink: NPB_FORMAL_PACKAGE.calibrate.shrink,
    temp: NPB_FORMAL_PACKAGE.calibrate.temp,
    fairHome: mkt.fairHome,
  });
  const pickHome = pHome >= 0.5;
  const modelProb = pickHome ? pHome : 1 - pHome;
  const odds = pickHome ? mkt.homeOdds : mkt.awayOdds;
  const fair = pickHome ? mkt.fairHome : mkt.fairAway;
  const edge = modelProb - fair;
  const ev = modelProb * (odds - 1) - (1 - modelProb);
  const pick = pickHome ? g.home_team : g.away_team;
  const cand = { odds, modelProb, edge, ev };
  const passed = passMid(cand);
  const reasons = passed ? [] : rejectionReasons(cand);

  return {
    ...base,
    passedGate: passed,
    inReleaseWindow,
    pick,
    pickSide: pickHome ? 'home' : 'away',
    oddsDecimal: Number(odds.toFixed(3)),
    modelProbability: Number(modelProb.toFixed(4)),
    marketProbability: Number(fair.toFixed(4)),
    expectedValue: Number(ev.toFixed(4)),
    edge: Number(edge.toFixed(4)),
    absMuDev: Number(absDev.toFixed(3)),
    appliedShrinkToLeague: shrinkLeague,
    stakeUsd: NPB_FORMAL_PACKAGE.flatStakeUsd,
    reasons,
  };
}

/**
 * 今日 NPB 正式推薦 slate
 */
export function getNpbPrematchSlate({ from } = {}) {
  const state = buildTrainState();
  const upcoming = loadUpcomingNpb({ fromIso: from });
  const startedToday = loadStartedTodayNpb();
  const scored = upcoming.map((g) => scoreUpcomingGame(g, state));

  const passed = scored.filter((r) => r.passedGate);
  const topK = Math.max(0, Number(NPB_FORMAL_PACKAGE.dailyTopK) || 0);
  const released = passed.filter((r) => r.inReleaseWindow);
  /** 日 TopK：同日（UTC 日）按 EV 取前 K */
  let actionablePool = released;
  if (topK > 0) {
    const byDay = new Map();
    for (const row of released) {
      const d = String(row.commenceTime || '').slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(row);
    }
    actionablePool = [];
    for (const arr of byDay.values()) {
      arr
        .slice()
        .sort(
          (a, b) =>
            (b.expectedValue || 0) - (a.expectedValue || 0) ||
            (b.edge || 0) - (a.edge || 0)
        )
        .slice(0, topK)
        .forEach((x) => actionablePool.push(x));
    }
  }
  const actionable = actionablePool
    .slice()
    .sort((a, b) => (b.expectedValue || 0) - (a.expectedValue || 0))
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const held = passed
    .filter((r) => !r.inReleaseWindow)
    .sort((a, b) => (a.hoursUntilCommence ?? 99) - (b.hoursUntilCommence ?? 99))
    .map((r, i) => ({
      rank: i + 1,
      gameId: r.gameId,
      matchup: r.matchup,
      commenceTime: r.commenceTime,
      hoursUntilCommence: r.hoursUntilCommence,
      // 故意不帶選邊／賠率
    }));

  const cutByTopK = released.filter((r) => !actionable.some((a) => a.gameId === r.gameId));
  const excluded = [
    ...scored.filter((r) => !r.passedGate),
    ...cutByTopK.map((r) => ({
      ...r,
      reasons: ['daily_topk_cut'],
    })),
  ];
  const reasonCounts = {};
  for (const r of excluded) {
    for (const code of r.reasons || []) {
      reasonCounts[code] = (reasonCounts[code] || 0) + 1;
    }
  }
  const topReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, n]) => ({
      reason,
      n,
      label: reasonLabels[reason] || reason,
    }));

  return {
    researchOnly: false,
    wiredToFormal: true,
    league: LEAGUE,
    package: {
      id: NPB_FORMAL_PACKAGE.id,
      label: NPB_FORMAL_PACKAGE.label,
      modelId: NPB_FORMAL_PACKAGE.modelId,
      flatStakeUsd: NPB_FORMAL_PACKAGE.flatStakeUsd,
      dailyTopK: NPB_FORMAL_PACKAGE.dailyTopK,
      releaseHoursBefore: NPB_FORMAL_PACKAGE.releaseHoursBefore,
      gate: GATE,
      note: NPB_FORMAL_PACKAGE.note,
      paperEvidenceUsd50: NPB_FORMAL_PACKAGE.paperEvidenceUsd50,
    },
    modelReady: Boolean(state.ridge?.ok),
    trainGames: state.trainN,
    releasePolicy: {
      hoursBefore: NPB_FORMAL_PACKAGE.releaseHoursBefore,
      enabled: NPB_FORMAL_PACKAGE.releaseHoursBefore > 0,
    },
    dailyTop: actionable,
    heldUntilRelease: held,
    excluded: excluded.map((r) => ({
      gameId: r.gameId,
      matchup: r.matchup,
      commenceTime: r.commenceTime,
      reasons: (r.reasons || []).map((code) => reasonLabels[code] || code),
      ready: r.ready,
      hasOdds: r.hasOdds,
    })),
    todayFunnel: {
      upcoming: upcoming.length,
      selected: actionable.length,
      passedGatesHeld: held.length,
      passedGatesTotal: passed.length,
      excluded: excluded.length,
      topKCut: cutByTopK.length,
      pendingData: excluded.filter((r) => (r.reasons || []).includes('features_not_ready'))
        .length,
      startedToday: startedToday.length,
      topReasons,
    },
    startedToday: startedToday.map((g) => ({
      gameId: g.id,
      matchup: `${g.away_team} @ ${g.home_team}`,
      commenceTime: g.commence_time,
    })),
    generatedAt: new Date().toISOString(),
  };
}
