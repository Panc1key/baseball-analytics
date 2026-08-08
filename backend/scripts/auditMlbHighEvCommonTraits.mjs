/**
 * 只分析高 EV 單的共同點（影子，不改正式）
 * node scripts/auditMlbHighEvCommonTraits.mjs
 */
import fs from 'fs';
import { buildFrozenBShadowPickSets } from '../src/services/MlbFrozenBShadow.js';

const STAKE = 50;
const STRONG = 0.65;

function summarize(bets) {
  if (!bets.length) {
    return { n: 0, hits: 0, hr: null, roi: null, usd: 0, avgOdds: null, avgEv: null, avgP: null };
  }
  let hits = 0;
  let unit = 0;
  let odds = 0;
  let ev = 0;
  let p = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    ev += b.ev ?? 0;
    p += b.modelProb ?? 0;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    n,
    hits,
    hr: Number(((hits / n) * 100).toFixed(2)),
    roi: Number(((unit / n) * 100).toFixed(2)),
    usd: Math.round(unit * STAKE),
    avgOdds: Number((odds / n).toFixed(3)),
    avgEv: Number(((ev / n) * 100).toFixed(2)),
    avgP: Number(((p / n) * 100).toFixed(2)),
  };
}

function bucket(bets, keyFn) {
  const map = new Map();
  for (const b of bets) {
    const k = keyFn(b);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(b);
  }
  return [...map.entries()]
    .map(([k, arr]) => ({ key: k, ...summarize(arr) }))
    .sort((a, b) => b.n - a.n);
}

function edge(b) {
  return (b.modelProb ?? 0) - 1 / Math.max(1.01, b.pickOdds);
}

function isToxic(b) {
  return !b.pickHome && (b.homeWinPct ?? 0) >= STRONG && (b.modelProb ?? 0) >= 0.55;
}

console.log('building base…');
const { shadow: base } = buildFrozenBShadowPickSets({});

const low = base.filter((b) => (b.ev ?? 0) < 0.09);
const mid = base.filter((b) => (b.ev ?? 0) >= 0.09 && (b.ev ?? 0) < 0.12);
const high = base.filter((b) => (b.ev ?? 0) >= 0.1);
const veryHigh = base.filter((b) => (b.ev ?? 0) >= 0.12);
const extreme = base.filter((b) => (b.ev ?? 0) >= 0.15);

const groups = {
  all: summarize(base),
  ev_lt9: summarize(low),
  ev_9_12: summarize(mid),
  ev_ge10: summarize(high),
  ev_ge12: summarize(veryHigh),
  ev_ge15: summarize(extreme),
};

const highSlices = {
  side: bucket(high, (b) => (b.pickHome ? 'home' : 'away')),
  rank: bucket(high, (b) => `R${b.rank || '?'}`),
  window: bucket(high, (b) => b.window || '?'),
  oddsBand: bucket(high, (b) => {
    const o = b.pickOdds;
    if (o < 1.95) return '1.85-1.95';
    if (o < 2.1) return '1.95-2.10';
    if (o < 2.25) return '2.10-2.25';
    return '2.25-2.50';
  }),
  modelP: bucket(high, (b) => {
    const p = b.modelProb ?? 0;
    if (p < 0.52) return 'P<52';
    if (p < 0.55) return 'P52-55';
    if (p < 0.58) return 'P55-58';
    return 'P>=58';
  }),
  edgeBand: bucket(high, (b) => {
    const e = edge(b);
    if (e < 0.03) return 'edge<3pp';
    if (e < 0.05) return 'edge3-5';
    if (e < 0.08) return 'edge5-8';
    return 'edge>=8';
  }),
  margin: bucket(high, (b) => {
    const m = b.margin ?? 0;
    if (m < 0.3) return 'margin<0.30';
    if (m < 0.5) return 'margin0.30-0.50';
    if (m < 0.8) return 'margin0.50-0.80';
    return 'margin>=0.80';
  }),
  toxic: bucket(high, (b) => (isToxic(b) ? 'toxic_away' : 'not_toxic')),
  awayStrongHome: bucket(high, (b) => {
    if (b.pickHome) return 'home_pick';
    const hw = b.homeWinPct ?? 0;
    if (hw >= 0.65) return 'away_vs_homeWin>=65';
    if (hw >= 0.58) return 'away_vs_homeWin58-65';
    return 'away_vs_weaker_home';
  }),
  longAway: bucket(high, (b) => {
    if (b.pickHome) return 'home';
    if (b.pickOdds >= 2.2) return 'away_odds>=2.20';
    if (b.pickOdds >= 2.1) return 'away_odds2.10-2.20';
    return 'away_odds<2.10';
  }),
};

