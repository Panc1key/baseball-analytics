/**
 * 從鎖定 B 影子「輸掉的注」反推失敗模式（不改正式）
 * 對照贏注抬升度，找可手術優化方向
 *
 * 用法: node scripts/auditMlbLossAutopsy.mjs
 * 產物: tmp-mlb-loss-autopsy.json
 */
import fs from 'fs';
import { buildFrozenBShadowPickSets } from '../src/services/MlbFrozenBShadow.js';
import { MLB_SURGICAL_AWAY_STRONG_EV_SPEC } from '../src/services/MlbSurgicalAwayStrongEvShadow.js';

const STAKE = 50;
const STRONG = 0.65;
const RULE = MLB_SURGICAL_AWAY_STRONG_EV_SPEC.rule;

function summarize(bets) {
  if (!bets.length) {
    return { n: 0, hits: 0, hr: null, roi: null, usd: 0, avgOdds: null, avgEv: null };
  }
  let hits = 0;
  let unit = 0;
  let odds = 0;
  let ev = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    ev += b.ev ?? 0;
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

function isSurgicalA(b) {
  return (
    (b.ev ?? 0) >= RULE.minEv &&
    !b.pickHome &&
    (b.homeWinPct ?? 0) >= RULE.strongHomeWinPct
  );
}

function traitsOf(b) {
  return {
    side: b.pickHome ? 'home' : 'away',
    rank: `R${b.rank}`,
    oddsBand:
      b.pickOdds < 1.95
        ? '1.85-1.95'
        : b.pickOdds < 2.1
          ? '1.95-2.10'
          : b.pickOdds < 2.2
            ? '2.10-2.20'
            : '2.20+',
    evBand:
      (b.ev ?? 0) < 0.05
        ? 'EV<5'
        : (b.ev ?? 0) < 0.1
          ? 'EV5-10'
          : (b.ev ?? 0) < 0.15
            ? 'EV10-15'
            : 'EV≥15',
    pBand:
      (b.modelProb ?? 0) < 0.52
        ? 'P<52'
        : (b.modelProb ?? 0) < 0.55
          ? 'P52-55'
          : (b.modelProb ?? 0) < 0.6
            ? 'P55-60'
            : 'P≥60',
    homeStrength:
      (b.homeWinPct ?? 0) >= 0.65
        ? 'home≥65'
        : (b.homeWinPct ?? 0) >= 0.58
          ? 'home58-65'
          : 'home<58',
    marginBand:
      (b.margin ?? 0) < 0.4
        ? 'margin<0.4'
        : (b.margin ?? 0) < 0.7
          ? 'margin0.4-0.7'
          : 'margin≥0.7',
    toxic:
      !b.pickHome && (b.homeWinPct ?? 0) >= STRONG && (b.modelProb ?? 0) >= 0.55
        ? 'toxic_away'
        : 'other',
    surgicalA: isSurgicalA(b) ? 'surgical_a' : 'other',
    longAway:
      !b.pickHome && b.pickOdds >= 2.1 && b.pickOdds < 2.2
        ? 'away_2.10-2.20'
        : !b.pickHome && b.pickOdds >= 2.2
          ? 'away_≥2.20'
          : !b.pickHome
            ? 'away_<2.10'
            : 'home',
    edgeBand:
      edge(b) < 0.04
        ? 'edge<4pp'
        : edge(b) < 0.08
          ? 'edge4-8pp'
          : 'edge≥8pp',
  };
}

/** 輸注占比相對全體占比的抬升（>1 = 輸注中過代表現） */
function lossLift(all, losses, keyFn) {
  const allB = bucket(all, keyFn);
  const lossB = bucket(losses, keyFn);
  const allN = all.length || 1;
  const lossN = losses.length || 1;
  return lossB
    .map((row) => {
      const base = allB.find((x) => x.key === row.key);
      const allShare = (base?.n ?? 0) / allN;
      const lossShare = row.n / lossN;
      const lift = allShare > 0 ? lossShare / allShare : null;
      return {
        key: row.key,
        lossN: row.n,
        lossShare: Number((lossShare * 100).toFixed(1)),
        allN: base?.n ?? 0,
        allShare: Number((allShare * 100).toFixed(1)),
        allHr: base?.hr ?? null,
        allRoi: base?.roi ?? null,
        lift: lift == null ? null : Number(lift.toFixed(2)),
      };
    })
    .filter((r) => r.lossN >= 15)
    .sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));
}

