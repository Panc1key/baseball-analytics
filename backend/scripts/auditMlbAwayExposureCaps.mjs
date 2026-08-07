/**
 * 降客暴露／強主客加閘：對鎖定 B 的可證偽對照
 * node scripts/auditMlbAwayExposureCaps.mjs
 * 產物: tmp-away-exposure-caps.json
 *
 * 不改正式選注；只影子重放。
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  buildMlbExpectedRunsSideFeatures,
  predictMlbExpectedRunsMean,
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
  calibrateMlbScoreMarkets,
  MLB_MONEYLINE_RULE_PROFILES,
  scoreMlbMoneylineDailyRank,
  MLB_EXPECTED_RUNS_FEATURE_KEYS,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';

const STAKE = 50;
const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const STRONG = 0.62;

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
  { key: '2025-06', from: '2025-06-01', to: '2025-06-30' },
  { key: '2026-06', from: '2026-06-01', to: '2026-06-30' },
];

const VARIANTS = [
  { id: 'baseline', desc: '正式鎖定 B' },
  { id: 'max_away_2_per_day', desc: '日內客最多 2；超出用主隊候選補或留空' },
  { id: 'max_away_1_per_day', desc: '日內客最多 1' },
  { id: 'away_share_le_50', desc: '日內客占比≤50%（3注最多1客／2注最多1客）' },
  {
    id: 'skip_strong_home_away',
    desc: `客且主場勝率≥${STRONG} → 跳過該候選`,
  },
  {
    id: 'skip_strong_home_away_ev10',
    desc: `客且 hwp≥${STRONG} 且 EV≥10% → 跳過（毒區刀）`,
  },
  {
    id: 'cap2_plus_skip_strong',
    desc: '客≤2/日 + 跳過強主客',
  },
  {
    id: 'force_balance_topk',
    desc: '日 TopK 盡量主客交替：先取最高分，再優先補另一側',
  },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function finite(v, f = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
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
    return {
      bets: 0,
      hitRate: null,
      usd50: 0,
      awayShare: null,
      homeShare: null,
      avgOdds: null,
    };
  }
  let hits = 0;
  let unit = 0;
  let away = 0;
  let odds = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    if (!b.pickHome) away += 1;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
    awayShare: Number((away / n).toFixed(3)),
    homeShare: Number(((n - away) / n).toFixed(3)),
    avgOdds: Number((odds / n).toFixed(3)),
  };
}

function applyDrop(sorted) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
  if (
    slots.length >= 2 &&
    slots[1].pickOdds >= 1.85 &&
    slots[1].pickOdds < 1.95
  ) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}

function passesPreFilter(c, variantId) {
  if (variantId === 'skip_strong_home_away' || variantId === 'cap2_plus_skip_strong') {
    if (!c.pickHome && (c.homeWinPct ?? 0) >= STRONG) return false;
  }
  if (variantId === 'skip_strong_home_away_ev10') {
    if (!c.pickHome && (c.homeWinPct ?? 0) >= STRONG && c.ev >= 0.1) return false;
  }
  return true;
}

function selectDay(cands, variantId) {
  const filtered = cands.filter((c) => passesPreFilter(c, variantId));
  const ranked = [...filtered].sort(
    (a, b) => b.bScore - a.bScore || b.margin - a.margin
  );

  if (variantId === 'baseline' || variantId.startsWith('skip_strong')) {
    return applyDrop(ranked);
  }

  if (variantId === 'force_balance_topk') {
    const out = [];
    const used = new Set();
    const take = (pred) => {
      for (const c of ranked) {
        if (used.has(c.gameId)) continue;
        if (!pred(c)) continue;
        out.push(c);
        used.add(c.gameId);
        return true;
      }
      return false;
    };
    // 先最高分
    if (ranked[0]) {
      out.push(ranked[0]);
      used.add(ranked[0].gameId);
    }
    while (out.length < 3) {
      const needHome = out.filter((x) => x.pickHome).length <= out.filter((x) => !x.pickHome).length;
      const got = take((c) => (needHome ? c.pickHome : !c.pickHome));
      if (!got && !take(() => true)) break;
    }
    return applyDrop(out);
  }

  // cap variants: build pool then enforce away caps while filling to ≤3
  let pool = applyDrop(ranked);
  if (variantId === 'max_away_2_per_day' || variantId === 'cap2_plus_skip_strong') {
    return enforceAwayCap(ranked, pool, 2);
  }
  if (variantId === 'max_away_1_per_day') {
    return enforceAwayCap(ranked, pool, 1);
  }
  if (variantId === 'away_share_le_50') {
    // 目標最多 floor(n/2) 客；先用 drop 後再調
    const maxAway = Math.max(1, Math.floor(3 / 2)); // for up to 3 → 1
    return enforceAwayCap(ranked, pool, maxAway);
  }
  return pool;
}

function enforceAwayCap(ranked, initial, maxAway) {
  const out = [];
  const used = new Set();
  let awayN = 0;
  // 先按排名取，客超過則跳過等主
  for (const c of ranked) {
    if (out.length >= 3) break;
    if (used.has(c.gameId)) continue;
    const isAway = !c.pickHome;
    if (isAway && awayN >= maxAway) continue;
    out.push(c);
    used.add(c.gameId);
    if (isAway) awayN += 1;
  }
  // 若因 cap 太瘦，允許用主隊補滿（已在上面優先）
  // 再套用 dropR3/R2 結構（在已選集合上）
  return applyDrop(out);
}

const model = getLatestMlbExpectedRunsValidation().model;
console.log('loading candidates…');

const allCandidates = [];
for (const w of WINDOWS.filter((x) => !x.key.includes('-'))) {
  // load season windows only once; june sliced later
}
const seasonWins = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

for (const w of seasonWins) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam,
              g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);

  for (const row of rows) {
    const hs = +row.homeScore;
    const as = +row.awayScore;
    if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) continue;
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    const homeVec = buildMlbExpectedRunsSideFeatures(features, 'home');
    const awayVec = buildMlbExpectedRunsSideFeatures(features, 'away');
    if (!MLB_EXPECTED_RUNS_FEATURE_KEYS.every((k) => Number.isFinite(homeVec[k]))) continue;
    if (!MLB_EXPECTED_RUNS_FEATURE_KEYS.every((k) => Number.isFinite(awayVec[k]))) continue;
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) continue;
    const ph = predictMlbExpectedRunsMean(model, homeVec);
    const pa = predictMlbExpectedRunsMean(model, awayVec);
    const dist = buildMlbScoreDistribution({
      homeMean: ph,
      awayMean: pa,
      homeDispersion: model.dispersion,
      awayDispersion: model.dispersion,
    });
    const markets = calibrateMlbScoreMarkets(
      deriveMlbScoreMarkets(dist, { totalLine: 8.5 }),
      model.moneylineTemperature ?? 1
    );
    const pickHome = ph >= pa;
    const modelProb = pickHome
      ? +markets.homeWinProbability
      : +markets.awayWinProbability;
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? +sig.homeEarlyExitsLast3 || 0
      : +sig.awayEarlyExitsLast3 || 0;
    const oppEarly = pickHome
      ? +sig.awayEarlyExitsLast3 || 0
      : +sig.homeEarlyExitsLast3 || 0;
    if (pickEarly > oppEarly) continue;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue) continue;
    if (margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (pickOdds < B.minimumPickOdds || pickOdds > B.maximumPickOdds) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    allCandidates.push({
      year: w.key,
      day: hk(row.commenceTime),
      gameId: row.gameId,
      pickHome,
      pickOdds,
      modelProb,
      ev,
      margin,
      bScore,
      homeWinPct: finite(features?.home?.homeWinPct, 0.5),
      hit: pickHome ? hs > as : as > hs,
    });
  }
  console.log(w.key, 'cands', allCandidates.filter((c) => c.year === w.key).length);
}

function evalVariant(variantId, dayFrom, dayTo) {
  const cands = allCandidates.filter((c) => c.day >= dayFrom && c.day <= dayTo);
  const byDay = new Map();
  for (const c of cands) {
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day).push(c);
  }
  const bets = [];
  for (const day of [...byDay.keys()].sort()) {
    const slots = selectDay(byDay.get(day), variantId);
    slots.forEach((s, i) => bets.push({ ...s, rank: i + 1 }));
  }
  return summarize(bets);
}

const results = {};
for (const v of VARIANTS) {
  results[v.id] = { desc: v.desc, byWindow: {}, overall: null };
  const overallBets = [];
  for (const w of WINDOWS) {
    // for june windows, filter by day string
    const s = evalVariant(v.id, w.from, w.to);
    // recompute properly: evalVariant uses day range but candidates have year seasons
    // June is inside 2025/2026 seasons already loaded — OK if day filter works
    results[v.id].byWindow[w.key] = s;
  }
  // overall = 2024+2025+2026 season only
  const seas = ['2024', '2025', '2026'].map((k) => results[v.id].byWindow[k]);
  let bets = 0;
  let hits = 0;
  let unitProxy = 0;
  let away = 0;
  let odds = 0;
  // re-eval overall from seasons combined
  const overall = evalVariant(v.id, '2024-04-01', '2026-07-22');
  results[v.id].overall = overall;
  void seas;
  void bets;
  void hits;
  void unitProxy;
  void away;
  void odds;
  void overallBets;
}

// ranking: prefer non-negative delta in all 3 seasons AND higher or similar usd; also june2025 less bad
const baseline = results.baseline;
const ranked = VARIANTS.filter((v) => v.id !== 'baseline')
  .map((v) => {
    const r = results[v.id];
    let seasonsNonNeg = 0;
    let seasonDelta = 0;
    for (const k of ['2024', '2025', '2026']) {
      const d = r.byWindow[k].usd50 - baseline.byWindow[k].usd50;
      seasonDelta += d;
      if (d >= 0) seasonsNonNeg += 1;
    }
    const june25Delta =
      r.byWindow['2025-06'].usd50 - baseline.byWindow['2025-06'].usd50;
    const june26Delta =
      r.byWindow['2026-06'].usd50 - baseline.byWindow['2026-06'].usd50;
    return {
      id: v.id,
      desc: v.desc,
      overall: r.overall,
      deltaUsdOverall: r.overall.usd50 - baseline.overall.usd50,
      deltaHrOverall:
        r.overall.hitRate != null && baseline.overall.hitRate != null
          ? Number((r.overall.hitRate - baseline.overall.hitRate).toFixed(4))
          : null,
      awayShare: r.overall.awayShare,
      seasonsNonNeg,
      seasonDelta,
      june25Delta,
      june26Delta,
      byWindow: r.byWindow,
    };
  })
  .sort(
    (a, b) =>
      b.seasonsNonNeg - a.seasonsNonNeg ||
      b.deltaUsdOverall - a.deltaUsdOverall ||
      b.june25Delta - a.june25Delta
  );

const out = {
  experimentId: 'away-exposure-caps-2026-08-07',
  plainLanguage:
    '限制日內客隊暴露／跳過強主客，看能否降集中度風險且不傷三年窗',
  stakeUsd: STAKE,
  strongHomeThreshold: STRONG,
  baseline: {
    overall: baseline.overall,
    byWindow: baseline.byWindow,
  },
  variants: results,
  ranked,
  recommendation: (() => {
    const pass = ranked.find(
      (r) =>
        r.seasonsNonNeg === 3 &&
        r.deltaUsdOverall >= 0 &&
        r.overall.awayShare < baseline.overall.awayShare - 0.05
    );
    const soft = ranked.find(
      (r) =>
        r.seasonsNonNeg >= 2 &&
        r.june25Delta > 0 &&
        r.deltaUsdOverall >= -200 &&
        r.overall.awayShare < baseline.overall.awayShare - 0.05
    );
    if (pass) {
      return {
        wireSuggested: false,
        best: pass.id,
        note: `${pass.id}：三年不傷、總$不降、客占比下降——可列影子觀察，仍不自動升格`,
      };
    }
    if (soft) {
      return {
        wireSuggested: false,
        best: soft.id,
        note: `${soft.id}：部分改善（含 2025-06）但未穩過三窗——僅研究，不升格`,
      };
    }
    return {
      wireSuggested: false,
      best: ranked[0]?.id || null,
      note: '降客暴露未能穩贏基線：可能傷 EV 來源；需改 μ／校準而非只砍客',
    };
  })(),
};

fs.writeFileSync(
  new URL('../tmp-away-exposure-caps.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\nBASELINE', baseline.overall, {
  '24': baseline.byWindow['2024'].usd50,
  '25': baseline.byWindow['2025'].usd50,
  '26': baseline.byWindow['2026'].usd50,
  '25-06': baseline.byWindow['2025-06'],
  '26-06': baseline.byWindow['2026-06'],
});
console.log('\nRANKED:');
for (const r of ranked) {
  console.log(
    `${r.id.padEnd(28)} Δ$=${String(r.deltaUsdOverall).padStart(5)} hrΔ=${r.deltaHrOverall} away=${r.awayShare} seas+=${r.seasonsNonNeg}/3 jun25Δ=${r.june25Delta} jun26Δ=${r.june26Delta}`
  );
  console.log(
    `  $ 24:${r.byWindow['2024'].usd50} 25:${r.byWindow['2025'].usd50} 26:${r.byWindow['2026'].usd50} | 25-06:${r.byWindow['2025-06'].usd50}(${r.byWindow['2025-06'].hitRate}) 26-06:${r.byWindow['2026-06'].usd50}(${r.byWindow['2026-06'].hitRate})`
  );
}
console.log('\nREC', out.recommendation);
