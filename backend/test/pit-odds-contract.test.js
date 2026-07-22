import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';

import db from '../src/db/database.js';
import {
  recordOddsSnapshot,
  resolvePitOdds,
} from '../src/services/PitOddsService.js';

function books(price = 1.9) {
  return [{
    key: 'test-book',
    title: 'Test Book',
    markets: [{
      key: 'h2h',
      outcomes: [
        { name: 'Home', price },
        { name: 'Away', price },
      ],
    }],
  }];
}

test('PIT resolver 只選開賽前最後快照並拒絕 post-start', () => {
  const gameId = `pit-${randomUUID()}`;
  const commenceTime = '2026-07-22T12:00:00.000Z';
  try {
    recordOddsSnapshot({
      gameId,
      league: 'MLB',
      commenceTime,
      capturedAt: '2026-07-22T10:00:00.000Z',
      bookmakers: books(1.8),
    });
    recordOddsSnapshot({
      gameId,
      league: 'MLB',
      commenceTime,
      capturedAt: '2026-07-22T11:30:00.000Z',
      bookmakers: books(1.9),
    });
    const post = recordOddsSnapshot({
      gameId,
      league: 'MLB',
      commenceTime,
      capturedAt: '2026-07-22T12:01:00.000Z',
      bookmakers: books(2.5),
    });

    assert.equal(post.isPrematch, false);
    assert.equal(post.source, 'odds_api_post_start');

    const result = resolvePitOdds(gameId, commenceTime);
    assert.equal(result.ok, true);
    assert.equal(result.capturedAt, '2026-07-22T11:30:00.000Z');
    assert.equal(result.bookmakers[0].markets[0].outcomes[0].price, 1.9);
  } finally {
    db.prepare('DELETE FROM odds_snapshots WHERE game_id = ?').run(gameId);
  }
});

test('PIT resolver 缺快照時失敗，禁止 fallback 到 games.raw_odds', () => {
  const gameId = `pit-${randomUUID()}`;
  const result = resolvePitOdds(gameId, '2026-07-22T12:00:00.000Z');
  assert.deepEqual(
    {
      ok: result.ok,
      reason: result.reason,
    },
    {
      ok: false,
      reason: 'no_pit_odds_snapshot',
    }
  );
});

test('PIT resolver 不接受 captured_at 等於開賽時間', () => {
  const gameId = `pit-${randomUUID()}`;
  const commenceTime = '2026-07-22T12:00:00.000Z';
  try {
    recordOddsSnapshot({
      gameId,
      league: 'MLB',
      commenceTime,
      capturedAt: commenceTime,
      bookmakers: books(),
    });
    const result = resolvePitOdds(gameId, commenceTime);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_pit_odds_snapshot');
  } finally {
    db.prepare('DELETE FROM odds_snapshots WHERE game_id = ?').run(gameId);
  }
});
