/**
 * Hybrid 大小第二輪檢查：在「Under×投手公園」之外找下一刀
 * 用法: node scripts/auditMlbTotalsHybridRound2.mjs
 * 產物: tmp-totals-hybrid-round2.json
 *
 * 依賴：先有 tmp-totals-hybrid-loss-autopsy.json（或自動重跑 autopsy）
 */
import fs from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTOPSY = path.join(__dirname, '../tmp-totals-hybrid-loss-autopsy.json');
const OUT = path.join(__dirname, '../tmp-totals-hybrid-round2.json');

function ensureAutopsy() {
  if (fs.existsSync(AUTOPSY)) {
    try {
      const j = JSON.parse(fs.readFileSync(AUTOPSY, 'utf8'));
      if (j?.knives?.length) return j;
    } catch {
      /* rebuild */
    }
  }
  spawnSync(process.execPath, [path.join(__dirname, 'auditMlbTotalsHybridLossAutopsy.mjs')], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });
  return JSON.parse(fs.readFileSync(AUTOPSY, 'utf8'));
}

const a = ensureAutopsy();
const knives = [...(a.knives || [])].sort((x, y) => {
  const score = (k) =>
    (k.dHr || 0) * 6 +
    (k.dRoi || 0) * 3 +
    Math.min(k.dUsd || 0, 500) / 250 -
    ((k.byYearDelta?.['2024'] ?? 0) < -100 ? 2 : 0) -
    ((k.byYearDelta?.['2026'] ?? 0) < -150 ? 2 : 0);
  return score(y) - score(x);
});

const already = 'drop_under_pitcher_park';
const underPitcher = knives.find((k) => k.id === already);

/** 候選：HR升、ROI不掉、Δ$不太負、砍量別太大 */
const nextPool = knives.filter(
  (k) =>
    k.id !== already &&
    (k.cut?.n || 0) >= 25 &&
    (k.dHr || 0) >= 0.3 &&
    (k.dRoi || 0) >= 0 &&
    (k.keepRate || 0) >= 0.75 &&
    (k.dUsd || 0) >= -200
);

const rejected = knives
  .filter((k) => !nextPool.includes(k) && k.id !== already)
  .slice(0, 8)
  .map((k) => ({
    id: k.id,
    label: k.label,
    why:
      (k.dUsd || 0) < -200
        ? '少賺太多'
        : (k.dHr || 0) < 0.3
          ? '勝率幾乎不升'
          : (k.keepRate || 0) < 0.75
            ? '砍太狠'
            : (k.dRoi || 0) < 0
              ? 'ROI 下降'
              : '未過篩',
    dUsd: k.dUsd,
    dHr: k.dHr,
    cutPct: k.cutPct,
  }));

const lifts = a.lossLifts || {};
const interestingLifts = Object.entries(lifts).flatMap(([dim, rows]) =>
  (rows || [])
    .filter((r) => (r.lift || 0) >= 1.08 && (r.allRoi ?? 99) < 8)
    .slice(0, 2)
    .map((r) => ({ dim, ...r }))
);

const interpretation = [
  `已開觀察：Under×投手公園 — 砍${underPitcher?.cutPct}% Δ$${underPitcher?.dUsd} HR${underPitcher?.dHr >= 0 ? '+' : ''}${underPitcher?.dHr}pp`,
  `基線仍健康：n=${a.baseline?.n} HR=${a.baseline?.hr}% ROI=${a.baseline?.roi}% $${a.baseline?.usd}`,
  '勿砍全部 Over·raw／勿因畫面高 EV 全砍 Under',
];

if (!nextPool.length) {
  interpretation.push(
    '第二輪：暫無同時滿足「勝率升 + 不太減收 + 砍量可控」的下一硬刀；優先活體驗證 Under×投手公園'
  );
} else {
  for (const k of nextPool.slice(0, 3)) {
    interpretation.push(
      `下一候選影子：${k.label} 砍${k.cutPct}% Δ$${k.dUsd} HR${k.dHr >= 0 ? '+' : ''}${k.dHr} 年Δ=${JSON.stringify(k.byYearDelta)}`
    );
  }
}

for (const r of interestingLifts.slice(0, 5)) {
  interpretation.push(
    `弱片抬升：${r.dim}=${r.key} lift=${r.lift} HR=${r.allHr}% ROI=${r.allRoi}% $${r.allUsd}`
  );
}

const out = {
  experimentId: 'totals-hybrid-round2-2026-08-06',
  parentObservation: already,
  baseline: a.baseline,
  underPitcherKnife: underPitcher || null,
  nextShadowCandidates: nextPool.slice(0, 5),
  rejectedExamples: rejected,
  interestingLifts,
  interpretation,
  doNot: a.doNot || [],
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ baseline: out.baseline, underPitcher: underPitcher && {
  cutPct: underPitcher.cutPct, dHr: underPitcher.dHr, dRoi: underPitcher.dRoi, dUsd: underPitcher.dUsd, yd: underPitcher.byYearDelta
}, next: out.nextShadowCandidates.map((k) => ({ id: k.id, cutPct: k.cutPct, dHr: k.dHr, dUsd: k.dUsd, yd: k.byYearDelta })), rejected: rejected.slice(0, 5) }, null, 2));
console.log('\nINTERP');
for (const line of interpretation) console.log(' -', line);
