/**
 * 跨聯盟按日 Slate — 棒/足/籃/網 初盤推薦聚合（香港時區）
 */
import db from '../db/database.js';
import { config, BASEBALL_LEAGUE_SQL, LEAGUES } from '../config.js';
import { FOOTBALL_LEAGUES, FOOTBALL_LEAGUE_CODES } from '../football/config.js';
import { BASKETBALL_LEAGUES, BASKETBALL_LEAGUE_CODES } from '../basketball/config.js';
import { TENNIS_LEAGUE_SQL, isTennisLeagueCode } from '../tennis/config.js';
import { activeGameWhere, isGameStarted } from '../utils/activeGames.js';
import { classifyBetStrategy } from './BetStrategy.js';
import { enrichWithSuggestedStake } from './StakeSizer.js';
import { getBettingStrategyMeta } from './AnalysisEngine.js';
import { getFootballBettingMeta } from '../football/FootballAnalysisEngine.js';
import { getBasketballBettingMeta } from '../basketball/BasketballAnalysisEngine.js';
import { getTennisBettingMeta } from '../tennis/TennisAnalysisEngine.js';
import { fullRefresh } from './AnalysisEngine.js';
import { footballFullRefresh } from '../football/FootballAnalysisEngine.js';
import { basketballFullRefresh } from '../basketball/BasketballAnalysisEngine.js';
import { tennisFullRefresh } from '../tennis/TennisAnalysisEngine.js';
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
const BASKETBALL_LEAGUE_SQL = BASKETBALL_LEAGUE_CODES.map((c) => `'${c}'`).join(',');
/** 靜態聯盟碼 + 網球動態 ATP_/WTA_ */
const ALL_SLATE_LEAGUE_PRED = `(
  league IN (${BASEBALL_LEAGUE_SQL},${FOOTBALL_LEAGUE_SQL},${BASKETBALL_LEAGUE_SQL})
  OR ${TENNIS_LEAGUE_SQL}
)`;

const BASEBALL_SET = new Set(Object.keys(LEAGUES));
const FOOTBALL_SET = new Set(FOOTBALL_LEAGUE_CODES);
const BASKETBALL_SET = new Set(BASKETBALL_LEAGUE_CODES);

export const LEAGUE_DISPLAY_NAMES = {
  ...Object.fromEntries(Object.entries(LEAGUES).map(([k, v]) => [k, v.name])),
  ...Object.fromEntries(Object.entries(FOOTBALL_LEAGUES).map(([k, v]) => [k, v.name])),
  ...Object.fromEntries(Object.entries(BASKETBALL_LEAGUES).map(([k, v]) => [k, v.name])),
};

function sportCategory(league) {
  if (BASEBALL_SET.has(league)) return 'baseball';
  if (FOOTBALL_SET.has(league)) return 'football';
  if (BASKETBALL_SET.has(league)) return 'basketball';
  if (isTennisLeagueCode(league)) return 'tennis';
  return 'other';
}

function enrichRow(r) {
  const base = {
    ...r,
    is_started: isGameStarted(r.commence_time, r.completed),
    /** Slate 僅初盤；已開賽標「進行中」，真滾球見滾球 Tab */
    is_live: false,
    pick_rank: r.pick_rank,
    rank_label:
      r.tier === 'sample' && r.pick_rank === 1
        ? '樣本'
        : r.tier === 'watch' && r.pick_rank === 1
          ? '觀察'
          : r.pick_rank === 1
            ? '主推'
            : r.pick_rank === 2
              ? '次推'
              : r.pick_rank
                ? `第${r.pick_rank}推`
                : null,
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
    WHERE ${ALL_SLATE_LEAGUE_PRED.replace(/\bleague\b/g, 'r.league')}
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
  const bySport = { baseball: 0, football: 0, basketball: 0, tennis: 0, other: 0 };
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
      basketball: BASKETBALL_LEAGUE_CODES,
      tennis: 'dynamic',
    },
    meta: {
      baseball: getBettingStrategyMeta(),
      football: getFootballBettingMeta(),
      basketball: getBasketballBettingMeta(),
      tennis: getTennisBettingMeta(),
      horizonHours: config.upcomingGameHorizonHours,
    },
  };
}

/** 同步並分析所有已啟用聯盟（可依 config.slateRefreshSports 只跑部分運動） */
async function runSlateModule(name, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[slate/${name}] 失敗:`, err.message);
    return { error: err.message };
  }
}

export async function slateFullRefresh() {
  const modules = new Set(config.slateRefreshSports);
  const result = { skipped: [], errors: [] };

  if (modules.has('baseball')) {
    const baseball = await runSlateModule('baseball', fullRefresh);
    if (baseball?.error) result.errors.push({ sport: 'baseball', message: baseball.error });
    result.baseball = baseball;
  } else {
    result.skipped.push('baseball');
  }
  if (modules.has('football')) {
    const football = await runSlateModule('football', footballFullRefresh);
    if (football?.error) result.errors.push({ sport: 'football', message: football.error });
    result.football = football;
  } else {
    result.skipped.push('football');
  }
  if (modules.has('basketball')) {
    const basketball = await runSlateModule('basketball', basketballFullRefresh);
    if (basketball?.error) result.errors.push({ sport: 'basketball', message: basketball.error });
    result.basketball = basketball;
  } else {
    result.skipped.push('basketball');
  }
  if (modules.has('tennis')) {
    const tennis = await runSlateModule('tennis', tennisFullRefresh);
    if (tennis?.error) result.errors.push({ sport: 'tennis', message: tennis.error });
    result.tennis = tennis;
  } else {
    result.skipped.push('tennis');
  }

  if (result.skipped.length) {
    console.log(`[slate] 略過同步: ${result.skipped.join(', ')}（SLATE_REFRESH_SPORTS）`);
  }

  return {
    ...result,
    totalRecommendations:
      (result.baseball?.recommendationCount ?? 0) +
      (result.football?.analysis?.recommendations ?? 0) +
      (result.basketball?.analysis?.recommendations ?? 0) +
      (result.tennis?.analysis?.recommendations ?? 0),
  };
}

export function getSlateStatus() {
  const gameCounts = db
    .prepare(
      `SELECT league, COUNT(1) as cnt FROM games
       WHERE ${ALL_SLATE_LEAGUE_PRED}
         AND completed = 0
         AND ${activeGameWhere()}
       GROUP BY league`
    )
    .all();

  const recCounts = db
    .prepare(
      `SELECT league, COUNT(1) as cnt FROM recommendations
       WHERE ${ALL_SLATE_LEAGUE_PRED}
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
      basketball: BASKETBALL_LEAGUE_CODES.map((c) => ({
        code: c,
        name: BASKETBALL_LEAGUES[c].name,
      })),
      tennis: 'ATP/WTA active keys（動態）',
    },
  };
}
