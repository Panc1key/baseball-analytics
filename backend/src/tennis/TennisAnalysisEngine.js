import db from '../db/database.js';
import { config } from '../config.js';
import { tennisConfig, TENNIS_LEAGUE_SQL } from './config.js';
import { activeGameWhere } from '../utils/activeGames.js';
import {
  discoverActiveTennisSports,
  fetchTennisOdds,
  fetchTennisScores,
} from './TennisOddsService.js';
import {
  updateTennisPlayerStatsFromScores,
  analyzeTennisMatchup,
} from './TennisPlayerAnalyzer.js';
import { extractTennisMarkets } from './utils/tennisOdds.js';
import { pickTennisGameRecommendations } from './TennisRecommendationRules.js';
import { classifyTennisBetStrategy } from './TennisPickScorer.js';

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

function upsertGame(game, league) {
  db.prepare(`
    INSERT INTO games (id, league, commence_time, home_team, away_team, raw_odds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      raw_odds = excluded.raw_odds,
      league = excluded.league,
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

function clearTennisRecommendations() {
  db.prepare(`DELETE FROM recommendations WHERE ${TENNIS_LEAGUE_SQL}`).run();
}

function saveRecommendation(rec) {
  const betStrategy =
    rec.betStrategy ??
    classifyTennisBetStrategy({
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

export async function syncTennisData() {
  const discovered = await discoverActiveTennisSports();
  const activeSports = discovered.sports;
  console.log(
    `[tennis] active 賽事 ${activeSports.length}:`,
    activeSports.map((s) => s.code).join(', ') || '(空窗)'
  );

  setMeta('tennis_active_sports', JSON.stringify(activeSports));

  if (!activeSports.length) {
    return {
      oddsQuota: discovered.quota,
      scoresQuota: null,
      activeSports: [],
      gameCounts: {},
      emptyReason: '目前無 active 網球賽事（溫網後／下一站開打前常見空窗）',
    };
  }

  const [oddsData, scoresData] = await Promise.all([
    fetchTennisOdds(activeSports),
    fetchTennisScores(activeSports),
  ]);

  for (const [code, { scores, error }] of Object.entries(scoresData.results)) {
    if (error) {
      console.warn(`[tennis/${code}] 比分失敗:`, error);
      continue;
    }
    updateTennisPlayerStatsFromScores(code, scores);

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
      console.warn(`[tennis/${code}] 賠率失敗:`, error);
      continue;
    }
    for (const game of games) {
      upsertGame(game, code);
    }
  }

  return {
    oddsQuota: oddsData.quota,
    scoresQuota: scoresData.quota,
    activeSports,
    gameCounts: Object.fromEntries(
      Object.entries(oddsData.results).map(([k, v]) => [k, v.games?.length || 0])
    ),
  };
}

export async function runTennisAnalysis() {
  clearTennisRecommendations();

  const upcoming = db
    .prepare(`
    SELECT * FROM games
    WHERE ${TENNIS_LEAGUE_SQL}
      AND ${activeGameWhere()}
    ORDER BY commence_time ASC
  `)
    .all();

  let count = 0;

  for (const game of upcoming) {
    const bookmakers = JSON.parse(game.raw_odds || '[]');
    if (!bookmakers.length) continue;

    const analysis = await analyzeTennisMatchup(
      game.league,
      game.home_team,
      game.away_team,
      bookmakers
    );

    const markets = extractTennisMarkets(bookmakers);
    const reasoning = analysis.factors.join(' | ');
    const picks = pickTennisGameRecommendations(game, markets, analysis, reasoning);

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

export function getTennisRecommendations(filters = {}) {
  const { league, minEv = 0, marketGroup, tier, betStrategy, limit = 80 } = filters;
  let sql = `
    SELECT r.*, g.home_team, g.away_team, g.commence_time
    FROM recommendations r
    JOIN games g ON g.id = r.game_id
    WHERE ${TENNIS_LEAGUE_SQL.replace(/league/g, 'r.league')}
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

export function getTennisUpcomingGames(league) {
  let sql = `
    SELECT * FROM games
    WHERE ${TENNIS_LEAGUE_SQL}
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

function parseActiveSportsMeta() {
  try {
    return JSON.parse(getMeta('tennis_active_sports') || '[]');
  } catch {
    return [];
  }
}

export function getTennisStatus() {
  const lastSyncAt = getMeta('tennis_last_sync_at');
  const lastAnalysisAt = getMeta('tennis_last_analysis_at');
  const quotaRaw = getMeta('tennis_odds_quota_remaining');
  const activeSports = parseActiveSportsMeta();

  const recCount = db
    .prepare(`SELECT COUNT(*) as c FROM recommendations WHERE ${TENNIS_LEAGUE_SQL}`)
    .get().c;

  const gameCount = db
    .prepare(`
      SELECT COUNT(*) as c FROM games
      WHERE ${TENNIS_LEAGUE_SQL}
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
    activeSports,
    isRefreshing: !!refreshPromise,
    formulas: {
      h2h: '選手勝率 Log5 + 市場混合',
      spreads: '預期局差 logistic 蓋盤',
      totals: '勢均力敵→多局 / 一邊倒→少局（BO3/BO5）',
    },
  };
}

export function getTennisMarketsInfo() {
  const active = parseActiveSportsMeta();
  if (!active.length) {
    return {
      _empty: {
        name: '目前無進行中賽事',
        oddsKey: 'tennis_*',
        bulkMarkets: ['h2h (獨贏)', 'spreads (讓局)', 'totals (總局數)'],
        eventMarkets: [],
        note: '賽事 key 動態發現；僅對 active 的 ATP/WTA 拉盤以節省額度',
      },
    };
  }
  return Object.fromEntries(
    active.map((s) => [
      s.code,
      {
        name: s.title || s.code,
        oddsKey: s.key,
        bulkMarkets: ['h2h (獨贏)', 'spreads (讓局)', 'totals (總局數)'],
        eventMarkets: [],
        note: '初盤模型已啟用；滾球未做',
      },
    ])
  );
}

export function getTennisBettingMeta() {
  return {
    flatBet: {
      label: '網球均注精選',
      minOdds: tennisConfig.flatBetMinOdds,
      minProb: tennisConfig.flatBetMinProb,
      minEv: tennisConfig.minEvThreshold,
      stake: 2,
      description: '高賠正 EV · 獨贏/讓局/總局數',
    },
    parlayAnchor: {
      label: '網球串關錨腿',
      minOdds: tennisConfig.parlayAnchorMinOdds,
      maxOdds: tennisConfig.parlayAnchorMaxOdds,
      minProb: tennisConfig.parlayAnchorMinProb,
      stake: 1,
      description: '低水高勝率錨腿',
    },
  };
}

export async function tennisFullRefresh() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const sync = await syncTennisData();
    setMeta('tennis_last_sync_at', new Date().toISOString());
    if (sync.oddsQuota?.remaining != null) {
      setMeta('tennis_odds_quota_remaining', parseInt(sync.oddsQuota.remaining, 10) || 0);
    }

    const analysis = await runTennisAnalysis();
    setMeta('tennis_last_analysis_at', new Date().toISOString());

    return { sync, analysis };
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}
