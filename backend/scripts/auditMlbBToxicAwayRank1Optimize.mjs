/**
 * B 病灶切片：客場 + 強主場(homeWinPct>=65%) + Rank1
 * 1) 量化占比
 * 2) 測試針對性優化（不下 / 降權 / P 收縮）
 * 3) Expanding WF 檢驗穩健性
 *
 * 用法：node scripts/auditMlbBToxicAwayRank1Optimize.mjs
 * 產物：tmp-b-toxic-away-rank1-optimize.json
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

function isToxicAway(c) {
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
      const modelProb = pickHome
        ? +pred.markets?.homeWinProbability
        : +pred.markets?.awayWinProbability;
      if (!Number.isFinite(modelProb)) continue;

      const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
      if (bs.length < 2) continue;
      bs.sort((a, b) => a.vig - b.vig);
      const best = bs[0];
      const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
      if (pickOdds < 1.4 || pickOdds > 2.3) continue;

      const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
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
        modelProb,
        pickOdds,
        homeOdds: best.homeOdds,
        awayOdds: best.awayOdds,
        ev,
        margin,
        homeWinPct: +features?.home?.homeWinPct || null,
      });
    }
  }
  return out;
}

/** 標準鎖定 B */
function selectB(cands, scoreFn = null) {
  const byDay = new Map();
  for (const c of cands) {
    if (
      c.ev < B.minimumExpectedValue ||
      c.margin < B.minimumExpectedRunMargin ||
      c.modelProb < B.minimumModelProbability ||
      c.pickOdds < B.minimumPickOdds ||
      c.pickOdds > B.maximumPickOdds
    ) {
      continue;
    }
    const bScore = scoreFn
      ? scoreFn(c)
      : scoreMlbMoneylineDailyRank(
          { expectedValue: c.ev, modelProbability: c.modelProb },
          B
        );
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day).push({
      ...c,
      bScore,
      hit: c.pickHome ? c.homeWon : !c.homeWon,
    });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    const slots = applyDrop(arr);
    slots.forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

/** 優化策略 */
const POLICIES = [
  {
    id: 'baseline',
    label: '純鎖定 B',
    apply: (bets) => bets,
  },
  {
    id: 'skip_toxic_rank1',
    label: '不下：客+強主場+Rank1',
    apply: (bets) =>
      bets.filter((b) => !(b.rank === 1 && isToxicAway(b))),
  },
  {
    id: 'skip_all_toxic_away',
    label: '不下：客+強主場（全部排名）',
    apply: (bets) => bets.filter((b) => !isToxicAway(b)),
  },
  {
    id: 'demote_toxic_from_r1',
    label: '降權：客+強主場不可佔 Rank1（當日改取次名）',
    apply: (bets) => {
      const byDay = new Map();
      for (const b of bets) {
        if (!byDay.has(b.day)) byDay.set(b.day, []);
        byDay.get(b.day).push(b);
      }
      const out = [];
      for (const day of [...byDay.keys()].sort()) {
        const arr = [...byDay.get(day)].sort((a, b) => a.rank - b.rank);
        // 若 Rank1 是 toxic away，丟掉它，其餘名次前移（已選池內）
        let slots = arr;
        if (slots[0] && slots[0].rank === 1 && isToxicAway(slots[0])) {
          slots = slots.slice(1);
        }
        slots.forEach((x, i) => out.push({ ...x, rank: i + 1 }));
      }
      return out;
    },
  },
  {
    id: 'flip_toxic_rank1_to_home',
    label: '反手：客+強主場+Rank1 → 改押主場',
    apply: (bets) =>
      bets.map((b) => {
        if (b.rank === 1 && isToxicAway(b)) {
          return {
            ...b,
            pickHome: true,
            pickOdds: b.homeOdds,
            hit: b.homeWon,
            flipped: true,
          };
        }
        return b;
      }),
  },
  {
    id: 'skip_toxic_r1_if_p_lt55',
    label: '不下：客+強主場+Rank1 且 P<55%',
    apply: (bets) =>
      bets.filter(
        (b) => !(b.rank === 1 && isToxicAway(b) && b.modelProb < 0.55)
      ),
  },
  {
    id: 'skip_toxic_r1_if_ev_ge10',
    label: '不下：客+強主場+Rank1 且 EV≥10%（幻覺EV）',
    apply: (bets) =>
      bets.filter((b) => !(b.rank === 1 && isToxicAway(b) && b.ev >= 0.1)),
  },
];

/** 選注前 P 收縮：毒切片 modelProb *= factor，再重算 EV/排名 */
function selectBWithShrink(cands, factor) {
  const adjusted = cands.map((c) => {
    if (!isToxicAway(c)) return c;
    const modelProb = Math.max(0.5, Math.min(0.99, c.modelProb * factor));
    const ev = modelProb * (c.pickOdds - 1) - (1 - modelProb);
    return { ...c, modelProb, ev, shrunk: true };
  });
  return selectB(adjusted);
}

const SHRINK_POLICIES = [
  { id: 'shrink_p_095', factor: 0.95 },
  { id: 'shrink_p_090', factor: 0.9 },
  { id: 'shrink_p_085', factor: 0.85 },
];

console.log('Building candidates…');
const candidates = buildCandidates();
const baseBets = selectB(candidates);
const toxicR1 = baseBets.filter((b) => b.rank === 1 && isToxicAway(b));
const toxicAll = baseBets.filter((b) => isToxicAway(b));

const baseSum = summarize(baseBets);
const toxicR1Sum = summarize(toxicR1);
const toxicAllSum = summarize(toxicAll);
const restSum = summarize(baseBets.filter((b) => !(b.rank === 1 && isToxicAway(b))));

const fixedResults = [];
for (const p of POLICIES) {
  const kept = p.apply(baseBets);
  const s = summarize(kept);
  const byWindow = {};
  for (const w of WINDOWS) {
    byWindow[w.key] = summarize(kept.filter((x) => x.window === w.key));
  }
  fixedResults.push({
    id: p.id,
    label: p.label,
    kept: s,
    deltaUsd50: s.usd50 - baseSum.usd50,
    deltaHitRatePp:
      s.hitRate != null && baseSum.hitRate != null
        ? Number(((s.hitRate - baseSum.hitRate) * 100).toFixed(2))
        : null,
    deltaBets: s.bets - baseSum.bets,
    byWindow,
  });
}

for (const sp of SHRINK_POLICIES) {
  const kept = selectBWithShrink(candidates, sp.factor);
  const s = summarize(kept);
  const byWindow = {};
  for (const w of WINDOWS) {
    byWindow[w.key] = summarize(kept.filter((x) => x.window === w.key));
  }
  fixedResults.push({
    id: sp.id,
    label: `選注前：毒切片 P×${sp.factor} 再排名`,
    kept: s,
    deltaUsd50: s.usd50 - baseSum.usd50,
    deltaHitRatePp:
      s.hitRate != null && baseSum.hitRate != null
        ? Number(((s.hitRate - baseSum.hitRate) * 100).toFixed(2))
        : null,
    deltaBets: s.bets - baseSum.bets,
    byWindow,
  });
}

fixedResults.sort((a, b) => (b.deltaUsd50 ?? -9999) - (a.deltaUsd50 ?? -9999));

// Expanding WF：短名單候選
const wfCandidates = [
  'skip_toxic_rank1',
  'demote_toxic_from_r1',
  'flip_toxic_rank1_to_home',
  'skip_toxic_r1_if_p_lt55',
  'skip_toxic_r1_if_ev_ge10',
  'skip_all_toxic_away',
  'shrink_p_090',
  'shrink_p_085',
  'baseline',
];

function runPolicyOnBets(policyId, bets, candsForShrink) {
  if (policyId.startsWith('shrink_p_')) {
    const factor = Number(policyId.replace('shrink_p_', '')) / 100;
    // shrink 需要整月候選重選；此處傳入該月 candidates
    return selectBWithShrink(candsForShrink, factor);
  }
  const p = POLICIES.find((x) => x.id === policyId);
  return p.apply(bets);
}

const months = [...new Set(baseBets.map((x) => x.month))].sort();
const wfRows = [];

for (let i = WARMUP; i < months.length; i += 1) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];
  const trainBets = baseBets.filter((x) => trainMonths.has(x.month));
  const testBets = baseBets.filter((x) => x.month === testMonth);
  const trainCands = candidates.filter((x) => trainMonths.has(x.month));
  const testCands = candidates.filter((x) => x.month === testMonth);
  if (!trainBets.length || !testBets.length) continue;

  const trainBase = summarize(trainBets);
  let best = null;
  for (const id of wfCandidates) {
    const kept =
      id.startsWith('shrink_p_')
        ? selectBWithShrink(trainCands, Number(id.replace('shrink_p_', '')) / 100)
        : POLICIES.find((p) => p.id === id).apply(trainBets);
    const s = summarize(kept);
    const deltaUsd = s.usd50 - trainBase.usd50;
    const deltaHr =
      s.hitRate != null && trainBase.hitRate != null
        ? (s.hitRate - trainBase.hitRate) * 100
        : 0;
    // 優先：Δ$ 且 Δ勝率不傷太多
    const score = deltaUsd + deltaHr * 15;
    if (!best || score > best.score) {
      best = { id, score, trainDeltaUsd: deltaUsd, trainDeltaHr: deltaHr };
    }
  }

  const testBase = summarize(testBets);
  const testKept = runPolicyOnBets(best.id, testBets, testCands);
  const testSum = summarize(testKept);
  wfRows.push({
    month: testMonth,
    selected: best.id,
    testBase,
    testOpt: testSum,
    delta: {
      usd50: testSum.usd50 - testBase.usd50,
      hitRatePp:
        testSum.hitRate != null && testBase.hitRate != null
          ? Number(((testSum.hitRate - testBase.hitRate) * 100).toFixed(2))
          : null,
      bets: testSum.bets - testBase.bets,
    },
  });
}

