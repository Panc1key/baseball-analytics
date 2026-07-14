import db from '../db/database.js';
import { config } from '../config.js';
import { basketballConfig, BASKETBALL_LEAGUES, BASKETBALL_LEAGUE_CODES } from './config.js';
import { activeGameWhere } from '../utils/activeGames.js';
import { fetchBasketballOdds, fetchBasketballScores } from './BasketballOddsService.js';
import {
  updateBasketballTeamStatsFromScores,
  analyzeBasketballMatchup,
} from './BasketballTeamAnalyzer.js';
import { extractBasketballMarkets } from './utils/basketballOdds.js';
import { pickBasketballGameRecommendations } from './BasketballRecommendationRules.js';
import { classifyBasketballBetStrategy } from './BasketballPickScorer.js';

let refreshPromise = null;

const BASKETBALL_LEAGUE_LIST = BASKETBALL_LEAGUE_CODES.map((c) => `'${c}'`).join(',');

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

function upsertGame(game, league) {
  db.prepare(`
    INSERT INTO games (id, league, commence_time, home_team, away_team, raw_odds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      raw_odds = excluded.raw_odds,
      updated_at = datetime('now')
  `).run(
    game.id,
    league,
    game.commence_time,
    game.home_team,
    game.away_team,
    JSON.stringify(game.bookmakers)
  );
}

function clearBasketballRecommendations() {
  db.prepare(`DELETE FROM recommendations WHERE league IN (${BASKETBALL_LEAGUE_LIST})`).run();
}

