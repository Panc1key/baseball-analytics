/**
 * 路徑 γ：鎖定 B 紙上實盤報表（vs 歷史基準 KPI）
 * 不改選注常數；只讀 mlb_paper_bets + 對照 MLB-B-BASELINE-LOCK。
 *
 * 用法: node scripts/reportMlbPathGammaPaper.mjs
 * 產物: tmp-path-gamma-paper-report.json
 */
import fs from 'fs';
import { buildMlbPathGammaPaperReport } from '../src/services/MlbPaperLedger.js';
import { config } from '../src/config.js';

const report = buildMlbPathGammaPaperReport();
const outPath = new URL('../tmp-path-gamma-paper-report.json', import.meta.url);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

const live = report.liveLedger;
console.log('=== MLB Path γ Paper Report ===');
console.log(`profile: ${report.profileConfigured} (expect ${report.profileExpected})`);
if (report.profileMismatch) {
  console.log('WARN: 建議 .env 設 MLB_PAPER_RULE_PROFILE=ev02_max230');
}
console.log('baseline lock:', report.baselineLock);
console.log('live overall @$50:', live.overallAt50);
console.log(`live overall @config$${config.mlbPaperFlatStakeUsd}:`, live.overallAtConfigStake);
console.log('rolling 7d:', live.rolling7d);
console.log('rolling 30d:', live.rolling30d);
console.log('byMonth:', live.byMonth);
console.log('candidates:', report.candidateCounts);
console.log('drift:', report.drift);
const shadow = report.frozenBShadow;
if (shadow?.status) {
  console.log('frozenBShadow status:', shadow.status, 'overlayEnabled:', shadow.overlayEnabled);
  console.log('paperEvidence usd50:', shadow.paperEvidence?.usd50 ?? shadow.lockedOverall?.usd50);
} else {
  console.log('frozenBShadow:', shadow?.note || 'n/a');
}
console.log('wrote', outPath.pathname || outPath);
