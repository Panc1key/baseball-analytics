/**
 * 影子掃描：不改鎖定 B 常數，找「HR↑ 且 ROI 不降／Δ$≥0」的後處理
 * 用法: node scripts/auditMlbHrLiftKeepRoi.mjs
 * 產物: tmp-hr-lift-keep-roi.json
 */
import fs from 'fs';
import { buildFrozenBShadowPickSets } from '../src/services/MlbFrozenBShadow.js';

const STAKE = 50;
const STRONG = 0.65;

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hits: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0, units: 0 };
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
  return {
    bets: n,
    hits,
    hitRate: hits / n,
    avgOdds: odds / n,
    roi: unit / n,
    usd50: Math.round(unit * STAKE),
    units: Number(unit.toFixed(4)),
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

function pack(id, label, bets, base) {
  const overall = summarize(bets);
  const windows = byYear(bets);
  const baseS = summarize(base);
  const keepRate = base.length ? bets.length / base.length : null;
  const deltaHrPp = overall.hitRate != null && baseS.hitRate != null
    ? (overall.hitRate - baseS.hitRate) * 100
    : null;
  const deltaRoiPp = overall.roi != null && baseS.roi != null
    ? (overall.roi - baseS.roi) * 100
    : null;
  const deltaUsd = overall.usd50 - baseS.usd50;
  const windowsOk = ['2024', '2025', '2026'].every((y) => (windows[y].roi ?? -1) >= 0);
  const windowsHrNonNeg = ['2024', '2025', '2026'].filter(
    (y) => (windows[y].hitRate ?? 0) >= (byYear(base)[y].hitRate ?? 0) - 1e-9
  ).length;
  const passStrict =
    keepRate >= 0.7 &&
    deltaHrPp != null &&
    deltaHrPp >= 0.3 &&
    deltaRoiPp != null &&
    deltaRoiPp >= -0.5 &&
    deltaUsd >= -0.05 * Math.abs(baseS.usd50 || 1) &&
    windowsOk &&
    overall.avgOdds >= 1.95;
  const passSoft =
    keepRate >= 0.85 &&
    deltaHrPp != null &&
    deltaHrPp > 0 &&
    deltaRoiPp != null &&
    deltaRoiPp >= 0 &&
    deltaUsd >= 0 &&
    windowsOk;
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
        },
      ])
    ),
    deltaHrPp: deltaHrPp == null ? null : Number(deltaHrPp.toFixed(2)),
    deltaRoiPp: deltaRoiPp == null ? null : Number(deltaRoiPp.toFixed(2)),
    deltaUsd,
    windowsOk,
    windowsHrNonNeg,
    passStrict,
    passSoft,
  };
}

function reRankDailyTop3(bets) {
  const byDay = new Map();
  for (const b of bets) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  }
  const out = [];
  for (const [, list] of byDay) {
    const sorted = [...list].sort(
      (a, b) => (a.rank || 99) - (b.rank || 99) || (b.ev || 0) - (a.ev || 0)
    );
    out.push(...sorted.slice(0, 3));
  }
  return out;
}

const { shadow: base } = buildFrozenBShadowPickSets({});