// 組合病灶：高EV內再細切，找「可套用」規則
const surgicalCandidates = [
  {
    id: 'cut_high_ev_away_ge210',
    label: '高EV且客賠≥2.10',
    pred: (b) => (b.ev ?? 0) >= 0.1 && !b.pickHome && b.pickOdds >= 2.1,
  },
  {
    id: 'cut_high_ev_away_ge220',
    label: '高EV且客賠≥2.20',
    pred: (b) => (b.ev ?? 0) >= 0.1 && !b.pickHome && b.pickOdds >= 2.2,
  },
  {
    id: 'cut_high_ev_toxic',
    label: '高EV且毒客',
    pred: (b) => (b.ev ?? 0) >= 0.1 && isToxic(b),
  },
  {
    id: 'cut_high_ev_away_strong_home',
    label: '高EV且客打主勝率≥65%',
    pred: (b) => (b.ev ?? 0) >= 0.1 && !b.pickHome && (b.homeWinPct ?? 0) >= 0.65,
  },
  {
    id: 'cut_high_ev_rank3',
    label: '高EV且Rank3',
    pred: (b) => (b.ev ?? 0) >= 0.1 && b.rank === 3,
  },
  {
    id: 'cut_high_ev_p_lt52',
    label: '高EV且P<52%（靠高賠堆EV）',
    pred: (b) => (b.ev ?? 0) >= 0.1 && (b.modelProb ?? 0) < 0.52,
  },
  {
    id: 'cut_high_ev_edge_ge8',
    label: '高EV且edge≥8pp',
    pred: (b) => (b.ev ?? 0) >= 0.1 && edge(b) >= 0.08,
  },
  {
    id: 'cut_vh_away_ge210',
    label: 'EV≥12%且客賠≥2.10',
    pred: (b) => (b.ev ?? 0) >= 0.12 && !b.pickHome && b.pickOdds >= 2.1,
  },
  {
    id: 'cut_vh_p_lt53_away',
    label: 'EV≥12%且客且P<53%',
    pred: (b) => (b.ev ?? 0) >= 0.12 && !b.pickHome && (b.modelProb ?? 0) < 0.53,
  },
  {
    id: 'cut_extreme_any',
    label: 'EV≥15%全砍',
    pred: (b) => (b.ev ?? 0) >= 0.15,
  },
  {
    id: 'cut_ev10_all',
    label: '對照：EV≥10%全砍',
    pred: (b) => (b.ev ?? 0) >= 0.1,
  },
  {
    id: 'shrink_not_cut',
    label: '標記：高EV客長水（建議shrink非砍）',
    pred: (b) => (b.ev ?? 0) >= 0.1 && !b.pickHome && b.pickOdds >= 2.1,
  },
];

function applyCut(cutPred) {
  const kept = base.filter((b) => !cutPred(b));
  const cut = base.filter(cutPred);
  const k = summarize(kept);
  const c = summarize(cut);
  const baseS = summarize(base);
  return {
    kept: k,
    cut: c,
    keepRate: Number((kept.length / base.length).toFixed(3)),
    cutPct: Number((100 * (1 - kept.length / base.length)).toFixed(1)),
    dHr: Number((k.hr - baseS.hr).toFixed(2)),
    dRoi: Number((k.roi - baseS.roi).toFixed(2)),
    dUsd: k.usd - baseS.usd,
  };
}