function applyCut(base, pred) {
  const cut = base.filter(pred);
  const kept = base.filter((b) => !pred(b));
  const bS = summarize(base);
  const kS = summarize(kept);
  const cS = summarize(cut);
  return {
    cutPct: Number(((100 * cut.length) / Math.max(1, base.length)).toFixed(1)),
    cut: cS,
    kept: kS,
    dHr: Number((kS.hr - bS.hr).toFixed(2)),
    dRoi: Number((kS.roi - bS.roi).toFixed(2)),
    dUsd: kS.usd - bS.usd,
    keepRate: Number((kept.length / Math.max(1, base.length)).toFixed(3)),
  };
}

console.log('[loss-autopsy] building…');
const { shadow: base } = buildFrozenBShadowPickSets({});
const wins = base.filter((b) => b.hit);
const losses = base.filter((b) => !b.hit);

const dims = [
  'side',
  'rank',
  'oddsBand',
  'evBand',
  'pBand',
  'homeStrength',
  'marginBand',
  'toxic',
  'surgicalA',
  'longAway',
  'edgeBand',
];

const lifts = {};
for (const dim of dims) {
  lifts[dim] = lossLift(base, losses, (b) => traitsOf(b)[dim]);
}

/** 輸注內高頻組合（至少 12 筆） */
const comboKeys = [
  (b) => {
    const t = traitsOf(b);
    return `${t.side}|${t.evBand}|${t.homeStrength}`;
  },
  (b) => {
    const t = traitsOf(b);
    return `${t.side}|${t.oddsBand}|${t.rank}`;
  },
  (b) => {
    const t = traitsOf(b);
    return `${t.evBand}|${t.longAway}`;
  },
  (b) => {
    const t = traitsOf(b);
    return `R${b.rank}|${t.oddsBand}|${t.evBand}`;
  },
];

const lossCombos = [];
for (const keyFn of comboKeys) {
  for (const row of bucket(losses, keyFn)) {
    if (row.n < 12) continue;
    const allSame = base.filter((b) => keyFn(b) === row.key);
    const allS = summarize(allSame);
    lossCombos.push({
      key: row.key,
      lossN: row.n,
      lossShare: Number(((100 * row.n) / losses.length).toFixed(1)),
      sliceN: allS.n,
      sliceHr: allS.hr,
      sliceRoi: allS.roi,
      sliceUsd: allS.usd,
    });
  }
}
lossCombos.sort((a, b) => {
  const aBad = (a.sliceRoi ?? 0) + (a.sliceHr ?? 50) * 0.05;
  const bBad = (b.sliceRoi ?? 0) + (b.sliceHr ?? 50) * 0.05;
  return aBad - bBad || b.lossN - a.lossN;
});

const candidateKnives = [
  {
    id: 'already_surgical_a',
    label: '已開觀察：高EV×客×主≥65%',
    pred: isSurgicalA,
  },
  {
    id: 'loss_mid_odds_high_ev_away',
    label: '高EV×客×賠率2.10-2.20',
    pred: (b) =>
      (b.ev ?? 0) >= 0.1 && !b.pickHome && b.pickOdds >= 2.1 && b.pickOdds < 2.2,
  },
  {
    id: 'loss_high_ev_rank2',
    label: '高EV×Rank2',
    pred: (b) => (b.ev ?? 0) >= 0.1 && b.rank === 2,
  },
  {
    id: 'loss_away_mid_odds_any_ev',
    label: '客×賠率1.95-2.10（不限EV）',
    pred: (b) => !b.pickHome && b.pickOdds >= 1.95 && b.pickOdds < 2.1,
  },
  {
    id: 'loss_r2_mid_odds',
    label: 'Rank2×賠率1.95-2.10',
    pred: (b) => b.rank === 2 && b.pickOdds >= 1.95 && b.pickOdds < 2.1,
  },
  {
    id: 'loss_thin_margin_away',
    label: '客×margin<0.4',
    pred: (b) => !b.pickHome && (b.margin ?? 0) < 0.4,
  },
  {
    id: 'loss_high_ev_low_p',
    label: '高EV×P<52%',
    pred: (b) => (b.ev ?? 0) >= 0.1 && (b.modelProb ?? 0) < 0.52,
  },
  {
    id: 'loss_surgical_a_plus_mid_odds',
    label: '手術A ∪ 高EV客2.10-2.20',
    pred: (b) =>
      isSurgicalA(b) ||
      ((b.ev ?? 0) >= 0.1 && !b.pickHome && b.pickOdds >= 2.1 && b.pickOdds < 2.2),
  },
];

const knives = candidateKnives.map((k) => ({
  id: k.id,
  label: k.label,
  ...applyCut(base, k.pred),
}));

