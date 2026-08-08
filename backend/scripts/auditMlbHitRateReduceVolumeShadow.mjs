/**
 * 影子刀：在鎖定 B 上減注換命中率（不改正式主倉）
 *
 * 使用者假設：寧可少下，少錯一次 -$50；接受 keepRate 明顯下降。
 * 用法: node scripts/auditMlbHitRateReduceVolumeShadow.mjs
 * 產物: tmp-hr-reduce-volume-shadow.json
 */
import fs from 'fs';
import { buildFrozenBShadowPickSets } from '../src/services/MlbFrozenBShadow.js';

const STAKE = 50;
const STRONG = 0.65;

function summarize(bets) {
  if (!bets.length) {
    return {
      bets: 0,
      hits: 0,
      hitRate: null,
      avgOdds: null,
      roi: null,
      usd50: 0,
      units: 0,
      maxLoseStreak: 0,
    };
  }
  let hits = 0;
  let unit = 0;
  let odds = 0;
  let streak = 0;
  let maxLose = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
      streak = 0;
    } else {
      unit -= 1;
      streak += 1;
      if (streak > maxLose) maxLose = streak;
    }
  }
  const n = bets.length;
  return {
    bets: n,
    hits,
    hitRate: hits / n,
    avgOdds: odds / n,
    roi: unit / n,
    usd50: Math.round(unit * STAKE),
    units: Number(unit.toFixed(4)),
    maxLoseStreak: maxLose,
  };
}

function byYear(bets) {
  const out = {};
  for (const y of ['2024', '2025', '2026']) {
    out[y] = summarize(bets.filter((b) => b.window === y));
  }
  return out;
}

function isToxic(b) {
  return !b.pickHome && (b.homeWinPct ?? 0) >= STRONG && (b.modelProb ?? 0) >= 0.55;
}

function claimedEdge(b) {
  return (b.modelProb ?? 0) - 1 / Math.max(1.01, b.pickOdds);
}

function pack(id, label, bets, base) {
  const overall = summarize(bets);
  const windows = byYear(bets);
  const baseS = summarize(base);
  const keepRate = base.length ? bets.length / base.length : null;
  const deltaHrPp =
    overall.hitRate != null && baseS.hitRate != null
      ? (overall.hitRate - baseS.hitRate) * 100
      : null;
  const deltaRoiPp =
    overall.roi != null && baseS.roi != null ? (overall.roi - baseS.roi) * 100 : null;
  const deltaUsd = overall.usd50 - baseS.usd50;
  const windowsOk = ['2024', '2025', '2026'].every((y) => (windows[y].roi ?? -1) >= 0);
  const windowsHrUp = ['2024', '2025', '2026'].filter((y) => {
    const w = windows[y];
    const b = byYear(base)[y];
    return w.bets >= 20 && b.hitRate != null && w.hitRate != null && w.hitRate >= b.hitRate - 1e-9;
  }).length;

  // 使用者願意減注：keep 可低到 35%；但要 HR↑、三窗 ROI≥0、ROI 不太崩
  const passHitFirst =
    keepRate >= 0.35 &&
    keepRate <= 0.9 &&
    deltaHrPp != null &&
    deltaHrPp >= 1.5 &&
    deltaRoiPp != null &&
    deltaRoiPp >= -3 &&
    windowsOk &&
    overall.bets >= 120 &&
    overall.avgOdds >= 1.85;

  const passBalanced =
    keepRate >= 0.5 &&
    deltaHrPp != null &&
    deltaHrPp >= 1.0 &&
    deltaRoiPp != null &&
    deltaRoiPp >= -1.5 &&
    deltaUsd >= -0.15 * Math.abs(baseS.usd50 || 1) &&
    windowsOk &&
    overall.bets >= 180;

  return {
    id,
    label,
    keepRate: keepRate == null ? null : Number(keepRate.toFixed(3)),
    overall: {
      ...overall,
      hitRate: overall.hitRate == null ? null : Number(overall.hitRate.toFixed(4)),
      avgOdds: overall.avgOdds == null ? null : Number(overall.avgOdds.toFixed(3)),
      roi: overall.roi == null ? null : Number(overall.roi.toFixed(4)),
    },
    windows: Object.fromEntries(
      Object.entries(windows).map(([y, s]) => [
        y,
        {
          bets: s.bets,
          hitRate: s.hitRate == null ? null : Number(s.hitRate.toFixed(4)),
          roi: s.roi == null ? null : Number(s.roi.toFixed(4)),
          usd50: s.usd50,
          maxLoseStreak: s.maxLoseStreak,
        },
      ])
    ),
    deltaHrPp: deltaHrPp == null ? null : Number(deltaHrPp.toFixed(2)),
    deltaRoiPp: deltaRoiPp == null ? null : Number(deltaRoiPp.toFixed(2)),
    deltaUsd,
    deltaLoseStreak: overall.maxLoseStreak - baseS.maxLoseStreak,
    windowsOk,
    windowsHrUp,
    passHitFirst,
    passBalanced,
  };
}