const aggBase = summarize(wfRows.flatMap((r) => baseBets.filter((x) => x.month === r.month)));
const aggOpt = summarize(
  wfRows.flatMap((r) => {
    const monthBets = baseBets.filter((x) => x.month === r.month);
    const monthCands = candidates.filter((x) => x.month === r.month);
    return runPolicyOnBets(r.selected, monthBets, monthCands);
  })
);

const out = {
  experimentId: 'b-toxic-away-rank1-optimize-2026-07-29',
  toxicDefinition: 'pickAway && homeWinPct>=0.65',
  focus: '尤其 Rank1',
  baseline: baseSum,
  sliceImpact: {
    toxicRank1: toxicR1Sum,
    toxicAllRanks: toxicAllSum,
    withoutToxicRank1: restSum,
    toxicRank1Share: Number((toxicR1.length / baseBets.length).toFixed(3)),
    toxicRank1Rows: toxicR1.map((b) => ({
      window: b.window,
      day: b.day,
      matchup: `${b.awayTeam} @ ${b.homeTeam}`,
      home: b.homeTeam,
      pick: b.awayTeam,
      hit: b.hit,
      odds: Number(b.pickOdds.toFixed(3)),
      P: Number(b.modelProb.toFixed(4)),
      EV: Number(b.ev.toFixed(4)),
      homeWinPct: Number((b.homeWinPct ?? 0).toFixed(3)),
      gameId: b.gameId,
    })),
  },
  fixedOosStyle: fixedResults,
  expandingWf: {
    warmupMonths: WARMUP,
    rows: wfRows,
    aggregate: {
      baseline: aggBase,
      optimized: aggOpt,
      deltaUsd50: aggOpt.usd50 - aggBase.usd50,
      deltaHitRatePp:
        aggOpt.hitRate != null && aggBase.hitRate != null
          ? Number(((aggOpt.hitRate - aggBase.hitRate) * 100).toFixed(2))
          : null,
      beatMonths: wfRows.filter((r) => r.delta.usd50 > 0).length,
      hurtMonths: wfRows.filter((r) => r.delta.usd50 < 0).length,
      flatMonths: wfRows.filter((r) => r.delta.usd50 === 0).length,
    },
  },
  recommendation: null,
};