knives.sort(
  (a, b) =>
    b.dHr * 6 +
    b.dRoi * 3 +
    Math.min(0, b.dUsd) / 800 -
    (a.dHr * 6 + a.dRoi * 3 + Math.min(0, a.dUsd) / 800)
);

/** 輸注裡「本可避開」的占比 */
const avoidable = {
  surgicalA: losses.filter(isSurgicalA).length,
  midOddsHighEvAway: losses.filter(
    (b) =>
      (b.ev ?? 0) >= 0.1 && !b.pickHome && b.pickOdds >= 2.1 && b.pickOdds < 2.2
  ).length,
  highEvR2: losses.filter((b) => (b.ev ?? 0) >= 0.1 && b.rank === 2).length,
};

const interpretation = [];
interpretation.push(
  `基線 n=${base.length} 贏=${wins.length} 輸=${losses.length} HR=${summarize(base).hr}% ROI=${summarize(base).roi}%`
);
interpretation.push(
  `輸注中手術A病灶 ${avoidable.surgicalA}/${losses.length}（${((100 * avoidable.surgicalA) / losses.length).toFixed(1)}%）— 已開觀察線`
);

const topLifts = Object.entries(lifts)
  .flatMap(([dim, rows]) =>
    rows.slice(0, 2).map((r) => ({ dim, ...r }))
  )
  .filter((r) => (r.lift ?? 0) >= 1.15)
  .sort((a, b) => b.lift - a.lift)
  .slice(0, 8);

for (const r of topLifts) {
  interpretation.push(
    `輸注抬升：${r.dim}=${r.key} lift=${r.lift}（輸占比${r.lossShare}% vs 全體${r.allShare}%；該片 HR=${r.allHr}% ROI=${r.allRoi}%）`
  );
}

const goodKnives = knives.filter(
  (k) => k.cut.n >= 30 && k.dHr >= 0.4 && k.dRoi >= -0.5 && k.keepRate >= 0.75
);
for (const k of goodKnives.slice(0, 5)) {
  interpretation.push(
    `可跟進刀：${k.label} 砍${k.cutPct}% 被砍ROI=${k.cut.roi}% → 保留 HR ${k.kept.hr}% (${k.dHr >= 0 ? '+' : ''}${k.dHr}) ROI ${k.kept.roi}% (${k.dRoi >= 0 ? '+' : ''}${k.dRoi}) Δ$${k.dUsd}`
  );
}

const out = {
  experimentId: 'mlb-loss-autopsy-2026-08-06',
  note: '從輸注反推；不改正式主倉。手術A已開觀察線。',
  baseline: summarize(base),
  wins: summarize(wins),
  losses: summarize(losses),
  avoidableInLosses: {
    ...avoidable,
    lossN: losses.length,
  },
  lossLiftsByDim: lifts,
  topLossCombos: lossCombos.slice(0, 20),
  candidateKnives: knives,
  recommendedNext: goodKnives
    .filter((k) => k.id !== 'already_surgical_a')
    .slice(0, 3)
    .map((k) => k.id),
  interpretation,
};

fs.writeFileSync(
  new URL('../tmp-mlb-loss-autopsy.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('BASE', out.baseline);
console.log('WINS', out.wins);
console.log('LOSSES', out.losses);
console.log('\nAVOIDABLE IN LOSSES', out.avoidableInLosses);
console.log('\nTOP LOSS LIFTS');
for (const r of topLifts) {
  console.log(
    `  ${r.dim}=${r.key} lift=${r.lift} lossShare=${r.lossShare}% allHR=${r.allHr}% allROI=${r.allRoi}%`
  );
}
console.log('\nTOP LOSS COMBOS (weak slices)');
for (const c of lossCombos.slice(0, 10)) {
  console.log(
    `  ${c.key} lossN=${c.lossN} slice n=${c.sliceN} HR=${c.sliceHr}% ROI=${c.sliceRoi}% $${c.sliceUsd}`
  );
}
console.log('\nKNIVES');
for (const k of knives.slice(0, 8)) {
  console.log(
    `  ${k.id} cut ${k.cutPct}% (cutROI=${k.cut.roi}%) keep HR=${k.kept.hr}% (${k.dHr >= 0 ? '+' : ''}${k.dHr}) ROI=${k.kept.roi}% (${k.dRoi >= 0 ? '+' : ''}${k.dRoi}) Δ$${k.dUsd}`
  );
}
console.log('\nINTERP');
for (const line of interpretation) console.log(' -', line);
console.log('\nNEXT', out.recommendedNext);
