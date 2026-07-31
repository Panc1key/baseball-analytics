import db from '../src/db/database.js';

console.log(
  db.prepare('PRAGMA table_info(games)').all().map((c) => c.name).join(', ')
);
const g = db.prepare('SELECT * FROM games WHERE league = ? LIMIT 1').get('MLB');
console.log(Object.keys(g || {}));
console.log({
  venue: g?.venue,
  venue_name: g?.venue_name,
  home: g?.home_team,
  raw_keys_sample: g ? Object.fromEntries(
    Object.entries(g).filter(([k]) => /venue|park|stadium/i.test(k))
  ) : null,
});
