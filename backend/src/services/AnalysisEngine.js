import db from '../db/database.js';
import { fetchAllLeagueOdds, fetchAllLeagueScores, fetchMlbPlayerProps } from './OddsApiClient.js';
import {
  getMlbStandings,
  getMlbScheduleRange,
  matchMlbTeam,
  getProbablePitchers,
  getPitcherSeasonStats,
} from './MlbStatsService.js';
import { analyzeMatchup, updateTeamStatsFromScores } from './TeamAnalyzer.js';
import { pickGameRecommendations } from './RecommendationRules.js';
import { buildParlaysFromDb, LEAGUE_MARKETS_INFO } from './ParlayBuilder.js';
import { extractPlayerProps } from './PlayerPropAnalyzer.js';
import { extractMarkets } from '../utils/odds.js';
import { config } from '../config.js';
import { classifyBetStrategy } from './BetStrategy.js';
import { getStakeSizingMeta, enrichWithSuggestedStake } from './StakeSizer.js';

let refreshPromise = null;

function getMeta(key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

function setMeta(key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
}

export function isRefreshInProgress() {
  return !!refreshPromise;
}

function upsertGame(game, league, rawProps = null) {
  db.prepare(`
    INSERT INTO games (id, league, commence_time, home_team, away_team, raw_odds, raw_props, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      raw_odds = excluded.raw_odds,
      raw_props = COALESCE(excluded.raw_props, games.raw_props),
      updated_at = datetime('now')
  `).run(
    game.id,
    league,
    game.commence_time,
    game.home_team,
    game.away_team,
    JSON.stringify(game.bookmakers),
    rawProps ? JSON.stringify(rawProps) : null
  );
}

function saveGameProps(gameId, bookmakers) {
  db.prepare(`
    UPDATE games SET raw_props = ?, updated_at = datetime('now') WHERE id = ?
  `).run(JSON.stringify(bookmakers), gameId);
}

function clearOldRecommendations() {
  db.prepare('DELETE FROM recommendations').run();
  db.prepare('DELETE FROM parlay_recommendations').run();
}


function buildRecEntry(game, pick, id) {
  return {
    id,
    gameId: game.id,
    league: game.league,
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    commenceTime: game.commence_time,
    modelProb: pick.modelProb,
    market: pick.market,
    pick: pick.pick,
    ev: pick.ev,
    score: pick.score,
    tier: pick.tier,
    odds: pick.odds,
  };
}

function saveRecommendation(rec) {
  const betStrategy =
    rec.betStrategy ??
    classifyBetStrategy(
      {
        tier: rec.tier,
        market: rec.market,
        league: rec.league,
        ev: rec.ev,
        edge_prob: rec.edgeProb,
        model_prob: rec.modelProb,
        odds_decimal: rec.oddsDecimal,
        data_quality: rec.dataQuality,
        pick_rank: rec.pickRank,
      },
      { pickRank: rec.pickRank }
    );

  return db
    .prepare(`
    INSERT INTO recommendations
      (game_id, league, market, pick, line, odds_decimal, bookmaker, model_prob, implied_prob, ev, confidence, reasoning, tier, score, edge_prob, data_quality, market_group, bet_strategy, pick_rank, actionable_score, suggested_stake, stake_multiplier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      rec.gameId,
      rec.league,
      rec.market,
      rec.pick,
      rec.line,
      rec.oddsDecimal,
      rec.bookmaker,
      rec.modelProb,
      rec.impliedProb,
      rec.ev,
      rec.confidence ?? 0.5,
      rec.reasoning,
      rec.tier,
      rec.score,
      rec.edgeProb,
      rec.dataQuality,
      rec.marketGroup || 'main',
      betStrategy,
      rec.pickRank ?? null,
      rec.actionableScore ?? null,
      rec.suggestedStake ?? rec.suggested_stake ?? null,
      rec.stakeMultiplier ?? rec.stake_multiplier ?? null
    ).lastInsertRowid;
}

/** 同步賠率與比分，更新隊伍統計 */
export async function syncAllData() {
  const [oddsData, scoresData] = await Promise.all([
    fetchAllLeagueOdds(),
    fetchAllLeagueScores(),
  ]);

  let mlbStandings = [];
  try {
    mlbStandings = await getMlbStandings();
  } catch (err) {
    console.warn('MLB standings 取得失敗:', err.message);
  }

  for (const [code, { scores, error }] of Object.entries(scoresData.results)) {
    if (error) {
      console.warn(`[${code}] 比分同步失敗:`, error);
      continue;
    }
    updateTeamStatsFromScores(code, scores);

    for (const game of scores) {
      if (!game.completed) continue;
      const hs = game.scores?.find((s) => s.name === game.home_team)?.score;
      const as = game.scores?.find((s) => s.name === game.away_team)?.score;
      db.prepare(`
        INSERT INTO games (id, league, commence_time, home_team, away_team, completed, home_score, away_score, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET completed=1, home_score=?, away_score=?, updated_at=datetime('now')
      `).run(game.id, code, game.commence_time, game.home_team, game.away_team, hs, as, hs, as);
    }
  }

  for (const [code, { games, error }] of Object.entries(oddsData.results)) {
    if (error) {
      console.warn(`[${code}] 賠率同步失敗:`, error);
      continue;
    }
    for (const game of games) {
      upsertGame(game, code);
    }
  }

  let propsQuota = null;
  if (config.enablePlayerProps && oddsData.results.MLB?.games?.length) {
    try {
      const { propsByGameId, quota } = await fetchMlbPlayerProps(
        oddsData.results.MLB.games,
        config.maxPropGames
      );
      propsQuota = quota;
      for (const [gameId, bookmakers] of Object.entries(propsByGameId)) {
        if (bookmakers?.length) saveGameProps(gameId, bookmakers);
      }
      console.log(`[sync] MLB 球員盤口: ${Object.keys(propsByGameId).length} 場`);
    } catch (err) {
      console.warn('[sync] 球員盤口同步失敗:', err.message);
    }
  }

  return {
    oddsQuota: oddsData.quota,
    scoresQuota: scoresData.quota,
    propsQuota,
    gameCounts: Object.fromEntries(
      Object.entries(oddsData.results).map(([k, v]) => [k, v.games?.length || 0])
    ),
  };
}

/** 對所有初盤場次跑分析並產生推薦 */
export async function runAnalysis() {
  clearOldRecommendations();

  let mlbStandings = [];
  let mlbSchedule = [];
  try {
    [mlbStandings, mlbSchedule] = await Promise.all([
      getMlbStandings(),
      getMlbScheduleRange(3),
    ]);
  } catch (err) {
    console.warn('MLB 資料取得失敗:', err.message);
  }

  const upcoming = db
    .prepare(`
    SELECT * FROM games
    WHERE completed = 0 AND datetime(commence_time) > datetime('now')
    ORDER BY commence_time ASC
  `)
    .all();

  const allRecs = [];

  for (const game of upcoming) {
    const bookmakers = JSON.parse(game.raw_odds || '[]');
    if (!bookmakers.length) continue;

    let mlbScheduleGame = null;
    if (game.league === 'MLB') {
      mlbScheduleGame = mlbSchedule.find((g) => {
        const home = g.teams?.home?.team?.name;
        const away = g.teams?.away?.team?.name;
        if (!home || !away) return false;
        return (
          matchMlbTeam(game.home_team, [{ name: home }]) &&
          matchMlbTeam(game.away_team, [{ name: away }])
        );
      });
    }

    const analysis = await analyzeMatchup(
      game.league,
      game.home_team,
      game.away_team,
      bookmakers,
      { mlbStandings, mlbScheduleGame }
    );

    const markets = extractMarkets(bookmakers);
    const reasoning = analysis.factors.join(' | ');

    let propsContext = { bookmakers };

    if (game.league === 'MLB' && config.enablePlayerProps) {
      const rawProps = JSON.parse(game.raw_props || '[]');
      const propsMap = extractPlayerProps(rawProps);
      let homePitcherStats = null;
      let awayPitcherStats = null;
      let homePitcherName = null;
      let awayPitcherName = null;

      if (mlbScheduleGame) {
        const pitchers = getProbablePitchers(mlbScheduleGame);
        homePitcherName = pitchers.home?.name;
        awayPitcherName = pitchers.away?.name;
        [homePitcherStats, awayPitcherStats] = await Promise.all([
          getPitcherSeasonStats(pitchers.home?.id),
          getPitcherSeasonStats(pitchers.away?.id),
        ]);
      }

      propsContext = {
        ...propsContext,
        propsMap,
        homePitcherStats,
        awayPitcherStats,
        homePitcherName,
        awayPitcherName,
      };
    } else if (game.league === 'MLB' && mlbScheduleGame) {
      const pitchers = getProbablePitchers(mlbScheduleGame);
      const [homePitcherStats, awayPitcherStats] = await Promise.all([
        getPitcherSeasonStats(pitchers.home?.id),
        getPitcherSeasonStats(pitchers.away?.id),
      ]);
      propsContext = { ...propsContext, homePitcherStats, awayPitcherStats };
    }

    const picks = pickGameRecommendations(game, markets, analysis, reasoning, propsContext);

    for (const pick of picks) {
      const id = saveRecommendation({
        gameId: game.id,
        league: game.league,
        market: pick.market,
        marketGroup: pick.marketGroup || (pick.market?.startsWith('pitcher_') || pick.market?.startsWith('batter_') ? 'props' : 'main'),
        pick: pick.pick,
        line: pick.line ?? null,
        oddsDecimal: pick.oddsDecimal,
        bookmaker: pick.bookmaker || pick.odds?.bookmaker,
        modelProb: pick.modelProb,
        impliedProb: pick.impliedProb,
        ev: pick.ev,
        confidence: pick.confidence,
        reasoning: pick.reasoning,
        tier: pick.tier,
        score: pick.score,
        edgeProb: pick.edgeProb,
        dataQuality: pick.dataQuality,
        pickRank: pick.pickRank,
        actionableScore: pick.actionableScore,
        suggestedStake: pick.suggestedStake,
        stakeMultiplier: pick.stakeMultiplier,
        betStrategy: pick.bet_strategy,
      });
      allRecs.push(buildRecEntry(game, pick, id));
    }
  }

  const parlays = buildParlaysFromDb({ limit: 40 });
  persistParlays(parlays);
  return { singles: allRecs.length, parlays: parlays.length };
}

function persistParlays(parlays) {
  db.prepare('DELETE FROM parlay_recommendations').run();
  for (const p of parlays) {
    db.prepare(`
      INSERT INTO parlay_recommendations (legs, combined_odds, combined_prob, combined_ev, suggested_stake)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      JSON.stringify({
        legs: p.legs,
        pickSummary: p.pickSummary,
        combined_score: p.combined_score,
        leg_count: p.leg_count,
        category: p.category,
        parlay_label: p.parlay_label,
        potential_payout: p.potential_payout,
      }),
      p.combined_odds,
      p.combined_prob,
      p.combined_ev,
      p.suggested_stake
    );
  }
}

export function getParlayRecommendations(limit = 40) {
  const dynamic = buildParlaysFromDb({ limit });
  if (dynamic.length) return dynamic;

  return db
    .prepare('SELECT * FROM parlay_recommendations ORDER BY combined_ev DESC LIMIT ?')
    .all(limit)
    .map((p, idx) => {
      const parsed = JSON.parse(p.legs);
      const legs = Array.isArray(parsed) ? parsed : parsed.legs || [];
      const enriched = legs.map((leg) => {
        if (leg.homeTeam) return leg;
        const game = leg.gameId
          ? db.prepare('SELECT league, home_team, away_team, commence_time FROM games WHERE id = ?').get(leg.gameId)
          : null;
        return {
          ...leg,
          league: leg.league || game?.league,
          homeTeam: leg.homeTeam || game?.home_team,
          awayTeam: leg.awayTeam || game?.away_team,
          commenceTime: leg.commenceTime || game?.commence_time,
        };
      });
      return {
        id: p.id || `saved-${idx}`,
        legs: enriched,
        pickSummary: parsed.pickSummary || enriched.map((l) => l.pick).join(' + '),
        combined_odds: p.combined_odds,
        combined_prob: p.combined_prob,
        combined_ev: p.combined_ev,
        combined_score: parsed.combined_score,
        leg_count: parsed.leg_count || enriched.length,
        suggested_stake: p.suggested_stake ?? config.parlayBetUsd,
        potential_payout: parsed.potential_payout ?? p.combined_odds * (p.suggested_stake || config.parlayBetUsd),
        parlay_label: parsed.parlay_label,
        category: parsed.category,
      };
    });
}

export { LEAGUE_MARKETS_INFO };

export function getRecommendations(filters = {}) {
  const {
    league,
    minEv = 0,
    market,
    marketGroup,
    tier,
    betStrategy,
    gamePicks,
    limit = 80,
  } = filters;
  let sql = `
    SELECT r.*, g.home_team, g.away_team, g.commence_time
    FROM recommendations r
    JOIN games g ON g.id = r.game_id
    WHERE r.ev >= ?
      AND datetime(g.commence_time) > datetime('now')
  `;
  const params = [minEv];

  if (tier) {
    sql += ' AND r.tier = ?';
    params.push(tier);
  }
  if (league) {
    sql += ' AND r.league = ?';
    params.push(league);
  }
  if (market) {
    sql += ' AND r.market = ?';
    params.push(market);
  }
  if (marketGroup === 'props') {
    sql += " AND r.market_group = 'props'";
  } else if (marketGroup === 'main') {
    sql += " AND r.market_group = 'main'";
  }

  if (gamePicks) {
    sql += ' AND r.pick_rank IS NOT NULL';
    sql += ' ORDER BY g.commence_time ASC, r.pick_rank ASC, r.actionable_score DESC';
  } else if (betStrategy === 'flat_bet' || betStrategy === 'parlay_anchor') {
    sql += ' AND r.bet_strategy = ?';
    params.push(betStrategy);
    if (betStrategy === 'flat_bet') {
      sql += " AND r.tier = 'primary' AND r.odds_decimal >= ?";
      params.push(config.flatBetMinOdds);
      sql += ' ORDER BY g.commence_time ASC, COALESCE(r.pick_rank, 99) ASC, r.ev DESC';
    } else {
      sql += ' ORDER BY r.model_prob DESC, r.ev DESC';
    }
  } else {
    sql += " ORDER BY CASE r.tier WHEN 'primary' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END, r.score DESC, r.model_prob DESC";
  }

  const rows = db.prepare(sql).all(...params);
  const enriched = rows.map((r) => {
    const base = {
      ...r,
      pick_rank: r.pick_rank,
      rank_label: r.pick_rank === 1 ? '主推' : r.pick_rank === 2 ? '次推' : r.pick_rank ? `第${r.pick_rank}推` : null,
      bet_strategy: r.bet_strategy || classifyBetStrategy(r),
    };
    if (base.suggested_stake == null && base.pick_rank != null) {
      return enrichWithSuggestedStake(base);
    }
    return base;
  });

  const filtered =
    !gamePicks && (betStrategy === 'flat_bet' || betStrategy === 'parlay_anchor')
      ? enriched.filter((r) => r.bet_strategy === betStrategy)
      : enriched;

  return filtered.slice(0, limit);
}

export function getBettingStrategyMeta() {
  const stakeMeta = getStakeSizingMeta();
  return {
    flatBet: {
      label: '均注精選',
      minOdds: config.flatBetMinOdds,
      minProb: config.flatBetMinProb,
      minEdgePct: config.flatBetMinEdgePct,
      minEv: config.minEvThreshold,
      baseUnit: stakeMeta.baseUnit,
      currency: stakeMeta.currency,
      stakeSizing: stakeMeta,
      markets: ['h2h', 'spreads', 'totals', 'props'],
      description: '跨盤口排序 · 基準均注動態建議額 · 高 EV 多投',
    },
    parlayAnchor: {
      label: '串關錨腿',
      minOdds: config.parlayAnchorMinOdds,
      maxOdds: config.parlayAnchorMaxOdds,
      minProb: config.parlayAnchorMinProb,
      baseUnit: stakeMeta.baseUnit,
      currency: stakeMeta.currency,
      stakeRatio: config.parlayAnchorStakeRatio,
      description: '低水高勝率 · 建議額為基準均注的縮倉比例',
    },
  };
}

export function getUpcomingGames(league) {
  let sql = `
    SELECT * FROM games
    WHERE completed = 0 AND datetime(commence_time) > datetime('now')
  `;
  const params = [];
  if (league) {
    sql += ' AND league = ?';
    params.push(league);
  }
  sql += ' ORDER BY commence_time ASC';
  return db.prepare(sql).all(...params);
}

export function getBetStats() {
  return db
    .prepare(`
    SELECT
      COUNT(*) as total_bets,
      SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN result = 'pending' THEN 1 ELSE 0 END) as pending,
      COALESCE(SUM(profit), 0) as total_profit,
      COALESCE(SUM(stake), 0) as total_staked
    FROM bet_log
  `)
    .get();
}

export function logBet(bet) {
  if (bet.recId != null) {
    const existing = db
      .prepare(`
        SELECT id FROM bet_log
        WHERE rec_id = ? AND rec_type = ? AND result = 'pending'
      `)
      .get(bet.recId, bet.recType || 'single');
    if (existing) {
      const err = new Error('此推薦已記錄投注');
      err.code = 'DUPLICATE_BET';
      throw err;
    }
  }

  const potentialReturn = bet.stake * bet.oddsDecimal;
  return db
    .prepare(`
    INSERT INTO bet_log (rec_type, rec_id, game_id, league, market, pick, stake, odds_decimal, potential_return)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      bet.recType,
      bet.recId,
      bet.gameId,
      bet.league,
      bet.market,
      bet.pick,
      bet.stake,
      bet.oddsDecimal,
      potentialReturn
    ).lastInsertRowid;
}

export function settleBet(betId, result, profit) {
  db.prepare(`
    UPDATE bet_log SET result = ?, profit = ?, settled_at = datetime('now') WHERE id = ?
  `).run(result, profit, betId);
}

export function getBetLog(limit = 100) {
  return db.prepare('SELECT * FROM bet_log ORDER BY created_at DESC LIMIT ?').all(limit);
}

function parseSpreadPick(pick) {
  const match = pick.match(/^(.+?)\s+([+-]?\d+\.?\d*)$/);
  if (!match) return null;
  return { team: match[1].trim(), line: parseFloat(match[2]) };
}

function calcBetProfit(stake, oddsDecimal, result) {
  if (result === 'win') return stake * oddsDecimal - stake;
  if (result === 'loss') return -stake;
  return 0;
}

/** 依已完成場次比分自動結算待結投注 */
export function autoSettlePendingBets() {
  const pending = db
    .prepare(`
      SELECT b.*, g.home_team, g.away_team, g.home_score, g.away_score, g.completed
      FROM bet_log b
      JOIN games g ON g.id = b.game_id
      WHERE b.result = 'pending' AND g.completed = 1
    `)
    .all();

  let settled = 0;
  for (const bet of pending) {
    const { home_score: hs, away_score: as } = bet;
    if (hs == null || as == null) continue;

    let result = null;
    if (bet.market === 'h2h') {
      if (bet.pick === bet.home_team) {
        if (hs > as) result = 'win';
        else if (hs < as) result = 'loss';
        else result = 'push';
      } else if (bet.pick === bet.away_team) {
        if (as > hs) result = 'win';
        else if (as < hs) result = 'loss';
        else result = 'push';
      }
    } else if (bet.market === 'spreads') {
      const parsed = parseSpreadPick(bet.pick);
      if (!parsed) continue;
      const isHome = parsed.team === bet.home_team;
      const isAway = parsed.team === bet.away_team;
      if (!isHome && !isAway) continue;
      const margin = isHome ? hs - as + parsed.line : as - hs + parsed.line;
      if (margin > 0) result = 'win';
      else if (margin < 0) result = 'loss';
      else result = 'push';
    }

    if (!result) continue;
    const profit = calcBetProfit(bet.stake, bet.odds_decimal, result);
    settleBet(bet.id, result, profit);
    settled++;
  }
  return settled;
}

export function getLoggedRecIds() {
  const rows = db
    .prepare(`
      SELECT rec_type, rec_id FROM bet_log
      WHERE result = 'pending' AND rec_id IS NOT NULL
    `)
    .all();
  const singles = [];
  const parlays = [];
  for (const row of rows) {
    if (row.rec_type === 'parlay') parlays.push(row.rec_id);
    else singles.push(row.rec_id);
  }
  return { singles, parlays };
}

export function getAppStatus() {
  const lastSyncAt = getMeta('last_sync_at');
  const lastAnalysisAt = getMeta('last_analysis_at');
  const quotaRaw = getMeta('odds_quota_remaining');
  const recommendationCount = db.prepare('SELECT COUNT(*) as c FROM recommendations').get().c;
  const pendingBets = db.prepare(`SELECT COUNT(*) as c FROM bet_log WHERE result = 'pending'`).get().c;

  let needsRefresh = false;
  if (config.oddsApiKey) {
    if (!lastSyncAt) {
      needsRefresh = true;
    } else {
      const hoursSince = (Date.now() - new Date(lastSyncAt).getTime()) / 3600000;
      needsRefresh = hoursSince >= config.staleDataHours;
    }
  }

  return {
    lastSyncAt,
    lastAnalysisAt,
    oddsQuotaRemaining: quotaRaw != null ? parseInt(quotaRaw, 10) : null,
    recommendationCount,
    pendingBets,
    needsRefresh,
    staleDataHours: config.staleDataHours,
    hasApiKey: !!config.oddsApiKey,
    isRefreshing: isRefreshInProgress(),
    loggedRecIds: getLoggedRecIds(),
  };
}

/** 同步 → 分析，帶防重入鎖 */
export async function fullRefresh() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const sync = await syncAllData();
    setMeta('last_sync_at', new Date().toISOString());
    if (sync.oddsQuota?.remaining != null) {
      setMeta('odds_quota_remaining', parseInt(sync.oddsQuota.remaining, 10) || 0);
    }

    const analysis = await runAnalysis();
    setMeta('last_analysis_at', new Date().toISOString());

    const recommendationCount = db.prepare('SELECT COUNT(*) as c FROM recommendations').get().c;
    return { sync, analysis, recommendationCount };
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}
