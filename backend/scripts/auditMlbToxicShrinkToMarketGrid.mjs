/**
 * 毒切片「P 往市場收縮」權重網格 + Expanding WF + 影子帳
 *
 * 規則：若 pickAway && homeWinPct>=0.65
 *   P' = (1-w)*P_model + w*(1/odds)
 * 其餘場次不變；再用 P' 算 EV 跑鎖定 B。
 *
 * 用法：node scripts/auditMlbToxicShrinkToMarketGrid.mjs
 * 產物：tmp-b-toxic-shrink-to-market-grid.json
 *       tmp-b-toxic-shrink-to-market-shadow.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
} from '../src/services/MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const STRONG = 0.65;
const WARMUP = 3;
const STAKE = 50;
const W_GRID = [0.25, 0.35, 0.45, 0.5, 0.55, 0.65, 0.75];

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function ym(iso) {
  return hk(iso).slice(0, 7);
}
function books(g, c, h, a) {
  const pit = resolvePitOdds(g, c);
  if (!pit?.bookmakers?.length) return [];
  const out = [];
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const home =
      m.outcomes.find((o) => o.name === h) ||
      m.outcomes.find((o) => String(o.name).includes(String(h).split(' ').pop()));
    const away =
      m.outcomes.find((o) => o.name === a) ||
      m.outcomes.find((o) => String(o.name).includes(String(a).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const ho = +home.price;
    const ao = +away.price;
    if (!Number.isFinite(ho) || !Number.isFinite(ao)) continue;
    out.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao });
  }
  return out;
}
function summarize(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0 };
  let hits = 0;
  let unit = 0;
  let odds = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
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
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}
function isToxic(c) {
  return c.pickHome === false && (c.homeWinPct ?? 0) >= STRONG;
}

function buildCandidates() {
  const validation = getLatestMlbExpectedRunsValidation();
  const out = [];
  for (const w of WINDOWS) {
    const rows = db
      .prepare(
        `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
                g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
         FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
         WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
           AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
         ORDER BY f.commence_time`
      )
      .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);
    for (const row of rows) {
      let features;
      try {
        features = JSON.parse(row.featuresJson);
      } catch {
        continue;
      }
      const hs = +row.homeScore;
      const as = +row.awayScore;
      if (hs === as) continue;
      const pred = predictMlbGameRuns(validation.model, features, { totalLine: 8.5 });
      const ph = +pred.homeExpectedRuns;
      const pa = +pred.awayExpectedRuns;
      if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;
      const pickHome = ph >= pa;
      const modelProbRaw = pickHome
        ? +pred.markets?.homeWinProbability
        : +pred.markets?.awayWinProbability;
      if (!Number.isFinite(modelProbRaw)) continue;
      const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
      if (bs.length < 2) continue;
      bs.sort((a, b) => a.vig - b.vig);
      const best = bs[0];
      const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
      if (pickOdds < 1.4 || pickOdds > 2.3) continue;
      const margin = Math.abs(ph - pa);
      const sig = buildPregameRegimeSignals(features);
      const pickEarly = pickHome ? +sig.homeEarlyExitsLast3 || 0 : +sig.awayEarlyExitsLast3 || 0;
      const oppEarly = pickHome ? +sig.awayEarlyExitsLast3 || 0 : +sig.homeEarlyExitsLast3 || 0;
      const pitchers = features?.pitchers || {};
      if (
        (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
        (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
      ) {
        continue;
      }
      if (best.homeOdds < 1.2 || best.awayOdds < 1.2 || pickEarly > oppEarly) continue;
      out.push({
        window: w.key,
        day: hk(row.commenceTime),
        month: ym(row.commenceTime),
        gameId: row.gameId,
        homeTeam: row.homeTeam,
        awayTeam: row.awayTeam,
        homeWon: hs > as,
        pickHome,
        modelProbRaw,
        pickOdds,
        homeOdds: best.homeOdds,
        awayOdds: best.awayOdds,
        margin,
        homeWinPct: +features?.home?.homeWinPct || null,
      });
    }
  }
  return out;
}

function selectB(cands, w) {
  const byDay = new Map();
  for (const c of cands) {
    let modelProb = c.modelProbRaw;
    if (isToxic(c)) {
      const market = 1 / c.pickOdds;
      modelProb = c.modelProbRaw * (1 - w) + market * w;
    }
    const ev = modelProb * (c.pickOdds - 1) - (1 - modelProb);
    if (ev < B.minimumExpectedValue) continue;
    if (c.margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (c.pickOdds < B.minimumPickOdds || c.pickOdds > B.maximumPickOdds) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day).push({
      ...c,
      modelProb,
      ev,
      bScore,
      hit: c.pickHome ? c.homeWon : !c.homeWon,
    });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    applyDrop(arr).forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

const candidates = buildCandidates();
const months = [...new Set(candidates.map((c) => c.month))].sort();

// 固定參數全窗（含暖機月，便於對照）
const fixed = [];
const rawAll = selectB(candidates, 0);
const rawSum = summarize(rawAll);
for (const w of W_GRID) {
  const bets = selectB(candidates, w);
  const s = summarize(bets);
  const byWindow = {};
  for (const win of WINDOWS) {
    byWindow[win.key] = summarize(bets.filter((x) => x.window === win.key));
  }
  const windowsNonNeg = WINDOWS.filter(
    (win) => (byWindow[win.key].usd50 ?? 0) >= (summarize(rawAll.filter((x) => x.window === win.key)).usd50 ?? 0)
  ).length;
  fixed.push({
    w,
    kept: s,
    deltaUsd50: s.usd50 - rawSum.usd50,
    deltaHitRatePp:
      s.hitRate != null && rawSum.hitRate != null
        ? Number(((s.hitRate - rawSum.hitRate) * 100).toFixed(2))
        : null,
    deltaBets: s.bets - rawSum.bets,
    byWindow,
    windowsBeatOrFlatVsRaw: windowsNonNeg,
  });
}
fixed.sort((a, b) => b.deltaUsd50 - a.deltaUsd50);

// Expanding WF：訓練窗選最佳 w
const wfRows = [];
for (let i = WARMUP; i < months.length; i += 1) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];
  const train = candidates.filter((c) => trainMonths.has(c.month));
  const test = candidates.filter((c) => c.month === testMonth);
  if (!train.length || !test.length) continue;

  const trainRaw = summarize(selectB(train, 0));
  let best = null;
  for (const w of W_GRID) {
    const s = summarize(selectB(train, w));
    const deltaUsd = s.usd50 - trainRaw.usd50;
    const deltaHr =
      s.hitRate != null && trainRaw.hitRate != null
        ? (s.hitRate - trainRaw.hitRate) * 100
        : 0;
    const score = deltaUsd + deltaHr * 10;
    if (!best || score > best.score) best = { w, score, deltaUsd, deltaHr };
  }

  const testRawBets = selectB(test, 0);
  const testOptBets = selectB(test, best.w);
  const testRaw = summarize(testRawBets);
  const testOpt = summarize(testOptBets);
  wfRows.push({
    month: testMonth,
    selectedW: best.w,
    testRaw,
    testOpt,
    delta: {
      usd50: testOpt.usd50 - testRaw.usd50,
      hitRatePp:
        testOpt.hitRate != null && testRaw.hitRate != null
          ? Number(((testOpt.hitRate - testRaw.hitRate) * 100).toFixed(2))
          : null,
      bets: testOpt.bets - testRaw.bets,
    },
  });
}

const aggRaw = summarize(
  wfRows.flatMap((r) => selectB(candidates.filter((c) => c.month === r.month), 0))
);
const aggOpt = summarize(
  wfRows.flatMap((r) =>
    selectB(candidates.filter((c) => c.month === r.month), r.selectedW)
  )
);

// 影子：用固定最佳 w（全窗 Δ$ 最大且三窗相對 raw 不差）
const shadowCandidate =
  fixed.find((x) => x.windowsBeatOrFlatVsRaw === 3) ||
  fixed.find((x) => x.windowsBeatOrFlatVsRaw >= 2) ||
  fixed[0];

const shadowW = shadowCandidate.w;
const official = selectB(candidates, 0);
const shadow = selectB(candidates, shadowW);

// 毒幻覺 Rank1 殘留
function toxicIllusionR1(bets) {
  return bets.filter(
    (b) =>
      b.rank === 1 &&
      isToxic(b) &&
      b.ev >= 0.1
  );
}

const gridOut = {
  experimentId: 'b-toxic-shrink-to-market-grid-2026-07-29',
  rule: 'toxic away+strongHome: P\'=(1-w)P + w/odds',
  baseline: rawSum,
  fixedGrid: fixed,
  expandingWf: {
    warmup: WARMUP,
    rows: wfRows,
    aggregate: {
      raw: aggRaw,
      opt: aggOpt,
      deltaUsd50: aggOpt.usd50 - aggRaw.usd50,
      deltaHitRatePp:
        aggOpt.hitRate != null && aggRaw.hitRate != null
          ? Number(((aggOpt.hitRate - aggRaw.hitRate) * 100).toFixed(2))
          : null,
      beat: wfRows.filter((r) => r.delta.usd50 > 0).length,
      hurt: wfRows.filter((r) => r.delta.usd50 < 0).length,
      flat: wfRows.filter((r) => r.delta.usd50 === 0).length,
    },
  },
  shadowPick: {
    w: shadowW,
    reason: '固定網格中 Δ$ 優先，且盡量三窗不差於 raw',
  },
};

const shadowOut = {
  experimentId: 'b-toxic-shrink-to-market-shadow-2026-07-29',
  rule: `客+強主場：P'=(1-${shadowW})*P + ${shadowW}/odds；其餘不變`,
  recommendWire: false,
  reason:
    'Expanding 選參後仍需更多 live 樣本；先影子觀察，不改鎖定 B 常數／不進紙上正式選注',
  w: shadowW,
  official: summarize(official),
  shadow: summarize(shadow),
  deltaUsd50: summarize(shadow).usd50 - summarize(official).usd50,
  deltaHitRatePp:
    summarize(shadow).hitRate != null && summarize(official).hitRate != null
      ? Number(((summarize(shadow).hitRate - summarize(official).hitRate) * 100).toFixed(2))
      : null,
  byWindow: {
    official: Object.fromEntries(
      WINDOWS.map((w) => [w.key, summarize(official.filter((x) => x.window === w.key))])
    ),
    shadow: Object.fromEntries(
      WINDOWS.map((w) => [w.key, summarize(shadow.filter((x) => x.window === w.key))])
    ),
  },
  toxicIllusionRank1: {
    official: summarize(toxicIllusionR1(official)),
    shadow: summarize(toxicIllusionR1(shadow)),
    officialN: toxicIllusionR1(official).length,
    shadowN: toxicIllusionR1(shadow).length,
  },
  expandingWfRef: gridOut.expandingWf.aggregate,
};

fs.writeFileSync(
  new URL('../tmp-b-toxic-shrink-to-market-grid.json', import.meta.url),
  JSON.stringify(gridOut, null, 2)
);
fs.writeFileSync(
  new URL('../tmp-b-toxic-shrink-to-market-shadow.json', import.meta.url),
  JSON.stringify(shadowOut, null, 2)
);

console.log('BASELINE', rawSum);
console.log('\nFIXED GRID top:');
for (const r of fixed.slice(0, 5)) {
  console.log(
    `w=${r.w} Δ$=${r.deltaUsd50} Δhr=${r.deltaHitRatePp} Δn=${r.deltaBets} winBeat=${r.windowsBeatOrFlatVsRaw}/3 $=${r.kept.usd50}`
  );
}
console.log('\nEXPANDING WF', gridOut.expandingWf.aggregate);
for (const r of wfRows) {
  console.log(`${r.month} w=${r.selectedW} Δ$=${r.delta.usd50} Δhr=${r.delta.hitRatePp}`);
}
console.log('\nSHADOW w=', shadowW, shadowOut.shadow, 'Δ$', shadowOut.deltaUsd50);
console.log('toxicIllusionR1', shadowOut.toxicIllusionRank1);