const bestFixed = fixedResults.find((x) => x.id !== 'baseline');
const wfOk =
  out.expandingWf.aggregate.deltaUsd50 >= 0 &&
  out.expandingWf.aggregate.beatMonths >= out.expandingWf.aggregate.hurtMonths;

out.recommendation = {
  bestFixedId: bestFixed?.id ?? null,
  bestFixedDeltaUsd: bestFixed?.deltaUsd50 ?? null,
  expandingWfDeltaUsd: out.expandingWf.aggregate.deltaUsd50,
  expandingWfBeatHurt: `${out.expandingWf.aggregate.beatMonths}/${out.expandingWf.aggregate.hurtMonths}`,
  wireSuggested: wfOk && (bestFixed?.deltaUsd50 ?? 0) > 0,
  note: wfOk
    ? 'Expanding WF 合計不傷且 beat≥hurt；可進影子帳觀察，仍不建議直接改鎖定 B 常數。'
    : 'Expanding WF 未過穩健門檻；先影子觀察或改特徵／校準，不接入正式選注。',
};

fs.writeFileSync(
  new URL('../tmp-b-toxic-away-rank1-optimize.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\n=== 切片影響 ===');
console.log('baseline', baseSum);
console.log('toxic Rank1', toxicR1Sum, 'share', out.sliceImpact.toxicRank1Share);
console.log('without toxic Rank1', restSum);

console.log('\n=== 固定規則（相對 baseline Δ$）===');
for (const r of fixedResults.slice(0, 8)) {
  console.log(
    `${r.id.padEnd(28)} Δ$=${String(r.deltaUsd50).padStart(5)} Δhr=${r.deltaHitRatePp}pp Δn=${r.deltaBets} | $${r.kept.usd50} hr=${r.kept.hitRate}`
  );
}

console.log('\n=== Expanding WF ===');
console.log(out.expandingWf.aggregate);
for (const r of wfRows) {
  console.log(
    `${r.month} sel=${r.selected.padEnd(26)} Δ$=${r.delta.usd50} Δhr=${r.delta.hitRatePp}pp`
  );
}
console.log('\nrecommendation', out.recommendation);
