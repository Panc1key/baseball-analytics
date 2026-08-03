/**
 * 實驗 1（Grok 2026-08-03）：串關紀律紙上審計
 * 單場 $50；當日恰有 3 推時：R1×R2、R1×R3、3串 各 $25
 * 對照純單場；不改鎖定 B 常數
 *
 * 用法: node scripts/auditMlbStarParlayDiscipline.mjs
 * 產物: tmp-star-parlay-discipline.json
 */
import fs from 'fs';
import { buildFrozenBShadowPickSets } from '../src/services/MlbFrozenBShadow.js';

const SINGLE = 50;
const PARLAY = 25;
const EXP_ID = 'star-parlay-discipline-2026-08-03';

function sumSingles(bets) {
  let units = 0;
  let hits = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      units += b.pickOdds - 1;
    } else units -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hits,
    hitRate: n ? hits / n : null,
    units: Number(units.toFixed(4)),
    usd: Math.round(units * SINGLE),
    staked: n * SINGLE,
    roi: n ? units / n : null,
  };
}

function evalParlay(legs, stake = PARLAY) {
  const combined = legs.reduce((p, x) => p * x.pickOdds, 1);
  const won = legs.every((x) => x.hit);
  return {
    combined: Number(combined.toFixed(4)),
    won,
    profit: won ? stake * (combined - 1) : -stake,
  };
}

function byWindow(rows, keyFn) {
  const out = {};
  for (const y of ['2024', '2025', '2026']) {
    const list = rows.filter((r) => keyFn(r) === y);
    out[y] = list;
  }
  return out;
}

function maxConsecutive(flags) {
  let max = 0;
  let cur = 0;
  for (const f of flags) {
    if (f) {
      cur += 1;
      max = Math.max(max, cur);
    } else cur = 0;
  }
  return max;
}

function stdev(xs) {
  if (!xs.length) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Number(Math.sqrt(v).toFixed(2));
}

const { shadow: bets } = buildFrozenBShadowPickSets({});
const byDay = new Map();
for (const b of bets) {
  if (!byDay.has(b.day)) byDay.set(b.day, []);
  byDay.get(b.day).push(b);
}

const days = [...byDay.entries()]
  .map(([day, list]) => ({
    day,
    window: list[0].window,
    month: list[0].month,
    legs: [...list].sort((a, b) => (a.rank || 99) - (b.rank || 99)),
  }))
  .sort((a, b) => a.day.localeCompare(b.day));

const days3 = days.filter((d) => d.legs.length === 3);
const dayRows = [];

for (const d of days) {
  const singles = sumSingles(d.legs);
  const hits = d.legs.filter((x) => x.hit).length;
  const fullBlack = hits === 0;
  let parlayProfit = 0;
  let parlayStaked = 0;
  let parlayWins = 0;
  let parlayN = 0;
  const parlays = [];
  if (d.legs.length === 3) {
    const [r1, r2, r3] = d.legs;
    const bundle = [
      { id: '2leg_r1r2', ...evalParlay([r1, r2]) },
      { id: '2leg_r1r3', ...evalParlay([r1, r3]) },
      { id: '3leg', ...evalParlay([r1, r2, r3]) },
    ];
    for (const p of bundle) {
      parlays.push(p);
      parlayProfit += p.profit;
      parlayStaked += PARLAY;
      parlayN += 1;
      if (p.won) parlayWins += 1;
    }
  }
  const singlesOnlyUsd = singles.usd;
  const withParlayUsd = singlesOnlyUsd + parlayProfit;
  dayRows.push({
    day: d.day,
    window: d.window,
    nLegs: d.legs.length,
    hits,
    fullBlack,
    singlesUsd: singlesOnlyUsd,
    parlayUsd: Number(parlayProfit.toFixed(2)),
    combinedUsd: Number(withParlayUsd.toFixed(2)),
    parlayN,
    parlayWins,
    parlays,
  });
}

function packBook(label, useParlay) {
  let singlesUsd = 0;
  let parlayUsd = 0;
  let singleBets = 0;
  let singleHits = 0;
  let parlayBets = 0;
  let parlayHits = 0;
  let parlayStaked = 0;
  const dayPnls = [];
  const fullBlackFlags = [];
  const dayNetNegFlags = [];

  for (const d of dayRows) {
    singlesUsd += d.singlesUsd;
    singleBets += d.nLegs;
    singleHits += d.hits;
    let dayPnl = d.singlesUsd;
    if (useParlay) {
      parlayUsd += d.parlayUsd;
      parlayBets += d.parlayN;
      parlayHits += d.parlayWins;
      parlayStaked += d.parlayN * PARLAY;
      dayPnl = d.combinedUsd;
    }
    dayPnls.push(dayPnl);
    fullBlackFlags.push(d.fullBlack);
    dayNetNegFlags.push(dayPnl < 0);
  }

  const totalUsd = singlesUsd + (useParlay ? parlayUsd : 0);
  const singleStaked = singleBets * SINGLE;
  const totalStaked = singleStaked + (useParlay ? parlayStaked : 0);
  const fullBlackDays = fullBlackFlags.filter(Boolean).length;
  // 「全日零中」：單場全黑；有串關時另計「當日淨虧」天
  return {
    label,
    singleBets,
    singleHitRate: singleBets ? singleHits / singleBets : null,
    singlesUsd: Math.round(singlesUsd),
    parlayBets,
    parlayHitRate: parlayBets ? parlayHits / parlayBets : null,
    parlayUsd: Number(parlayUsd.toFixed(2)),
    totalUsd: Number(totalUsd.toFixed(2)),
    totalStaked,
    roiOnStaked: totalStaked ? totalUsd / totalStaked : null,
    pickDays: dayRows.length,
    daysWith3: days3.length,
    fullBlackDays,
    fullBlackRate: dayRows.length ? fullBlackDays / dayRows.length : null,
    maxConsecutiveFullBlackDays: maxConsecutive(fullBlackFlags),
    netLoseDays: dayNetNegFlags.filter(Boolean).length,
    maxConsecutiveNetLoseDays: maxConsecutive(dayNetNegFlags),
    dayPnlStdev: stdev(dayPnls),
    avgDayPnl: dayRows.length
      ? Number((dayPnls.reduce((a, b) => a + b, 0) / dayRows.length).toFixed(2))
      : null,
  };
}

