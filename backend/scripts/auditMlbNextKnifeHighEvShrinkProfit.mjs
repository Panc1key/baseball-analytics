/**
 * 下一刀盈利判定：shrink_w15_l15 vs 鎖定 B（24/25/26 真實賽果）
 *
 * 主問：在現有底座上，這刀能否推動盈利？
 * 用法: node scripts/auditMlbNextKnifeHighEvShrinkProfit.mjs
 * 產物: tmp-next-knife-high-ev-shrink-profit.json
 */
import fs from 'fs';
import {
  buildFrozenBShadowPickSets,
  MLB_FROZEN_B_SHADOW_SPEC,
} from '../src/services/MlbFrozenBShadow.js';
import { MLB_HIGH_EV_SHRINK_SHADOW_SPEC } from '../src/services/MlbHighEvShrinkShadow.js';
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

function betKey(b) {
  return `${b.gameId}|${b.pick}|${b.day}`;
}

function unitPnL(b) {
  return b.hit ? b.pickOdds - 1 : -1;
}

function summarize(bets) {
  if (!bets.length) {
    return {
      bets: 0,
      hits: 0,
      hitRate: null,
      roi: null,
      usd50: 0,
      highEvN: 0,
      highEvUsd50: 0,
    };
  }
  let hits = 0;
  let unit = 0;
  let highEv = 0;
  let highEvUnit = 0;
  for (const b of bets) {
    const rawEv = b.rawEv ?? b.ev ?? 0;
    const u = unitPnL(b);
    if (b.hit) hits += 1;
    unit += u;
    if (rawEv >= HIGH_EV) {
      highEv += 1;
      highEvUnit += u;
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
    adjusted.push({
      ...b,
      rawEv: b.ev,
      modelProb,
      ev,
      bScore,
      overlayTouched: Boolean(isHighEv && w > 0),
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

function byYear(bets) {
  const out = {};
  for (const y of ['2024', '2025', '2026']) {
    out[y] = summarize(bets.filter((b) => String(b.month).startsWith(y)));
  }
  return out;
}

function byMonth(bets) {
  const months = [...new Set(bets.map((b) => b.month))].sort();
  return months.map((m) => ({ month: m, ...summarize(bets.filter((b) => b.month === m)) }));
}

console.log('Loading locked B picks (24/25/26)…');
const { shadow: baseAll } = buildFrozenBShadowPickSets({});
const formal = select(baseAll, { w: 0, lambda: 0 });
const knife = select(baseAll, { w: W, lambda: LAMBDA });

const formalS = summarize(formal);
const knifeS = summarize(knife);
const formalY = byYear(formal);
const knifeY = byYear(knife);

const formalMap = new Map(formal.map((b) => [betKey(b), b]));
const knifeMap = new Map(knife.map((b) => [betKey(b), b]));
const dropped = formal.filter((b) => !knifeMap.has(betKey(b)));
const added = knife.filter((b) => !formalMap.has(betKey(b)));
const kept = knife.filter((b) => formalMap.has(betKey(b)));

const droppedS = summarize(dropped);
const addedS = summarize(added);
const keptS = summarize(kept);

/** 換注貢獻：丟掉的注若繼續下會是多少 vs 新增注實際多少 */
const swapDeltaUsd = addedS.usd50 - droppedS.usd50;

const months = [...new Set(baseAll.map((b) => b.month))].sort();
const monthlyDelta = months.map((m) => {
  const f = summarize(formal.filter((b) => b.month === m));
  const k = summarize(knife.filter((b) => b.month === m));
  return {
    month: m,
    formalUsd50: f.usd50,
    knifeUsd50: k.usd50,
    deltaUsd: k.usd50 - f.usd50,
    formalBets: f.bets,
    knifeBets: k.bets,
  };
});

const beat = monthlyDelta.filter((x) => x.deltaUsd > 0).length;
const hurt = monthlyDelta.filter((x) => x.deltaUsd < 0).length;
const flat = monthlyDelta.filter((x) => x.deltaUsd === 0).length;

const y2026Months = monthlyDelta.filter((x) => x.month.startsWith('2026'));
const recent2026 = y2026Months.slice(-3);
const recent2026Delta = recent2026.reduce((s, x) => s + x.deltaUsd, 0);

const deltaTotal = knifeS.usd50 - formalS.usd50;
const deltaHighEv = knifeS.highEvUsd50 - formalS.highEvUsd50;
const yearDeltas = {
  '2024': knifeY['2024'].usd50 - formalY['2024'].usd50,
  '2025': knifeY['2025'].usd50 - formalY['2025'].usd50,
  '2026': knifeY['2026'].usd50 - formalY['2026'].usd50,
};

const gates = {
  totalDeltaPositive: deltaTotal > 0,
  highEvSubsetImproves: deltaHighEv >= 0,
  beatGeHurt: beat >= hurt,
  year2024NonNeg: yearDeltas['2024'] >= -50,
  year2025NonNeg: yearDeltas['2025'] >= -50,
  year2026WithinTol: yearDeltas['2026'] >= -50,
  swapEdgePositive: swapDeltaUsd > 0,
  recent2026NotCollapse: recent2026Delta >= -100,
  hrNotSoleGate: true,
};

const passCount = Object.values(gates).filter(Boolean).length;
const gateN = Object.keys(gates).length;

let verdict;
let action;
if (
  gates.totalDeltaPositive &&
  gates.highEvSubsetImproves &&
  gates.beatGeHurt &&
  gates.year2024NonNeg &&
  gates.year2025NonNeg &&
  gates.year2026WithinTol &&
  gates.swapEdgePositive
) {
  if (!gates.recent2026NotCollapse || yearDeltas['2026'] < 0) {
    verdict = 'PROFIT_PUSH_YES_WATCH_2026';
    action =
      '24/25/合併與換注邊為正，能推盈利；2026 略拖或近窗需盯。維持 compare 觀察，不升格、不拧 w/λ。';
  } else {
    verdict = 'PROFIT_PUSH_YES';
    action =
      '真實窗證據支持下一刀推盈利；繼續 compare／活體累積，達活體閘再議可開關執行層。';
  }
} else if (gates.totalDeltaPositive && gates.swapEdgePositive) {
  verdict = 'PROFIT_PUSH_WEAK';
  action = '合併 Δ$ 為正但不穩；維持影子對照，觸提前停即關。';
} else {
  verdict = 'PROFIT_PUSH_NO';
  action = '本窗無法證明推盈利；關影子或只留更輕一檔，不升格。';
}

const out = {
  experimentId: 'next_knife_shrink_w15_l15_profit',
  knife: 'shrink_w15_l15',
  vs: 'locked_B_formal_selection',
  stakeUsd: STAKE,
  nBasePool: baseAll.length,
  formal: formalS,
  knife: knifeS,
  delta: {
    usd50: deltaTotal,
    bets: knifeS.bets - formalS.bets,
    hitRatePp:
      formalS.hitRate != null && knifeS.hitRate != null
        ? Number(((knifeS.hitRate - formalS.hitRate) * 100).toFixed(2))
        : null,
    highEvUsd50: deltaHighEv,
    byYear: yearDeltas,
  },
  swapEdge: {
    dropped: droppedS,
    added: addedS,
    kept: keptS,
    /** 新增實賺 − 若未丟會賺／虧 → 正＝換注推盈利 */
    swapDeltaUsd,
    note: '推盈利的本質來自換注邊，不是整體勝率口號',
  },
  monthlyDelta,
  monthBeatHurtFlat: { beat, hurt, flat },
  recent2026: { months: recent2026, deltaUsd: recent2026Delta },
  byYearDetail: { formal: formalY, knife: knifeY },
  gates,
  gateScore: `${passCount}/${gateN}`,
  verdict,
  action,
  hrMonitorOnly: {
    formalHr: formalS.hitRate,
    knifeHr: knifeS.hitRate,
    note: 'HR 只監控；本判定以 Δ$／換注邊／窗穩為準',
  },
};

fs.writeFileSync(
  new URL('../tmp-next-knife-high-ev-shrink-profit.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log(
  JSON.stringify(
    {
      verdict: out.verdict,
      deltaUsd: out.delta.usd50,
      byYear: out.delta.byYear,
      swapDeltaUsd: out.swapEdge.swapDeltaUsd,
      highEvDelta: out.delta.highEvUsd50,
      beatHurt: out.monthBeatHurtFlat,
      recent2026Delta: out.recent2026.deltaUsd,
      gateScore: out.gateScore,
      action: out.action,
    },
    null,
    2
  )
);
console.log('wrote tmp-next-knife-high-ev-shrink-profit.json');
