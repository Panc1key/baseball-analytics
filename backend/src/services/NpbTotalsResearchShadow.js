/**
 * NPB 大小盤正式套件（Round8 規則；2026-08-06 用戶明示升格）
 *
 * - 規則凍結：edge03 Over + 砍 odds∈[1.85,2.00) + μ→league 0.25
 * - 已接正式日推（與獨贏同板）；紙上表仍作對照追蹤
 * - 證據僅 2026（thin-year）；回滾：formalScope.totals=false
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
  poissonTotalOverUnderProb,
  shrinkAsianSideMus,
  trainAsianRunsLinear,
  exampleFromGameSide,
} from './AsianExpectedRunsLite.js';
import { NPB_RESEARCH_SHADOW_SPEC } from './AsianNpbResearchShadow.js';

const LEAGUE = 'NPB';
const CAND = NPB_RESEARCH_SHADOW_SPEC.savedTotalsEdge03OverDropOddsShadow;

export const NPB_TOTALS_FORMAL_PACKAGE = Object.freeze({
  id: 'npb_formal_totals_edge03_over_drop_odds_185_200_v2026-08-06',
  shadowId: CAND?.id || 'totals_edge03_over_drop_odds_185_200',
  label: 'NPB 正式大小',
  lockedAt: '2026-08-06',
  promotedAt: '2026-08-06',
  wiredToFormal: true,
  researchOnly: false,
  head: 'ridge_poisson_totals',
  muShrinkToLeague: CAND?.muShrinkToLeague ?? 0.25,
  minEdge: CAND?.minEdge ?? 0.03,
  minEv: CAND?.minEv ?? 0.03,
  side: 'over',
  dropOddsBand: CAND?.dropOddsBand || Object.freeze({ minInclusive: 1.85, maxExclusive: 2.0 }),
  gate: Object.freeze({
    minOdds: 1.7,
    maxOdds: 2.2,
    minProb: 0.52,
  }),
  flatStakeUsd: NPB_RESEARCH_SHADOW_SPEC.stakeUsd,
  releaseHoursBefore: Math.max(
    0,
    Number(config.npbFormalReleaseHoursBefore ?? config.mlbLockedBReleaseHoursBefore) || 8
  ),
  paperEvidenceUsd50: CAND?.paperEvidenceUsd50 || null,
  thinYearWarning: true,
  observation: Object.freeze({
    targetBets: 150,
    softTargetBets: 120,
    earlyStopNetUsd50: -200,
    requireMultiYearBeforeFormal: true,
  }),
  note:
    '正式大小：Over-only + edge≥3% + 砍中賠 1.85–2.00；開賽前放出；證據幾乎僅 2026（thin-year）',
});

/** @deprecated 別名：升格後仍保留舊名供紙上腳本引用 */
export const NPB_TOTALS_RESEARCH_SHADOW_PACKAGE = NPB_TOTALS_FORMAL_PACKAGE;

