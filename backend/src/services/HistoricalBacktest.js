/**
 * 歷史回放校準 — 用「當前算法」對已完賽場次重算初盤推薦，再對實際比分結算
 * 不需手動一場場測，也不依賴當時是否存了 snapshot
 */
import db from '../db/database.js';
import { config, BASEBALL_LEAGUE_SQL } from '../config.js';
import { analyzeMatchup } from './TeamAnalyzer.js';
import { pickGameRecommendations } from './RecommendationRules.js';
import { evaluateBaseballMarketResult } from './AnalysisEngine.js';
import { extractMarkets } from '../utils/odds.js';
import { getMlbStandings } from './MlbStatsService.js';
import { qualifiesFlatBet } from './BetStrategy.js';
import { createWalkForwardElo } from './BaseballElo.js';
import { buildPointInTimeTeamStatsOverride } from './TeamRollingStats.js';
import { resolveStarAbsenceForGame } from './StarPlayerImpact.js';
import {
  brierScore,
  logLoss,
  buildCalibrationFromDetails,
  formatCalibrationCurve,
  saveCalibrationTable,
} from './ProbabilityCalibration.js';

function emptyBag() {
  return { n: 0, w: 0, l: 0, p: 0, sumProb: 0, sumEv: 0, profitUnits: 0 };
}

function addBag(bag, result, pick) {
  bag.n += 1;
  bag.sumProb += Number(pick.modelProb ?? 0);
  bag.sumEv += Number(pick.ev ?? 0);
  if (result === 'win') bag.w += 1;
  else if (result === 'loss') bag.l += 1;
  else if (result === 'push') bag.p += 1;
  if (result === 'win') bag.profitUnits += Number(pick.oddsDecimal ?? 1) - 1;
  else if (result === 'loss') bag.profitUnits -= 1;
}

function fmtBag(bag) {
  const decided = bag.w + bag.l;
  const hit = decided ? `${((bag.w / decided) * 100).toFixed(1)}%` : 'n/a';
  const avgP = bag.n ? `${((bag.sumProb / bag.n) * 100).toFixed(1)}%` : '-';
  const avgEv = bag.n ? `${((bag.sumEv / bag.n) * 100).toFixed(1)}%` : '-';
  const roi = bag.n ? `${((bag.profitUnits / bag.n) * 100).toFixed(1)}%` : '-';
  return {
    n: bag.n,
    wins: bag.w,
    losses: bag.l,
    pushes: bag.p,
    hitRate: hit,
    avgPredictedProb: avgP,
    avgEv: avgEv,
    profitUnits: Math.round(bag.profitUnits * 100) / 100,
    roi,
    text: `n=${bag.n} W${bag.w} L${bag.l} P${bag.p} 命中=${hit} ROI=${roi} 預測均值=${avgP} EV均值=${avgEv}`,
  };
}

function probBucket(p) {
  if (p >= 0.65) return '65+';
  if (p >= 0.6) return '60-65';
  if (p >= 0.55) return '55-60';
  if (p >= 0.5) return '50-55';
  return '<50';
}

function edgeBucket(edgePct) {
  const edge = Number(edgePct ?? 0);
  if (edge >= 8) return '8+';
  if (edge >= 5) return '5-8';
  if (edge >= 3) return '3-5';
  return '<3';
}

function isGradableGame(game) {
  const hs = Number(game.home_score);
  const as = Number(game.away_score);
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return false;
  const done = game.completed === 1 || game.status === 'completed';
  if (!done && hs === 0 && as === 0) return false;
  if (!game.raw_odds || game.raw_odds === '[]') return false;
  return true;
}

function datetimeKey(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
}

function gradePick(pick, game) {
  return evaluateBaseballMarketResult(
    {
      market: pick.market,
      pick: pick.pick,
      line: pick.line ?? null,
    },
    {
      home_team: game.home_team,
      away_team: game.away_team,
      home_score: game.home_score,
      away_score: game.away_score,
      completed: 1,
      status: 'completed',
    }
  );
}

