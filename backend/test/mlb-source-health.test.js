import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isMlbEvidenceVersionAllowed,
  runMlbDataSourceHealthAudit,
} from '../src/services/MlbDataSourceHealth.js';

test('錯誤傷兵 evidence v1 必須被隔離', () => {
  assert.equal(isMlbEvidenceVersionAllowed('mlb-prematch-evidence-v1'), false);
  assert.equal(isMlbEvidenceVersionAllowed('mlb-prematch-evidence-v2'), true);
  assert.equal(isMlbEvidenceVersionAllowed(null), false);
});

test('MLB 資料源健康檢查阻止語意與時點污染', () => {
  const report = runMlbDataSourceHealthAudit({ persist: false });
  const byKey = Object.fromEntries(report.checks.map((item) => [item.key, item]));
  assert.equal(byKey.completed_scores.status, 'passed');
  assert.equal(byKey.post_start_odds_label.status, 'passed');
  assert.equal(byKey.feature_outcome_consistency.status, 'passed');
  assert.equal(byKey.injury_evidence_v2_semantics.status, 'passed');
  assert.ok(byKey.legacy_injury_evidence_quarantine.value.quarantinedSnapshots > 0);
  assert.notEqual(report.status, 'failed');
});