function shadowLedgerId() {
  return NPB_TOTALS_FORMAL_PACKAGE.shadowId;
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

function inDropBand(odds) {
  const band = NPB_TOTALS_RESEARCH_SHADOW_PACKAGE.dropOddsBand;
  const o = Number(odds);
  return o >= band.minInclusive && o < band.maxExclusive;
}

function hoursUntil(commenceTime) {
  const t = Date.parse(commenceTime);
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / 3600000;
}

function summarizeBets(bets) {
  if (!bets.length) return { bets: 0, decided: 0, pending: 0, hitRate: null, roi: null, usd50: 0 };
  let unit = 0;
  let hits = 0;
  let decided = 0;
  let pending = 0;
  for (const b of bets) {
    const result = b.result || (b.push ? 'push' : b.hit === true ? 'win' : b.hit === false ? 'loss' : null);
    if (result === 'pending') {
      pending += 1;
      continue;
    }
    if (result === 'push') continue;
    if (result !== 'win' && result !== 'loss') continue;
    decided += 1;
    const odds = Number(b.odds ?? b.odds_decimal);
    if (result === 'win') {
      hits += 1;
      unit += odds - 1;
    } else unit -= 1;
  }
  return {
    bets: bets.length,
    decided,
    pending,
    hitRate: decided ? Number((hits / decided).toFixed(4)) : null,
    roi: decided ? Number((unit / decided).toFixed(4)) : null,
    usd50: Math.round(unit * NPB_TOTALS_RESEARCH_SHADOW_PACKAGE.flatStakeUsd),
  };
}

function evaluateCandidate({ homeMu0, awayMu0, leagueTotal, totals }) {
  const pkg = NPB_TOTALS_RESEARCH_SHADOW_PACKAGE;
  if (!totals) return { pass: false, reasons: ['no_totals'] };
  const sh = shrinkAsianSideMus(homeMu0, awayMu0, {
    leagueTotal,
    shrinkToLeague: pkg.muShrinkToLeague,
  });
  const muSum = sh.homeMu + sh.awayMu;
  const dist = poissonTotalOverUnderProb(sh.homeMu, sh.awayMu, totals.line);
  const overP = dist.overProb;
  const underP = dist.underProb;
  if (underP > overP) return { pass: false, reasons: ['model_prefers_under'] };

  const modelProb = overP;
  const odds = totals.overOdds;
  const fair = totals.fairOver;
  const edge = modelProb - fair;
  const ev = modelProb * (odds - 1) - (1 - modelProb);
  const absGap = Math.abs(muSum - totals.line);
  const reasons = [];
  if (odds < pkg.gate.minOdds) reasons.push('odds_below_min');
  if (odds > pkg.gate.maxOdds) reasons.push('odds_above_max');
  if (modelProb < pkg.gate.minProb) reasons.push('prob_below_min');
  if (edge < pkg.minEdge) reasons.push('edge_below_min');
  if (ev < pkg.minEv) reasons.push('ev_below_min');
  if (inDropBand(odds)) reasons.push('drop_odds_185_200');
  return {
    pass: reasons.length === 0,
    reasons,
    side: 'over',
    line: totals.line,
    odds,
    fair,
    modelProb,
    edge,
    ev,
    absGap,
    muSum,
    homeMu: sh.homeMu,
    awayMu: sh.awayMu,
  };
}

/**
 * Walk-forward 歷史紙上重放（與 Round8 主觀察同口徑）
 */
export function replayNpbTotalsResearchShadowPaper() {
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

  const bets = [];
  const holdMonths = months.filter((m) => !warmup.has(m));
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
      const cand = evaluateCandidate({
        homeMu0,
        awayMu0,
        leagueTotal,
        totals: row.totals,
      });
      if (!cand.pass) continue;
      const actualTotal = row.yHomeRuns + row.yAwayRuns;
      const push = actualTotal === cand.line;
      const hit = !push && actualTotal > cand.line;
      bets.push({
        gameId: row.gameId,
        day: row.day,
        hold: row.month,
        homeTeam: row.g.home_team,
        awayTeam: row.g.away_team,
        commenceTime: row.g.commence_time,
        side: cand.side,
        line: cand.line,
        odds: cand.odds,
        modelProb: cand.modelProb,
        fair: cand.fair,
        edge: cand.edge,
        ev: cand.ev,
        absGap: cand.absGap,
        hit,
        push,
        result: push ? 'push' : hit ? 'win' : 'loss',
        actualTotal,
      });
    }
  }

  const byMonth = {};
  for (const b of bets) {
    if (!byMonth[b.hold]) byMonth[b.hold] = [];
    byMonth[b.hold].push(b);
  }
  const monthSummaries = Object.fromEntries(
    Object.entries(byMonth)
      .sort()
      .map(([m, arr]) => [m, summarizeBets(arr)])
  );

  const days = [...new Set(bets.map((b) => b.day))].sort();
  const cumulative = [];
  let running = [];
  for (const day of days) {
    running = running.concat(bets.filter((b) => b.day === day));
    const s = summarizeBets(running);
    cumulative.push({ day, ...s });
  }

  const spanDays =
    days.length >= 2
      ? Math.max(
          1,
          Math.round(
            (Date.parse(days[days.length - 1]) - Date.parse(days[0])) / 86400000
          ) + 1
        )
      : days.length || 1;
  const betsPerDay = bets.length / spanDays;
  const target = NPB_TOTALS_RESEARCH_SHADOW_PACKAGE.observation.targetBets;
  const remaining = Math.max(0, target - bets.length);
  const etaDays = betsPerDay > 0 ? Math.ceil(remaining / betsPerDay) : null;

  return {
    shadowId: shadowLedgerId(),
    overall: summarizeBets(bets),
    byMonth: monthSummaries,
    bets,
    cumulative,
    pace: {
      activeDays: days.length,
      spanDays,
      betsPerCalendarDay: Number(betsPerDay.toFixed(3)),
      targetBets: target,
      remainingToTarget: remaining,
      etaDaysToTarget: etaDays,
      crossedTargetAt: cumulative.find((c) => c.bets >= target)?.day || null,
    },
  };
}

