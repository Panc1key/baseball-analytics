/**
 * 近 N 天：每天最多 K 注（3 / 5）的勝率對照。
 * 候選來自 HistoricalBacktest（每場最多 1 注，含 primary+watch，非僅 flat）。
 * 當日按 EV 降序取前 K；若當日不足 K 注則有多少算多少。
 *
 * 用法: node scripts/auditDailyTopKPicks.mjs [--days=90]
 */
import 'dotenv/config';
import fs from 'fs';
import { runHistoricalBacktest } from '../src/services/HistoricalBacktest.js';

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const days = Number(argValue('days') || '90');

function hkDate(iso) {
  if (!iso) return 'unknown';
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function unitPnl(d) {
  const odds = Number(d.odds);
  if (d.result === 'win') return Number.isFinite(odds) ? odds - 1 : 0;
  if (d.result === 'loss') return -1;
  return 0;
}

function summarize(details, label) {
  const decided = details.filter((d) => d.result === 'win' || d.result === 'loss');
  const wins = decided.filter((d) => d.result === 'win').length;
  const losses = decided.filter((d) => d.result === 'loss').length;
  const pushes = details.filter((d) => d.result === 'push').length;
  const pnl = details.reduce((s, d) => s + unitPnl(d), 0);
  const byDay = new Map();
  for (const d of details) {
    const day = hkDate(d.commenceTime);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  const dayCounts = [...byDay.values()];
  const avgPerDay = dayCounts.length
    ? Number((details.length / dayCounts.length).toFixed(2))
    : 0;
  return {
    label,
    daysWithPicks: dayCounts.length,
    bets: details.length,
    avgBetsPerActiveDay: avgPerDay,
    W: wins,
    L: losses,
    P: pushes,
    hitRate: wins + losses ? Number((wins / (wins + losses)).toFixed(4)) : null,
    unitPnl: Number(pnl.toFixed(2)),
    roi: details.length ? Number((pnl / details.length).toFixed(4)) : null,
  };
}

function takeTopKPerDay(details, k) {
  const byDay = new Map();
  for (const d of details) {
    const day = hkDate(d.commenceTime);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(d);
  }
  const selected = [];
  for (const [, list] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ranked = [...list].sort((a, b) => {
      const evDiff = (Number(b.ev) || -999) - (Number(a.ev) || -999);
      if (evDiff !== 0) return evDiff;
      return (Number(b.modelProb) || 0) - (Number(a.modelProb) || 0);
    });
    selected.push(...ranked.slice(0, k));
  }
  return selected;
}

function dayFillStats(details, k) {
  const byDay = new Map();
  for (const d of details) {
    const day = hkDate(d.commenceTime);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(d);
  }
  let full = 0;
  let partial = 0;
  let empty = 0;
  const sizes = [];
  for (const [, list] of byDay) {
    const n = Math.min(list.length, k);
    // recount from raw day pool before slice - need original pool sizes
  }
  // recompute from grouping raw then slice
  return null;
}

console.log(`回測候選池 days=${days}（primary+watch，每場1注，非僅flat）…`);
const report = await runHistoricalBacktest({
  days,
  primaryOnly: false,
  flatBetOnly: false,
  excludeSample: true,
  topPickPerGame: true,
  pointInTimeForm: true,
  saveCalibration: false,
});

const pool = (report.details || []).filter((d) =>
  ['win', 'loss', 'push'].includes(d.result)
);
const mlbPool = pool.filter((d) => d.league === 'MLB');

// 原始日供應量
const supplyByDay = new Map();
for (const d of mlbPool) {
  const day = hkDate(d.commenceTime);
  supplyByDay.set(day, (supplyByDay.get(day) || 0) + 1);
}
const supply = [...supplyByDay.values()];
const supplyStats = {
  activeDays: supply.length,
  avgCandidatesPerDay: supply.length
    ? Number((mlbPool.length / supply.length).toFixed(2))
    : 0,
  daysWithGe3: supply.filter((n) => n >= 3).length,
  daysWithGe5: supply.filter((n) => n >= 5).length,
  medianCandidates: supply.length
    ? [...supply].sort((a, b) => a - b)[Math.floor(supply.length / 2)]
    : 0,
};

function fillProfile(selected, k) {
  const byDay = new Map();
  for (const d of selected) {
    const day = hkDate(d.commenceTime);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  const counts = [...byDay.values()];
  return {
    daysReachedK: counts.filter((n) => n >= k).length,
    daysBelowK: counts.filter((n) => n < k).length,
    avgOnActiveDays: counts.length
      ? Number((selected.length / counts.length).toFixed(2))
      : 0,
  };
}

const top3 = takeTopKPerDay(mlbPool, 3);
const top5 = takeTopKPerDay(mlbPool, 5);

const flatMlb = mlbPool.filter(
  (d) => d.betStrategy === 'flat_bet' || d.bet_strategy === 'flat_bet'
);

const out = {
  ok: true,
  days,
  window: report.window,
  modelVersion: report.modelVersion,
  mlbCandidatePool: {
    bets: mlbPool.length,
    ...summarize(mlbPool, 'all_mlb_candidates'),
    supply: supplyStats,
  },
  dailyCap: {
    top3: {
      ...summarize(top3, 'mlb_top3_per_day_by_ev'),
      fill: fillProfile(top3, 3),
    },
    top5: {
      ...summarize(top5, 'mlb_top5_per_day_by_ev'),
      fill: fillProfile(top5, 5),
    },
  },
  referenceFlatTagged: summarize(flatMlb, 'mlb_flat_tagged_in_pool'),
  note: [
    '排序：當日 EV 高→低，同 EV 看 modelProb',
    '候選池＝系統有推薦的場（非全 14 場硬塞）；若當日不足 3/5，不會硬湊',
    '若 daysWithGe5 很少，代表現有門檻下很難穩定每天 5 注',
  ],
};

fs.writeFileSync('tmp-daily-topk.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
