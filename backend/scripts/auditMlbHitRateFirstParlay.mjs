/**
 * 體感勝率優先（串關用）：在 frozen_b+shrink／鎖定 B 選注上後處理抬 HR
 *
 * KPI：hitRate 為主；keep≥70% 才進候選；附 2／3 串獨立假設命中率
 * 正式鎖定 B 常數不改；只產出觀察規則建議
 *
 * 用法：node scripts/auditMlbHitRateFirstParlay.mjs
 * 產物：tmp-b-hitrate-first-parlay.json
 */
import fs from 'fs';
import { buildFrozenBShadowPickSets } from '../src/services/MlbFrozenBShadow.js';

const STAKE = 50;
const STRONG = 0.65;

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0 };
  }
  let hits = 0;
  let unit = 0;
  let odds = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  const hitRate = hits / n;
  return {
    bets: n,
    hits,
    hitRate: Number(hitRate.toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
    parlay2Assumed: Number((hitRate ** 2).toFixed(4)),
    parlay3Assumed: Number((hitRate ** 3).toFixed(4)),
  };
}

function byWindow(bets) {
  const out = {};
  for (const y of ['2024', '2025', '2026']) {
    out[y] = summarize(bets.filter((b) => b.window === y));
  }
  return out;
}

function pack(id, label, bets, base) {
  const overall = summarize(bets);
  const windows = byWindow(bets);
  const baseN = base.length;
  const keepRate = baseN ? Number((bets.length / baseN).toFixed(3)) : null;
  const baseS = summarize(base);
  let windowsHrNonNeg = 0;
  for (const y of ['2024', '2025', '2026']) {
    const bh = windows[y].hitRate;
    const rh = byWindow(base)[y].hitRate;
    if (bh == null || rh == null || bh >= rh - 1e-9) windowsHrNonNeg += 1;
  }
  return {
    id,
    label,
    overall,
    byWindow: windows,
    keepRate,
    deltaHrPp: Number((((overall.hitRate ?? 0) - (baseS.hitRate ?? 0)) * 100).toFixed(2)),
    deltaUsd: overall.usd50 - baseS.usd50,
    windowsHrNonNeg,
  };
}

function applyFilter(bets, pred) {
  return bets.filter(pred);
}

console.log('Loading pick sets…');
const { locked, shadow } = buildFrozenBShadowPickSets();

const filters = [
  { id: 'raw', label: '無後處理', pred: () => true },
  { id: 'rank1', label: '只取日內 Rank1', pred: (b) => b.rank === 1 },
  { id: 'rank12', label: '只取 Rank1–2', pred: (b) => b.rank <= 2 },
  { id: 'maxOdds_220', label: '賠率≤2.20', pred: (b) => b.pickOdds <= 2.2 },
  { id: 'maxOdds_215', label: '賠率≤2.15', pred: (b) => b.pickOdds <= 2.15 },
  { id: 'maxOdds_210', label: '賠率≤2.10', pred: (b) => b.pickOdds <= 2.1 },
  { id: 'maxOdds_205', label: '賠率≤2.05', pred: (b) => b.pickOdds <= 2.05 },
  { id: 'minOdds_190', label: '賠率≥1.90', pred: (b) => b.pickOdds >= 1.9 },
  { id: 'minOdds_195', label: '賠率≥1.95', pred: (b) => b.pickOdds >= 1.95 },
  { id: 'band_190_215', label: '賠率 1.90–2.15', pred: (b) => b.pickOdds >= 1.9 && b.pickOdds <= 2.15 },
  { id: 'band_185_215', label: '賠率 1.85–2.15', pred: (b) => b.pickOdds <= 2.15 },
  { id: 'band_185_210', label: '賠率 1.85–2.10', pred: (b) => b.pickOdds <= 2.1 },
  { id: 'p_ge52', label: '模型P≥52%', pred: (b) => b.modelProb >= 0.52 },
  { id: 'p_ge55', label: '模型P≥55%', pred: (b) => b.modelProb >= 0.55 },
  { id: 'p_ge58', label: '模型P≥58%', pred: (b) => b.modelProb >= 0.58 },
  { id: 'margin_035', label: 'margin≥0.35', pred: (b) => b.margin >= 0.35 },
  { id: 'margin_050', label: 'margin≥0.50', pred: (b) => b.margin >= 0.5 },
  { id: 'margin_075', label: 'margin≥0.75', pred: (b) => b.margin >= 0.75 },
  { id: 'ev_ge03', label: 'EV≥3%', pred: (b) => b.ev >= 0.03 },
  { id: 'ev_ge04', label: 'EV≥4%', pred: (b) => b.ev >= 0.04 },
  { id: 'ev_ge05', label: 'EV≥5%', pred: (b) => b.ev >= 0.05 },
  {
    id: 'no_toxic_away',
    label: '去掉客+強主場',
    pred: (b) => !( !b.pickHome && (b.homeWinPct ?? 0) >= STRONG ),
  },
  {
    id: 'rank1_max220',
    label: 'Rank1 且賠率≤2.20',
    pred: (b) => b.rank === 1 && b.pickOdds <= 2.2,
  },
  {
    id: 'rank1_max215',
    label: 'Rank1 且賠率≤2.15',
    pred: (b) => b.rank === 1 && b.pickOdds <= 2.15,
  },
  {
    id: 'rank1_p55',
    label: 'Rank1 且 P≥55%',
    pred: (b) => b.rank === 1 && b.modelProb >= 0.55,
  },
  {
    id: 'rank12_max215',
    label: 'Rank1–2 且賠率≤2.15',
    pred: (b) => b.rank <= 2 && b.pickOdds <= 2.15,
  },
  {
    id: 'rank12_p55',
    label: 'Rank1–2 且 P≥55%',
    pred: (b) => b.rank <= 2 && b.modelProb >= 0.55,
  },
  {
    id: 'parlay_legs_r1_p55_m210',
    label: '串關腿：Rank1 + P≥55% + 賠≤2.10',
    pred: (b) => b.rank === 1 && b.modelProb >= 0.55 && b.pickOdds <= 2.1,
  },
  {
    id: 'parlay_legs_r1_p55_m215',
    label: '串關腿：Rank1 + P≥55% + 賠≤2.15',
    pred: (b) => b.rank === 1 && b.modelProb >= 0.55 && b.pickOdds <= 2.15,
  },
  {
    id: 'parlay_legs_r12_p55_m215',
    label: '串關腿：Rank1–2 + P≥55% + 賠≤2.15',
    pred: (b) => b.rank <= 2 && b.modelProb >= 0.55 && b.pickOdds <= 2.15,
  },
];