/**
 * @param {{
 *   leagues?: string[],
 *   days?: number | null,
 *   since?: string | null,
 *   primaryOnly?: boolean,
 *   flatBetOnly?: boolean,
 *   excludeSample?: boolean,
 *   topPickPerGame?: boolean,
 *   fetchMlb?: boolean,
 *   pointInTimeForm?: boolean,
 * }} options
 * days 預設 30：只回放最近 N 天完賽場次（最快定位算法問題）
 * days=null / 0：不限日期
 * pointInTimeForm：開賽前近窗形態（MLB 用免費 Stats API，不耗 Odds 額度）
 */
export async function runHistoricalBacktest(options = {}) {
  const requestedLeagues = options.leagues ?? ['MLB', 'NPB', 'KBO'];
  const leagues = config.mlbTruthResearchOnly
    ? requestedLeagues.filter((league) => league !== 'MLB')
    : requestedLeagues;
  if (!leagues.length) {
    return {
      disabled: true,
      mode: 'research_only',
      reason: 'legacy_mlb_backtest_uses_non_pit_current_data',
      useInstead: 'MlbModelValidation / MlbResearchRanker / MlbTruthPitBacktest',
    };
  }
  const leagueSql = leagues.map((c) => `'${c}'`).join(',');
  const primaryOnly = options.primaryOnly ?? false;
  const flatBetOnly = options.flatBetOnly ?? false;
  const excludeSample = options.excludeSample ?? true;
  const topPickPerGame = options.topPickPerGame !== false;
  const pointInTimeForm = options.pointInTimeForm === true;
  const days =
    options.days === null || options.days === 0
      ? null
      : Number.isFinite(Number(options.days))
        ? Number(options.days)
        : 30;

  // 回測用未校準概率建表，避免雙重校準
  const prevCalib = config.enableReliabilityCalibration;
  config.enableReliabilityCalibration = false;

  try {
  let sinceIso = options.since || null;
  if (!sinceIso && days != null) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    sinceIso = since.toISOString();
  }

  let mlbStandings = [];
  if (options.fetchMlb !== false && leagues.includes('MLB')) {
    try {
      mlbStandings = await getMlbStandings();
    } catch (err) {
      console.warn('[backtest] MLB standings 略過:', err.message);
    }
  }

  // Walk-forward Elo：用全部完賽歷史種子推進，但分析時只用開賽前狀態
  const eloWalkers = {
    NPB: createWalkForwardElo('NPB', { seedFromRating: false }),
    KBO: createWalkForwardElo('KBO', { seedFromRating: false }),
  };
  const allChrono = db
    .prepare(
      `
    SELECT league, home_team, away_team, home_score, away_score, commence_time
    FROM games
    WHERE league IN ('NPB','KBO')
      AND completed = 1
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND NOT (home_score = 0 AND away_score = 0)
    ORDER BY datetime(commence_time) ASC
  `
    )
    .all();

  const games = db
    .prepare(
      sinceIso
        ? `
    SELECT * FROM games
    WHERE league IN (${leagueSql})
      AND datetime(commence_time) >= datetime(?)
    ORDER BY datetime(commence_time) ASC
  `
        : `
    SELECT * FROM games
    WHERE league IN (${leagueSql})
    ORDER BY datetime(commence_time) ASC
  `
    )
    .all(...(sinceIso ? [sinceIso] : []))
    .filter(isGradableGame);

  const bags = {};
  const getBag = (key) => {
    if (!bags[key]) bags[key] = emptyBag();
    return bags[key];
  };

  const details = [];
  let analyzed = 0;
  let skippedNoPick = 0;
  let errors = 0;
  let eloCursor = 0;

  for (const game of games) {
    // 推進 Elo 到本場開賽前（不含本場）
    while (eloCursor < allChrono.length) {
      const eg = allChrono[eloCursor];
      if (datetimeKey(eg.commence_time) >= datetimeKey(game.commence_time)) break;
      const w = eloWalkers[eg.league];
      if (w) w.applyGame(eg.home_team, eg.away_team, eg.home_score, eg.away_score);
      eloCursor += 1;
    }

    let bookmakers;
    try {
      bookmakers = JSON.parse(game.raw_odds || '[]');
    } catch {
      errors += 1;
      continue;
    }
    if (!bookmakers.length) continue;

    const eloOverride =
      game.league === 'NPB' || game.league === 'KBO'
        ? eloWalkers[game.league]
        : null;

    try {
      let teamStatsOverride = null;
      if (pointInTimeForm) {
        teamStatsOverride = await buildPointInTimeTeamStatsOverride(
          game.league,
          game.commence_time,
          game.home_team,
          game.away_team
        );
      }

      let starAbsence = null;
      if (config.enableStarImpact && game.league === 'MLB') {
        starAbsence = await resolveStarAbsenceForGame(
          game.home_team,
          game.away_team,
          game.commence_time
        );
      }

      const analysis = await analyzeMatchup(
        game.league,
        game.home_team,
        game.away_team,
        bookmakers,
        {
          mlbStandings,
          mlbScheduleGame: null,
          eloOverride,
          teamStatsOverride,
          starAbsence,
          commenceTime: game.commence_time,
        }
      );

      const markets = extractMarkets(bookmakers);
      const reasoning = (analysis.factors || []).join(' | ');
      const picks = pickGameRecommendations(game, markets, analysis, reasoning, {
        bookmakers,
      });

      let pool = picks || [];
      if (excludeSample) pool = pool.filter((p) => p.tier !== 'sample');
      if (primaryOnly) pool = pool.filter((p) => p.tier === 'primary');
      if (flatBetOnly) {
        pool = pool.filter((p) =>
          qualifiesFlatBet(
            {
              ...p,
              league: game.league,
              hasTeamStrength: analysis.hasTeamStrength,
              data_quality: p.dataQuality ?? analysis.dataQuality,
            },
            {
              pickRank: p.pickRank ?? p.pick_rank ?? 1,
              hasTeamStrength: analysis.hasTeamStrength,
              analysis,
            }
          )
        );
      }
      if (topPickPerGame) {
        pool = pool.filter((p) => (p.pickRank ?? p.pick_rank ?? 1) === 1);
      }

      if (!pool.length) {
        skippedNoPick += 1;
        continue;
      }

      analyzed += 1;
      for (const pick of pool) {
        const result = gradePick(pick, game);
        if (!['win', 'loss', 'push'].includes(result)) continue;

        const pred = Number(pick.modelProb ?? 0);
        const keys = [
          'ALL',
          `league:${game.league}`,
          `market:${pick.market}`,
          `tier:${pick.tier || '-'}`,
          `${game.league}|${pick.market}`,
          `bucket:${probBucket(pred)}`,
          `${game.league}|bucket:${probBucket(pred)}`,
        ];
        if (pick.bet_strategy) keys.push(`strategy:${pick.bet_strategy}`);
        keys.push(`edge:${edgeBucket(pick.edgeProb)}`);
        if (pick.market === 'spreads') {
          if (Number(pick.line) > 0) keys.push('spread:plus');
          else if (Number(pick.line) < 0) keys.push('spread:minus');
          else keys.push('spread:pk');
        }
        if (pred >= 0.6) keys.push('prob60+');
        if (pick.tier === 'primary') keys.push('primary');

        for (const k of keys) addBag(getBag(k), result, pick);

        details.push({
          result,
          league: game.league,
          tier: pick.tier,
          market: pick.market,
          pick: pick.pick,
          line: pick.line,
          odds: pick.oddsDecimal,
          modelProb: pred,
          ev: pick.ev,
          edgeProb: pick.edgeProb,
          spreadSign:
            pick.market !== 'spreads'
              ? null
              : Number(pick.line) > 0
                ? 'plus'
                : Number(pick.line) < 0
                  ? 'minus'
                  : 'pk',
          rawModelProb: pick.rawModelProb,
          marketProb: pick.marketProb,
          preCapProb: pick.preCapProb,
          finalEdgeCapped: pick.finalEdgeCapped === true,
          betStrategy: pick.bet_strategy,
          score: `${game.away_score}-${game.home_score}`,
          teams: `${game.away_team} @ ${game.home_team}`,
          commenceTime: game.commence_time,
        });
      }
    } catch (err) {
      errors += 1;
      console.warn(`[backtest] ${game.id} 失敗:`, err.message);
    }
  }

  const summary = {};
  for (const [k, b] of Object.entries(bags)) summary[k] = fmtBag(b);

  const first = details[0]?.commenceTime || games[0]?.commence_time || null;
  const last =
    details[details.length - 1]?.commenceTime ||
    games[games.length - 1]?.commence_time ||
    null;

  const outcomePoints = details
    .filter((d) => d.result === 'win' || d.result === 'loss')
    .map((d) => ({
      p: Number(d.modelProb),
      y: d.result === 'win' ? 1 : 0,
    }));
  const metrics = {
    brier: brierScore(outcomePoints),
    logLoss: logLoss(outcomePoints),
    nDecided: outcomePoints.length,
  };

  const calibration = buildCalibrationFromDetails(details);
  if (options.saveCalibration !== false && calibration.n >= 20) {
    try {
      saveCalibrationTable(calibration);
    } catch (err) {
      console.warn('[backtest] 校準表寫入失敗:', err.message);
    }
  }

  return {
    modelVersion: config.modelVersion,
    leagues,
    window: { days, since: sinceIso, firstGame: first, lastGame: last },
    filters: {
      primaryOnly,
      flatBetOnly,
      excludeSample,
      topPickPerGame,
    },
    gamesGradable: games.length,
    gamesWithPick: analyzed,
    gamesSkippedNoPick: skippedNoPick,
    errors,
    summary,
    metrics,
    calibration: {
      n: calibration.n,
      metrics: calibration.metrics,
      globalCurve: formatCalibrationCurve(calibration.global),
      identity: calibration.global?.identity,
    },
    details,
    note:
      '使用庫內完賽比分 + 當時 raw_odds 重跑現行算法；NPB/KBO Elo 為 walk-forward（開賽前狀態）。' +
      (pointInTimeForm
        ? ' 近窗形態為開賽前 point-in-time（MLB Stats API 免費、按日快取）。'
        : '') +
      ' 預設最近 30 天。',
    pointInTimeForm,
  };
  } finally {
    config.enableReliabilityCalibration = prevCalib;
  }
}

