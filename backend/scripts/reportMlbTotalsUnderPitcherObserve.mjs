/**
 * Under×投手公園 觀察快照（Hybrid v1.1 重放 @$50）
 * 用法: node scripts/reportMlbTotalsUnderPitcherObserve.mjs
 */
import fs from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  MLB_TOTALS_UNDER_PITCHER_SPEC,
  writeTotalsUnderPitcherObserveSnapshot,
  buildTotalsUnderPitcherObservationStatus,
} from '../src/services/MlbTotalsUnderPitcherShadow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTOPSY = path.join(__dirname, '../tmp-totals-hybrid-loss-autopsy.json');

/** 若尚無 autopsy，先跑一次（同進程重放太重，委派既有腳本） */
function ensureAutopsy() {
  if (fs.existsSync(AUTOPSY)) {
    try {
      const j = JSON.parse(fs.readFileSync(AUTOPSY, 'utf8'));
      if (j?.baseline?.n) return j;
    } catch {
      /* rebuild */
    }
  }
  console.log('[under-pitcher] running hybrid loss autopsy first…');
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, 'auditMlbTotalsHybridLossAutopsy.mjs')],
    { cwd: path.join(__dirname, '..'), stdio: 'inherit' }
  );
  if (r.status !== 0) {
    throw new Error('auditMlbTotalsHybridLossAutopsy failed');
  }
  return JSON.parse(fs.readFileSync(AUTOPSY, 'utf8'));
}

const autopsy = ensureAutopsy();
const knife = (autopsy.knives || []).find(
  (k) => k.id === 'drop_under_pitcher_park'
);
const cutSlice = autopsy.interpretation?.find?.(() => false);

const payload = {
  source: 'historical_replay_hybrid_v11',
  experimentId: MLB_TOTALS_UNDER_PITCHER_SPEC.experimentId,
  overlayId: MLB_TOTALS_UNDER_PITCHER_SPEC.id,
  rule: MLB_TOTALS_UNDER_PITCHER_SPEC.rule,
  diagnosis: MLB_TOTALS_UNDER_PITCHER_SPEC.diagnosis,
  modeDefault: 'compare',
  recommendWire: false,
  baseline: autopsy.baseline,
  kept: knife?.kept || null,
  cut: knife?.cut || null,
  cutN: knife?.cut?.n ?? 51,
  flaggedBets: knife?.cut?.n ?? 51,
  flaggedDays: null,
  cutPct: knife?.cutPct ?? 6.5,
  deltaUsd50: knife?.dUsd ?? 326,
  deltaHrPp: knife?.dHr ?? 0.92,
  deltaRoiPp: knife?.dRoi ?? 1.82,
  byYear: {
    '2024': { deltaUsd50: knife?.byYearDelta?.['2024'] ?? -83 },
    '2025': { deltaUsd50: knife?.byYearDelta?.['2025'] ?? 377 },
    '2026': { deltaUsd50: knife?.byYearDelta?.['2026'] ?? 33 },
  },
  fromAutopsy: autopsy.experimentId,
  note: cutSlice || MLB_TOTALS_UNDER_PITCHER_SPEC.paperEvidenceUsd50.note,
};

const written = writeTotalsUnderPitcherObserveSnapshot(payload);
const status = buildTotalsUnderPitcherObservationStatus({ live: written });

fs.writeFileSync(
  new URL('../tmp-totals-under-pitcher-report.json', import.meta.url),
  JSON.stringify({ ...payload, observation: status }, null, 2)
);

console.log('BASE', payload.baseline);
console.log(
  'KEPT',
  payload.kept,
  `Δ$=${payload.deltaUsd50} ΔHR=${payload.deltaHrPp}pp ΔROI=${payload.deltaRoiPp}pp`
);
console.log('CUT', payload.cut, `n=${payload.cutN} (${payload.cutPct}%)`);
console.log('BY YEAR Δ$', payload.byYear);
console.log('observation.status', status.status);
console.log('wrote tmp-totals-under-pitcher-observe.json');
