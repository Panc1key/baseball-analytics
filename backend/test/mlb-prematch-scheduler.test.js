import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getDuePregameWindows,
  parseFixedSnapshotHours,
} from '../src/services/MlbPrematchScheduler.js';

test('固定 MLB 快照時段只接受合法且去重的 24 小時制', () => {
  assert.deepEqual(
    parseFixedSnapshotHours('5,1,3,13,15,17,17,99,nope'),
    [1, 3, 5, 13, 15, 17]
  );
});

test('僅在賽前窗口與寬限期內建立快照工作', () => {
  const game = { id: 'mlb-game-1', commence_time: '2026-07-21T01:00:00Z' };

  const due = getDuePregameWindows([game], {
    now: new Date('2026-07-20T23:30:04Z'),
    windowsMinutes: [90, 30],
    graceMinutes: 12,
  });
  assert.deepEqual(due.map((item) => item.runKey), ['window:mlb-game-1:T-90']);

  const tooLate = getDuePregameWindows([game], {
    now: new Date('2026-07-20T23:43:00Z'),
    windowsMinutes: [90],
    graceMinutes: 12,
  });
  assert.equal(tooLate.length, 0);
});

test('開賽後不會建立任何賽前快照工作', () => {
  const due = getDuePregameWindows(
    [{ id: 'mlb-game-2', commence_time: '2026-07-21T01:00:00Z' }],
    {
      now: new Date('2026-07-21T01:00:01Z'),
      windowsMinutes: [5],
      graceMinutes: 12,
    }
  );
  assert.equal(due.length, 0);
});