const filters = [
  { id: 'raw', label: '基線（無過濾）', pred: () => true },
  { id: 'drop_rank3', label: '去掉日 Rank3', pred: (b) => b.rank !== 3 },
  { id: 'rank12_only', label: '只留 Rank1–2', pred: (b) => (b.rank || 99) <= 2 },
  { id: 'rank1_only', label: '只留 Rank1', pred: (b) => b.rank === 1 },
  { id: 'home_only', label: '只選主', pred: (b) => b.pickHome },
  { id: 'away_only', label: '只選客', pred: (b) => !b.pickHome },
  { id: 'no_toxic', label: '去掉毒客', pred: (b) => !isToxic(b) },
  { id: 'p_ge52', label: 'P≥52%', pred: (b) => b.modelProb >= 0.52 },
  { id: 'p_ge53', label: 'P≥53%', pred: (b) => b.modelProb >= 0.53 },
  { id: 'p_ge54', label: 'P≥54%', pred: (b) => b.modelProb >= 0.54 },
  { id: 'p_ge55', label: 'P≥55%', pred: (b) => b.modelProb >= 0.55 },
  { id: 'ev_ge03', label: 'EV≥3%', pred: (b) => (b.ev ?? 0) >= 0.03 },
  { id: 'ev_ge04', label: 'EV≥4%', pred: (b) => (b.ev ?? 0) >= 0.04 },
  { id: 'ev_ge05', label: 'EV≥5%', pred: (b) => (b.ev ?? 0) >= 0.05 },
  { id: 'margin_ge030', label: '分差≥0.30', pred: (b) => (b.margin ?? 0) >= 0.3 },
  { id: 'margin_ge040', label: '分差≥0.40', pred: (b) => (b.margin ?? 0) >= 0.4 },
  { id: 'odds_ge190', label: '賠率≥1.90', pred: (b) => b.pickOdds >= 1.9 },
  { id: 'odds_ge195', label: '賠率≥1.95', pred: (b) => b.pickOdds >= 1.95 },
  { id: 'odds_le230', label: '賠率≤2.30', pred: (b) => b.pickOdds <= 2.3 },
  { id: 'odds_le220', label: '賠率≤2.20', pred: (b) => b.pickOdds <= 2.2 },
  { id: 'odds_le215', label: '賠率≤2.15', pred: (b) => b.pickOdds <= 2.15 },
  { id: 'odds_le210', label: '賠率≤2.10', pred: (b) => b.pickOdds <= 2.1 },
  { id: 'band_185_210', label: '賠率帶 1.85–2.10', pred: (b) => b.pickOdds >= 1.85 && b.pickOdds <= 2.1 },
  { id: 'band_190_220', label: '賠率帶 1.90–2.20', pred: (b) => b.pickOdds >= 1.9 && b.pickOdds <= 2.2 },
  { id: 'band_195_225', label: '賠率帶 1.95–2.25', pred: (b) => b.pickOdds >= 1.95 && b.pickOdds <= 2.25 },
  {
    id: 'edge_ge02',
    label: 'model−market≥2pp',
    pred: (b) => b.modelProb - 1 / b.pickOdds >= 0.02,
  },
  {
    id: 'edge_ge03',
    label: 'model−market≥3pp',
    pred: (b) => b.modelProb - 1 / b.pickOdds >= 0.03,
  },
  {
    id: 'no_toxic_rank12',
    label: '去毒客 + Rank1–2',
    pred: (b) => !isToxic(b) && (b.rank || 99) <= 2,
  },
  {
    id: 'home_rank12',
    label: '主隊 + Rank1–2',
    pred: (b) => b.pickHome && (b.rank || 99) <= 2,
  },
  {
    id: 'p53_odds220',
    label: 'P≥53% 且賠率≤2.20',
    pred: (b) => b.modelProb >= 0.53 && b.pickOdds <= 2.2,
  },
  {
    id: 'p52_rank12',
    label: 'P≥52% + Rank1–2',
    pred: (b) => b.modelProb >= 0.52 && (b.rank || 99) <= 2,
  },
  {
    id: 'drop_r3_if_odds_lt195',
    label: 'Rank3 且賠率<1.95 則丟',
    pred: (b) => !(b.rank === 3 && b.pickOdds < 1.95),
  },
  {
    id: 'drop_r3_if_p_lt53',
    label: 'Rank3 且 P<53% 則丟',
    pred: (b) => !(b.rank === 3 && b.modelProb < 0.53),
  },
  {
    id: 'drop_away_odds_ge205',
    label: '丟掉客且賠率≥2.05',
    pred: (b) => !(!b.pickHome && b.pickOdds >= 2.05),
  },
  {
    id: 'drop_away_strong_home',
    label: '丟掉客×主勝率≥65%',
    pred: (b) => !(!b.pickHome && (b.homeWinPct ?? 0) >= 0.65),
  },
];

const rows = [];
for (const f of filters) {
  const filtered = base.filter(f.pred);
  // 兩種口徑：池內直接；以及過濾後重取日 Top3
  rows.push(pack(f.id, f.label, filtered, base));
  if (f.id !== 'raw') {
    rows.push(
      pack(`${f.id}__retop3`, `${f.label}（過濾後重取日Top3）`, reRankDailyTop3(filtered), base)
    );
  }
}