let modelCache = null;
const MODEL_TTL_MS = 20 * 60 * 1000;

function buildTrainState() {
  const completed = loadAsianCompletedGames(LEAGUE);
  const cacheKey = `${completed.length}:${completed[completed.length - 1]?.id || 'none'}`;
  if (modelCache && modelCache.key === cacheKey && Date.now() - modelCache.builtAt < MODEL_TTL_MS) {
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

function loadUpcomingNpb({ fromIso } = {}) {
  const from = fromIso || new Date().toISOString();
  return db
    .prepare(
      `SELECT id, league, commence_time, home_team, away_team, raw_odds, completed,
              home_score, away_score
       FROM games
       WHERE league = ?
         AND completed = 0
         AND datetime(commence_time) >= datetime(?)
       ORDER BY datetime(commence_time) ASC`
    )
    .all(LEAGUE, from);
}

function scoreUpcomingTotals(g, state) {
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
  const totals = bestTotals(books);
  const hours = hoursUntil(g.commence_time);
  const releaseH = NPB_TOTALS_RESEARCH_SHADOW_PACKAGE.releaseHoursBefore;
  const inReleaseWindow = releaseH <= 0 || (hours != null && hours <= releaseH);
  const matchup = `${g.away_team} @ ${g.home_team}`;
  if (!ready) {
    return {
      gameId: g.id,
      matchup,
      commenceTime: g.commence_time,
      hoursUntilCommence: hours,
      inReleaseWindow,
      passedGate: false,
      reasons: ['features_not_ready'],
    };
  }
  const homeMu0 = predictSide(ridge, homeEx.x);
  const awayMu0 = predictSide(ridge, awayEx.x);
  const cand = evaluateCandidate({ homeMu0, awayMu0, leagueTotal, totals });
  return {
    gameId: g.id,
    matchup,
    homeTeam: g.home_team,
    awayTeam: g.away_team,
    commenceTime: g.commence_time,
    hoursUntilCommence: hours,
    inReleaseWindow,
    passedGate: cand.pass,
    reasons: cand.pass ? [] : cand.reasons,
    side: cand.side,
    line: cand.line,
    odds: cand.odds,
    modelProb: cand.modelProb,
    marketProb: cand.fair,
    edge: cand.edge,
    expectedValue: cand.ev,
    absGap: cand.absGap,
    expectedTotal: cand.muSum,
  };
}

export function getNpbTotalsResearchShadowSlate({ from } = {}) {
  const state = buildTrainState();
  const upcoming = loadUpcomingNpb({ fromIso: from });
  const scored = upcoming.map((g) => scoreUpcomingTotals(g, state));
  const passed = scored.filter((r) => r.passedGate);
  const actionable = passed
    .filter((r) => r.inReleaseWindow)
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
    }));
  return {
    researchOnly: !NPB_TOTALS_FORMAL_PACKAGE.wiredToFormal,
    wiredToFormal: Boolean(NPB_TOTALS_FORMAL_PACKAGE.wiredToFormal),
    league: LEAGUE,
    package: {
      id: NPB_TOTALS_FORMAL_PACKAGE.id,
      shadowId: NPB_TOTALS_FORMAL_PACKAGE.shadowId,
      label: NPB_TOTALS_FORMAL_PACKAGE.label,
      flatStakeUsd: NPB_TOTALS_FORMAL_PACKAGE.flatStakeUsd,
      releaseHoursBefore: NPB_TOTALS_FORMAL_PACKAGE.releaseHoursBefore,
      dropOddsBand: NPB_TOTALS_FORMAL_PACKAGE.dropOddsBand,
      thinYearWarning: NPB_TOTALS_FORMAL_PACKAGE.thinYearWarning,
      paperEvidenceUsd50: NPB_TOTALS_FORMAL_PACKAGE.paperEvidenceUsd50,
      note: NPB_TOTALS_FORMAL_PACKAGE.note,
    },
    modelReady: Boolean(state.ridge?.ok),
    trainGames: state.trainN,
    dailyTop: actionable,
    heldUntilRelease: held,
    excluded: scored.filter((r) => !r.passedGate).map((r) => ({
      gameId: r.gameId,
      matchup: r.matchup,
      commenceTime: r.commenceTime,
      reasons: r.reasons,
    })),
  };
}

