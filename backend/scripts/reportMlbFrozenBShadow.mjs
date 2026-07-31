/**
 * 凍結 B 影子觀察報表：鎖定 B vs frozen_b+shrink（不建注）
 *
 * 用法: node scripts/reportMlbFrozenBShadow.mjs
 * 產物: tmp-frozen-b-shadow-report.json
 */
import {
  buildFrozenBShadowPitReport,
  writeFrozenBShadowReportSnapshot,
} from '../src/services/MlbFrozenBShadow.js';

console.log('Building frozen_b+shrink PIT observation report…');
const report = buildFrozenBShadowPitReport();
const outPath = writeFrozenBShadowReportSnapshot(report);

console.log('=== Frozen B Shadow Observation ===');
console.log('spec:', report.spec.id, report.spec.freezeDate);
console.log('locked B overall @$50:', report.lockedB.overall);
console.log('shadow overall @$50:', report.shadow.overall);
console.log('deltaUsd:', report.shadow.deltaUsd);
console.log('oos 24+26:', report.shadow.oos2426);
console.log('byWindow delta:', {
  '2024': report.shadow.byWindow['2024']?.deltaUsd,
  '2025': report.shadow.byWindow['2025']?.deltaUsd,
  '2026': report.shadow.byWindow['2026']?.deltaUsd,
});
console.log('recentDiff:', {
  fromDay: report.recentDiff.fromDay,
  changedDays: report.recentDiff.changedDays,
  sumDeltaUsd: report.recentDiff.sumDeltaUsd,
});
if (report.recentDiff.days?.length) {
  console.log('latest changed days:');
  for (const d of report.recentDiff.days.slice(-5)) {
    console.log(
      `  ${d.day} Δ$${d.deltaUsd} locked=${d.locked.length} shadow=${d.shadow.length}`
    );
  }
}
console.log('wrote', outPath);
