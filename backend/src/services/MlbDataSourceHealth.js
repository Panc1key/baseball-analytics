import { randomUUID } from 'crypto';
import db from '../db/database.js';

const INVALID_EVIDENCE_VERSIONS = new Set(['mlb-prematch-evidence-v1']);

export function isMlbEvidenceVersionAllowed(version) {
  return Boolean(version) && !INVALID_EVIDENCE_VERSIONS.has(version);
}

export function repairMlbOddsSourceLabels() {
  const result = db.prepare(`
    UPDATE odds_snapshots
    SET source = source || '_post_start'
    WHERE id IN (
      SELECT o.id
      FROM odds_snapshots o
      JOIN games g ON g.id = o.game_id
      WHERE g.league = 'MLB'
        AND datetime(o.captured_at) >= datetime(g.commence_time)
        AND o.source NOT LIKE '%_post_start'
    )
  `).run();
  return { relabeled: result.changes };
}

function check(key, status, value, detail) {
  return { key, status, value, detail };
}

function sourceVersion(row) {
  try {
    return JSON.parse(row.source_versions_json || '{}').evidence || null;
  } catch {
    return null;
  }
}

function injuryEvidence(row) {
  try {
    const evidence = JSON.parse(row.evidence_json || '[]');
    return evidence.find((item) => item.key === 'injuries') || null;
  } catch {
    return null;
  }
}

function auditInjuryEvidence() {
  const rows = db.prepare(`
    SELECT id, source_versions_json, evidence_json, model_input_json, gate_status
    FROM mlb_prematch_truth_snapshots
  `).all();
  let invalidVersion = 0;
  let activePlayersMisclassified = 0;
  let currentVersionRows = 0;
  let currentVersionInvalidStatuses = 0;
  let replayableVersionRows = 0;
  let replayableVersionMissingInput = 0;
  for (const row of rows) {
    const version = sourceVersion(row);
    const injuries = injuryEvidence(row);
    if (!isMlbEvidenceVersionAllowed(version)) invalidVersion += 1;
    if (['mlb-prematch-evidence-v2', 'mlb-prematch-evidence-v3', 'mlb-prematch-evidence-v4'].includes(version)) {
      currentVersionRows += 1;
    }
    if (
      ['mlb-prematch-evidence-v3', 'mlb-prematch-evidence-v4'].includes(version) &&
      row.gate_status === 'research_ready'
    ) {
      replayableVersionRows += 1;
      if (!row.model_input_json) replayableVersionMissingInput += 1;
    }
    const entries = [
      ...(injuries?.values?.home || []),
      ...(injuries?.values?.away || []),
    ];
    if (entries.some((entry) => entry.status === 'Active')) {
      activePlayersMisclassified += 1;
    }
    if (
      ['mlb-prematch-evidence-v2', 'mlb-prematch-evidence-v3', 'mlb-prematch-evidence-v4'].includes(version) &&
      entries.some((entry) => !String(entry.status || '').startsWith('Injured'))
    ) {
      currentVersionInvalidStatuses += 1;
    }
  }
  return {
    total: rows.length,
    invalidVersion,
    activePlayersMisclassified,
    currentVersionRows,
    currentVersionInvalidStatuses,
    replayableVersionRows,
    replayableVersionMissingInput,
  };
}

export function repairNonReplayableMlbTruthSnapshots() {
  const rows = db.prepare(`
    SELECT id, source_versions_json, gate_reasons_json
    FROM mlb_prematch_truth_snapshots
    WHERE gate_status = 'research_ready'
      AND model_input_json IS NULL
  `).all();
  const update = db.prepare(`
    UPDATE mlb_prematch_truth_snapshots
    SET mandatory_complete = 0,
        gate_status = 'blocked_data',
        gate_reasons_json = ?
    WHERE id = ?
  `);
  let repaired = 0;
  db.transaction(() => {
    for (const row of rows) {
      const version = sourceVersion(row);
      if (!['mlb-prematch-evidence-v3', 'mlb-prematch-evidence-v4'].includes(version)) {
        continue;
      }
      let reasons;
      try {
        reasons = JSON.parse(row.gate_reasons_json || '[]');
      } catch {
        reasons = [];
      }
      if (!reasons.includes('baseline_model_input:missing')) {
        reasons.push('baseline_model_input:missing');
      }
      update.run(JSON.stringify(reasons), row.id);
      repaired += 1;
    }
  })();
  return { inspected: rows.length, repaired };
}