const surgeries = surgicalCandidates.map((s) => {
  const r = applyCut(s.pred);
  return {
    id: s.id,
    label: s.label,
    ...r,
    // 手術品質：HR升、ROI不太掉、砍得少
    score:
      r.cut.n < 15
        ? -1e9
        : r.dHr * 8 +
          r.dRoi * 3 +
          Math.min(0, r.keepRate - 0.55) * 4 +
          r.dUsd / 1200 +
          // 被砍子集本身 ROI 越差越好（證明切到病灶）
          Math.min(0, r.cut.roi) * 0.15,
  };
});

const ranked = [...surgeries].sort((a, b) => b.score - a.score);

const out = {
  experimentId: 'high-ev-common-traits-2026-08-06',
  note: '只分析高EV共同點與可套用手術刀；不改正式主倉',
  groups,
  highEvTraits: highSlices,
  surgeries: ranked,
  bestSurgical: ranked.filter((r) => r.cut.n >= 30 && r.dHr >= 1 && r.dRoi >= -2 && r.keepRate >= 0.5).slice(0, 8),
  interpretation: [],
};

// 自動寫解釋線索
const away = highSlices.side.find((x) => x.key === 'away');
const home = highSlices.side.find((x) => x.key === 'home');
if (away && home) {
  out.interpretation.push(
    `高EV中客隊 n=${away.n} HR=${away.hr}% ROI=${away.roi}%；主隊 n=${home.n} HR=${home.hr}% ROI=${home.roi}%`
  );
}
const toxic = highSlices.toxic.find((x) => x.key === 'toxic_away');
if (toxic) {
  out.interpretation.push(`高EV毒客 n=${toxic.n} HR=${toxic.hr}% ROI=${toxic.roi}% usd=${toxic.usd}`);
}
const lowP = highSlices.modelP.find((x) => x.key === 'P<52');
if (lowP) {
  out.interpretation.push(`高EV且P<52% n=${lowP.n} HR=${lowP.hr}% ROI=${lowP.roi}%（高賠堆EV嫌疑）`);
}

fs.writeFileSync(
  new URL('../tmp-high-ev-common-traits.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('GROUPS');
for (const [k, v] of Object.entries(groups)) {
  console.log(`${k.padEnd(10)} n=${v.n} HR=${v.hr}% ROI=${v.roi}% $${v.usd} odds=${v.avgOdds} EV=${v.avgEv}% P=${v.avgP}%`);
}
console.log('\nHIGH_EV SIDE/RANK/ODDS/P/TOXIC');
for (const name of ['side', 'rank', 'oddsBand', 'modelP', 'toxic', 'awayStrongHome', 'longAway', 'edgeBand']) {
  console.log(`-- ${name}`);
  for (const row of highSlices[name]) {
    console.log(`  ${row.key.padEnd(22)} n=${row.n} HR=${row.hr}% ROI=${row.roi}% $${row.usd}`);
  }
}
console.log('\nSURGERIES (best first)');
for (const s of ranked.slice(0, 10)) {
  console.log(
    `${s.id} | cut ${s.cutPct}% (nCut=${s.cut.n} HR=${s.cut.hr}% ROI=${s.cut.roi}%) | keep HR=${s.kept.hr}% (+${s.dHr}) ROI=${s.kept.roi}% (${s.dRoi >= 0 ? '+' : ''}${s.dRoi}) $${s.kept.usd} (Δ${s.dUsd}) keep=${(s.keepRate * 100).toFixed(0)}%`
  );
}
console.log('\nINTERP');
for (const line of out.interpretation) console.log('-', line);
console.log('wrote tmp-high-ev-common-traits.json');
