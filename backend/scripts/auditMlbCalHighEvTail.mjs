/**
 * 實驗 2（Grok）：cal_high_ev_tail
 * 只對高 EV 子集做輕收縮／排序減分；不改全局門檻
 *
 * 用法: node scripts/auditMlbCalHighEvTail.mjs
 * 產物: tmp-cal-high-ev-tail.json
 */
import fs from 'fs';
import {
  buildFrozenBShadowPickSets,
  MLB_FROZEN_B_SHADOW_SPEC,
} from '../src/services/MlbFrozenBShadow.js';
import {
  MLB_MONEYLINE_RULE_PROFILES,
  scoreMlbMoneylineDailyRank,
} from '../src/services/MlbExpectedRunsModel.js';

const STAKE = 50;
const B = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: MLB_FROZEN_B_SHADOW_SPEC.selection.minimumH2hBookmakers,
};
const DROP_R3 = MLB_FROZEN_B_SHADOW_SPEC.selection.dropThirdIfMarginBelow;
const DROP_R2_MAX = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsBelow;
const DROP_R2_MIN = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsMin;

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hitRate: null, roi: null, usd50: 0, highEvN: 0, highEvLossShare: null };
  }
  let hits = 0;
  let unit = 0;
  let highEv = 0;
  let highEvLoss = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
    if ((b.rawEv ?? b.ev ?? 0) >= 0.08) {
      highEv += 1;
      if (!b.hit) highEvLoss += 1;
    }
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
    highEvN: highEv,
    highEvLossShare: highEv ? Number((highEvLoss / highEv).toFixed(4)) : null,
  };
}

function byYear(bets) {
  const out = {};
  for (const y of ['2024', '2025', '2026']) out[y] = summarize(bets.filter((b) => b.window === y));
  return out;
}

function applyDrop(sorted) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
  if (
    slots.length >= 2 &&
    slots[1].pickOdds >= DROP_R2_MIN &&
    slots[1].pickOdds < DROP_R2_MAX
  ) {
    slots = [slots[0], ...slots.slice(2)].slice(0, 2);
  }
  return slots;
}

/**
 * 從「已過基礎閘的影子池」重跑：可對高 EV 子集縮 P 或減排序分後再過閘 + 日 Top
 * basePool = buildFrozenBShadowPickSets 前的日內候選太重；改用已選出的 shadow 回放不夠。
 * 簡化：在最終 shadow 注上，對高 EV 子集若收縮後 EV 不過閘則丟棄該注；其餘保留；再按日重排 Top3。
 */
function runShrinkVariant(baseBets, { w = 0, lambda = 0, highEvMin = 0.08 } = {}) {
  const adjusted = [];
  for (const b of baseBets) {
    const market = 1 / b.pickOdds;
    const isHighEv = (b.ev ?? 0) >= highEvMin;
    let modelProb = b.modelProb;
    let ev = b.ev;
    let sortEv = b.ev;
    if (isHighEv && w > 0) {
      modelProb = modelProb * (1 - w) + market * w;
      ev = modelProb * (b.pickOdds - 1) - (1 - modelProb);
    }
    if (isHighEv && lambda > 0) {
      sortEv = (ev ?? 0) - lambda * Math.max(0, (b.ev ?? 0) - highEvMin);
    } else {
      sortEv = ev;
    }
    // 仍過原閘才保留
    if (ev < B.minimumExpectedValue) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (b.margin < B.minimumExpectedRunMargin) continue;
    if (b.pickOdds < B.minimumPickOdds || b.pickOdds > B.maximumPickOdds) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: sortEv, modelProbability: modelProb },
      B
    );
    adjusted.push({
      ...b,
      rawEv: b.ev,
      modelProb,
      ev,
      sortEv,
      bScore,
      shrunk: isHighEv && (w > 0 || lambda > 0),
    });
  }

  const byDay = new Map();
  for (const b of adjusted) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (x, y) => y.bScore - x.bScore || y.margin - x.margin
    );
    applyDrop(arr).forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

console.log('Loading picks…');
const { shadow: base } = buildFrozenBShadowPickSets({});

const variants = [];
const configs = [
  { id: 'baseline', w: 0, lambda: 0 },
  { id: 'shrink_w15', w: 0.15, lambda: 0 },
  { id: 'shrink_w25', w: 0.25, lambda: 0 },
  { id: 'penalty_l15', w: 0, lambda: 0.15 },
  { id: 'penalty_l25', w: 0, lambda: 0.25 },
  { id: 'shrink_w15_l15', w: 0.15, lambda: 0.15 },
  { id: 'shrink_w25_l25', w: 0.25, lambda: 0.25 },
];

const baseSum = summarize(base);
const baseYears = byYear(base);

for (const cfg of configs) {
  const bets = cfg.id === 'baseline' ? base : runShrinkVariant(base, cfg);
  const overall = summarize(bets);
  const years = byYear(bets);
  const highEvBets = bets.filter((b) => (b.rawEv ?? b.ev ?? 0) >= 0.08);
  const highEv = summarize(highEvBets.map((b) => ({ ...b, ev: b.rawEv ?? b.ev })));
  const deltaUsd = overall.usd50 - baseSum.usd50;
  const windowsOk = ['2024', '2025', '2026'].every(
    (y) => (years[y].roi ?? -1) >= 0 && (years[y].usd50 ?? 0) >= (baseYears[y].usd50 ?? 0) - 50
  );
  // Grok: 子集 Δ$ 改善，全池 ROI 不降、三窗無單窗轉負
  const subsetImproved =
    cfg.id === 'baseline'
      ? false
      : (highEv.usd50 ?? 0) >=
        summarize(base.filter((b) => (b.ev ?? 0) >= 0.08)).usd50;
  const poolRoiOk = (overall.roi ?? -1) >= (baseSum.roi ?? 0) - 1e-9;
  const poolUsdOk = deltaUsd >= 0;
  const windowsNonNeg = ['2024', '2025', '2026'].every((y) => (years[y].roi ?? -1) >= 0);
  const pass =
    cfg.id !== 'baseline' && subsetImproved && poolRoiOk && poolUsdOk && windowsNonNeg;

  variants.push({
    id: cfg.id,
    w: cfg.w,
    lambda: cfg.lambda,
    overall,
    years,
    highEvSubset: highEv,
    deltaUsd,
    keepRate: Number((bets.length / base.length).toFixed(3)),
    subsetImproved,
    poolRoiOk,
    poolUsdOk,
    windowsNonNeg,
    pass,
  });
}

const passers = variants.filter((v) => v.pass);
const out = {
  experimentId: 'cal_high_ev_tail',
  base: baseSum,
  baseYears,
  baseHighEv: summarize(base.filter((b) => (b.ev ?? 0) >= 0.08)),
  variants,
  passers: passers.map((v) => v.id),
  verdict: passers.length
    ? `PASS candidates: ${passers.map((v) => v.id).join(', ')} — 影子觀察，勿直接改主閘`
    : 'FAIL — 高 EV 輕收縮／罰分未能同時改善子集與全池；維持現狀',
};

fs.writeFileSync(new URL('../tmp-cal-high-ev-tail.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('BASE', baseSum, 'highEv', out.baseHighEv);
for (const v of variants) {
  console.log(
    v.id,
    `usd=${v.overall.usd50} Δ$${v.deltaUsd} roi=${v.overall.roi} keep=${v.keepRate}`,
    `highEv$=${v.highEvSubset.usd50} lossShare=${v.highEvSubset.highEvLossShare}`,
    `pass=${v.pass}`
  );
}
console.log('VERDICT', out.verdict);
