/**
 * 下一刀：決策層（排序鍵／TopK／drop）是否推盈利
 * 門檻仍用鎖定 B；只改「怎麼排、取幾場」
 *
 * 用法: node scripts/auditMlbNextKnifeDecisionProfit.mjs
 * 產物: tmp-next-knife-decision-profit.json
 */
import fs from 'fs';
import {
  buildFrozenBShadowPickSets,
  MLB_FROZEN_B_SHADOW_SPEC,
  applyFrozenResidualToPrediction,
  applyFrozenToxicShrink,
} from '../src/services/MlbFrozenBShadow.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
} from '../src/services/MlbExpectedRunsModel.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import db from '../src/db/database.js';

const STAKE = 50;
const B = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: MLB_FROZEN_B_SHADOW_SPEC.selection.minimumH2hBookmakers,
};
const DROP_R3 = MLB_FROZEN_B_SHADOW_SPEC.selection.dropThirdIfMarginBelow;
const DROP_R2_MAX = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsBelow;
const DROP_R2_MIN = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsMin;

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
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
  if (!bets.length) {
    return { bets: 0, hits: 0, hitRate: null, roi: null, usd50: 0, avgOdds: null };
  }
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
    hits,
    hitRate: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
    avgOdds: Number((odds / n).toFixed(3)),
  };
}

function byYear(bets) {
  const out = {};
  for (const y of ['2024', '2025', '2026']) {
    out[y] = summarize(bets.filter((b) => b.window === y));
  }
  return out;
}

function loadPool(from, to, model) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, from, to);
  const out = [];
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
    const base = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((x, y) => x.vig - y.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) continue;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    const homeWinPct = Number(features?.home?.homeWinPct);
    if (!Number.isFinite(homeWinPct)) continue;
    const sig = buildPregameRegimeSignals(features);
    out.push({
      gameId: row.gameId,
      window: from.slice(0, 4),
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      homeWon: hs > as,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      homeWinPct,
      xHome: homeWinPct - 0.5,
      base,
      homeEarly: +sig.homeEarlyExitsLast3 || 0,
      awayEarly: +sig.awayEarlyExitsLast3 || 0,
    });
  }
  return out;
}

/** 過鎖定 B 閘的全日候選（尚未 TopK／drop） */
function buildCandidates(pool, model) {
  const cands = [];
  for (const g of pool) {
    const pred = applyFrozenResidualToPrediction(model, g.base, g.xHome);
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? g.homeOdds : g.awayOdds;
    const pickEarly =
      (pickHome ? g.homeEarly : g.awayEarly) >
      (pickHome ? g.awayEarly : g.homeEarly);
    modelProb = applyFrozenToxicShrink(modelProb, pickOdds, {
      pickHome,
      homeWinPct: g.homeWinPct,
    });
    const marketProb = 1 / pickOdds;
    const edge = modelProb - marketProb;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue) continue;
    if (margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (pickOdds < B.minimumPickOdds || pickOdds > B.maximumPickOdds) continue;
    const penalized = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb, pickEarlyExitsHigher: pickEarly },
      B
    );
    cands.push({
      gameId: g.gameId,
      window: g.window,
      day: g.day,
      month: g.month,
      pickHome,
      pick: pickHome ? g.homeTeam : g.awayTeam,
      pickOdds,
      modelProb,
      marketProb,
      edge,
      ev,
      margin,
      pickEarly,
      penalized,
      hit: pickHome ? g.homeWon : !g.homeWon,
    });
  }
  return cands;
}

function applySlots(sorted, { topK = 3, dropR3 = true, dropR2 = true } = {}) {
  let slots = sorted.slice(0, Math.max(1, topK));
  if (dropR3 && slots.length >= 3 && slots[2].margin < DROP_R3) {
    slots = slots.slice(0, 2);
  }
  if (
    dropR2 &&
    slots.length >= 2 &&
    slots[1].pickOdds >= DROP_R2_MIN &&
    slots[1].pickOdds < DROP_R2_MAX
  ) {
    slots = [slots[0], ...slots.slice(2)].slice(0, Math.min(2, topK));
  }
  return slots;
}

function selectPolicy(cands, policy) {
  const byDay = new Map();
  for (const c of cands) {
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day).push(c);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)];
    arr.sort(policy.sort);
    const slots = applySlots(arr, policy.slots || {});
    slots.forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

