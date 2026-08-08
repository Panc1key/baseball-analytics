/**
 * EV 上限細掃影子（不改正式）
 * node scripts/auditMlbEvCapGridShadow.mjs
 */
import fs from 'fs';
import { buildFrozenBShadowPickSets } from '../src/services/MlbFrozenBShadow.js';

const STAKE = 50;

function summarize(bets) {
  if (!bets.length) {
    return {
      bets: 0,
      hits: 0,
      hitRate: null,
      avgOdds: null,
      roi: null,
      usd50: 0,
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

function scoreHitFirst(r) {
  if (r.capNum >= 1) return -1e9;
  if (!r.windowsOk) return -1e9;
  if (r.bets < 120) return -1e9;
  return r.dHr * 10 + r.dRoi * 2 + Math.min(0, r.keep - 0.35) * 5 + r.dUsd / 1000;
}

function scoreBalanced(r) {
  if (r.capNum >= 1) return -1e9;
  if (!r.windowsOk) return -1e9;
  if (r.bets < 180) return -1e9;
  if (r.keep < 0.4) return -1e9;
  return r.dHr * 6 + r.dRoi * 4 + r.dUsd / 800 + r.keep * 2;
}

console.log('building base…');
const { shadow: base } = buildFrozenBShadowPickSets({});
const baseS = summarize(base);
const caps = [0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.18, 0.2, 1];
const rows = [];

for (const cap of caps) {
  const bets = cap >= 1 ? base : base.filter((b) => (b.ev ?? 0) < cap);
  const s = summarize(bets);
  const w = byYear(bets);
  const windowsOk = ['2024', '2025', '2026'].every((y) => (w[y].roi ?? -1) >= 0);
  rows.push({
    cap: cap >= 1 ? 'none(base)' : `EV<${(cap * 100).toFixed(0)}%`,
    capNum: cap,
    bets: s.bets,
    keep: Number((s.bets / base.length).toFixed(3)),
    cutPct: Number((100 * (1 - s.bets / base.length)).toFixed(1)),
    hitRate: Number((s.hitRate * 100).toFixed(2)),
    dHr: Number(((s.hitRate - baseS.hitRate) * 100).toFixed(2)),
    roi: Number((s.roi * 100).toFixed(2)),
    dRoi: Number(((s.roi - baseS.roi) * 100).toFixed(2)),
    usd50: s.usd50,
    dUsd: s.usd50 - baseS.usd50,
    avgOdds: Number(s.avgOdds.toFixed(3)),
    streak: s.maxLoseStreak,
    windowsOk,
    byYear: {
      '2024': {
        n: w['2024'].bets,
        hr: Number((w['2024'].hitRate * 100).toFixed(1)),
        roi: Number((w['2024'].roi * 100).toFixed(1)),
      },
      '2025': {
        n: w['2025'].bets,
        hr: Number((w['2025'].hitRate * 100).toFixed(1)),
        roi: Number((w['2025'].roi * 100).toFixed(1)),
      },
      '2026': {
        n: w['2026'].bets,
        hr: Number((w['2026'].hitRate * 100).toFixed(1)),
        roi: Number((w['2026'].roi * 100).toFixed(1)),
      },
    },
  });
}

const hitFirst = [...rows]
  .filter((r) => r.capNum < 1)
  .sort((a, b) => scoreHitFirst(b) - scoreHitFirst(a));
const balanced = [...rows]
  .filter((r) => r.capNum < 1)
  .sort((a, b) => scoreBalanced(b) - scoreBalanced(a));

const out = {
  experimentId: 'ev-cap-grid-shadow-2026-08-06',
  base: {
    bets: baseS.bets,
    hitRate: Number((baseS.hitRate * 100).toFixed(2)),
    roi: Number((baseS.roi * 100).toFixed(2)),
    usd50: baseS.usd50,
    avgOdds: Number(baseS.avgOdds.toFixed(3)),
  },
  grid: rows,
  bestHitFirst: hitFirst.slice(0, 5),
  bestBalanced: balanced.slice(0, 5),
  recommendation: {
    best: 'EV_cap_10pct',
    rule: '保留宣稱 EV < 10% 的鎖定 B 注；EV≥10% 影子剔除',
    reason:
      '命中率抬升最大且 ROI 幾乎不掉；代價是注數約砍六成、總美元下降',
  },
};

fs.writeFileSync(
  new URL('../tmp-ev-cap-grid-shadow.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('BASE', out.base);
console.log('GRID');
for (const r of rows) {
  const dRoi = `${r.dRoi >= 0 ? '+' : ''}${r.dRoi}`;
  const dUsd = `${r.dUsd >= 0 ? '+' : ''}${r.dUsd}`;
  console.log(
    `${r.cap.padEnd(12)} n=${String(r.bets).padStart(3)} cut=${String(r.cutPct).padStart(5)}% HR=${r.hitRate}% (+${r.dHr}) ROI=${r.roi}% (${dRoi}) $${r.usd50} (${dUsd}) odds=${r.avgOdds} ok=${r.windowsOk}`
  );
}
console.log('BEST_HIT_FIRST');
for (const r of hitFirst.slice(0, 5)) {
  console.log(
    `${r.cap} cut ${r.cutPct}% | HR ${r.hitRate}% (+${r.dHr}) | ROI ${r.roi}% | keep ${(r.keep * 100).toFixed(0)}% | $${r.usd50}`
  );
}
console.log('BEST_BALANCED');
for (const r of balanced.slice(0, 5)) {
  console.log(
    `${r.cap} cut ${r.cutPct}% | HR ${r.hitRate}% (+${r.dHr}) | ROI ${r.roi}% | keep ${(r.keep * 100).toFixed(0)}% | $${r.usd50}`
  );
}
console.log('RECOMMEND', out.recommendation);