export function formatBacktestReport(report) {
  const lines = [];
  lines.push(`模型 ${report.modelVersion}`);
  const w = report.window || {};
  lines.push(
    `視窗: 最近 ${w.days ?? '全部'} 天` +
      (w.since ? `（自 ${String(w.since).slice(0, 10)}）` : '') +
      (w.firstGame || w.lastGame
        ? ` · 實際場次 ${String(w.firstGame || '').slice(0, 10)} ~ ${String(w.lastGame || '').slice(0, 10)}`
        : '')
  );
  lines.push(
    `可回放場次 ${report.gamesGradable} · 有推薦 ${report.gamesWithPick} · 無推薦跳過 ${report.gamesSkippedNoPick} · 錯誤 ${report.errors}`
  );
  lines.push(`篩選: ${JSON.stringify(report.filters)}`);
  if (report.metrics) {
    const m = report.metrics;
    lines.push(
      `評分: Brier=${m.brier != null ? m.brier.toFixed(4) : 'n/a'}` +
        ` · LogLoss=${m.logLoss != null ? m.logLoss.toFixed(4) : 'n/a'}` +
        ` · n=${m.nDecided ?? 0}`
    );
  }
  if (report.calibration?.globalCurve) {
    lines.push('=== 校準曲線（全局）===');
    lines.push(report.calibration.globalCurve);
  }
  lines.push('');
  const order = [
    'ALL',
    'primary',
    'prob60+',
    'strategy:flat_bet',
    'league:MLB',
    'league:NPB',
    'league:KBO',
    'market:h2h',
    'market:spreads',
    'market:totals',
    'spread:plus',
    'spread:minus',
    'spread:pk',
    'edge:<3',
    'edge:3-5',
    'edge:5-8',
    'edge:8+',
    'tier:primary',
    'tier:watch',
    'MLB|h2h',
    'MLB|spreads',
    'MLB|totals',
    'NPB|h2h',
    'NPB|spreads',
    'NPB|totals',
    'KBO|h2h',
    'KBO|spreads',
    'KBO|totals',
    'bucket:<50',
    'bucket:50-55',
    'bucket:55-60',
    'bucket:60-65',
    'bucket:65+',
    'MLB|bucket:55-60',
    'MLB|bucket:60-65',
    'NPB|bucket:55-60',
    'NPB|bucket:60-65',
  ];
  lines.push('=== 命中率 ===');
  for (const k of order) {
    if (report.summary[k]) lines.push(`${k.padEnd(22)} ${report.summary[k].text}`);
  }
  for (const k of Object.keys(report.summary).sort()) {
    if (!order.includes(k)) lines.push(`${k.padEnd(22)} ${report.summary[k].text}`);
  }
  return lines.join('\n');
}
