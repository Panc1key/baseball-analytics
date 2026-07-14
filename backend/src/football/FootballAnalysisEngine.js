import db from '../db/database.js';
import { config } from '../config.js';
import { footballConfig, FOOTBALL_LEAGUES, FOOTBALL_LEAGUE_CODES, SOCCER_PROP_MARKETS } from './config.js';
import { activeGameWhere } from '../utils/activeGames.js';
import { fetchFootballOdds, fetchFootballScores, fetchFootballPlayerProps } from './FootballOddsService.js';
import { updateFootballTeamStatsFromScores, analyzeFootballMatchup } from './FootballTeamAnalyzer.js';
import { extractSoccerMarkets } from './utils/footballOdds.js';
import { extractSoccerPlayerProps } from './FootballPlayerAnalyzer.js';
import { pickFootballGameRecommendations } from './FootballRecommendationRules.js';
import { classifyFootballBetStrategy } from './FootballPickScorer.js';

let refreshPromise = null;

const FOOTBALL_LEAGUE_LIST = FOOTBALL_LEAGUE_CODES.map((c) => `'${c}'`).join(',');

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

function clearFootballRecommendations() {
  db.prepare(`DELETE FROM recommendations WHERE league IN (${FOOTBALL_LEAGUE_LIST})`).run();
}

