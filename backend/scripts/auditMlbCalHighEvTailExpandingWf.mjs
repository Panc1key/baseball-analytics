/**
 * 實驗 2A：高 EV 收縮 expanding WF
 * 固定政策：shrink_w15、shrink_w15_l15 vs 基線
 * + expanding 在訓練窗三選一（base / w15 / w15l15）再測次月
 *
 * 用法: node scripts/auditMlbCalHighEvTailExpandingWf.mjs
 * 產物: tmp-cal-high-ev-tail-expanding-wf.json
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
const HIGH_EV = 0.08;
const B = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: MLB_FROZEN_B_SHADOW_SPEC.selection.minimumH2hBookmakers,
};
const DROP_R3 = MLB_FROZEN_B_SHADOW_SPEC.selection.dropThirdIfMarginBelow;
const DROP_R2_MAX = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsBelow;
const DROP_R2_MIN = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsMin;

const POLICIES = [
  { id: 'baseline', w: 0, lambda: 0 },
  { id: 'shrink_w15', w: 0.15, lambda: 0 },
  { id: 'shrink_w15_l15', w: 0.15, lambda: 0.15 },
];

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hits: 0, hitRate: null, roi: null, usd50: 0, highEvN: 0, highEvUsd50: 0, highEvLossShare: null };
  }
  let hits = 0;
  let unit = 0;
  let highEv = 0;
  let highEvUnit = 0;
  let highEvLoss = 0;
  for (const b of bets) {
    const rawEv = b.rawEv ?? b.ev ?? 0;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
    if (rawEv >= HIGH_EV) {
      highEv += 1;
      if (b.hit) highEvUnit += b.pickOdds - 1;
      else {
        highEvUnit -= 1;
        highEvLoss += 1;
      }
    }
  }
  const n = bets.length;
  return {
    bets: n,
    hits,
    hitRate: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
    highEvN: highEv,
    highEvUsd50: Math.round(highEvUnit * STAKE),
    highEvLossShare: highEv ? Number((highEvLoss / highEv).toFixed(4)) : null,
  };
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

function selectWithPolicy(baseBets, policy) {
  const { w, lambda } = policy;
  const adjusted = [];
  for (const b of baseBets) {
    const market = 1 / b.pickOdds;
    const isHighEv = (b.ev ?? 0) >= HIGH_EV;
    let modelProb = b.modelProb;
    let ev = b.ev;
    let sortEv = b.ev;
    if (isHighEv && w > 0) {
      modelProb = modelProb * (1 - w) + market * w;
      ev = modelProb * (b.pickOdds - 1) - (1 - modelProb);
    }
    if (isHighEv && lambda > 0) {
      sortEv = (ev ?? 0) - lambda * Math.max(0, (b.ev ?? 0) - HIGH_EV);
    } else sortEv = ev;
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
      bScore,
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

console.log('Loading locked B shadow picks…');
const { shadow: baseAll } = buildFrozenBShadowPickSets({});
const months = [...new Set(baseAll.map((b) => b.month))].sort();
console.log('months', months.join(', '), 'n=', baseAll.length);

const inSample = {};
for (const p of POLICIES) {
  inSample[p.id] = summarize(selectWithPolicy(baseAll, p));
}

// —— 固定政策：逐月 OOS（每月相對基線 Δ$）——
function fixedMonthFolds(policy) {
  const folds = [];
  for (const month of months) {
    const pool = baseAll.filter((b) => b.month === month);
    const base = summarize(selectWithPolicy(pool, POLICIES[0]));
    const alt = summarize(selectWithPolicy(pool, policy));
    folds.push({
      month,
      base,
      alt,
      deltaUsd: alt.usd50 - base.usd50,
      deltaHighEvUsd: alt.highEvUsd50 - base.highEvUsd50,
    });
  }
  return folds;
}

const fixedReports = {};
for (const p of POLICIES.filter((x) => x.id !== 'baseline')) {
  const folds = fixedMonthFolds(p);
  const beat = folds.filter((f) => f.deltaUsd > 0).length;
  const hurt = folds.filter((f) => f.deltaUsd < 0).length;
  const flat = folds.filter((f) => f.deltaUsd === 0).length;
  const oosUsd = folds.reduce((s, f) => s + f.alt.usd50, 0);
  const baseUsd = folds.reduce((s, f) => s + f.base.usd50, 0);
  const oosHighEv = folds.reduce((s, f) => s + f.alt.highEvUsd50, 0);
  const baseHighEv = folds.reduce((s, f) => s + f.base.highEvUsd50, 0);
  const byYear = {};
  for (const y of ['2024', '2025', '2026']) {
    const ym = folds.filter((f) => f.month.startsWith(y));
    const a = ym.reduce((s, f) => s + f.alt.usd50, 0);
    const b = ym.reduce((s, f) => s + f.base.usd50, 0);
    byYear[y] = { usd50: a, baseUsd50: b, deltaUsd: a - b, months: ym.length };
  }
  const pass =
    oosUsd >= baseUsd &&
    beat >= hurt &&
    oosHighEv >= baseHighEv &&
    ['2024', '2025', '2026'].every((y) => byYear[y].deltaUsd >= -50);
  fixedReports[p.id] = {
    folds,
    beat,
    hurt,
    flat,
    oosUsd,
    baseUsd,
    deltaUsd: oosUsd - baseUsd,
    oosHighEvUsd: oosHighEv,
    baseHighEvUsd: baseHighEv,
    deltaHighEvUsd: oosHighEv - baseHighEv,
    byYear,
    pass,
  };
}

// —— Expanding：訓練窗選 best(base/w15/w15l15)，測次月 ——
const wfFolds = [];
for (let i = 1; i < months.length; i++) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];
  const trainPool = baseAll.filter((b) => trainMonths.has(b.month));
  const testPool = baseAll.filter((b) => b.month === testMonth);
  let best = POLICIES[0];
  let bestTrain = -Infinity;
  const trainScores = [];
  for (const p of POLICIES) {
    const s = summarize(selectWithPolicy(trainPool, p));
    trainScores.push({ id: p.id, usd50: s.usd50 });
    if (s.usd50 > bestTrain) {
      bestTrain = s.usd50;
      best = p;
    }
  }
  const oos = summarize(selectWithPolicy(testPool, best));
  const baseOos = summarize(selectWithPolicy(testPool, POLICIES[0]));
  const w15Oos = summarize(selectWithPolicy(testPool, POLICIES[1]));
  const w15l15Oos = summarize(selectWithPolicy(testPool, POLICIES[2]));
  wfFolds.push({
    testMonth,
    chosen: best.id,
    trainScores,
    oos,
    baseOos,
    w15Oos,
    w15l15Oos,
    deltaChosenVsBase: oos.usd50 - baseOos.usd50,
    deltaW15VsBase: w15Oos.usd50 - baseOos.usd50,
    deltaW15L15VsBase: w15l15Oos.usd50 - baseOos.usd50,
  });
  console.log(
    `fold ${testMonth}: chose ${best.id} OOSΔ$${oos.usd50 - baseOos.usd50} (w15Δ$${w15Oos.usd50 - baseOos.usd50}, w15l15Δ$${w15l15Oos.usd50 - baseOos.usd50})`
  );
}

function sumOos(field) {
  return wfFolds.reduce((s, f) => s + f[field].usd50, 0);
}
const expanding = {
  folds: wfFolds,
  chosenUsd: sumOos('oos'),
  baseUsd: sumOos('baseOos'),
  w15Usd: sumOos('w15Oos'),
  w15l15Usd: sumOos('w15l15Oos'),
  deltaChosen: sumOos('oos') - sumOos('baseOos'),
  deltaW15: sumOos('w15Oos') - sumOos('baseOos'),
  deltaW15L15: sumOos('w15l15Oos') - sumOos('baseOos'),
  chosenBeat: wfFolds.filter((f) => f.deltaChosenVsBase > 0).length,
  chosenHurt: wfFolds.filter((f) => f.deltaChosenVsBase < 0).length,
  w15Beat: wfFolds.filter((f) => f.deltaW15VsBase > 0).length,
  w15Hurt: wfFolds.filter((f) => f.deltaW15VsBase < 0).length,
  w15l15Beat: wfFolds.filter((f) => f.deltaW15L15VsBase > 0).length,
  w15l15Hurt: wfFolds.filter((f) => f.deltaW15L15VsBase < 0).length,
  choseNonBaseRate: wfFolds.filter((f) => f.chosen !== 'baseline').length / wfFolds.length,
};

const expandingPassChosen =
  expanding.deltaChosen >= 0 && expanding.chosenBeat >= expanding.chosenHurt;
const fixedW15Pass = fixedReports.shrink_w15.pass;
const fixedW15L15Pass = fixedReports.shrink_w15_l15.pass;

const promote =
  fixedW15Pass || fixedW15L15Pass
    ? {
        recommend: fixedW15L15Pass ? 'shrink_w15_l15' : 'shrink_w15',
        note: '固定政策逐月 OOS 過閘；仍建議影子觀察期，不直接改 ev02 常數——可先寫入執行層可開關 overlay',
      }
    : {
        recommend: null,
        note: '固定政策 WF 未過；丟棄或只保留更輕一檔繼續影子',
      };

const out = {
  experimentId: 'cal_high_ev_tail_expanding_wf',
  highEvThreshold: HIGH_EV,
  inSample,
  fixedMonthlyOos: {
    shrink_w15: {
      ...fixedReports.shrink_w15,
      folds: fixedReports.shrink_w15.folds.map((f) => ({
        month: f.month,
        deltaUsd: f.deltaUsd,
        deltaHighEvUsd: f.deltaHighEvUsd,
        altUsd: f.alt.usd50,
        baseUsd: f.base.usd50,
      })),
    },
    shrink_w15_l15: {
      ...fixedReports.shrink_w15_l15,
      folds: fixedReports.shrink_w15_l15.folds.map((f) => ({
        month: f.month,
        deltaUsd: f.deltaUsd,
        deltaHighEvUsd: f.deltaHighEvUsd,
        altUsd: f.alt.usd50,
        baseUsd: f.base.usd50,
      })),
    },
  },
  expanding,
  gates: {
    fixedW15Pass,
    fixedW15L15Pass,
    expandingPassChosen,
    expandingFixedW15:
      expanding.deltaW15 >= 0 && expanding.w15Beat >= expanding.w15Hurt,
    expandingFixedW15L15:
      expanding.deltaW15L15 >= 0 && expanding.w15l15Beat >= expanding.w15l15Hurt,
  },
  promote,
  verdict: promote.recommend
    ? `PASS_FIXED — 建議影子觀察／可開關 overlay：${promote.recommend}；expanding 選參 beat/hurt=${expanding.chosenBeat}/${expanding.chosenHurt}`
    : `FAIL_FIXED — 不升格；expanding Δ$chosen=${expanding.deltaChosen}`,
};

fs.writeFileSync(
  new URL('../tmp-cal-high-ev-tail-expanding-wf.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log('inSample', inSample);
console.log('fixed w15', {
  pass: fixedW15Pass,
  delta: fixedReports.shrink_w15.deltaUsd,
  beatHurt: `${fixedReports.shrink_w15.beat}/${fixedReports.shrink_w15.hurt}`,
  byYear: fixedReports.shrink_w15.byYear,
});
console.log('fixed w15l15', {
  pass: fixedW15L15Pass,
  delta: fixedReports.shrink_w15_l15.deltaUsd,
  beatHurt: `${fixedReports.shrink_w15_l15.beat}/${fixedReports.shrink_w15_l15.hurt}`,
  byYear: fixedReports.shrink_w15_l15.byYear,
});
console.log('expanding', {
  deltaChosen: expanding.deltaChosen,
  deltaW15: expanding.deltaW15,
  deltaW15L15: expanding.deltaW15L15,
  beatHurtChosen: `${expanding.chosenBeat}/${expanding.chosenHurt}`,
  beatHurtW15: `${expanding.w15Beat}/${expanding.w15Hurt}`,
  beatHurtW15L15: `${expanding.w15l15Beat}/${expanding.w15l15Hurt}`,
  choseNonBaseRate: expanding.choseNonBaseRate,
});
console.log('VERDICT', out.verdict);
console.log('wrote tmp-cal-high-ev-tail-expanding-wf.json');
