/**
 * 對「三窗皆≥raw」條件收縮短名單做嚴格複驗 + 更新影子主候選
 * 用法：node scripts/auditMlbToxicConditionalShrinkStrict.mjs
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
const STAKE = 50;
const WARMUP = 3;

// 上一輪三窗贏家（固定）
const SHORTLIST = [
  { policy: 'shrink_ev_ge10_or_p55', w: 0.65 },
  { policy: 'shrink_p_ge55', w: 0.45 },
  { policy: 'shrink_p_ge55', w: 0.5 },
  { policy: 'shrink_ev_ge12', w: 0.5 },
  { policy: 'shrink_p_ge55', w: 0.35 },
  { policy: 'shrink_p_ge55', w: 0.55 },
  { policy: 'shrink_ev_ge08', w: 0.65 },
];

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

const POLICY_WHEN = {
  shrink_ev_ge10_or_p55: (c, rawEv) => rawEv >= 0.1 || c.modelProbRaw >= 0.55,
  shrink_p_ge55: (c) => c.modelProbRaw >= 0.55,
  shrink_ev_ge12: (_c, rawEv) => rawEv >= 0.12,
  shrink_ev_ge08: (_c, rawEv) => rawEv >= 0.08,
};

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

function selectB(cands, policyId, w) {
  const when = policyId === 'raw' ? () => false : POLICY_WHEN[policyId];
  const byDay = new Map();
  for (const c of cands) {
    const rawEv = c.modelProbRaw * (c.pickOdds - 1) - (1 - c.modelProbRaw);
    let modelProb = c.modelProbRaw;
    if (isToxic(c) && when(c, rawEv)) {
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
const rawAll = selectB(candidates, 'raw', 0);

// Expanding WF only on shortlist
const months = [...new Set(candidates.map((c) => c.month))].sort();
const wfRows = [];
for (let i = WARMUP; i < months.length; i += 1) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];
  const train = candidates.filter((c) => trainMonths.has(c.month));
  const test = candidates.filter((c) => c.month === testMonth);
  const trainRaw = summarize(selectB(train, 'raw', 0));
  let best = null;
  for (const cand of SHORTLIST) {
    const s = summarize(selectB(train, cand.policy, cand.w));
    const deltaUsd = s.usd50 - trainRaw.usd50;
    const deltaHr =
      s.hitRate != null && trainRaw.hitRate != null
        ? (s.hitRate - trainRaw.hitRate) * 100
        : 0;
    const score = deltaUsd + deltaHr * 10;
    if (!best || score > best.score) best = { ...cand, score };
  }
  const testRaw = summarize(selectB(test, 'raw', 0));
  const testOpt = summarize(selectB(test, best.policy, best.w));
  wfRows.push({
    month: testMonth,
    selected: { policy: best.policy, w: best.w },
    deltaUsd: testOpt.usd50 - testRaw.usd50,
    deltaHrPp:
      testOpt.hitRate != null && testRaw.hitRate != null
        ? Number(((testOpt.hitRate - testRaw.hitRate) * 100).toFixed(2))
        : null,
  });
}

const aggRaw = summarize(
  wfRows.flatMap((r) => selectB(candidates.filter((c) => c.month === r.month), 'raw', 0))
);
const aggOpt = summarize(
  wfRows.flatMap((r) =>
    selectB(candidates.filter((c) => c.month === r.month), r.selected.policy, r.selected.w)
  )
);

// Holdouts restricted to shortlist
function holdout(trainFilter, testFilter, label) {
  const train = candidates.filter(trainFilter);
  const test = candidates.filter(testFilter);
  const trainRaw = summarize(selectB(train, 'raw', 0));
  let best = null;
  for (const cand of SHORTLIST) {
    const s = summarize(selectB(train, cand.policy, cand.w));
    const score = s.usd50 - trainRaw.usd50;
    if (!best || score > best.score) best = { ...cand, score };
  }
  const testRaw = summarize(selectB(test, 'raw', 0));
  const testOpt = summarize(selectB(test, best.policy, best.w));
  return {
    label,
    selected: { policy: best.policy, w: best.w },
    trainDelta: best.score,
    testDelta: testOpt.usd50 - testRaw.usd50,
    testRaw,
    testOpt,
  };
}

const holdouts = [
  holdout((c) => c.window !== '2024', (c) => c.window === '2024', 'train25+26→test24'),
  holdout((c) => c.window !== '2026', (c) => c.window === '2026', 'train24+25→test26'),
  holdout((c) => c.window === '2024', (c) => c.window !== '2024', 'train24→test25+26'),
];

// 影子主候選：固定三窗最佳
const preferred = SHORTLIST[0]; // shrink_ev_ge10_or_p55 w=0.65
const official = rawAll;
const shadow = selectB(candidates, preferred.policy, preferred.w);

const out = {
  experimentId: 'b-toxic-conditional-shrink-strict-2026-07-29',
  preferredShadow: {
    ...preferred,
    rule: '毒切片且 (rawEV≥10% 或 P≥55%)：P\'=(1-0.65)P + 0.65/odds',
  },
  expandingWf: {
    aggregate: {
      raw: aggRaw,
      opt: aggOpt,
      deltaUsd: aggOpt.usd50 - aggRaw.usd50,
      beat: wfRows.filter((r) => r.deltaUsd > 0).length,
      hurt: wfRows.filter((r) => r.deltaUsd < 0).length,
      flat: wfRows.filter((r) => r.deltaUsd === 0).length,
    },
    rows: wfRows,
  },
  holdouts,
  shadowLedger: {
    official: summarize(official),
    shadow: summarize(shadow),
    deltaUsd: summarize(shadow).usd50 - summarize(official).usd50,
    byWindow: Object.fromEntries(
      WINDOWS.map((w) => [
        w.key,
        {
          official: summarize(official.filter((x) => x.window === w.key)),
          shadow: summarize(shadow.filter((x) => x.window === w.key)),
          deltaUsd:
            summarize(shadow.filter((x) => x.window === w.key)).usd50 -
            summarize(official.filter((x) => x.window === w.key)).usd50,
        },
      ])
    ),
  },
  gates: null,
};

const hOk = holdouts.every((h) => h.testDelta >= 0);
const wfOk =
  out.expandingWf.aggregate.deltaUsd >= 0 &&
  out.expandingWf.aggregate.beat >= out.expandingWf.aggregate.hurt;
out.gates = {
  threeWindowFixed: true,
  holdoutsAllNonNeg: hOk,
  expandingBeatGeHurt: wfOk,
  wireSuggested: hOk && wfOk,
  note:
    hOk && wfOk
      ? '嚴格閘過：可考慮升格接入討論'
      : '三窗固定已過，但 holdout/WF 未全過：影子主候選更新，正式仍不接',
};

fs.writeFileSync(
  new URL('../tmp-b-toxic-conditional-shrink-strict.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
fs.writeFileSync(
  new URL('../tmp-b-toxic-conditional-shrink-shadow.json', import.meta.url),
  JSON.stringify(
    {
      experimentId: 'b-toxic-conditional-shrink-shadow-2026-07-29',
      recommendWire: out.gates.wireSuggested,
      ...out.preferredShadow,
      ...out.shadowLedger,
      expandingWf: out.expandingWf.aggregate,
      holdouts,
    },
    null,
    2
  )
);

console.log('PREFERRED', preferred);
console.log('SHADOW', out.shadowLedger);
console.log('WF', out.expandingWf.aggregate);
console.log('HOLDOUTS', holdouts);
console.log('GATES', out.gates);