function saveRecommendation(rec) {
  const betStrategy =
    rec.betStrategy ??
    classifyFootballBetStrategy({
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

export async function syncFootballData() {
  const [oddsData, scoresData] = await Promise.all([fetchFootballOdds(), fetchFootballScores()]);

  for (const [code, { scores, error }] of Object.entries(scoresData.results)) {
    if (error) {
      console.warn(`[football/${code}] 比分失敗:`, error);
      continue;
    }
    updateFootballTeamStatsFromScores(code, scores);

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
      console.warn(`[football/${code}] 賠率失敗:`, error);
      continue;
    }
    for (const game of games) {
      upsertGame(game, code);
    }
  }

  let propsQuota = null;
  if (footballConfig.enablePlayerProps) {
    for (const [code, { games, league }] of Object.entries(oddsData.results)) {
      if (!games?.length) continue;
      try {
        const { propsByGameId, quota, aborted } = await fetchFootballPlayerProps(
          games,
          league.key,
          footballConfig.maxPropGames
        );
        propsQuota = quota;
        for (const [gameId, bookmakers] of Object.entries(propsByGameId)) {
          if (bookmakers?.length) {
            db.prepare(`UPDATE games SET raw_props = ?, updated_at = datetime('now') WHERE id = ?`).run(
              JSON.stringify(bookmakers),
              gameId
            );
          }
        }
        console.log(`[football/${code}] 球員盤 ${Object.keys(propsByGameId).length} 場`);
        if (aborted) {
          console.warn('[football] 額度不足，跳過其餘聯盟球員盤');
          break;
        }
      } catch (err) {
        console.warn(`[football/${code}] 球員盤失敗:`, err.message);
        if (/OUT_OF_USAGE_CREDITS|quota has been reached/i.test(err.message || '')) break;
      }
    }
  } else {
    console.log('[football] 球員盤已關閉（FOOTBALL_ENABLE_PROPS≠true），節省 Odds API 額度');
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

export async function runFootballAnalysis() {
  clearFootballRecommendations();

  const placeholders = FOOTBALL_LEAGUE_CODES.map(() => '?').join(',');
  const upcoming = db
    .prepare(`
    SELECT * FROM games
    WHERE league IN (${placeholders})
      AND ${activeGameWhere()}
    ORDER BY commence_time ASC
  `)
    .all(...FOOTBALL_LEAGUE_CODES);

  let count = 0;

  for (const game of upcoming) {
    const bookmakers = JSON.parse(game.raw_odds || '[]');
    if (!bookmakers.length) continue;

    const analysis = await analyzeFootballMatchup(
      game.league,
      game.home_team,
      game.away_team,
      bookmakers,
      game.commence_time
    );

    const markets = extractSoccerMarkets(bookmakers);
    const reasoning = analysis.factors.join(' | ');
    const rawProps = JSON.parse(game.raw_props || '[]');
    const propsMap = extractSoccerPlayerProps(rawProps);

    const picks = await pickFootballGameRecommendations(
      game,
      markets,
      analysis,
      reasoning,
      { propsMap, bookmakers }
    );

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

    if (analysis.intel?.fixtureId) {
      try {
        db.prepare(`
          INSERT INTO football_match_intel (game_id, league, fixture_id, intel_json, updated_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(game_id) DO UPDATE SET fixture_id=excluded.fixture_id, intel_json=excluded.intel_json, updated_at=datetime('now')
        `).run(
          game.id,
          game.league,
          analysis.intel.fixtureId,
          JSON.stringify({
            homeProfile: analysis.homeProfile,
            awayProfile: analysis.awayProfile,
            tacticalEdge: analysis.intel.tacticalEdge,
            h2hCount: analysis.intel.h2h?.length ?? 0,
          })
        );
      } catch {
        /* table may not exist yet */
      }
    }
  }

  return { recommendations: count, games: upcoming.length };
}

export function getFootballRecommendations(filters = {}) {
  const { league, minEv = 0, marketGroup, tier, betStrategy, limit = 80 } = filters;
  let sql = `
    SELECT r.*, g.home_team, g.away_team, g.commence_time
    FROM recommendations r
    JOIN games g ON g.id = r.game_id
    WHERE r.league IN (${FOOTBALL_LEAGUE_LIST})
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
  if (marketGroup === 'props') {
    sql += " AND r.market_group = 'props'";
  } else if (marketGroup === 'main') {
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

  const rows = db.prepare(sql).all(...params);
  return rows.slice(0, limit);
}

export function getFootballUpcomingGames(league) {
  let sql = `
    SELECT * FROM games
    WHERE league IN (${FOOTBALL_LEAGUE_LIST})
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

export function getFootballStatus() {
  const lastSyncAt = getMeta('football_last_sync_at');
  const lastAnalysisAt = getMeta('football_last_analysis_at');
  const quotaRaw = getMeta('football_odds_quota_remaining');

  const recCount = db
    .prepare(`SELECT COUNT(*) as c FROM recommendations WHERE league IN (${FOOTBALL_LEAGUE_LIST})`)
    .get().c;

  const gameCount = db
    .prepare(`
      SELECT COUNT(*) as c FROM games
      WHERE league IN (${FOOTBALL_LEAGUE_LIST})
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
    hasFootballStatsApi: !!footballConfig.apiFootballKey,
    leagues: FOOTBALL_LEAGUES,
    isRefreshing: !!refreshPromise,
  };
}

export const FOOTBALL_MARKETS_INFO = Object.fromEntries(
  Object.entries(FOOTBALL_LEAGUES).map(([code, league]) => [
    code,
    {
      name: league.name,
      oddsKey: league.key,
      bulkMarkets: ['h2h (獨贏含和局)', 'spreads (亞洲讓球)', 'totals (大小球)'],
      eventMarkets: SOCCER_PROP_MARKETS.map((m) => m),
      note: 'Dixon–Coles 比分矩陣定價 1X2/亞盤/大小 · 暫無滾球',
    },
  ])
);

export function getFootballBettingMeta() {
  return {
    flatBet: {
      label: '足球均注精選',
      minOdds: footballConfig.flatBetMinOdds,
      minProb: footballConfig.flatBetMinProb,
      minEv: footballConfig.minEvThreshold,
      stake: 2,
      description: '高賠正 EV · 含球員盤',
    },
    parlayAnchor: {
      label: '足球串關錨腿',
      minOdds: footballConfig.parlayAnchorMinOdds,
      maxOdds: footballConfig.parlayAnchorMaxOdds,
      minProb: footballConfig.parlayAnchorMinProb,
      stake: 1,
      description: '低水高勝率 · 世界盃淘汰賽穩腿',
    },
  };
}

export async function footballFullRefresh() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const sync = await syncFootballData();
    setMeta('football_last_sync_at', new Date().toISOString());
    if (sync.oddsQuota?.remaining != null) {
      setMeta('football_odds_quota_remaining', parseInt(sync.oddsQuota.remaining, 10) || 0);
    }

    const analysis = await runFootballAnalysis();
    setMeta('football_last_analysis_at', new Date().toISOString());

    return { sync, analysis };
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}
