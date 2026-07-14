/**
 * 跨聯盟按日 Slate — 棒球 + 足球推薦聚合（香港時區）
 */
import db from '../db/database.js';
import { config, BASEBALL_LEAGUE_SQL, LEAGUES } from '../config.js';
import { FOOTBALL_LEAGUES, FOOTBALL_LEAGUE_CODES } from '../football/config.js';
import { activeGameWhere, isGameLive } from '../utils/activeGames.js';
import { classifyBetStrategy } from './BetStrategy.js';
import { enrichWithSuggestedStake } from './StakeSizer.js';
import { getBettingStrategyMeta } from './AnalysisEngine.js';
import { getFootballBettingMeta } from '../football/FootballAnalysisEngine.js';
import { fullRefresh } from './AnalysisEngine.js';
import { footballFullRefresh } from '../football/FootballAnalysisEngine.js';
import {
  toLocalDateKey,
  formatLocalDateLabel,
  formatLocalTime,
  todayLocalDateKey,
  addDaysToDateKey,
  HK_TIMEZONE,
  sqliteLocalDateExpr,
} from '../utils/timezone.js';

const FOOTBALL_LEAGUE_SQL = FOOTBALL_LEAGUE_CODES.map((c) => `'${c}'`).join(',');
const ALL_SLATE_LEAGUE_SQL = `${BASEBALL_LEAGUE_SQL},${FOOTBALL_LEAGUE_SQL}`;

const BASEBALL_SET = new Set(Object.keys(LEAGUES));
const FOOTBALL_SET = new Set(FOOTBALL_LEAGUE_CODES);

export const LEAGUE_DISPLAY_NAMES = {
  ...Object.fromEntries(Object.entries(LEAGUES).map(([k, v]) => [k, v.name])),
  ...Object.fromEntries(Object.entries(FOOTBALL_LEAGUES).map(([k, v]) => [k, v.name])),
};

function sportCategory(league) {
  if (BASEBALL_SET.has(league)) return 'baseball';
  if (FOOTBALL_SET.has(league)) return 'football';
  return 'other';
}

function enrichRow(r) {
  const base = {
    ...r,
    is_live: isGameLive(r.commence_time, r.completed),
    pick_rank: r.pick_rank,
    rank_label:
      r.pick_rank === 1 ? '主推' : r.pick_rank === 2 ? '次推' : r.pick_rank ? `第${r.pick_rank}推` : null,
    bet_strategy: r.bet_strategy || classifyBetStrategy(r),
    sport_category: sportCategory(r.league),
    league_name: LEAGUE_DISPLAY_NAMES[r.league] || r.league,
    local_date: toLocalDateKey(r.commence_time),
    local_time: formatLocalTime(r.commence_time),
  };
  if (base.suggested_stake == null && base.pick_rank != null) {
    return enrichWithSuggestedStake(base);
  }
  return base;
}

/**
 * 查詢 Slate 推薦（跨棒球 + 足球）
 */
export function querySlatePicks(filters = {}) {
  const {
    fromDate,
    toDate,
    betStrategy,
    league,
    minEv = 0,
    tier,
    marketGroup,
  } = filters;

  const localDateExpr = sqliteLocalDateExpr('g.commence_time', 8);
  let sql = `
    SELECT r.*, g.home_team, g.away_team, g.commence_time, g.completed
    FROM recommendations r
    JOIN games g ON g.id = r.game_id
    WHERE r.league IN (${ALL_SLATE_LEAGUE_SQL})
      AND IFNULL(r.phase, 'prematch') = 'prematch'
      AND r.ev >= ?
      AND g.completed = 0
      AND ${activeGameWhere('g')}
  `;
  const params = [minEv];

  if (fromDate) {
    sql += ` AND ${localDateExpr} >= ?`;
    params.push(fromDate);
  }
  if (toDate) {
    sql += ` AND ${localDateExpr} <= ?`;
    params.push(toDate);
  }
  if (betStrategy) {
    sql += ' AND r.bet_strategy = ?';
    params.push(betStrategy);
  }
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

  sql += ` ORDER BY g.commence_time ASC, COALESCE(r.pick_rank, 99) ASC, r.actionable_score DESC, r.ev DESC`;

  return db.prepare(sql).all(...params).map(enrichRow);
}

