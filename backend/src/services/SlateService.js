/**
 * 跨聯盟按日 Slate — 棒/足/籃/網 初盤推薦聚合（香港時區）
 */
import db from '../db/database.js';
import { config, BASEBALL_LEAGUE_SQL, LEAGUES } from '../config.js';
import { FOOTBALL_LEAGUES, FOOTBALL_LEAGUE_CODES } from '../football/config.js';
import { BASKETBALL_LEAGUES, BASKETBALL_LEAGUE_CODES } from '../basketball/config.js';
import { TENNIS_LEAGUE_SQL, isTennisLeagueCode } from '../tennis/config.js';
import {
  activeGameWhere,
  slateDisplayGameWhere,
  isGameStarted,
} from '../utils/activeGames.js';
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

/** @returns {string|null} SQL fragment on `league` column, or null = 全部運動 */
function sportLeaguePredicate(sport, column = 'league') {
  const s = String(sport || '').toLowerCase().trim();
  if (!s || s === 'all') return null;
  if (s === 'baseball') return `${column} IN (${BASEBALL_LEAGUE_SQL})`;
  if (s === 'football') return `${column} IN (${FOOTBALL_LEAGUE_SQL})`;
  if (s === 'basketball') return `${column} IN (${BASKETBALL_LEAGUE_SQL})`;
  if (s === 'tennis') return TENNIS_LEAGUE_SQL.replace(/\bleague\b/g, column);
  return null;
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
    sport,
    minEv = 0,
    tier,
    marketGroup,
  } = filters;

  const localDateExpr = sqliteLocalDateExpr('g.commence_time', 8);
  const sportPred = sportLeaguePredicate(sport, 'r.league');
  let sql = `
    SELECT r.*, g.home_team, g.away_team, g.commence_time, g.completed
    FROM recommendations r
    JOIN games g ON g.id = r.game_id
    WHERE ${ALL_SLATE_LEAGUE_PRED.replace(/\bleague\b/g, 'r.league')}
      AND IFNULL(r.phase, 'prematch') = 'prematch'
      AND r.ev >= ?
      AND g.completed = 0
      AND ${slateDisplayGameWhere('g')}
  `;
  const params = [minEv];
  if (config.mlbTruthResearchOnly) {
    sql += " AND r.league != 'MLB'";
  }

  if (sportPred) {
    sql += ` AND (${sportPred})`;
  }
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

function summarizeDay(picks, gameCount = null) {
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

  const uniqueGames = gameCount ?? new Set(picks.map((p) => p.game_id)).size;

  return {
    count: picks.length,
    gameCount: uniqueGames,
    byLeague,
    bySport,
    flatCount,
    anchorCount,
    totalSuggestedStake: Math.round(totalSuggestedStake),
  };
}

function matchupKey(p) {
  return [
    p.league,
    p.local_date || '',
    p.away_team || '',
    p.home_team || '',
  ].join('|');
}

function pickDedupeKey(p) {
  return [p.market, p.pick, p.line ?? ''].join('|');
}

/**
 * 同場多盤口合併；同對戰不同 game_id 也合併，避免列表看起來像很多場
 */
export function groupPicksByGame(picks) {
  const byMatchup = new Map();
  for (const p of picks) {
    const key = matchupKey(p);
    if (!byMatchup.has(key)) byMatchup.set(key, []);
    byMatchup.get(key).push(p);
  }

  const groups = [];
  for (const bucket of byMatchup.values()) {
    const byPick = new Map();
    for (const p of bucket) {
      const dk = pickDedupeKey(p);
      const prev = byPick.get(dk);
      if (
        !prev ||
        (p.ev ?? 0) > (prev.ev ?? 0) ||
        ((p.ev ?? 0) === (prev.ev ?? 0) &&
          (p.actionable_score ?? 0) > (prev.actionable_score ?? 0))
      ) {
        byPick.set(dk, p);
      }
    }
    const merged = [...byPick.values()].sort(
      (a, b) =>
        (a.pick_rank ?? 99) - (b.pick_rank ?? 99) ||
        (b.actionable_score ?? 0) - (a.actionable_score ?? 0) ||
        (b.ev ?? 0) - (a.ev ?? 0)
    );
    const head = merged[0];
    if (!head) continue;
    groups.push({
      game_id: head.game_id,
      league: head.league,
      league_name: head.league_name,
      sport_category: head.sport_category,
      home_team: head.home_team,
      away_team: head.away_team,
      commence_time: head.commence_time,
      local_date: head.local_date,
      local_time: head.local_time,
      is_started: head.is_started,
      is_live: head.is_live,
      pickCount: merged.length,
      picks: merged,
    });
  }

  groups.sort(
    (a, b) =>
      String(a.commence_time).localeCompare(String(b.commence_time)) ||
      String(a.away_team).localeCompare(String(b.away_team))
  );
  return groups;
}

