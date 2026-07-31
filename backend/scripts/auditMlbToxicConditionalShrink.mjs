/**
 * 條件化收縮：只在「假 EV」時往市場拉，避免誤傷 2024 仍賺錢的薄邊毒切片
 *
 * 候選：
 * - shrink_always (對照)：毒切片一律 w
 * - shrink_if_ev_ge10：毒且 rawEV≥10% 才收縮
 * - shrink_if_rank1：先用 raw 選出 B 後，無法直接；改為選注前對毒切片收縮後重排（同 always，但…）
 *   實際：選注前條件收縮
 * - shrink_if_ev_ge10_or_p_ge55
 * - shrink_if_ev_ge08 / ge12
 *
 * Expanding WF + 三年窗 + 2024 holdout
 *
 * 用法：node scripts/auditMlbToxicConditionalShrink.mjs
 * 產物：tmp-b-toxic-conditional-shrink.json
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
const W_GRID = [0.35, 0.45, 0.5, 0.55, 0.65];

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

const POLICIES = [
  { id: 'raw', when: () => false },
  { id: 'shrink_always', when: () => true },
  {
    id: 'shrink_ev_ge08',
    when: (_c, rawEv) => rawEv >= 0.08,
  },
  {
    id: 'shrink_ev_ge10',
    when: (_c, rawEv) => rawEv >= 0.1,
  },
  {
    id: 'shrink_ev_ge12',
    when: (_c, rawEv) => rawEv >= 0.12,
  },
  {
    id: 'shrink_ev_ge10_or_p55',
    when: (c, rawEv) => rawEv >= 0.1 || c.modelProbRaw >= 0.55,
  },
  {
    id: 'shrink_p_ge55',
    when: (c) => c.modelProbRaw >= 0.55,
  },
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

function selectB(cands, policy, w) {
  const byDay = new Map();
  for (const c of cands) {
    const rawEv = c.modelProbRaw * (c.pickOdds - 1) - (1 - c.modelProbRaw);
    let modelProb = c.modelProbRaw;
    if (isToxic(c) && policy.when(c, rawEv)) {
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
      rawEv,
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

function pack(cands, policy, w, rawBets) {
  const bets = selectB(cands, policy, w);
  const byWindow = {};
  let winBeat = 0;
  for (const win of WINDOWS) {
    const s = summarize(bets.filter((x) => x.window === win.key));
    const r = summarize(rawBets.filter((x) => x.window === win.key));
    byWindow[win.key] = { ...s, deltaUsd: s.usd50 - r.usd50 };
    if (s.usd50 - r.usd50 >= 0) winBeat += 1;
  }
  const s = summarize(bets);
  const r = summarize(rawBets);
  return {
    policy: policy.id,
    w,
    kept: s,
    deltaUsd: s.usd50 - r.usd50,
    deltaHrPp:
      s.hitRate != null && r.hitRate != null
        ? Number(((s.hitRate - r.hitRate) * 100).toFixed(2))
        : null,
    deltaBets: s.bets - r.bets,
    byWindow,
    windowsNonNeg: winBeat,
  };
}

const candidates = buildCandidates();
const rawPolicy = POLICIES.find((p) => p.id === 'raw');
const rawBets = selectB(candidates, rawPolicy, 0);
const rawSum = summarize(rawBets);

const fixed = [];
for (const policy of POLICIES) {
  if (policy.id === 'raw') {
    fixed.push({
      policy: 'raw',
      w: 0,
      kept: rawSum,
      deltaUsd: 0,
      deltaHrPp: 0,
      deltaBets: 0,
      byWindow: Object.fromEntries(
        WINDOWS.map((w) => [
          w.key,
          { ...summarize(rawBets.filter((x) => x.window === w.key)), deltaUsd: 0 },
        ])
      ),
      windowsNonNeg: 3,
    });
    continue;
  }
  for (const w of W_GRID) {
    fixed.push(pack(candidates, policy, w, rawBets));
  }
}
fixed.sort(
  (a, b) =>
    (b.windowsNonNeg || 0) - (a.windowsNonNeg || 0) ||
    (b.deltaUsd || 0) - (a.deltaUsd || 0)
);

// Expanding WF：訓練窗從短名單選 (policy,w)
const shortlist = fixed
  .filter((x) => x.policy !== 'raw' && x.windowsNonNeg >= 2 && x.deltaUsd > 0)
  .slice(0, 12);
if (!shortlist.length) {
  shortlist.push(...fixed.filter((x) => x.policy !== 'raw').slice(0, 8));
}

const months = [...new Set(candidates.map((c) => c.month))].sort();
const wfRows = [];
for (let i = WARMUP; i < months.length; i += 1) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];
  const train = candidates.filter((c) => trainMonths.has(c.month));
  const test = candidates.filter((c) => c.month === testMonth);
  if (!train.length || !test.length) continue;

  const trainRaw = summarize(selectB(train, rawPolicy, 0));
  let best = null;
  for (const cand of shortlist) {
    const policy = POLICIES.find((p) => p.id === cand.policy);
    const s = summarize(selectB(train, policy, cand.w));
    const deltaUsd = s.usd50 - trainRaw.usd50;
    const deltaHr =
      s.hitRate != null && trainRaw.hitRate != null
        ? (s.hitRate - trainRaw.hitRate) * 100
        : 0;
    const score = deltaUsd + deltaHr * 10;
    if (!best || score > best.score) {
      best = { policyId: cand.policy, w: cand.w, score, deltaUsd };
    }
  }

  const testRaw = summarize(selectB(test, rawPolicy, 0));
  const policy = POLICIES.find((p) => p.id === best.policyId);
  const testOpt = summarize(selectB(test, policy, best.w));
  wfRows.push({
    month: testMonth,
    selected: { policy: best.policyId, w: best.w },
    delta: {
      usd50: testOpt.usd50 - testRaw.usd50,
      hitRatePp:
        testOpt.hitRate != null && testRaw.hitRate != null
          ? Number(((testOpt.hitRate - testRaw.hitRate) * 100).toFixed(2))
          : null,
    },
    testRaw,
    testOpt,
  });
}

const aggRaw = summarize(
  wfRows.flatMap((r) =>
    selectB(
      candidates.filter((c) => c.month === r.month),
      rawPolicy,
      0
    )
  )
);
const aggOpt = summarize(
  wfRows.flatMap((r) => {
    const policy = POLICIES.find((p) => p.id === r.selected.policy);
    return selectB(
      candidates.filter((c) => c.month === r.month),
      policy,
      r.selected.w
    );
  })
);

// 2024 holdout：用 2025+2026 選最佳，測 2024
const trainHold = candidates.filter((c) => c.window !== '2024');
const testHold = candidates.filter((c) => c.window === '2024');
const trainHoldRaw = summarize(selectB(trainHold, rawPolicy, 0));
let bestHold = null;
for (const cand of fixed.filter((x) => x.policy !== 'raw')) {
  const policy = POLICIES.find((p) => p.id === cand.policy);
  const s = summarize(selectB(trainHold, policy, cand.w));
  const score = s.usd50 - trainHoldRaw.usd50;
  if (!bestHold || score > bestHold.score) {
    bestHold = { policyId: cand.policy, w: cand.w, score };
  }
}
const holdPolicy = POLICIES.find((p) => p.id === bestHold.policyId);
const holdout2024 = {
  selected: { policy: bestHold.policyId, w: bestHold.w },
  trainDeltaUsd: bestHold.score,
  testRaw: summarize(selectB(testHold, rawPolicy, 0)),
  testOpt: summarize(selectB(testHold, holdPolicy, bestHold.w)),
  deltaUsd:
    summarize(selectB(testHold, holdPolicy, bestHold.w)).usd50 -
    summarize(selectB(testHold, rawPolicy, 0)).usd50,
};

const top3Window = fixed.filter((x) => x.windowsNonNeg === 3 && x.deltaUsd > 0);

const out = {
  experimentId: 'b-toxic-conditional-shrink-2026-07-29',
  goal: '跨年都賺錢再談投入；先修 2024 被一律收縮誤傷',
  baseline: rawSum,
  topByWindowsThenUsd: fixed.slice(0, 15),
  threeWindowWinners: top3Window.slice(0, 10),
  expandingWf: {
    shortlistSize: shortlist.length,
    aggregate: {
      raw: aggRaw,
      opt: aggOpt,
      deltaUsd: aggOpt.usd50 - aggRaw.usd50,
      deltaHrPp:
        aggOpt.hitRate != null && aggRaw.hitRate != null
          ? Number(((aggOpt.hitRate - aggRaw.hitRate) * 100).toFixed(2))
          : null,
      beat: wfRows.filter((r) => r.delta.usd50 > 0).length,
      hurt: wfRows.filter((r) => r.delta.usd50 < 0).length,
      flat: wfRows.filter((r) => r.delta.usd50 === 0).length,
    },
    rows: wfRows,
  },
  holdout2024,
  recommendation: null,
};

const best3 = top3Window[0] || null;
const wf = out.expandingWf.aggregate;
out.recommendation = {
  keepShadow: true,
  wireSuggested:
    !!best3 &&
    best3.deltaUsd > 0 &&
    holdout2024.deltaUsd >= 0 &&
    wf.deltaUsd >= 0 &&
    wf.beat >= wf.hurt,
  preferred:
    best3 ||
    fixed.find((x) => x.policy === 'shrink_ev_ge10' && x.w === 0.5) ||
    fixed[0],
  note: best3
    ? holdout2024.deltaUsd >= 0 && wf.beat >= wf.hurt
      ? '出現三窗皆不傷且 holdout/WF 過線：可升格影子主候選，仍不改鎖定 B。'
      : '有三窗不傷候選，但 holdout 或 WF 未全過：繼續影子，不接入。'
    : '尚無三窗皆≥raw 的收縮變體；維持純 B + 舊影子，繼續優化。',
};

fs.writeFileSync(
  new URL('../tmp-b-toxic-conditional-shrink.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('BASELINE', rawSum);
console.log('\nTOP (windowsNonNeg, Δ$):');
for (const r of fixed.slice(0, 12)) {
  console.log(
    `${String(r.policy).padEnd(24)} w=${r.w} win=${r.windowsNonNeg}/3 Δ$=${r.deltaUsd} Δhr=${r.deltaHrPp} Δn=${r.deltaBets}`
  );
  console.log(
    `  24:${r.byWindow['2024'].deltaUsd} 25:${r.byWindow['2025'].deltaUsd} 26:${r.byWindow['2026'].deltaUsd}`
  );
}
console.log('\n3-window winners', top3Window.length);
console.log('EXPANDING', out.expandingWf.aggregate);
console.log('HOLDOUT2024', holdout2024);
console.log('REC', out.recommendation.note);
console.log('preferred', out.recommendation.preferred);