const baseS = summarize(base);
const hrUpRoiFlat = rows
  .filter(
    (r) =>
      r.id !== 'raw' &&
      (r.deltaHrPp ?? -1) > 0 &&
      (r.deltaRoiPp ?? -99) >= -0.25 &&
      (r.deltaUsd ?? -1e9) >= -100 &&
      (r.keepRate ?? 0) >= 0.5
  )
  .sort(
    (a, b) =>
      (b.deltaHrPp ?? 0) - (a.deltaHrPp ?? 0) ||
      (b.deltaUsd ?? 0) - (a.deltaUsd ?? 0) ||
      (b.keepRate ?? 0) - (a.keepRate ?? 0)
  );

const softPass = rows.filter((r) => r.passSoft).sort((a, b) => (b.deltaHrPp ?? 0) - (a.deltaHrPp ?? 0));
const strictPass = rows
  .filter((r) => r.passStrict)
  .sort((a, b) => (b.deltaHrPp ?? 0) - (a.deltaHrPp ?? 0));

const pareto = rows
  .filter(
    (r) =>
      r.id !== 'raw' &&
      (r.deltaHrPp ?? 0) >= 0.2 &&
      (r.deltaRoiPp ?? -1) >= 0 &&
      (r.deltaUsd ?? -1) >= 0 &&
      (r.keepRate ?? 0) >= 0.7 &&
      r.windowsOk
  )
  .sort((a, b) => (b.deltaHrPp ?? 0) - (a.deltaHrPp ?? 0));

const out = {
  experimentId: 'hr-lift-keep-roi-2026-08-03',
  goal: '不改鎖定 B 常數；找 HR↑ 且 ROI/美元不傷的後處理',
  base: {
    bets: baseS.bets,
    hitRate: Number(baseS.hitRate.toFixed(4)),
    roi: Number(baseS.roi.toFixed(4)),
    avgOdds: Number(baseS.avgOdds.toFixed(3)),
    usd50: baseS.usd50,
  },
  gates: {
    soft: 'keep≥85% & ΔHR>0 & ΔROI≥0 & Δ$≥0 & 三窗ROI≥0',
    strict: 'keep≥70% & ΔHR≥0.3pp & ΔROI≥−0.5pp & Δ$≥−5%基線 & 均賠≥1.95 & 三窗ROI≥0',
    pareto: 'keep≥70% & ΔHR≥0.2pp & ΔROI≥0 & Δ$≥0 & 三窗ROI≥0',
  },
  softPass: softPass.slice(0, 15),
  strictPass: strictPass.slice(0, 15),
  pareto,
  nearMisses: hrUpRoiFlat.slice(0, 20),
  verdict:
    pareto.length || softPass.length || strictPass.length
      ? 'FOUND_CANDIDATES — 可進影子觀察，勿直接改主閘'
      : 'NO_PARETO — 現池內難有「明顯抬 HR 且不傷 ROI」；維持主倉，勝率用平行衛星或接受天花板',
};

fs.writeFileSync(
  new URL('../tmp-hr-lift-keep-roi.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('BASE', out.base);
console.log('SOFT_PASS', softPass.length);
for (const r of softPass.slice(0, 10)) {
  console.log(
    `  ${r.id} HR ${r.overall.hitRate} (+${r.deltaHrPp}pp) ROIΔ ${r.deltaRoiPp}pp $Δ ${r.deltaUsd} keep ${r.keepRate}`
  );
}
console.log('STRICT_PASS', strictPass.length);
for (const r of strictPass.slice(0, 10)) {
  console.log(
    `  ${r.id} HR ${r.overall.hitRate} (+${r.deltaHrPp}pp) ROIΔ ${r.deltaRoiPp}pp $Δ ${r.deltaUsd} keep ${r.keepRate}`
  );
}
console.log('PARETO', pareto.length);
for (const r of pareto.slice(0, 10)) {
  console.log(
    `  ${r.id} HR ${r.overall.hitRate} (+${r.deltaHrPp}pp) ROIΔ ${r.deltaRoiPp}pp $Δ ${r.deltaUsd} keep ${r.keepRate}`
  );
}
console.log('NEAR', hrUpRoiFlat.slice(0, 12).map((r) => `${r.id}:+${r.deltaHrPp}pp/$Δ${r.deltaUsd}/k${r.keepRate}`));
console.log('VERDICT', out.verdict);