function summarizeDay(picks) {
  const byLeague = {};
  const bySport = { baseball: 0, football: 0, other: 0 };
  let totalSuggestedStake = 0;
  let flatCount = 0;
  let anchorCount = 0;

  for (const p of picks) {
    byLeague[p.league] = (byLeague[p.league] || 0) + 1;
    bySport[p.sport_category] = (bySport[p.sport_category] || 0) + 1;
    totalSuggestedStake += p.suggested_stake ?? p.suggestedStake ?? 0;
    if (p.bet_strategy === 'flat_bet') flatCount += 1;
    if (p.bet_strategy === 'parlay_anchor') anchorCount += 1;
  }

  return {
    count: picks.length,
    byLeague,
    bySport,
    flatCount,
    anchorCount,
    totalSuggestedStake: Math.round(totalSuggestedStake),
  };
}

/**
 * 按香港日曆日分組的 Slate
 */
export function getSlateByDate(filters = {}) {
  const days = filters.days ?? config.slateDefaultDays ?? 7;
  const fromDate = filters.from || todayLocalDateKey();
  const toDate = filters.to || addDaysToDateKey(fromDate, days - 1);

  const picks = querySlatePicks({
    ...filters,
    fromDate,
    toDate,
  });

  const byDate = new Map();
  for (const p of picks) {
    const key = p.local_date || toLocalDateKey(p.commence_time);
    if (!key) continue;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(p);
  }

  const dates = [];
  let cursor = fromDate;
  while (cursor <= toDate) {
    const dayPicks = byDate.get(cursor) || [];
    dates.push({
      date: cursor,
      label: formatLocalDateLabel(cursor),
      isToday: cursor === todayLocalDateKey(),
      picks: dayPicks,
      summary: summarizeDay(dayPicks),
    });
    cursor = addDaysToDateKey(cursor, 1);
  }

  const allSummary = summarizeDay(picks);

  return {
    timezone: HK_TIMEZONE,
    from: fromDate,
    to: toDate,
    dates,
    totalPicks: picks.length,
    summary: allSummary,
    enabledLeagues: {
      baseball: Object.keys(LEAGUES),
      football: FOOTBALL_LEAGUE_CODES,
    },
    meta: {
      baseball: getBettingStrategyMeta(),
      football: getFootballBettingMeta(),
      horizonHours: config.upcomingGameHorizonHours,
    },
  };
}

/** 同步並分析所有已啟用聯盟 */
export async function slateFullRefresh() {
  const [baseball, football] = await Promise.all([fullRefresh(), footballFullRefresh()]);
  return {
    baseball,
    football,
    totalRecommendations:
      (baseball.recommendationCount ?? 0) + (football.analysis?.recommendations ?? 0),
  };
}

export function getSlateStatus() {
  const gameCounts = db
    .prepare(
      `SELECT league, COUNT(1) as cnt FROM games
       WHERE league IN (${ALL_SLATE_LEAGUE_SQL})
         AND completed = 0
         AND ${activeGameWhere()}
       GROUP BY league`
    )
    .all();

  const recCounts = db
    .prepare(
      `SELECT league, COUNT(1) as cnt FROM recommendations
       WHERE league IN (${ALL_SLATE_LEAGUE_SQL})
         AND IFNULL(phase, 'prematch') = 'prematch'
       GROUP BY league`
    )
    .all();

  return {
    timezone: HK_TIMEZONE,
    horizonHours: config.upcomingGameHorizonHours,
    slateDays: config.slateDefaultDays,
    gamesByLeague: Object.fromEntries(gameCounts.map((r) => [r.league, r.cnt])),
    recsByLeague: Object.fromEntries(recCounts.map((r) => [r.league, r.cnt])),
    enabledLeagues: {
      baseball: Object.keys(LEAGUES),
      football: FOOTBALL_LEAGUE_CODES.map((c) => ({
        code: c,
        name: FOOTBALL_LEAGUES[c].name,
      })),
    },
  };
}
