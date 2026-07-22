import db from '../src/db/database.js';

const from = process.argv[2] || '2026-04-01';
const base = db.prepare(`
  SELECT COUNT(*) AS games,
         MIN(commence_time) AS firstGame,
         MAX(commence_time) AS lastGame
  FROM games
  WHERE league = 'MLB'
    AND completed = 1
    AND datetime(commence_time) >= datetime(?)
`).get(from);

const coverage = db.prepare(`
  SELECT COUNT(DISTINCT g.id) AS coveredGames
  FROM games g
  JOIN odds_snapshots o
    ON o.game_id = g.id
   AND datetime(o.captured_at) < datetime(g.commence_time)
   AND o.source != 'odds_api_post_start'
  WHERE g.league = 'MLB'
    AND g.completed = 1
    AND datetime(g.commence_time) >= datetime(?)
`).get(from);

const sources = db.prepare(`
  SELECT o.source,
         COUNT(*) AS snapshots,
         COUNT(DISTINCT o.game_id) AS games,
         ROUND(AVG((julianday(g.commence_time) - julianday(o.captured_at)) * 24), 2)
           AS avgLeadHours,
         ROUND(MIN((julianday(g.commence_time) - julianday(o.captured_at)) * 24), 2)
           AS minLeadHours,
         ROUND(MAX((julianday(g.commence_time) - julianday(o.captured_at)) * 24), 2)
           AS maxLeadHours
  FROM odds_snapshots o
  JOIN games g ON g.id = o.game_id
  WHERE g.league = 'MLB'
    AND g.completed = 1
    AND datetime(g.commence_time) >= datetime(?)
    AND datetime(o.captured_at) < datetime(g.commence_time)
    AND o.source != 'odds_api_post_start'
  GROUP BY o.source
  ORDER BY games DESC
`).all(from);

const months = db.prepare(`
  SELECT strftime('%Y-%m', g.commence_time) AS month,
         COUNT(DISTINCT g.id) AS totalGames,
         COUNT(DISTINCT CASE WHEN o.id IS NOT NULL THEN g.id END) AS pitGames
  FROM games g
  LEFT JOIN odds_snapshots o
    ON o.game_id = g.id
   AND datetime(o.captured_at) < datetime(g.commence_time)
   AND o.source != 'odds_api_post_start'
  WHERE g.league = 'MLB'
    AND g.completed = 1
    AND datetime(g.commence_time) >= datetime(?)
  GROUP BY month
  ORDER BY month
`).all(from);

console.log(JSON.stringify({
  from,
  ...base,
  coveredGames: coverage.coveredGames,
  coverageRatio: base.games ? coverage.coveredGames / base.games : null,
  sources,
  months,
}, null, 2));
