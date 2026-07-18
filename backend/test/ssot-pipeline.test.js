import test from 'node:test';
import assert from 'node:assert/strict';

import { blendScoreWithLog5 } from '../src/models/GameScoreModel.js';
import { config } from '../src/config.js';
import { estimateCoverProbDetails } from '../src/utils/odds.js';
import { MODEL_PIPELINE_VERSION } from '../src/models/ModelPipeline.js';

test('SSOT：有 λ 時泊松權重不低於下限', () => {
  const out = blendScoreWithLog5({
    log5HomeProb: 0.4,
    homeRuns: 4.5,
    awayRuns: 3.5,
    hasMlbCore: false,
    hasPitchers: false,
    hasNpbStrength: true,
    rho: 0.05,
  });
  assert.ok(out.scoreHomeProb != null);
  assert.ok(out.scoreBlend >= (config.ssotPoissonMinWeight ?? 0.72));
  // 結果應更靠近泊松而非 Elo 先驗 0.4
  assert.ok(Math.abs(out.homeWinProb - out.scoreHomeProb) < Math.abs(out.homeWinProb - 0.4));
});

test('SSOT：讓分蓋盤可帶 ρ', () => {
  const a = estimateCoverProbDetails(0.55, 1.5, {
    homeRuns: 4,
    awayRuns: 3.5,
    pickIsHome: true,
    rho: 0,
  });
  const b = estimateCoverProbDetails(0.55, 1.5, {
    homeRuns: 4,
    awayRuns: 3.5,
    pickIsHome: true,
    rho: 0.08,
  });
  assert.ok(a.rawModelProb > 0.5);
  assert.notEqual(a.rawModelProb, b.rawModelProb);
});

test('ModelPipeline 版本含 SSOT', () => {
  assert.ok(MODEL_PIPELINE_VERSION.startsWith('baseball-v2.'));
});
