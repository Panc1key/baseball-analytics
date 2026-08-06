/**
 * NPB 大小 Round9：紙上影子日更／累積注量門檻（不補 Odds、不升正式）
 *
 * - 凍結主觀察：edge03_over + drop odds 1.85–2.00
 * - 重放紙上帳 + 寫入 npb_totals_shadow_paper_bets
 * - 日更：ensure fill（釋放窗內）+ settle
 * - 升格 verdict：targetBets=150 + 多年 totals（現況 blocked）
 *
 * 用法: node scripts/auditNpbTotalsOptRound9.mjs
 * 產物: tmp-npb-totals-opt-round9.json
 */
import fs from 'fs';
import {
  NPB_TOTALS_RESEARCH_SHADOW_PACKAGE,
  replayNpbTotalsResearchShadowPaper,
  syncNpbTotalsShadowReplayToDb,
  ensureNpbTotalsShadowPaperFills,
  settleNpbTotalsShadowPaperBets,
  getNpbTotalsShadowPaperLedgerSummary,
  getNpbTotalsResearchShadowSlate,
  npbTotalsShadowPromoteVerdict,
} from '../src/services/NpbTotalsResearchShadow.js';
import { NPB_RESEARCH_SHADOW_SPEC } from '../src/services/AsianNpbResearchShadow.js';

console.log('[round9] replay…');
const replay = replayNpbTotalsResearchShadowPaper();

console.log('[round9] sync replay → db…');
const sync = syncNpbTotalsShadowReplayToDb(replay);

console.log('[round9] settle + live fill…');
const settled = settleNpbTotalsShadowPaperBets();
const fills = ensureNpbTotalsShadowPaperFills();
const ledger = getNpbTotalsShadowPaperLedgerSummary();
const slate = getNpbTotalsResearchShadowSlate();

const promote = npbTotalsShadowPromoteVerdict({
  replayOverall: replay.overall,
  yearCoverage: { '2026': true },
});

const crossed = replay.cumulative.find((c) => c.bets >= 120);
const decision = {
  doNotPromoteFormal: true,
  noOddsBackfill: true,
  formalScopeTotals: NPB_RESEARCH_SHADOW_SPEC.formalScope.totals,
  packageId: NPB_TOTALS_RESEARCH_SHADOW_PACKAGE.id,
  replayOverall: replay.overall,
  pace: replay.pace,
  ledgerRows: ledger.rowCount,
  ledgerOverall: ledger.overall,
  liveActionable: slate.dailyTop.length,
  liveHeld: slate.heldUntilRelease.length,
  promote,
  note:
    promote.status === 'blocked_observe'
      ? `紙上日更已接線；升格仍 blocked：${promote.blockers.join('；')}`
      : '達觀察門檻，等待用戶明示升格（本刀不自動升）',
};

const out = {
  researchOnly: true,
  wiredToFormal: false,
  openedAt: '2026-08-06',
  audit: 'scripts/auditNpbTotalsOptRound9.mjs',
  package: {
    id: NPB_TOTALS_RESEARCH_SHADOW_PACKAGE.id,
    observation: NPB_TOTALS_RESEARCH_SHADOW_PACKAGE.observation,
    dropOddsBand: NPB_TOTALS_RESEARCH_SHADOW_PACKAGE.dropOddsBand,
  },
  replay: {
    overall: replay.overall,
    byMonth: replay.byMonth,
    pace: replay.pace,
    cumulativeTail: replay.cumulative.slice(-8),
    softTargetCrossedAt: crossed?.day || null,
  },
  db: { sync, settled, fills: { inserted: fills.inserted, actionable: fills.actionable } },
  ledger: {
    rowCount: ledger.rowCount,
    overall: ledger.overall,
    byMonth: ledger.byMonth,
    pending: ledger.pending,
  },
  slate: {
    actionable: slate.dailyTop,
    held: slate.heldUntilRelease,
    excludedCount: slate.excluded.length,
  },
  decision,
};

fs.writeFileSync('tmp-npb-totals-opt-round9.json', JSON.stringify(out, null, 2));
console.log(
  JSON.stringify(
    {
      decision,
      pace: replay.pace,
      byMonth: replay.byMonth,
      liveActionable: slate.dailyTop.map((r) => ({
        matchup: r.matchup,
        side: r.side,
        line: r.line,
        odds: r.odds,
        ev: r.expectedValue,
      })),
    },
    null,
    2
  )
);
console.log('[round9] wrote tmp-npb-totals-opt-round9.json');