function upsertKnownIncident(injuryAudit) {
  db.prepare(`
    INSERT INTO mlb_data_source_incidents
      (incident_key, source_name, affected_version, severity, status, description,
       detected_at, resolved_at)
    VALUES (
      'mlb-injury-roster-type-v1',
      'MLB Stats API roster',
      'mlb-prematch-evidence-v1',
      'blocking',
      'resolved',
      ?,
      datetime('now'),
      datetime('now')
    )
    ON CONFLICT(incident_key) DO UPDATE SET
      status = 'resolved',
      description = excluded.description,
      resolved_at = datetime('now')
  `).run(
    `rosterType=injuryList 回退 active roster；${injuryAudit.activePlayersMisclassified} 筆舊快照受影響。v1 已禁止作為傷兵證據。`
  );
}

export function runMlbDataSourceHealthAudit({ persist = true } = {}) {
  const completed = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN home_score IS NULL OR away_score IS NULL THEN 1 ELSE 0 END) AS missingScore,
           SUM(CASE WHEN home_score = away_score THEN 1 ELSE 0 END) AS tiedScore
    FROM games
    WHERE league = 'MLB' AND completed = 1
  `).get();
  const pitCoverage = db.prepare(`
    SELECT COUNT(DISTINCT g.id) AS total,
           COUNT(DISTINCT CASE WHEN o.id IS NOT NULL THEN g.id END) AS covered
    FROM games g
    LEFT JOIN odds_snapshots o
      ON o.game_id = g.id
     AND datetime(o.captured_at) < datetime(g.commence_time)
     AND o.source NOT LIKE '%_post_start'
    WHERE g.league = 'MLB'
      AND g.completed = 1
      AND datetime(g.commence_time) >= datetime('2026-04-01')
  `).get();
  const mislabeledPostStartRows = db.prepare(`
    SELECT o.id, o.game_id AS gameId, o.captured_at AS capturedAt,
           g.commence_time AS commenceTime, o.source
    FROM odds_snapshots o
    JOIN games g ON g.id = o.game_id
    WHERE g.league = 'MLB'
      AND datetime(o.captured_at) >= datetime(g.commence_time)
      AND o.source NOT LIKE '%_post_start'
    ORDER BY datetime(o.captured_at) ASC
  `).all();
  const truthAfterStart = db.prepare(`
    SELECT COUNT(*) AS count
    FROM mlb_prematch_truth_snapshots
    WHERE datetime(captured_at) >= datetime(commence_time)
  `).get().count;
  const featureMismatch = db.prepare(`
    SELECT COUNT(*) AS count
    FROM mlb_historical_feature_rows f
    JOIN games g ON g.id = f.game_id
    WHERE f.home_win != CASE WHEN g.home_score > g.away_score THEN 1 ELSE 0 END
  `).get().count;
  const latestModel = db.prepare(`
    SELECT train_samples AS trainSamples, feature_version AS featureVersion
    FROM mlb_baseline_models
    ORDER BY id DESC
    LIMIT 1
  `).get();
  const currentFeatureRows = latestModel
    ? db.prepare(`
        SELECT COUNT(*) AS count
        FROM mlb_historical_feature_rows
        WHERE feature_version = ?
      `).get(latestModel.featureVersion).count
    : 0;
  const injuryAudit = auditInjuryEvidence();
  const starterSnapshotAudit = db.prepare(`
    SELECT
      COUNT(*) AS snapshots,
      COUNT(DISTINCT game_id) AS games,
      SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completeSnapshots,
      SUM(CASE WHEN datetime(captured_at) >= datetime(commence_time) THEN 1 ELSE 0 END)
        AS invalidPostStart
    FROM mlb_probable_starter_snapshots
  `).get();
  const coverageRatio = pitCoverage.total ? pitCoverage.covered / pitCoverage.total : 0;
  const checks = [
    check(
      'completed_scores',
      Number(completed.missingScore) === 0 && Number(completed.tiedScore) === 0
        ? 'passed'
        : 'failed',
      completed,
      '完賽 MLB 必須有非和局比分'
    ),
    check(
      'pit_odds_coverage',
      coverageRatio >= 0.98 ? 'passed' : coverageRatio >= 0.95 ? 'warning' : 'failed',
      { ...pitCoverage, ratio: coverageRatio },
      '4 月起完賽場次必須有 captured_at < commence_time 的賠率快照'
    ),
    check(
      'post_start_odds_label',
      mislabeledPostStartRows.length === 0 ? 'passed' : 'failed',
      {
        mislabeledPostStart: mislabeledPostStartRows.length,
        rows: mislabeledPostStartRows,
      },
      '開賽後快照必須標記 odds_api_post_start'
    ),
    check(
      'truth_snapshot_time',
      Number(truthAfterStart) === 0 ? 'passed' : 'warning',
      { truthAfterStart },
      '開賽後 truth snapshot 不得用於 PIT 回放'
    ),
    check(
      'probable_starter_snapshot_time',
      Number(starterSnapshotAudit.invalidPostStart) > 0
        ? 'failed'
        : Number(starterSnapshotAudit.completeSnapshots) > 0
          ? 'passed'
          : 'warning',
      starterSnapshotAudit,
      '模型先發身份只接受開賽前保存的完整 probable starter 快照'
    ),
    check(
      'feature_outcome_consistency',
      Number(featureMismatch) === 0 ? 'passed' : 'failed',
      { featureMismatch },
      '歷史 feature row 的 label 必須與 games 比分一致'
    ),
    check(
      'deployment_training_regime',
      latestModel && Number(latestModel.trainSamples) === Number(currentFeatureRows)
        ? 'passed'
        : 'failed',
      { latestModel, currentFeatureRows },
      '部署研究模型必須使用目前 feature version 的全部歷史列重訓'
    ),
    check(
      'injury_evidence_v2_semantics',
      injuryAudit.currentVersionInvalidStatuses === 0 &&
      injuryAudit.currentVersionRows > 0
        ? 'passed'
        : 'failed',
      injuryAudit,
      'v2 傷兵證據只允許 40-man roster 的 Injured 狀態'
    ),
    check(
      'truth_model_input_replay',
      injuryAudit.replayableVersionRows > 0 &&
      injuryAudit.replayableVersionMissingInput === 0
        ? 'passed'
        : 'failed',
      {
        replayableVersionRows: injuryAudit.replayableVersionRows,
        missingModelInput: injuryAudit.replayableVersionMissingInput,
      },
      'v3 truth snapshot 必須持久化 feature vector 與原始模型概率'
    ),
    check(
      'legacy_injury_evidence_quarantine',
      injuryAudit.invalidVersion > 0 ? 'warning' : 'passed',
      {
        quarantinedSnapshots: injuryAudit.invalidVersion,
        invalidVersions: [...INVALID_EVIDENCE_VERSIONS],
      },
      'v1 快照保留審計但禁止作為傷兵證據'
    ),
  ];
  const status = checks.some((item) => item.status === 'failed')
    ? 'failed'
    : checks.some((item) => item.status === 'warning')
      ? 'warning'
      : 'passed';
  const run = {
    runId: `mlb-source-health-${randomUUID()}`,
    status,
    checks,
    createdAt: new Date().toISOString(),
  };
  if (persist) {
    upsertKnownIncident(injuryAudit);
    db.prepare(`
      INSERT INTO mlb_data_source_health_runs (run_id, status, checks_json)
      VALUES (?, ?, ?)
    `).run(run.runId, run.status, JSON.stringify(run.checks));
  }
  return run;
}

export function getLatestMlbDataSourceHealth() {
  const row = db.prepare(`
    SELECT run_id, status, checks_json, created_at
    FROM mlb_data_source_health_runs
    ORDER BY datetime(created_at) DESC, rowid DESC
    LIMIT 1
  `).get();
  if (!row) return null;
  return {
    runId: row.run_id,
    status: row.status,
    checks: JSON.parse(row.checks_json),
    createdAt: row.created_at,
    openIncidents: db.prepare(`
      SELECT incident_key, source_name, affected_version, severity, description, detected_at
      FROM mlb_data_source_incidents
      WHERE status = 'open'
      ORDER BY detected_at DESC
    `).all(),
  };
}