function scan(baseName, base) {
  const rows = filters.map((f) =>
    pack(f.id, f.label, applyFilter(base, f.pred), base)
  );
  const hrFirst = [...rows]
    .filter((r) => (r.keepRate ?? 0) >= 0.5 && r.overall.bets >= 40)
    .sort(
      (a, b) =>
        (b.overall.hitRate ?? 0) - (a.overall.hitRate ?? 0) ||
        (b.keepRate ?? 0) - (a.keepRate ?? 0) ||
        b.overall.usd50 - a.overall.usd50
    );
  const keep70 = hrFirst.filter((r) => (r.keepRate ?? 0) >= 0.7);
  const keep85 = hrFirst.filter((r) => (r.keepRate ?? 0) >= 0.85);
  const near60 = hrFirst.filter((r) => (r.overall.hitRate ?? 0) >= 0.58);
  const bestFeel = keep70.find((r) => r.windowsHrNonNeg >= 2) || keep70[0] || hrFirst[0];
  const bestKeep85 = keep85.sort(
    (a, b) =>
      (b.overall.hitRate ?? 0) - (a.overall.hitRate ?? 0) ||
      b.deltaHrPp - a.deltaHrPp
  )[0];
  return {
    baseName,
    base: summarize(base),
    variants: rows,
    rankedHitRateKeep50: hrFirst.slice(0, 15),
    rankedKeep70: keep70.slice(0, 10),
    near58plus: near60.slice(0, 10),
    recommendFeel: bestFeel,
    recommendKeep85: bestKeep85,
  };
}

const lockedScan = scan('locked_b', locked);
const shadowScan = scan('frozen_b+shrink', shadow);

const out = {
  experimentId: 'b-hitrate-first-parlay-2026-07-30',
  goal: '體感勝率優先（單注順便買串）；正式 B 不改；影子／觀察規則可建議',
  noteParlay:
    'parlay2/3Assumed 假設腿獨立，實際同日相關會更低；僅作體感量尺',
  lockedScan,
  shadowScan,
  recommendation: {
    wireFormalB: false,
    preferBase: 'frozen_b+shrink',
    feelOverlay: shadowScan.recommendFeel,
    volumeOverlay: shadowScan.recommendKeep85,
    howToUse:
      '單注仍可跟鎖定 B／凍結影子全清單；要買串時只用 feelOverlay 過濾後的腿（例如 Rank1+條件）',
  },
};

fs.writeFileSync(
  new URL('../tmp-b-hitrate-first-parlay.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

function printRec(title, scan) {
  console.log(`\n=== ${title} base HR=${scan.base.hitRate} n=${scan.base.bets} ===`);
  console.log('TOP HR (keep≥50%):');
  for (const r of scan.rankedHitRateKeep50.slice(0, 8)) {
    console.log(
      `  ${r.id.padEnd(28)} hr=${r.overall.hitRate} keep=${r.keepRate} n=${r.overall.bets} $=${r.overall.usd50} Δhr=${r.deltaHrPp}pp p2=${r.overall.parlay2Assumed} p3=${r.overall.parlay3Assumed} winHr=${r.windowsHrNonNeg}/3`
    );
  }
  console.log('FEEL REC:', scan.recommendFeel?.id, {
    hr: scan.recommendFeel?.overall.hitRate,
    keep: scan.recommendFeel?.keepRate,
    p2: scan.recommendFeel?.overall.parlay2Assumed,
    p3: scan.recommendFeel?.overall.parlay3Assumed,
    usd: scan.recommendFeel?.overall.usd50,
  });
  console.log('KEEP85 REC:', scan.recommendKeep85?.id, {
    hr: scan.recommendKeep85?.overall.hitRate,
    keep: scan.recommendKeep85?.keepRate,
  });
}

printRec('LOCKED B', lockedScan);
printRec('FROZEN SHADOW', shadowScan);
console.log('\nREC', out.recommendation.feelOverlay?.id, out.recommendation.howToUse);