function readMeta(key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

function writeMeta(key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
}

function collectUpdateTimes() {
  const keys = [
    ['slate', 'slate_last_refresh_at'],
    ['baseballSync', 'last_sync_at'],
    ['baseballAnalysis', 'last_analysis_at'],
    ['footballAnalysis', 'football_last_analysis_at'],
    ['basketballAnalysis', 'basketball_last_analysis_at'],
    ['tennisAnalysis', 'tennis_last_analysis_at'],
  ];
  const times = {};
  let latest = null;
  for (const [name, key] of keys) {
    const v = readMeta(key);
    times[name] = v;
    if (v && (!latest || v > latest)) latest = v;
  }
  return { ...times, latest };
}

/** 有盤口但可能尚無推薦的場次（避免列表空白） */
function querySlateShellGames({ fromDate, toDate, sport }) {
  const localDateExpr = sqliteLocalDateExpr('g.commence_time', 8);
  const sportPred = sportLeaguePredicate(sport, 'g.league');
  const sportClause = sportPred ? ` AND (${sportPred})` : '';
  return db
    .prepare(
      `
    SELECT g.id as game_id, g.league, g.home_team, g.away_team, g.commence_time, g.completed
    FROM games g
    WHERE ${ALL_SLATE_LEAGUE_PRED.replace(/\bleague\b/g, 'g.league')}
      AND g.completed = 0
      AND ${slateDisplayGameWhere('g')}
      AND g.raw_odds IS NOT NULL
      AND length(g.raw_odds) > 10
      AND ${localDateExpr} >= ?
      AND ${localDateExpr} <= ?
      ${sportClause}
    ORDER BY g.commence_time ASC
  `
    )
    .all(fromDate, toDate)
    .map((g) => ({
      game_id: g.game_id,
      league: g.league,
      league_name: LEAGUE_DISPLAY_NAMES[g.league] || g.league,
      sport_category: sportCategory(g.league),
      home_team: g.home_team,
      away_team: g.away_team,
      commence_time: g.commence_time,
      local_date: toLocalDateKey(g.commence_time),
      local_time: formatLocalTime(g.commence_time),
      is_started: isGameStarted(g.commence_time, g.completed),
      is_live: false,
      pickCount: 0,
      picks: [],
      no_picks: true,
    }));
}

function mergeShellGames(gamesWithPicks, shellGames) {
  const seen = new Set(gamesWithPicks.map((g) => matchupKey(g)));
  const extra = [];
  for (const g of shellGames) {
    const key = matchupKey(g);
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(g);
  }
  return [...gamesWithPicks, ...extra].sort(
    (a, b) =>
      String(a.commence_time).localeCompare(String(b.commence_time)) ||
      String(a.away_team).localeCompare(String(b.away_team))
  );
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
  const shellGames = filters.betStrategy
    ? []
    : querySlateShellGames({ fromDate, toDate, sport: filters.sport });

  const byDate = new Map();
  for (const p of picks) {
    const key = p.local_date || toLocalDateKey(p.commence_time);
    if (!key) continue;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(p);
  }

  const shellByDate = new Map();
  for (const g of shellGames) {
    const key = g.local_date;
    if (!key) continue;
    if (!shellByDate.has(key)) shellByDate.set(key, []);
    shellByDate.get(key).push(g);
  }

  const dates = [];
  let cursor = fromDate;
  let totalGames = 0;
  while (cursor <= toDate) {
    const dayPicks = byDate.get(cursor) || [];
    const games = mergeShellGames(
      groupPicksByGame(dayPicks),
      shellByDate.get(cursor) || []
    );
    totalGames += games.length;
    dates.push({
      date: cursor,
      label: formatLocalDateLabel(cursor),
      isToday: cursor === todayLocalDateKey(),
      picks: dayPicks,
      games,
      summary: summarizeDay(dayPicks, games.length),
    });
    cursor = addDaysToDateKey(cursor, 1);
  }

  const allGames = mergeShellGames(groupPicksByGame(picks), shellGames);
  const allSummary = summarizeDay(picks, allGames.length);
  const updated = collectUpdateTimes();

  return {
    timezone: HK_TIMEZONE,
    from: fromDate,
    to: toDate,
    dates,
    totalPicks: picks.length,
    totalGames: allGames.length || totalGames,
    summary: allSummary,
    updatedAt: updated.latest,
    updateTimes: updated,
    note: '美職晚場在香港時間常落在「明天」；已開賽 1 小時內仍會顯示／補算初盤。',
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

/** 同步並分析（可指定 sports；未指定則用 config.slateRefreshSports） */
async function runSlateModule(name, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[slate/${name}] 失敗:`, err.message);
    return { error: err.message };
  }
}

const VALID_SLATE_SPORTS = new Set(['baseball', 'football', 'basketball', 'tennis', 'live']);

/**
 * @param {{ sports?: string[] }} [options]
 * sports 例：['baseball'] — 只跑棒球初盤；含 'live' 時棒球模組一併跑滾球
 */
export async function slateFullRefresh(options = {}) {
  const requested = Array.isArray(options.sports)
    ? options.sports.map((s) => String(s).toLowerCase().trim()).filter(Boolean)
    : null;
  const modules = new Set(
    (requested?.length ? requested : config.slateRefreshSports).filter((s) =>
      VALID_SLATE_SPORTS.has(s)
    )
  );
  // live 依附棒球資料；單獨要求 live 時仍要能跑滾球分析
  const wantLive = modules.has('live');
  const wantBaseball = modules.has('baseball') || wantLive;
  const result = { skipped: [], errors: [], sports: [...modules] };

  console.log(`[slate] 本次同步範圍: ${[...modules].join(', ') || '(空)'}`);

  if (wantBaseball) {
    // 今日推薦只要初盤；滾球頁傳 sports=['live'] 才附帶滾球分析
    const baseball = await runSlateModule('baseball', () =>
      fullRefresh({ includeLive: wantLive, leagueCodes: ['MLB'] })
    );
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
    console.log(`[slate] 略過: ${result.skipped.join(', ')}`);
  }

  writeMeta('slate_last_refresh_at', new Date().toISOString());

  return {
    ...result,
    updatedAt: readMeta('slate_last_refresh_at'),
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

  const updated = collectUpdateTimes();

  return {
    timezone: HK_TIMEZONE,
    horizonHours: config.upcomingGameHorizonHours,
    slateDays: config.slateDefaultDays,
    updatedAt: updated.latest,
    updateTimes: updated,
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