const POLICIES = [
  {
    id: 'baseline_penalized_ev',
    sort: (a, b) => b.penalized - a.penalized || b.margin - a.margin,
    slots: { topK: 3, dropR3: true, dropR2: true },
  },
  {
    id: 'rank_raw_ev',
    sort: (a, b) => b.ev - a.ev || b.margin - a.margin,
    slots: { topK: 3, dropR3: true, dropR2: true },
  },
  {
    id: 'rank_edge',
    sort: (a, b) => b.edge - a.edge || b.margin - a.margin,
    slots: { topK: 3, dropR3: true, dropR2: true },
  },
  {
    id: 'rank_model_prob',
    sort: (a, b) => b.modelProb - a.modelProb || b.margin - a.margin,
    slots: { topK: 3, dropR3: true, dropR2: true },
  },
  {
    id: 'rank_ev_over_odds',
    sort: (a, b) => b.ev / (a.pickOdds) - a.ev / (b.pickOdds) || b.ev - a.ev,
    // fix sort properly:
    slots: { topK: 3, dropR3: true, dropR2: true },
  },
  {
    id: 'top2_only',
    sort: (a, b) => b.penalized - a.penalized || b.margin - a.margin,
    slots: { topK: 2, dropR3: false, dropR2: true },
  },
  {
    id: 'top1_only',
    sort: (a, b) => b.penalized - a.penalized || b.margin - a.margin,
    slots: { topK: 1, dropR3: false, dropR2: false },
  },
  {
    id: 'no_drop_r3',
    sort: (a, b) => b.penalized - a.penalized || b.margin - a.margin,
    slots: { topK: 3, dropR3: false, dropR2: true },
  },
  {
    id: 'no_drop_r2',
    sort: (a, b) => b.penalized - a.penalized || b.margin - a.margin,
    slots: { topK: 3, dropR3: true, dropR2: false },
  },
  {
    id: 'no_drops',
    sort: (a, b) => b.penalized - a.penalized || b.margin - a.margin,
    slots: { topK: 3, dropR3: false, dropR2: false },
  },
  {
    id: 'drop_r3_if_high_ev',
    sort: (a, b) => b.penalized - a.penalized || b.margin - a.margin,
    slots: { topK: 3, dropR3: true, dropR2: true },
    post: (slots) => {
      if (slots.length >= 3 && slots[2].ev >= 0.08) return slots.slice(0, 2);
      return slots;
    },
  },
];

// fix rank_ev_over_odds sort
POLICIES.find((p) => p.id === 'rank_ev_over_odds').sort = (a, b) => {
  const sa = a.ev / a.pickOdds;
  const sb = b.ev / b.pickOdds;
  return sb - sa || b.ev - a.ev;
};

function selectWithPost(cands, policy) {
  const byDay = new Map();
  for (const c of cands) {
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day).push(c);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(policy.sort);
    let slots = applySlots(arr, policy.slots || {});
    if (policy.post) slots = policy.post(slots);
    slots.forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

console.log('Loading pools…');
const validation = getLatestMlbExpectedRunsValidation();
const model = validation.model;
const pools = [];
for (const w of WINDOWS) {
  const p = loadPool(w.from, w.to, model).map((x) => ({ ...x, window: w.key }));
  console.log(w.key, p.length);
  pools.push(...p);
}
const cands = buildCandidates(pools, model);
console.log('candidates', cands.length);

const { shadow: frozenShadow } = buildFrozenBShadowPickSets({});
const frozenBase = summarize(frozenShadow);

const results = [];
for (const policy of POLICIES) {
  const bets = selectWithPost(cands, policy);
  const s = summarize(bets);
  const y = byYear(bets);
  const base = results.find((r) => r.id === 'baseline_penalized_ev')?.summary || s;
  results.push({
    id: policy.id,
    summary: s,
    byYear: y,
    deltaUsdVsBaseline: null,
    yearDeltas: null,
  });
}

const baseline = results.find((r) => r.id === 'baseline_penalized_ev');
for (const r of results) {
  r.deltaUsdVsBaseline = r.summary.usd50 - baseline.summary.usd50;
  r.yearDeltas = {
    '2024': r.byYear['2024'].usd50 - baseline.byYear['2024'].usd50,
    '2025': r.byYear['2025'].usd50 - baseline.byYear['2025'].usd50,
    '2026': r.byYear['2026'].usd50 - baseline.byYear['2026'].usd50,
  };
  const yearsOk = Object.values(r.yearDeltas).every((d) => d >= -80);
  r.pass =
    r.id !== 'baseline_penalized_ev' &&
    r.deltaUsdVsBaseline > 0 &&
    yearsOk &&
    r.summary.bets >= baseline.summary.bets * 0.7;
}

results.sort((a, b) => b.deltaUsdVsBaseline - a.deltaUsdVsBaseline);
const passers = results.filter((r) => r.pass);

const out = {
  experimentId: 'next_knife_decision_profit',
  thesis: '鎖定 B 閘門不變，只改日內排序／TopK／drop 是否推 @$50',
  nCandidates: cands.length,
  frozenShadowRef: frozenBase,
  baselineId: 'baseline_penalized_ev',
  results: results.map((r) => ({
    id: r.id,
    ...r.summary,
    deltaUsdVsBaseline: r.deltaUsdVsBaseline,
    yearDeltas: r.yearDeltas,
    pass: r.pass,
  })),
  passers: passers.map((p) => p.id),
  verdict: passers.length
    ? `PROFIT_PUSH_YES — ${passers.map((p) => p.id).join(', ')}`
    : 'PROFIT_PUSH_NO — 決策層變體相對現行 penalized_ev+drop 未能穩推盈利',
  action: passers.length
    ? '可開決策影子觀察；不改正式常數直至活體確認'
    : '決策層暫不動；維持現行日 Top 規則；高 EV 收縮繼續 compare 觀察',
};

fs.writeFileSync(
  new URL('../tmp-next-knife-decision-profit.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      baseline: baseline.summary,
      frozenRef: frozenBase,
      board: out.results.map((r) => ({
        id: r.id,
        usd: r.usd50,
        delta: r.deltaUsdVsBaseline,
        bets: r.bets,
        years: r.yearDeltas,
        pass: r.pass,
      })),
      verdict: out.verdict,
      action: out.action,
    },
    null,
    2
  )
);
console.log('wrote tmp-next-knife-decision-profit.json');
