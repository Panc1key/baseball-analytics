import db from '../src/db/database.js';
import { BASEBALL_LEAGUE_SQL } from '../src/config.js';
import { FOOTBALL_LEAGUE_CODES } from '../src/football/config.js';

const FOOTBALL_SQL = FOOTBALL_LEAGUE_CODES.map((c) => `'${c}'`).join(',');

function tonightGames(leagueSql) {
  return db
    .prepare(`
    SELECT id, league, home_team, away_team, commence_time
    FROM games
    WHERE league IN (${leagueSql})
      AND completed = 0
      AND datetime(commence_time) > datetime('now')
      AND datetime(commence_time) < datetime('now', '+18 hours')
    ORDER BY commence_time ASC
  `)
    .all();
}

function recsForGames(gameIds) {
  if (!gameIds.length) return [];
  const ph = gameIds.map(() => '?').join(',');
  return db
    .prepare(`
    SELECT r.game_id, r.league, r.market, r.pick, r.tier, r.ev, r.score,
           g.home_team, g.away_team, g.commence_time
    FROM recommendations r
    JOIN games g ON g.id = r.game_id
    WHERE r.game_id IN (${ph})
    ORDER BY g.commence_time, r.score DESC
  `)
    .all(...gameIds);
}

function auditSport(name, leagueSql) {
  const games = tonightGames(leagueSql);
  const gameIds = games.map((g) => g.id);
  const recs = recsForGames(gameIds);
  const recByGame = new Map();
  for (const r of recs) {
    if (!recByGame.has(r.game_id)) recByGame.set(r.game_id, []);
    recByGame.get(r.game_id).push(r);
  }

  const rows = games.map((g) => ({
    matchup: `${g.away_team} @ ${g.home_team}`,
    league: g.league,
    commence: g.commence_time,
    recCount: recByGame.get(g.id)?.length ?? 0,
    hasPrimary: recByGame.get(g.id)?.some((r) => r.tier === 'primary') ?? false,
    picks: (recByGame.get(g.id) || []).map((r) => `${r.market}:${r.pick}`),
  }));

  return {
    sport: name,
    gameCount: games.length,
    gamesWithRecs: rows.filter((r) => r.recCount > 0).length,
    gamesWithoutRecs: rows.filter((r) => r.recCount === 0).length,
    allCovered: rows.every((r) => r.recCount > 0),
    rows,
  };
}

const baseball = auditSport('baseball', BASEBALL_LEAGUE_SQL);
const football = auditSport('football', FOOTBALL_SQL);

console.log(JSON.stringify({ baseball, football, checkedAt: new Date().toISOString() }, null, 2));
