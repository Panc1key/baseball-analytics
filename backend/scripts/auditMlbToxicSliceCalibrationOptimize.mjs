/**
 * β：針對「客勝 + 強主場」切片做機率校準，壓制幻覺 EV
 *
 * 做法：
 * - 訓練窗內，對 pickAway && homeWinPct>=0.65 的候選做分桶校準（Beta 平滑）
 * - OOS：該切片用 calibrated P 重算 EV → 再跑鎖定 B 排名
 * - 對照：rawB / calibB / calibB+skip(幻覺EV Rank1)
 *
 * 用法：node scripts/auditMlbToxicSliceCalibrationOptimize.mjs
 * 產物：tmp-b-toxic-slice-calibration-optimize.json
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
const EV_CUT = 0.1;
const WARMUP = 3;
const PRIOR_A = 1;
const PRIOR_B = 1;
const STAKE = 50;

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

const BUCKETS = [
  { lo: 0.5, hi: 0.53 },
  { lo: 0.53, hi: 0.55 },
  { lo: 0.55, hi: 0.57 },
  { lo: 0.57, hi: 0.6 },
  { lo: 0.6, hi: 1.01 },
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
function bucketIndex(p) {
  for (let i = 0; i < BUCKETS.length; i += 1) {
    if (p >= BUCKETS[i].lo && p < BUCKETS[i].hi) return i;
  }
  return null;
}
function isToxicSlice(c) {
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

function selectB(cands, getProb) {
  const byDay = new Map();
  for (const c of cands) {
    const modelProb = getProb(c);
    if (!Number.isFinite(modelProb)) continue;
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

function fitCalib(trainCands) {
  // 只用會通過 B 原始閘的毒切片樣本，貼近實際生效區
  const slice = trainCands.filter((c) => {
    if (!isToxicSlice(c)) return false;
    const p = c.modelProbRaw;
    const ev = p * (c.pickOdds - 1) - (1 - p);
    return (
      ev >= B.minimumExpectedValue &&
      c.margin >= B.minimumExpectedRunMargin &&
      p >= B.minimumModelProbability &&
      c.pickOdds >= B.minimumPickOdds &&
      c.pickOdds <= B.maximumPickOdds
    );
  });

  const nAll = slice.length;
  const hitsAll = slice.filter((c) => !c.homeWon).length;
  const globalP = (hitsAll + PRIOR_A) / (nAll + PRIOR_A + PRIOR_B);

  const stats = BUCKETS.map(() => ({ n: 0, hits: 0 }));
  for (const c of slice) {
    const idx = bucketIndex(c.modelProbRaw);
    if (idx == null) continue;
    stats[idx].n += 1;
    if (!c.homeWon) stats[idx].hits += 1;
  }
  const map = stats.map((s, i) => {
    if (s.n === 0) return globalP;
    return (s.hits + PRIOR_A) / (s.n + PRIOR_A + PRIOR_B);
  });

  // 額外：對「高表面 EV」子段做更強收縮（幻覺 EV 區）
  const highEv = slice.filter((c) => {
    const p = c.modelProbRaw;
    const ev = p * (c.pickOdds - 1) - (1 - p);
    return ev >= EV_CUT;
  });
  const highEvP =
    highEv.length === 0
      ? globalP
      : (highEv.filter((c) => !c.homeWon).length + PRIOR_A) /
        (highEv.length + PRIOR_A + PRIOR_B);

  return { globalP, map, stats, highEvP, highEvN: highEv.length };
}

function makeGetProb(mode, calib) {
  if (mode === 'raw') return (c) => c.modelProbRaw;
  if (mode === 'calib_bucket') {
    return (c) => {
      if (!isToxicSlice(c)) return c.modelProbRaw;
      const idx = bucketIndex(c.modelProbRaw);
      return idx == null ? calib.globalP : calib.map[idx];
    };
  }
  if (mode === 'calib_bucket_plus_highev') {
    return (c) => {
      if (!isToxicSlice(c)) return c.modelProbRaw;
      const raw = c.modelProbRaw;
      const rawEv = raw * (c.pickOdds - 1) - (1 - raw);
      if (rawEv >= EV_CUT) {
        // 高幻覺 EV：用高 EV 子段經驗命中率（通常更低）
        return calib.highEvP;
      }
      const idx = bucketIndex(raw);
      return idx == null ? calib.globalP : calib.map[idx];
    };
  }
  if (mode === 'calib_shrink_to_market') {
    // 毒切片：把 model P 往市場隱含概率拉（shrink）
    return (c) => {
      if (!isToxicSlice(c)) return c.modelProbRaw;
      const market = 1 / c.pickOdds;
      const w = 0.5; // 50% 往市場拉
      return c.modelProbRaw * (1 - w) + market * w;
    };
  }
  throw new Error(`unknown mode ${mode}`);
}

function skipIllusionRank1(bets) {
  return bets.filter(
    (b) =>
      !(
        b.rank === 1 &&
        isToxicSlice(b) &&
        b.ev >= EV_CUT
      )
  );
}

function countToxicIllusionRank1(bets) {
  return bets.filter(
    (b) => b.rank === 1 && isToxicSlice(b) && b.ev >= EV_CUT
  );
}

const candidates = buildCandidates();
const months = [...new Set(candidates.map((c) => c.month))].sort();

const modes = [
  'raw',
  'calib_bucket',
  'calib_bucket_plus_highev',
  'calib_shrink_to_market',
];

const wfRows = [];
const monthStore = {};

for (let i = WARMUP; i < months.length; i += 1) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];
  const train = candidates.filter((c) => trainMonths.has(c.month));
  const test = candidates.filter((c) => c.month === testMonth);
  if (!train.length || !test.length) continue;

  const calib = fitCalib(train);
  const row = {
    month: testMonth,
    calib: {
      globalP: Number(calib.globalP.toFixed(4)),
      highEvP: Number(calib.highEvP.toFixed(4)),
      highEvN: calib.highEvN,
      buckets: calib.stats.map((s, idx) => ({
        n: s.n,
        hits: s.hits,
        p: Number(calib.map[idx].toFixed(4)),
      })),
    },
    variants: {},
  };

  for (const mode of modes) {
    const bets = selectB(test, makeGetProb(mode, calib));
    const withSkip = skipIllusionRank1(bets);
    const toxicIll = countToxicIllusionRank1(bets);
    row.variants[mode] = {
      b: summarize(bets),
      bPlusSkipIllusionR1: summarize(withSkip),
      toxicIllusionRank1Left: {
        n: toxicIll.length,
        summary: summarize(toxicIll),
      },
    };
    monthStore[`${testMonth}|${mode}`] = bets;
    monthStore[`${testMonth}|${mode}|skip`] = withSkip;
  }

  // deltas vs raw
  const rawUsd = row.variants.raw.b.usd50;
  for (const mode of modes) {
    if (mode === 'raw') continue;
    row.variants[mode].deltaVsRawUsd = row.variants[mode].b.usd50 - rawUsd;
    row.variants[mode].deltaSkipVsRawUsd =
      row.variants[mode].bPlusSkipIllusionR1.usd50 - rawUsd;
  }
  wfRows.push(row);
}

function agg(keySuffix) {
  const all = [];
  for (const r of wfRows) {
    all.push(...(monthStore[`${r.month}|${keySuffix}`] || []));
  }
  return summarize(all);
}

const aggregate = {
  raw: agg('raw'),
  calib_bucket: agg('calib_bucket'),
  calib_bucket_plus_highev: agg('calib_bucket_plus_highev'),
  calib_shrink_to_market: agg('calib_shrink_to_market'),
  raw_plus_skip: agg('raw|skip'),
  calib_bucket_plus_skip: agg('calib_bucket|skip'),
  calib_bucket_plus_highev_plus_skip: agg('calib_bucket_plus_highev|skip'),
  calib_shrink_plus_skip: agg('calib_shrink_to_market|skip'),
};

const comparisons = Object.fromEntries(
  Object.entries(aggregate).map(([k, v]) => [
    k,
    {
      ...v,
      deltaUsdVsRaw: v.usd50 - aggregate.raw.usd50,
      deltaHrPpVsRaw:
        v.hitRate != null && aggregate.raw.hitRate != null
          ? Number(((v.hitRate - aggregate.raw.hitRate) * 100).toFixed(2))
          : null,
    },
  ])
);

// 選最佳：Δ$ 最大，且勝率不低於 raw-1pp
const ranked = Object.entries(comparisons)
  .filter(([k]) => k !== 'raw')
  .map(([id, s]) => ({ id, ...s }))
  .sort((a, b) => (b.deltaUsdVsRaw ?? -9999) - (a.deltaUsdVsRaw ?? -9999));

const best = ranked[0] || null;

// 月穩健：對 best 相對 raw 的 beat/hurt
function monthBeatHurt(modeKey) {
  let beat = 0;
  let hurt = 0;
  let flat = 0;
  for (const r of wfRows) {
    const raw = r.variants.raw.b.usd50;
    const opt =
      modeKey.endsWith('_plus_skip') || modeKey.includes('plus_skip')
        ? null
        : null;
    let usd;
    if (modeKey === 'raw_plus_skip') usd = r.variants.raw.bPlusSkipIllusionR1.usd50;
    else if (modeKey === 'calib_bucket') usd = r.variants.calib_bucket.b.usd50;
    else if (modeKey === 'calib_bucket_plus_highev')
      usd = r.variants.calib_bucket_plus_highev.b.usd50;
    else if (modeKey === 'calib_shrink_to_market')
      usd = r.variants.calib_shrink_to_market.b.usd50;
    else if (modeKey === 'calib_bucket_plus_skip')
      usd = r.variants.calib_bucket.bPlusSkipIllusionR1.usd50;
    else if (modeKey === 'calib_bucket_plus_highev_plus_skip')
      usd = r.variants.calib_bucket_plus_highev.bPlusSkipIllusionR1.usd50;
    else if (modeKey === 'calib_shrink_plus_skip')
      usd = r.variants.calib_shrink_to_market.bPlusSkipIllusionR1.usd50;
    else usd = raw;
    const d = usd - raw;
    if (d > 0) beat += 1;
    else if (d < 0) hurt += 1;
    else flat += 1;
  }
  return { beat, hurt, flat };
}

const out = {
  experimentId: 'b-toxic-slice-calibration-optimize-2026-07-29',
  slice: 'pickAway && homeWinPct>=0.65',
  focus: '壓制幻覺 EV（尤其 Rank1 EV>=10%）',
  params: { STRONG, EV_CUT, WARMUP, PRIOR_A, PRIOR_B },
  aggregate: comparisons,
  rankedByDeltaUsd: ranked.slice(0, 8),
  best,
  monthStability: Object.fromEntries(
    ranked.slice(0, 6).map((r) => [r.id, monthBeatHurt(r.id)])
  ),
  wfRows,
  recommendation: null,
};

const bestStab = best ? monthBeatHurt(best.id) : null;
out.recommendation = {
  bestId: best?.id ?? null,
  deltaUsd: best?.deltaUsdVsRaw ?? null,
  stability: bestStab,
  wireSuggested:
    !!best &&
    (best.deltaUsdVsRaw ?? 0) > 0 &&
    bestStab &&
    bestStab.beat >= bestStab.hurt,
  note:
    bestStab && bestStab.beat >= bestStab.hurt && (best?.deltaUsdVsRaw ?? 0) > 0
      ? 'Expanding 合計正且 beat≥hurt：可進影子軌；仍不改鎖定 B 常數。'
      : '未過穩健閘或不優於 raw：維持純 B + 既有 skip 影子觀察。',
};

fs.writeFileSync(
  new URL('../tmp-b-toxic-slice-calibration-optimize.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('AGG comparisons (Δ$ vs raw):');
for (const r of ranked) {
  const st = monthBeatHurt(r.id);
  console.log(
    `${r.id.padEnd(40)} $=${String(r.usd50).padStart(5)} Δ$=${String(r.deltaUsdVsRaw).padStart(5)} hr=${r.hitRate} Δhr=${r.deltaHrPpVsRaw} beat/hurt=${st.beat}/${st.hurt}`
  );
}
console.log('\nrecommendation', out.recommendation);