const upsertBet = db.prepare(`
  INSERT INTO npb_totals_shadow_paper_bets (
    shadow_id, game_id, day, commence_time, home_team, away_team,
    side, line, odds_decimal, model_prob, market_prob, edge, expected_value, abs_gap,
    stake_usd, result, profit_usd, source, filled_at, settled_at
  ) VALUES (
    @shadow_id, @game_id, @day, @commence_time, @home_team, @away_team,
    @side, @line, @odds_decimal, @model_prob, @market_prob, @edge, @expected_value, @abs_gap,
    @stake_usd, @result, @profit_usd, @source, @filled_at, @settled_at
  )
  ON CONFLICT(shadow_id, game_id) DO NOTHING
`);

export function syncNpbTotalsShadowReplayToDb(replay = null) {
  const data = replay || replayNpbTotalsResearchShadowPaper();
  const shadowId = shadowLedgerId();
  const stake = NPB_TOTALS_RESEARCH_SHADOW_PACKAGE.flatStakeUsd;
  let inserted = 0;
  const tx = db.transaction((rows) => {
    for (const b of rows) {
      const profit =
        b.result === 'win'
          ? (b.odds - 1) * stake
          : b.result === 'loss'
            ? -stake
            : 0;
      const info = upsertBet.run({
        shadow_id: shadowId,
        game_id: b.gameId,
        day: b.day,
        commence_time: b.commenceTime,
        home_team: b.homeTeam,
        away_team: b.awayTeam,
        side: b.side,
        line: b.line,
        odds_decimal: b.odds,
        model_prob: b.modelProb,
        market_prob: b.fair,
        edge: b.edge,
        expected_value: b.ev,
        abs_gap: b.absGap,
        stake_usd: stake,
        result: b.result,
        profit_usd: profit,
        source: 'walkforward_replay',
        filled_at: b.day,
        settled_at: b.day,
      });
      inserted += info.changes;
    }
  });
  tx(data.bets);
  return { shadowId, attempted: data.bets.length, inserted, overall: data.overall };
}

export function ensureNpbTotalsShadowPaperFills({ from } = {}) {
  const slate = getNpbTotalsResearchShadowSlate({ from });
  const shadowId = shadowLedgerId();
  const stake = NPB_TOTALS_RESEARCH_SHADOW_PACKAGE.flatStakeUsd;
  let inserted = 0;
  for (const row of slate.dailyTop) {
    const info = upsertBet.run({
      shadow_id: shadowId,
      game_id: row.gameId,
      day: String(row.commenceTime || '').slice(0, 10),
      commence_time: row.commenceTime,
      home_team: row.homeTeam,
      away_team: row.awayTeam,
      side: row.side,
      line: row.line,
      odds_decimal: row.odds,
      model_prob: row.modelProb,
      market_prob: row.marketProb,
      edge: row.edge,
      expected_value: row.expectedValue,
      abs_gap: row.absGap,
      stake_usd: stake,
      result: 'pending',
      profit_usd: null,
      source: 'live_fill',
      filled_at: new Date().toISOString(),
      settled_at: null,
    });
    inserted += info.changes;
  }
  return { shadowId, actionable: slate.dailyTop.length, inserted, slate };
}

export function settleNpbTotalsShadowPaperBets() {
  const shadowId = shadowLedgerId();
  const pending = db
    .prepare(
      `SELECT b.*, g.home_score, g.away_score, g.completed
       FROM npb_totals_shadow_paper_bets b
       JOIN games g ON g.id = b.game_id
       WHERE b.shadow_id = ? AND b.result = 'pending'`
    )
    .all(shadowId);
  const upd = db.prepare(`
    UPDATE npb_totals_shadow_paper_bets
    SET result = ?, profit_usd = ?, settled_at = datetime('now')
    WHERE id = ?
  `);
  let settled = 0;
  for (const row of pending) {
    if (!row.completed) continue;
    const actual = Number(row.home_score) + Number(row.away_score);
    const line = Number(row.line);
    const stake = Number(row.stake_usd) || NPB_TOTALS_RESEARCH_SHADOW_PACKAGE.flatStakeUsd;
    let result = 'push';
    let profit = 0;
    if (actual === line) {
      result = 'push';
      profit = 0;
    } else if (row.side === 'over') {
      result = actual > line ? 'win' : 'loss';
      profit = result === 'win' ? (row.odds_decimal - 1) * stake : -stake;
    } else {
      result = actual < line ? 'win' : 'loss';
      profit = result === 'win' ? (row.odds_decimal - 1) * stake : -stake;
    }
    upd.run(result, profit, row.id);
    settled += 1;
  }
  return { shadowId, pending: pending.length, settled };
}