console.log('building frozen B shadow pick sets…');
const { shadow: base } = buildFrozenBShadowPickSets({});
console.log(`base n=${base.length}`);

const knives = [
  { id: 'raw', label: '現行鎖定 B（對照）', pred: () => true },
  { id: 'top2', label: '日 Top2（砍 Rank3）', pred: (b) => (b.rank || 99) <= 2 },
  { id: 'top1', label: '日 Top1 only', pred: (b) => b.rank === 1 },
  { id: 'ev_cap08', label: '砍宣稱 EV≥8%', pred: (b) => (b.ev ?? 0) < 0.08 },
  { id: 'ev_cap10', label: '砍宣稱 EV≥10%', pred: (b) => (b.ev ?? 0) < 0.1 },
  { id: 'ev_cap12', label: '砍宣稱 EV≥12%', pred: (b) => (b.ev ?? 0) < 0.12 },
  {
    id: 'ev_band_02_08',
    label: 'EV 甜蜜帶 2–8%',
    pred: (b) => (b.ev ?? 0) >= 0.02 && (b.ev ?? 0) < 0.08,
  },
  {
    id: 'ev_band_03_10',
    label: 'EV 甜蜜帶 3–10%',
    pred: (b) => (b.ev ?? 0) >= 0.03 && (b.ev ?? 0) < 0.1,
  },
  { id: 'p_ge52', label: 'P≥52%', pred: (b) => (b.modelProb ?? 0) >= 0.52 },
  { id: 'p_ge53', label: 'P≥53%', pred: (b) => (b.modelProb ?? 0) >= 0.53 },
  { id: 'p_ge54', label: 'P≥54%', pred: (b) => (b.modelProb ?? 0) >= 0.54 },
  { id: 'odds_le210', label: '賠率≤2.10', pred: (b) => b.pickOdds <= 2.1 },
  { id: 'odds_le220', label: '賠率≤2.20', pred: (b) => b.pickOdds <= 2.2 },
  { id: 'band_185_210', label: '賠率 1.85–2.10', pred: (b) => b.pickOdds >= 1.85 && b.pickOdds <= 2.1 },
  { id: 'no_toxic', label: '再砍殘留毒客', pred: (b) => !isToxic(b) },
  {
    id: 'no_away_long',
    label: '砍客隊≥2.10',
    pred: (b) => !(!b.pickHome && b.pickOdds >= 2.1),
  },
  {
    id: 'top2_ev_cap10',
    label: 'Top2 + 砍 EV≥10%',
    pred: (b) => (b.rank || 99) <= 2 && (b.ev ?? 0) < 0.1,
  },
  {
    id: 'top2_p53',
    label: 'Top2 + P≥53%',
    pred: (b) => (b.rank || 99) <= 2 && (b.modelProb ?? 0) >= 0.53,
  },
  {
    id: 'top2_odds220',
    label: 'Top2 + 賠率≤2.20',
    pred: (b) => (b.rank || 99) <= 2 && b.pickOdds <= 2.2,
  },
  {
    id: 'top2_ev_band',
    label: 'Top2 + EV 2–10%',
    pred: (b) =>
      (b.rank || 99) <= 2 && (b.ev ?? 0) >= 0.02 && (b.ev ?? 0) < 0.1,
  },
  {
    id: 'top1_ev_cap10',
    label: 'Top1 + 砍 EV≥10%',
    pred: (b) => b.rank === 1 && (b.ev ?? 0) < 0.1,
  },
  {
    id: 'top1_p53',
    label: 'Top1 + P≥53%',
    pred: (b) => b.rank === 1 && (b.modelProb ?? 0) >= 0.53,
  },
  {
    id: 'edge_ge02_top2',
    label: 'Top2 + edge≥2pp',
    pred: (b) => (b.rank || 99) <= 2 && claimedEdge(b) >= 0.02,
  },
  {
    id: 'no_away_long_top2',
    label: 'Top2 + 砍客≥2.10',
    pred: (b) => (b.rank || 99) <= 2 && !(!b.pickHome && b.pickOdds >= 2.1),
  },
  {
    id: 'hit_stack_a',
    label: '組合A：Top2 + P≥52% + 砍EV≥12%',
    pred: (b) =>
      (b.rank || 99) <= 2 &&
      (b.modelProb ?? 0) >= 0.52 &&
      (b.ev ?? 0) < 0.12,
  },
  {
    id: 'hit_stack_b',
    label: '組合B：Top2 + EV2–10% + 賠率≤2.20',
    pred: (b) =>
      (b.rank || 99) <= 2 &&
      (b.ev ?? 0) >= 0.02 &&
      (b.ev ?? 0) < 0.1 &&
      b.pickOdds <= 2.2,
  },
  {
    id: 'hit_stack_c',
    label: '組合C：Top1 + EV2–10%',
    pred: (b) =>
      b.rank === 1 && (b.ev ?? 0) >= 0.02 && (b.ev ?? 0) < 0.1,
  },
];

