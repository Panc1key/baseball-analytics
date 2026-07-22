import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMlbCalibration,
  fitPlattCalibration,
  probabilityMetrics,
  runMlbModelValidation,
} from '../src/services/MlbModelValidation.js';

test('概率指標包含 Brier、LogLoss 與 ECE', () => {
  const metrics = probabilityMetrics([
    { p: 0.8, y: 1 },
    { p: 0.7, y: 1 },
    { p: 0.3, y: 0 },
    { p: 0.2, y: 0 },
  ]);
  assert.equal(metrics.samples, 4);
  assert.ok(metrics.brier < 0.1);
  assert.ok(metrics.logLoss < 0.4);
  assert.ok(Number.isFinite(metrics.ece));
  assert.ok(metrics.calibrationBins.length > 0);
});

test('Platt 校準樣本不足時必須退回 identity', () => {
  const calibration = fitPlattCalibration([
    { p: 0.6, y: 1 },
    { p: 0.4, y: 0 },
  ]);
  assert.equal(calibration.method, 'identity');
  assert.equal(applyMlbCalibration(0.63, calibration), 0.63);
});

test('Platt 校準不允許輸出極端或非法概率', () => {
  const points = Array.from({ length: 80 }, (_, index) => ({
    p: index % 2 ? 0.8 : 0.2,
    y: index % 2 ? 1 : 0,
  }));
  const calibration = fitPlattCalibration(points, { epochs: 100 });
  const probability = applyMlbCalibration(0.8, calibration);
  assert.ok(probability > 0 && probability < 1);
  assert.ok(Number.isFinite(probability));
});

test('模型驗證嚴格分離 selection、calibration 與 final test', () => {
  const run = runMlbModelValidation({ persist: false });
  const split = run.summary.split;
  assert.ok(Date.parse(split.train.to) <= Date.parse(split.selection.from));
  assert.ok(Date.parse(split.selection.to) < Date.parse(split.calibration.from));
  assert.ok(Date.parse(split.calibration.to) < Date.parse(split.finalTest.from));
  assert.ok(run.summary.deploymentDecision);
  assert.equal(typeof run.summary.deploymentDecision.eligible, 'boolean');
  assert.ok(run.summary.rollingFolds.length >= 1);
});