function saveRecommendation(rec) {
  const betStrategy =
    rec.betStrategy ??
    classifyBasketballBetStrategy({
      oddsDecimal: rec.oddsDecimal,
      modelProb: rec.modelProb,
      ev: rec.ev,
      tier: rec.tier,
    });

  return db
    .prepare(`
    INSERT INTO recommendations
      (game_id, league, market, pick, line, odds_decimal, bookmaker, model_prob, implied_prob, ev, confidence, reasoning, tier, score, edge_prob, data_quality, market_group, bet_strategy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      betStrategy
    ).lastInsertRowid;
}

export async function syncBasketballData() {
  const [oddsData, scoresData] = await Promise.all([
    fetchBasketballOdds(),
    fetchBasketballScores(),
  ]);

  for (const [code, { scores, error }] of Object.entries(scoresData.results)) {
    if (error) {
      console.warn(`[basketball/${code}] 比分失敗:`, error);
      continue;
    }
    updateBasketballTeamStatsFromScores(code, scores);

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
      console.warn(`[basketball/${code}] 賠率失敗:`, error);
      continue;
    }
    for (const game of games) {
      upsertGame(game, code);
    }
  }

  return {
    oddsQuota: oddsData.quota,
    scoresQuota: scoresData.quota,
    gameCounts: Object.fromEntries(
      Object.entries(oddsData.results).map(([k, v]) => [k, v.games?.length || 0])
    ),
  };
}

export async function runBasketballAnalysis() {
  clearBasketballRecommendations();

  const placeholders = BASKETBALL_LEAGUE_CODES.map(() => '?').join(',');
  const upcoming = db
    .prepare(`
    SELECT * FROM games
    WHERE league IN (${placeholders})
      AND ${activeGameWhere()}
    ORDER BY commence_time ASC
  `)
    .all(...BASKETBALL_LEAGUE_CODES);

  let count = 0;

  for (const game of upcoming) {
    const bookmakers = JSON.parse(game.raw_odds || '[]');
    if (!bookmakers.length) continue;

    const analysis = await analyzeBasketballMatchup(
      game.league,
      game.home_team,
      game.away_team,
      bookmakers
    );

    const markets = extractBasketballMarkets(bookmakers);
    const reasoning = analysis.factors.join(' | ');
    const picks = pickBasketballGameRecommendations(game, markets, analysis, reasoning);

    for (const pick of picks) {
      saveRecommendation({
        gameId: game.id,
        league: game.league,
        market: pick.market,
        marketGroup: pick.marketGroup,
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
      });
      count++;
    }
  }

  return { recommendations: count, games: upcoming.length };
}

export function getBasketballRecommendations(filters = {}) {
  const { league, minEv = 0, marketGroup, tier, betStrategy, limit = 80 } = filters;
  let sql = `
    SELECT r.*, g.home_team, g.away_team, g.commence_time
    FROM recommendations r
    JOIN games g ON g.id = r.game_id
    WHERE r.league IN (${BASKETBALL_LEAGUE_LIST})
      AND r.ev >= ?
      AND ${activeGameWhere('g')}
  `;
  const params = [minEv];

  if (league) {
    sql += ' AND r.league = ?';
    params.push(league);
  }
  if (tier) {
    sql += ' AND r.tier = ?';
    params.push(tier);
  }
  if (marketGroup === 'main') {
    sql += " AND r.market_group = 'main'";
  }
  if (betStrategy) {
    sql += ' AND r.bet_strategy = ?';
    params.push(betStrategy);
  }

  if (betStrategy === 'flat_bet') {
    sql += ' ORDER BY g.commence_time ASC, r.ev DESC, r.score DESC';
  } else if (betStrategy === 'parlay_anchor') {
    sql += ' ORDER BY g.commence_time ASC, r.model_prob DESC, r.ev DESC';
  } else {
    sql += " ORDER BY g.commence_time ASC, CASE r.tier WHEN 'primary' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END, r.score DESC";
  }

  return db.prepare(sql).all(...params).slice(0, limit);
}

export function getBasketballUpcomingGames(league) {
  let sql = `
    SELECT * FROM games
    WHERE league IN (${BASKETBALL_LEAGUE_LIST})
      AND ${activeGameWhere()}
  `;
  const params = [];
  if (league) {
    sql += ' AND league = ?';
    params.push(league);
  }
  sql += ' ORDER BY commence_time ASC';
  return db.prepare(sql).all(...params);
}

export function getBasketballStatus() {
  const lastSyncAt = getMeta('basketball_last_sync_at');
  const lastAnalysisAt = getMeta('basketball_last_analysis_at');
  const quotaRaw = getMeta('basketball_odds_quota_remaining');

  const recCount = db
    .prepare(`SELECT COUNT(*) as c FROM recommendations WHERE league IN (${BASKETBALL_LEAGUE_LIST})`)
    .get().c;

  const gameCount = db
    .prepare(`
      SELECT COUNT(*) as c FROM games
      WHERE league IN (${BASKETBALL_LEAGUE_LIST})
        AND completed = 0
        AND datetime(commence_time) > datetime('now')
    `)
    .get().c;

  return {
    lastSyncAt,
    lastAnalysisAt,
    oddsQuotaRemaining: quotaRaw != null ? parseInt(quotaRaw, 10) : null,
    recommendationCount: recCount,
    upcomingGames: gameCount,
    hasOddsApiKey: !!config.oddsApiKey,
    leagues: BASKETBALL_LEAGUES,
    isRefreshing: !!refreshPromise,
    formulas: {
      h2h: '效率×節奏 → 淨勝分 N(μ,σ≈11.5) → Φ',
      spreads: '同一淨勝分常態積分蓋盤（含整數走盤）',
      totals: '期望總分 N(μ,σ≈14) → P(Over)',
    },
  };
}

export const BASKETBALL_MARKETS_INFO = Object.fromEntries(
  Object.entries(BASKETBALL_LEAGUES).map(([code, league]) => [
    code,
    {
      name: league.name,
      oddsKey: league.key,
      bulkMarkets: ['h2h (獨贏)', 'spreads (讓分)', 'totals (大小分)'],
      eventMarkets: [],
      note: '效率×節奏投影 · 淨勝分/總分常態分佈定價；暫無滾球',
    },
  ])
);

export function getBasketballBettingMeta() {
  return {
    flatBet: {
      label: '籃球均注精選',
      minOdds: basketballConfig.flatBetMinOdds,
      minProb: basketballConfig.flatBetMinProb,
      minEv: basketballConfig.minEvThreshold,
      stake: 2,
      description: '高賠正 EV · 獨贏/讓分/大小',
    },
    parlayAnchor: {
      label: '籃球串關錨腿',
      minOdds: basketballConfig.parlayAnchorMinOdds,
      maxOdds: basketballConfig.parlayAnchorMaxOdds,
      minProb: basketballConfig.parlayAnchorMinProb,
      stake: 1,
      description: '低水高勝率錨腿',
    },
  };
}

export async function basketballFullRefresh() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const sync = await syncBasketballData();
    setMeta('basketball_last_sync_at', new Date().toISOString());
    if (sync.oddsQuota?.remaining != null) {
      setMeta('basketball_odds_quota_remaining', parseInt(sync.oddsQuota.remaining, 10) || 0);
    }

    const analysis = await runBasketballAnalysis();
    setMeta('basketball_last_analysis_at', new Date().toISOString());

    return { sync, analysis };
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}
