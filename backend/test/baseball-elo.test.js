import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEloToLambdas,
  eloHomeWinProb,
  eloToStrength,
  expectedScore,
  updatePairElo,
  ELO_DEFAULT,
} from '../src/services/BaseballElo.js';

test('expectedScore：同 Elo 約 50%', () => {
  assert.ok(Math.abs(expectedScore(1500, 1500) - 0.5) < 1e-9);
});

test('eloHomeWinProb：主場加成抬高主勝', () => {
  const p = eloHomeWinProb(1500, 1500);
  assert.ok(p > 0.5);
  assert.ok(p < 0.56);
});

test('updatePairElo：主隊獲勝後 Elo 上升', () => {
  const next = updatePairElo(1500, 1500, 5, 2);
  assert.ok(next.homeElo > 1500);
  assert.ok(next.awayElo < 1500);
  assert.equal(next.actualHome, 1);
});

test('applyEloToLambdas：強主隊抬高主得分、壓縮總分', () => {
  const strong = applyEloToLambdas(4, 4, 1650, 1400);
  const even = applyEloToLambdas(4, 4, 1500, 1500);
  assert.ok(strong.homeRuns > even.homeRuns);
  assert.ok(strong.awayRuns < even.awayRuns);
  assert.ok(strong.modelTotal < even.modelTotal);
  assert.ok(strong.shrink > 0);
});

test('eloToStrength：高 Elo 對應較高實力', () => {
  assert.ok(eloToStrength(1600) > eloToStrength(ELO_DEFAULT));
  assert.ok(eloToStrength(1400) < 0.5);
});