const baseline = packBook('singles_only_$50', false);
const withStar = packBook('singles_$50_plus_star_parlays_$25', true);

const byYear = {};
for (const y of ['2024', '2025', '2026']) {
  const subset = dayRows.filter((d) => d.window === y);
  const singlesUsd = subset.reduce((s, d) => s + d.singlesUsd, 0);
  const parlayUsd = subset.reduce((s, d) => s + d.parlayUsd, 0);
  const fullBlack = subset.filter((d) => d.fullBlack).length;
  const netLoseBase = subset.filter((d) => d.singlesUsd < 0).length;
  const netLoseCombo = subset.filter((d) => d.combinedUsd < 0).length;
  byYear[y] = {
    pickDays: subset.length,
    days3: subset.filter((d) => d.nLegs === 3).length,
    singlesUsd: Math.round(singlesUsd),
    parlayUsd: Number(parlayUsd.toFixed(2)),
    combinedUsd: Number((singlesUsd + parlayUsd).toFixed(2)),
    deltaVsSinglesOnly: Number(parlayUsd.toFixed(2)),
    fullBlackDays: fullBlack,
    netLoseDaysSinglesOnly: netLoseBase,
    netLoseDaysWithParlay: netLoseCombo,
  };
}

// 僅在有 3 推日上的串關邊際（對照「那些天」純單場）
const only3 = dayRows.filter((d) => d.nLegs === 3);
const only3Singles = only3.reduce((s, d) => s + d.singlesUsd, 0);
const only3Parlay = only3.reduce((s, d) => s + d.parlayUsd, 0);
const only3FullBlack = only3.filter((d) => d.fullBlack).length;
const only3NetLoseS = only3.filter((d) => d.singlesUsd < 0).length;
const only3NetLoseC = only3.filter((d) => d.combinedUsd < 0).length;

const deltaTotal = withStar.totalUsd - baseline.totalUsd;
const deltaFullBlack = withStar.fullBlackDays - baseline.fullBlackDays; // same definition - full black is about singles hits
// 體感「少黑」：用當日淨虧天
const deltaNetLose = withStar.netLoseDays - baseline.netLoseDays;

const pass = {
  parlayDoesNotDragTotalUsd: deltaTotal >= 0,
  netLoseDaysDownOrFlat: deltaNetLose <= 0,
  // 全日零中（單場全黑）串關無法減少「場次全黑」本身，但可減少淨虧天
  note: 'fullBlackDays 由單場命中定義，串關不改變該計數；成功看 totalUsd 與 netLoseDays',
  allWindowsCombinedNonNeg: ['2024', '2025', '2026'].every((y) => byYear[y].combinedUsd >= 0),
  allWindowsParlayNonNeg: ['2024', '2025', '2026'].every((y) => byYear[y].parlayUsd >= 0),
};
pass.overall =
  pass.parlayDoesNotDragTotalUsd &&
  pass.netLoseDaysDownOrFlat &&
  pass.allWindowsCombinedNonNeg;

const out = {
  experimentId: EXP_ID,
  grokRef: 'GROK-HANDOFF-HITRATE-2026-08-03 / experiment 1',
  stakes: { single: SINGLE, parlay: PARLAY },
  rule: 'when daily Top has exactly 3 legs: 2x R1×R2, 2x R1×R3, 3x R1×R2×R3 @ $25; singles always @$50',
  windows: '2024-04～09 + 2025-04～09 + 2026-04～07-22 locked B shadow picks',
  baseline,
  withStar,
  delta: {
    totalUsd: Number(deltaTotal.toFixed(2)),
    netLoseDays: deltaNetLose,
    fullBlackDays: deltaFullBlack,
    dayPnlStdev: Number((withStar.dayPnlStdev - baseline.dayPnlStdev).toFixed(2)),
  },
  byYear,
  onDaysWithExactly3: {
    days: only3.length,
    singlesUsd: Math.round(only3Singles),
    parlayUsd: Number(only3Parlay.toFixed(2)),
    combinedUsd: Math.round(only3Singles + only3Parlay),
    fullBlackDays: only3FullBlack,
    netLoseDaysSinglesOnly: only3NetLoseS,
    netLoseDaysWithParlay: only3NetLoseC,
    avgParlayUsdPerSuchDay: Number((only3Parlay / only3.length).toFixed(2)),
  },
  pass,
  verdict: pass.overall
    ? 'PASS — 維持 star 串關紀律；不傷總美元且淨虧天未升'
    : 'REVIEW — 見 fail flags；暫勿當無條件加碼依據',
};

fs.writeFileSync(
  new URL('../tmp-star-parlay-discipline.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('=== Experiment 1: Star Parlay Discipline ===');
console.log('baseline', baseline);
console.log('withStar', withStar);
console.log('delta', out.delta);
console.log('byYear', byYear);
console.log('onDays3', out.onDaysWithExactly3);
console.log('pass', pass);
console.log('VERDICT', out.verdict);
console.log('wrote tmp-star-parlay-discipline.json');
