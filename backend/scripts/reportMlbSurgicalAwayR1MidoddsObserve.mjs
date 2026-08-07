/**
 * 手術 B 觀察快照：客 × Rank1 × 中水 1.95–2.10
 * 寫入 tmp-surgical-away-r1-midodds-observe.json
 *
 * 用法: node scripts/reportMlbSurgicalAwayR1MidoddsObserve.mjs
 */
import fs from 'fs';
import { buildFrozenBShadowPickSets } from '../src/services/MlbFrozenBShadow.js';
import {
  MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC,
  writeSurgicalAwayR1MidoddsObserveSnapshot,
  buildSurgicalAwayR1MidoddsObservationStatus,
} from '../src/services/MlbSurgicalAwayR1MidoddsShadow.js';

const STAKE = 50;
const RULE = MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC.rule;

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hits: 0, hitRate: null, roi: null, usd50: 0 };
  }
  let hits = 0;
  let unit = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hits,
    hitRate: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
  };
}

function isCut(b) {
  return (
    !b.pickHome &&
    b.rank === RULE.rank &&
    b.pickOdds >= RULE.minOdds &&
    b.pickOdds < RULE.maxOddsExclusive
  );
}

console.log('[surgical-b] building frozen B shadow…');
const { shadow: base } = buildFrozenBShadowPickSets({});
const cut = base.filter(isCut);
const kept = base.filter((b) => !isCut(b));
const baseS = summarize(base);
const keptS = summarize(kept);
const cutS = summarize(cut);

const years = ['2024', '2025', '2026'];
const byYear = {};
for (const y of years) {
  const bY = base.filter((x) => x.window === y);
  const kY = kept.filter((x) => x.window === y);
  byYear[y] = {
    baseline: summarize(bY),
    kept: summarize(kY),
    cut: summarize(cut.filter((x) => x.window === y)),
    deltaUsd50: summarize(kY).usd50 - summarize(bY).usd50,
  };
}

const payload = {
  source: 'historical_replay_frozen_b_picks',
  experimentId: MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC.experimentId,
  overlayId: MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC.id,
  rule: RULE,
  diagnosis: MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC.diagnosis,
  modeDefault: 'compare',
  recommendWire: false,
  baseline: baseS,
  kept: keptS,
  cut: cutS,
  cutN: cut.length,
  flaggedBets: cut.length,
  flaggedDays: new Set(cut.map((b) => b.day)).size,
  cutPct: Number(((100 * cut.length) / Math.max(1, base.length)).toFixed(1)),
  deltaUsd50: keptS.usd50 - baseS.usd50,
  deltaHrPp: Number(
    (((keptS.hitRate ?? 0) - (baseS.hitRate ?? 0)) * 100).toFixed(2)
  ),
  deltaRoiPp: Number((((keptS.roi ?? 0) - (baseS.roi ?? 0)) * 100).toFixed(2)),
  byYear,
  cutRows: cut.map((b) => ({
    window: b.window,
    day: b.day,
    matchup: `${b.awayTeam} @ ${b.homeTeam}`,
    pick: b.awayTeam,
    hit: b.hit,
    odds: Number(b.pickOdds.toFixed(3)),
    ev: Number((b.ev ?? 0).toFixed(4)),
    modelProb: Number((b.modelProb ?? 0).toFixed(4)),
    margin: Number((b.margin ?? 0).toFixed(3)),
    homeWinPct: Number((b.homeWinPct ?? 0).toFixed(3)),
    rank: b.rank,
    gameId: b.gameId,
  })),
};

const written = writeSurgicalAwayR1MidoddsObserveSnapshot(payload);
const status = buildSurgicalAwayR1MidoddsObservationStatus({ live: written });

fs.writeFileSync(
  new URL('../tmp-surgical-away-r1-midodds-report.json', import.meta.url),
  JSON.stringify({ ...payload, observation: status }, null, 2)
);

console.log('BASE', baseS);
console.log(
  'KEPT',
  keptS,
  `Δ$=${payload.deltaUsd50} ΔHR=${payload.deltaHrPp}pp ΔROI=${payload.deltaRoiPp}pp`
);
console.log('CUT ', cutS, `n=${cut.length} (${payload.cutPct}%)`);
console.log('BY YEAR Δ$', Object.fromEntries(years.map((y) => [y, byYear[y].deltaUsd50])));
console.log('observation.status', status.status);
console.log('wrote tmp-surgical-away-r1-midodds-observe.json');
