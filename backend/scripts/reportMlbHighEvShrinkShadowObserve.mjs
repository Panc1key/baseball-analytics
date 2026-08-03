/**
 * 高 EV shrink_w15_l15 影子觀察快照（歷史重放 @$50）
 * 寫入 tmp-high-ev-shrink-shadow-observe.json 供 slate / pathγ 讀取閘門狀態
 *
 * 用法: node scripts/reportMlbHighEvShrinkShadowObserve.mjs
 */
import fs from 'fs';
import {
  buildFrozenBShadowPickSets,
  MLB_FROZEN_B_SHADOW_SPEC,
} from '../src/services/MlbFrozenBShadow.js';
import {
  MLB_HIGH_EV_SHRINK_SHADOW_SPEC,
  writeHighEvShrinkLiveObserveSnapshot,
  buildObservationStatus,
} from '../src/services/MlbHighEvShrinkShadow.js';
import {
  MLB_MONEYLINE_RULE_PROFILES,
  scoreMlbMoneylineDailyRank,
} from '../src/services/MlbExpectedRunsModel.js';

const STAKE = 50;
const HIGH_EV = MLB_HIGH_EV_SHRINK_SHADOW_SPEC.highEvThreshold;
const W = MLB_HIGH_EV_SHRINK_SHADOW_SPEC.shrinkW;
const LAMBDA = MLB_HIGH_EV_SHRINK_SHADOW_SPEC.rankLambda;
const B = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: MLB_FROZEN_B_SHADOW_SPEC.selection.minimumH2hBookmakers,
};
const DROP_R3 = MLB_FROZEN_B_SHADOW_SPEC.selection.dropThirdIfMarginBelow;
const DROP_R2_MAX = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsBelow;
const DROP_R2_MIN = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsMin;

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hits: 0, hitRate: null, roi: null, usd50: 0, highEvN: 0, highEvUsd50: 0 };
  }
  let hits = 0;
  let unit = 0;
  let highEv = 0;
  let highEvUnit = 0;
  for (const b of bets) {
    const rawEv = b.rawEv ?? b.ev ?? 0;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
    if (rawEv >= HIGH_EV) {
      highEv += 1;
      if (b.hit) highEvUnit += b.pickOdds - 1;
      else highEvUnit -= 1;
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

function select(baseBets, { w, lambda }) {
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
    adjusted.push({ ...b, rawEv: b.ev, modelProb, ev, bScore, overlayTouched: isHighEv && w > 0 });
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
const formal = select(baseAll, { w: 0, lambda: 0 });
const overlay = select(baseAll, { w: W, lambda: LAMBDA });
const formalS = summarize(formal);
const overlayS = summarize(overlay);

const byYear = {};
for (const y of ['2024', '2025', '2026']) {
  const f = summarize(formal.filter((b) => String(b.month).startsWith(y)));
  const o = summarize(overlay.filter((b) => String(b.month).startsWith(y)));
  byYear[y] = {
    formalUsd50: f.usd50,
    overlayUsd50: o.usd50,
    deltaUsd50: o.usd50 - f.usd50,
    formalBets: f.bets,
    overlayBets: o.bets,
  };
}

const overlayTouched = overlay.filter((b) => b.overlayTouched);
const overlayDays = new Set(overlayTouched.map((b) => b.day)).size;
const payload = {
  source: 'historical_replay_frozen_b_picks',
  note: '歷史重放對照（非活體）；活體 apply/compare 累積後可覆寫本檔',
  overlayBets: overlayTouched.length,
  overlayDays,
  bets: overlay.length,
  days: new Set(overlay.map((b) => b.day)).size,
  deltaUsd50: overlayS.usd50 - formalS.usd50,
  highEvSubsetDeltaUsd50: overlayS.highEvUsd50 - formalS.highEvUsd50,
  formal: formalS,
  overlay: overlayS,
  byYear,
};

const written = writeHighEvShrinkLiveObserveSnapshot(payload);
const status = buildObservationStatus({ live: written });
fs.writeFileSync(
  new URL('../tmp-high-ev-shrink-shadow-observe-status.json', import.meta.url),
  JSON.stringify({ payload: written, status }, null, 2)
);
console.log(JSON.stringify({ delta: payload.deltaUsd50, byYear, status: status.status }, null, 2));
console.log('wrote tmp-high-ev-shrink-shadow-observe.json');
