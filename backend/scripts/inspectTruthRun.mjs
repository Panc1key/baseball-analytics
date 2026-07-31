import db from '../src/db/database.js';

const runId = process.argv[2] || 'truth-35de4609-cf87-45d1-9669-1a2a4f210356';
const rows = db
  .prepare(
    `
  SELECT t.home_team, t.away_team, t.mandatory_complete, t.gate_status, t.gate_reasons_json,
         t.source_versions_json, c.status AS candidate_status, c.rejection_reasons_json,
         c.model_version
  FROM mlb_prematch_truth_snapshots t
  LEFT JOIN mlb_paper_candidates c ON c.truth_snapshot_id = t.id
  WHERE t.run_id = ?
  ORDER BY t.commence_time
`
  )
  .all(runId);

const summary = {
  n: rows.length,
  mandatoryOk: rows.filter((r) => r.mandatory_complete === 1).length,
  gate: {},
  candidate: {},
  hasBaselineReason: 0,
  hasPitcherInGate: 0,
  modelVersions: [
    ...new Set(
      rows.map((r) => {
        try {
          return JSON.parse(r.source_versions_json || '{}').model;
        } catch {
          return null;
        }
      })
    ),
  ],
  samples: rows.slice(0, 8).map((r) => ({
    matchup: `${r.away_team} @ ${r.home_team}`,
    mandatory: r.mandatory_complete,
    gate: r.gate_status,
    gateReasons: JSON.parse(r.gate_reasons_json || '[]'),
    candidate: r.candidate_status,
    reject: JSON.parse(r.rejection_reasons_json || '[]').slice(0, 8),
    modelVersion: r.model_version,
  })),
};

for (const r of rows) {
  summary.gate[r.gate_status] = (summary.gate[r.gate_status] || 0) + 1;
  summary.candidate[r.candidate_status || 'none'] =
    (summary.candidate[r.candidate_status || 'none'] || 0) + 1;
  const gr = JSON.parse(r.gate_reasons_json || '[]');
  if (gr.some((x) => String(x).includes('baseline'))) summary.hasBaselineReason += 1;
  if (gr.some((x) => String(x).includes('starting_pitchers'))) summary.hasPitcherInGate += 1;
}

console.log(JSON.stringify(summary, null, 2));
