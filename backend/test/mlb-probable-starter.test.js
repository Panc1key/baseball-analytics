import test from 'node:test';
import assert from 'node:assert/strict';

import db from '../src/db/database.js';
import {
  recordMlbProbableStarterSnapshot,
  resolveMlbProbableStarterSnapshot,
} from '../src/services/MlbProbableStarterService.js';

const gameId = 'test-mlb-probable-starter';
const commenceTime = '2099-07-22T23:00:00.000Z';

test.before(() => {
  db.prepare(`
    INSERT OR IGNORE INTO games
      (id, league, commence_time, home_team, away_team, completed)
    VALUES (?, 'MLB', ?, 'Home Test', 'Away Test', 0)
  `).run(gameId, commenceTime);
});

test.after(() => {
  db.prepare('DELETE FROM mlb_probable_starter_snapshots WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM games WHERE id = ?').run(gameId);
});

test('probable starter 只接受嚴格早於開賽的官方快照', () => {
  const rejected = recordMlbProbableStarterSnapshot({
    gameId,
    commenceTime,
    capturedAt: commenceTime,
    pitchers: {
      home: { id: 1, name: 'Home Starter' },
      away: { id: 2, name: 'Away Starter' },
    },
  });
  assert.deepEqual(rejected, {
    ok: false,
    reason: 'starter_snapshot_not_prematch',
  });
});

test('probable starter resolver 取最後一筆完整賽前身份', () => {
  recordMlbProbableStarterSnapshot({
    gameId,
    commenceTime,
    capturedAt: '2099-07-22T20:00:00.000Z',
    pitchers: {
      home: { id: 1, name: 'Old Home Starter' },
      away: { id: 2, name: 'Away Starter' },
    },
  });
  recordMlbProbableStarterSnapshot({
    gameId,
    commenceTime,
    capturedAt: '2099-07-22T22:00:00.000Z',
    pitchers: {
      home: { id: 3, name: 'Updated Home Starter' },
      away: { id: 2, name: 'Away Starter' },
    },
  });

  const resolved = resolveMlbProbableStarterSnapshot(gameId, commenceTime);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.status, 'complete');
  assert.deepEqual(resolved.home, { id: 3, name: 'Updated Home Starter' });
  assert.deepEqual(resolved.away, { id: 2, name: 'Away Starter' });
  assert.equal(resolved.capturedAt, '2099-07-22T22:00:00.000Z');
});