export function getNpbTotalsShadowPaperLedgerSummary() {
  const shadowId = shadowLedgerId();
  const rows = db
    .prepare(
      `SELECT * FROM npb_totals_shadow_paper_bets WHERE shadow_id = ? ORDER BY day ASC, id ASC`
    )
    .all(shadowId);
  const mapped = rows.map((r) => ({
    ...r,
    odds: r.odds_decimal,
    hit: r.result === 'win',
    push: r.result === 'push',
  }));
  const overall = summarizeBets(mapped);
  const byMonth = {};
  for (const r of mapped) {
    const m = String(r.day || '').slice(0, 7);
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(r);
  }
  const monthSummaries = Object.fromEntries(
    Object.entries(byMonth)
      .sort()
      .map(([m, arr]) => [m, summarizeBets(arr)])
  );
  return {
    researchOnly: !NPB_TOTALS_FORMAL_PACKAGE.wiredToFormal,
    wiredToFormal: Boolean(NPB_TOTALS_FORMAL_PACKAGE.wiredToFormal),
    shadowId,
    package: NPB_TOTALS_FORMAL_PACKAGE,
    overall,
    byMonth: monthSummaries,
    pending: mapped.filter((r) => r.result === 'pending').length,
    rowCount: rows.length,
  };
}

export function npbTotalsShadowPromoteVerdict({ replayOverall, yearCoverage = { '2026': true } } = {}) {
  const obs = NPB_TOTALS_RESEARCH_SHADOW_PACKAGE.observation;
  const bets = Number(replayOverall?.bets) || 0;
  const usd = Number(replayOverall?.usd50) || 0;
  const years = Object.keys(yearCoverage || {}).filter((y) => yearCoverage[y]);
  const blockers = [];
  if (bets < obs.targetBets) blockers.push(`bets ${bets} < target ${obs.targetBets}`);
  if (obs.requireMultiYearBeforeFormal && years.length < 2) {
    blockers.push('thin_year_need_multi_year_totals');
  }
  if (usd <= obs.earlyStopNetUsd50) blockers.push(`usd ${usd} earlyStop`);
  const formalLockedOff = NPB_RESEARCH_SHADOW_SPEC.formalScope.totals !== true;
  return {
    status: formalLockedOff
      ? blockers.length
        ? 'blocked_observe'
        : 'ready_for_user_promote_review'
      : 'formal_wired',
    blockers: formalLockedOff ? blockers : [],
    formalScopeTotals: !formalLockedOff,
    autoWireBlocked: formalLockedOff,
    bets,
    usd50: usd,
    years,
    note: !formalLockedOff
      ? '已接正式日推（用戶明示升格）'
      : blockers.length
        ? '維持 research_only 紙上觀察'
        : '觀察門檻已達；仍須用戶明示升格（不會自動接正式）',
  };
}

export function getNpbTotalsResearchShadowStatus({ includeReplay = false } = {}) {
  const ledger = getNpbTotalsShadowPaperLedgerSummary();
  const promote = npbTotalsShadowPromoteVerdict({
    replayOverall: ledger.overall,
    yearCoverage: { '2026': true },
  });
  const out = {
    researchOnly: !NPB_TOTALS_FORMAL_PACKAGE.wiredToFormal,
    wiredToFormal: Boolean(NPB_TOTALS_FORMAL_PACKAGE.wiredToFormal),
    package: NPB_TOTALS_FORMAL_PACKAGE,
    ledger,
    promote,
  };
  if (includeReplay) {
    const replay = replayNpbTotalsResearchShadowPaper();
    out.replay = {
      overall: replay.overall,
      byMonth: replay.byMonth,
      pace: replay.pace,
    };
    out.promote = npbTotalsShadowPromoteVerdict({
      replayOverall: replay.overall,
      yearCoverage: { '2026': true },
    });
  }
  return out;
}
