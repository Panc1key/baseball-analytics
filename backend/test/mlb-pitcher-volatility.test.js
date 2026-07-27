import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeRecentStartLines } from '../src/services/MlbStatsService.js';
import { resolvePitcherStartVolatility } from '../src/services/MlbGameRegimeService.js';

test('逐場線：提早退場與爆分計數', () => {
  const vol = summarizeRecentStartLines([
    { stat: { inningsPitched: '3.1', earnedRuns: 5 } },
    { stat: { inningsPitched: '6.0', earnedRuns: 1 } },
    { stat: { inningsPitched: '4.2', earnedRuns: 4 } },
  ]);
  assert.equal(vol.earlyExitsLast3, 1);
  assert.equal(vol.blowupStartsLast3, 2);
  assert.ok(vol.minIpLast3 < 4);
  assert.equal(vol.maxErLast3, 5);
});

test('舊聚合列可用代理推估波動', () => {
  const proxy = resolvePitcherStartVolatility({
    startsObserved: 3,
    recent3Innings: 9,
    recent3Era: 7.2,
  });
  assert.equal(proxy.source, 'proxy');
  assert.ok(proxy.earlyExitsLast3 >= 1);
  assert.ok(proxy.blowupStartsLast3 >= 1);

  const explicit = resolvePitcherStartVolatility({
    startsObserved: 3,
    recent3Innings: 18,
    recent3Era: 2.5,
    earlyExitsLast3: 0,
    blowupStartsLast3: 0,
  });
  assert.equal(explicit.source, 'explicit');
  assert.equal(explicit.earlyExitsLast3, 0);
});
