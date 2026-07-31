import db from '../src/db/database.js';

const counts = db.prepare(`
  SELECT
    substr(g.commence_time, 1, 4) AS season,
    COUNT(DISTINCT g.id) AS games,
    COUNT(DISTINCT o.id) AS snapshots
  FROM games g
  LEFT JOIN odds_snapshots o
    ON o.game_id = g.id
   AND datetime(o.captured_at) < datetime(g.commence_time)
  WHERE g.league = 'MLB'
    AND g.commence_time >= '2025-01-01'
  GROUP BY 1
  ORDER BY 1
`).all();
console.log(counts);