const rows = knives.map((k) => pack(k.id, k.label, base.filter(k.pred), base));
const baseRow = rows.find((r) => r.id === 'raw');

const hitFirst = rows
  .filter((r) => r.id !== 'raw' && r.passHitFirst)
  .sort(
    (a, b) =>
      (b.deltaHrPp ?? 0) - (a.deltaHrPp ?? 0) ||
      (b.deltaRoiPp ?? 0) - (a.deltaRoiPp ?? 0) ||
      (b.deltaUsd ?? 0) - (a.deltaUsd ?? 0)
  );

const balanced = rows
  .filter((r) => r.id !== 'raw' && r.passBalanced)
  .sort(
    (a, b) =>
      (b.deltaHrPp ?? 0) - (a.deltaHrPp ?? 0) ||
      (b.deltaUsd ?? 0) - (a.deltaUsd ?? 0)
  );

const near = rows
  .filter(
    (r) =>
      r.id !== 'raw' &&
      (r.deltaHrPp ?? -99) >= 1 &&
      (r.deltaRoiPp ?? -99) >= -4 &&
      (r.keepRate ?? 0) >= 0.3 &&
      r.windowsOk
  )
  .sort((a, b) => (b.deltaHrPp ?? 0) - (a.deltaHrPp ?? 0));

const out = {
  experimentId: 'hr-reduce-volume-shadow-2026-08-06',
  role: 'shadow_only',
  note: '不改鎖定 B 正式常數；僅評估減注換命中率',
  stakeUsd: STAKE,
  base: baseRow,
  gates: {
    hitFirst:
      'keep 35–90% · ΔHR≥1.5pp · ΔROI≥−3pp · 三窗ROI≥0 · n≥120 · 均賠≥1.85',
    balanced:
      'keep≥50% · ΔHR≥1.0pp · ΔROI≥−1.5pp · Δ$≥−15%基線 · 三窗ROI≥0 · n≥180',
  },
  hitFirstPass: hitFirst.slice(0, 12),
  balancedPass: balanced.slice(0, 12),
  nearMisses: near.slice(0, 15),
  all: rows,
  verdict:
    hitFirst.length || balanced.length
      ? 'FOUND_SHADOW_CANDIDATES — 可平行觀察，勿直接升正式'
      : 'NO_STRONG_CANDIDATE — 減注可抬 HR，但難同時保住 ROI；維持主倉或只做極嚴個人觀察線',
};

fs.writeFileSync(
  new URL('../tmp-hr-reduce-volume-shadow.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\nBASE', {
  bets: baseRow.overall.bets,
  hitRate: baseRow.overall.hitRate,
  roi: baseRow.overall.roi,
  avgOdds: baseRow.overall.avgOdds,
  usd50: baseRow.overall.usd50,
  maxLoseStreak: baseRow.overall.maxLoseStreak,
});
console.log('\nHIT_FIRST_PASS', hitFirst.length);
for (const r of hitFirst.slice(0, 8)) {
  console.log(
    `  ${r.id} | HR ${(r.overall.hitRate * 100).toFixed(1)}% (+${r.deltaHrPp}pp) | ROI ${(r.overall.roi * 100).toFixed(1)}% (Δ${r.deltaRoiPp}pp) | $${r.overall.usd50} (Δ${r.deltaUsd}) | keep ${(r.keepRate * 100).toFixed(0)}% | streak ${r.overall.maxLoseStreak}`
  );
}
console.log('\nBALANCED_PASS', balanced.length);
for (const r of balanced.slice(0, 8)) {
  console.log(
    `  ${r.id} | HR ${(r.overall.hitRate * 100).toFixed(1)}% (+${r.deltaHrPp}pp) | ROI ${(r.overall.roi * 100).toFixed(1)}% (Δ${r.deltaRoiPp}pp) | $${r.overall.usd50} (Δ${r.deltaUsd}) | keep ${(r.keepRate * 100).toFixed(0)}%`
  );
}
console.log('\nNEAR', near.slice(0, 10).map((r) => `${r.id}:+${r.deltaHrPp}pp/ROIΔ${r.deltaRoiPp}/$Δ${r.deltaUsd}/k${r.keepRate}`));
console.log('\nVERDICT', out.verdict);
console.log('wrote tmp-hr-reduce-volume-shadow.json');
