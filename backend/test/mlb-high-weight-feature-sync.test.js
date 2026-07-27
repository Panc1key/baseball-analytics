import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getHighWeightFeatureCoverage,
  listCompletePitGameIds,
} from '../src/services/MlbHighWeightFeatureSync.js';

test('高權重覆蓋率報告包含季別與同步缺口', () => {
  const coverage = getHighWeightFeatureCoverage();
  assert.ok(Array.isArray(coverage.seasons));
  assert.ok(Number.isFinite(coverage.completePitSnapshots));
  assert.ok(Number.isFinite(coverage.featureRowsNeedingPitSync));
  assert.ok(coverage.note.includes('PIT'));
});

test('complete PIT game id 列表可讀', () => {
  const ids = listCompletePitGameIds();
  assert.ok(Array.isArray(ids));
  const needing = listCompletePitGameIds({ onlyMissingFeatureSync: true });
  assert.ok(Array.isArray(needing));
  assert.ok(needing.length <= ids.length);
});
