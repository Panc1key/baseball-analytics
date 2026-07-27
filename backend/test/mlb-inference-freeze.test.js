import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MLB_INFERENCE_FREEZE,
  describeMlbInferenceFreeze,
} from '../src/services/MlbInferenceFreeze.js';
import { config } from '../src/config.js';

test('MLB 推理骨架凍結契約存在且與 config 對齊', () => {
  assert.equal(MLB_INFERENCE_FREEZE.skeleton, 'expected-runs-score-distribution');
  assert.equal(MLB_INFERENCE_FREEZE.formalPredictor, 'predictMlbGameRuns');
  assert.equal(
    MLB_INFERENCE_FREEZE.auditOnlyPredictor,
    'predictMlbGameRunsWithRegime'
  );
  assert.equal(config.mlbInferenceSkeleton, MLB_INFERENCE_FREEZE.skeleton);
  assert.equal(config.mlbTruthResearchOnly, true);
  assert.equal(config.mlbBaselineShadowEnabled, false);
  const described = describeMlbInferenceFreeze();
  assert.match(described.rule, /ExpectedRuns/);
});
