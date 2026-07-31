/**
 * 影子掃描：在現行 ev02_max230（含 dropR3／dropR2）上試加場手段
 *   1) maxOdds 微抬 2.35／2.40（禁止 max_none）
 *   2) earlyExits：硬擋 → 日內軟罰分
 *   3) 觀察級近緣條件晉升（缺一刀：margin／early／maxOdds 擦邊）
 *
 * 不改正式鎖定常數；僅腳本回放。
 * 閘門：合併 usd50≥基線；2025／2026 雙窗皆≥基線；注數 keep 不設硬下限（報 Δ場）
 *
 * 用法: node scripts/auditMlbVolumeLiftShadowOnEv02.mjs
 * 產物: tmp-volume-lift-shadow-on-ev02.json
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
const DROP_R3_T = Number(B.dropThirdIfMarginBelow) || 0.5;
const DROP_R2_MAX = Number(B.dropSecondIfOddsBelow) || 1.95;
const DROP_R2_MIN = Number(B.dropSecondIfOddsMin) || 1.85;

const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-28' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function books(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return [];
  const out = [];
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const home =
      m.outcomes.find((o) => o.name === homeTeam) ||
      m.outcomes.find((o) => String(o.name).includes(String(homeTeam).split(' ').pop()));
    const away =
      m.outcomes.find((o) => o.name === awayTeam) ||
      m.outcomes.find((o) => String(o.name).includes(String(awayTeam).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const ho = Number(home.price);
    const ao = Number(away.price);
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
      avgOdds: null,
      roi: null,
      unitPnl: 0,
      usd50: 0,
    };
  }
  let unit = 0;
  let odds = 0;
  let hits = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else {
      unit -= 1;
    }
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    unitPnl: Number(unit.toFixed(2)),
    usd50: Math.round(unit * 50),
  };
}

/**
 * 寬宇宙：放寬 maxOdds 到 2.50、不硬擋 earlyExits、margin 下限 0.15（供近緣晉升）
 * 仍要求 EV／P／minOdds／雙先發／≥2庄／兩邊≥1.2
 */
function buildWideUniverse(from, to) {
  const validation = getLatestMlbExpectedRunsValidation();
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ?
         AND g.completed = 1
         AND g.home_score IS NOT NULL
         AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?)
         AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, from, to);

  const pool = [];
  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const hs = Number(row.homeScore);
    const as = Number(row.awayScore);
    if (hs === as) continue;

    const pred = predictMlbGameRuns(validation.model, features, { totalLine: 8.5 });
    const ph = Number(pred.homeExpectedRuns);
    const pa = Number(pred.awayExpectedRuns);
    if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;
    const pickHome = ph >= pa;
    const modelProb = pickHome
      ? Number(pred.markets?.homeWinProbability)
      : Number(pred.markets?.awayWinProbability);
    if (!Number.isFinite(modelProb)) continue;

    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < (B.minimumH2hBookmakers || 2)) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    if (
      best.homeOdds < (B.minimumEitherSideOdds || 1.2) ||
      best.awayOdds < (B.minimumEitherSideOdds || 1.2)
    ) {
      continue;
    }

    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (!Number.isFinite(pickOdds)) continue;
    if (pickOdds < B.minimumPickOdds) continue;
    if (pickOdds > 2.5) continue;

    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (margin < 0.15) continue;

    const pitchers = features?.pitchers || {};
    const homeId = pitchers.homeIdentity?.id ?? pitchers.home?.id ?? null;
    const awayId = pitchers.awayIdentity?.id ?? pitchers.away?.id ?? null;
    if (homeId == null || awayId == null) continue;

    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? Number(sig.homeEarlyExitsLast3) || 0
      : Number(sig.awayEarlyExitsLast3) || 0;
    const oppEarly = pickHome
      ? Number(sig.awayEarlyExitsLast3) || 0
      : Number(sig.homeEarlyExitsLast3) || 0;
    const earlyWorse = pickEarly > oppEarly;

    const baseScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );

    const strictMargin = margin >= B.minimumExpectedRunMargin;
    const strictMax230 = pickOdds <= B.maximumPickOdds;
    const strictEarly = !earlyWorse;
    const isStrict =
      strictMargin && strictMax230 && strictEarly && pickOdds <= B.maximumPickOdds;

    // 近緣：只差一項（或 maxOdds 擦邊進 2.40）
    const nearMargin = !strictMargin && margin >= 0.15 && margin < B.minimumExpectedRunMargin;
    const nearMax = pickOdds > B.maximumPickOdds && pickOdds <= 2.4;
    const nearEarly = earlyWorse && strictMargin && pickOdds <= B.maximumPickOdds;
    const failCount =
      (strictMargin ? 0 : 1) + (strictMax230 || nearMax ? 0 : 1) + (strictEarly ? 0 : 1);
    // near-miss for promote: either exactly one soft failure among margin/early, or maxOdds in (2.30,2.40]
    const isNearMiss =
      !isStrict &&
      ev >= B.minimumExpectedValue &&
      modelProb >= B.minimumModelProbability &&
      pickOdds >= B.minimumPickOdds &&
      ((nearMax && strictMargin && strictEarly) ||
        (nearMargin && strictMax230 && strictEarly) ||
        (nearEarly && strictMargin && strictMax230) ||
        (nearMax && nearEarly && strictMargin && failCount <= 2));

    pool.push({
      day: hk(row.commenceTime),
      window: from.startsWith('2025') ? '2025' : '2026',
      gameId: row.gameId,
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      earlyWorse,
      baseScore,
      isStrict,
      isNearMiss,
      nearMargin,
      nearMax,
      nearEarly,
      tags: {
        max235: pickOdds <= 2.35,
        max240: pickOdds <= 2.4,
        max250: pickOdds <= 2.5,
      },
    });
  }
  return pool;
}

function applyHardSlots(sorted) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3_T) slots = slots.slice(0, 2);
  if (
    slots.length >= 2 &&
    slots[1].pickOdds >= DROP_R2_MIN &&
    slots[1].pickOdds < DROP_R2_MAX
  ) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}

function selectDaily(pool, { admit, scoreFn }) {
  const byDay = new Map();
  for (const g of pool) {
    if (!admit(g)) continue;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({ ...g, score: scoreFn(g) });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = byDay.get(day).sort((a, b) => b.score - a.score || b.margin - a.margin);
    out.push(...applyHardSlots(arr));
  }
  return out;
}

function delta(sum, base) {
  if (!sum || !base) return null;
  return {
    bets: sum.bets - base.bets,
    hitRatePp: Number((((sum.hitRate ?? 0) - (base.hitRate ?? 0)) * 100).toFixed(2)),
    usd50: sum.usd50 - base.usd50,
    keepPct: base.bets ? Number(((sum.bets / base.bets) * 100).toFixed(1)) : null,
  };
}

function gateVsBaseline(byWindow, baselineByWindow, merged, baselineMerged) {
  const wOk = WINDOWS.every((w) => {
    const a = byWindow[w.key]?.usd50 ?? 0;
    const b = baselineByWindow[w.key]?.usd50 ?? 0;
    return a >= b;
  });
  const mergedOk = (merged?.usd50 ?? 0) >= (baselineMerged?.usd50 ?? 0);
  return {
    pass: wOk && mergedOk,
    dualWindowUsdGeBaseline: wOk,
    mergedUsdGeBaseline: mergedOk,
  };
}

const VARIANTS = [
  {
    id: 'baseline_ev02_max230',
    label: '基線 ev02_max230（硬 early + max≤2.30）',
    admit: (g) => g.isStrict,
    scoreFn: (g) => g.baseScore,
  },
  {
    id: 'max_235',
    label: 'maxOdds≤2.35（其餘同基線硬閘）',
    admit: (g) =>
      g.margin >= B.minimumExpectedRunMargin &&
      !g.earlyWorse &&
      g.tags.max235,
    scoreFn: (g) => g.baseScore,
  },
  {
    id: 'max_240',
    label: 'maxOdds≤2.40（其餘同基線硬閘）',
    admit: (g) =>
      g.margin >= B.minimumExpectedRunMargin &&
      !g.earlyWorse &&
      g.tags.max240,
    scoreFn: (g) => g.baseScore,
  },
  {
    id: 'early_soft_l005',
    label: 'earlyExits 軟罰 λ=0.05（max仍≤2.30、margin硬）',
    admit: (g) =>
      g.margin >= B.minimumExpectedRunMargin && g.pickOdds <= B.maximumPickOdds,
    scoreFn: (g) => g.baseScore - (g.earlyWorse ? 0.05 : 0),
  },
  {
    id: 'early_soft_l010',
    label: 'earlyExits 軟罰 λ=0.10',
    admit: (g) =>
      g.margin >= B.minimumExpectedRunMargin && g.pickOdds <= B.maximumPickOdds,
    scoreFn: (g) => g.baseScore - (g.earlyWorse ? 0.1 : 0),
  },
  {
    id: 'early_soft_l015',
    label: 'earlyExits 軟罰 λ=0.15',
    admit: (g) =>
      g.margin >= B.minimumExpectedRunMargin && g.pickOdds <= B.maximumPickOdds,
    scoreFn: (g) => g.baseScore - (g.earlyWorse ? 0.15 : 0),
  },
  {
    id: 'early_soft_l020',
    label: 'earlyExits 軟罰 λ=0.20',
    admit: (g) =>
      g.margin >= B.minimumExpectedRunMargin && g.pickOdds <= B.maximumPickOdds,
    scoreFn: (g) => g.baseScore - (g.earlyWorse ? 0.2 : 0),
  },
  {
    id: 'watch_promote_l010',
    label: '近緣晉升（差一刀）軟罰 λ=0.10 + 基線嚴格同池',
    admit: (g) => g.isStrict || g.isNearMiss,
    scoreFn: (g) => g.baseScore - (g.isNearMiss ? 0.1 : 0) - (g.earlyWorse ? 0.05 : 0),
  },
  {
    id: 'watch_promote_l015',
    label: '近緣晉升軟罰 λ=0.15',
    admit: (g) => g.isStrict || g.isNearMiss,
    scoreFn: (g) => g.baseScore - (g.isNearMiss ? 0.15 : 0) - (g.earlyWorse ? 0.05 : 0),
  },
  {
    id: 'watch_promote_l020',
    label: '近緣晉升軟罰 λ=0.20',
    admit: (g) => g.isStrict || g.isNearMiss,
    scoreFn: (g) => g.baseScore - (g.isNearMiss ? 0.2 : 0) - (g.earlyWorse ? 0.05 : 0),
  },
  {
    id: 'combo_max235_early_soft_l010',
    label: '組合：max≤2.35 + early軟罰0.10',
    admit: (g) => g.margin >= B.minimumExpectedRunMargin && g.tags.max235,
    scoreFn: (g) => g.baseScore - (g.earlyWorse ? 0.1 : 0),
  },
  {
    id: 'combo_max240_early_soft_l015',
    label: '組合：max≤2.40 + early軟罰0.15',
    admit: (g) => g.margin >= B.minimumExpectedRunMargin && g.tags.max240,
    scoreFn: (g) => g.baseScore - (g.earlyWorse ? 0.15 : 0),
  },
  {
    id: 'combo_max235_early_soft_watch_l015',
    label: '組合：max≤2.35 + early軟0.10 + 近緣晉升0.15',
    admit: (g) => {
      if (g.margin >= B.minimumExpectedRunMargin && g.tags.max235) return true;
      if (!g.isNearMiss) return false;
      return g.tags.max240;
    },
    scoreFn: (g) =>
      g.baseScore -
      (g.earlyWorse ? 0.1 : 0) -
      (g.isNearMiss ? 0.15 : 0),
  },
];

console.log('[volume-lift-shadow] building wide universe…');
const pools = {};
for (const w of WINDOWS) {
  pools[w.key] = buildWideUniverse(w.from, w.to);
  console.log(`  ${w.key}: ${pools[w.key].length} candidates (wide)`);
}

const results = [];
let baselineMerged = null;
let baselineByWindow = null;

for (const v of VARIANTS) {
  const byWindow = {};
  const mergedBets = [];
  for (const w of WINDOWS) {
    const bets = selectDaily(pools[w.key], v);
    byWindow[w.key] = summarize(bets);
    mergedBets.push(...bets);
  }
  const merged = summarize(mergedBets);
  if (v.id === 'baseline_ev02_max230') {
    baselineMerged = merged;
    baselineByWindow = byWindow;
  }
  const gate = baselineMerged
    ? gateVsBaseline(byWindow, baselineByWindow, merged, baselineMerged)
    : { pass: true, dualWindowUsdGeBaseline: true, mergedUsdGeBaseline: true };

  results.push({
    id: v.id,
    label: v.label,
    byWindow,
    merged,
    deltaMerged: baselineMerged ? delta(merged, baselineMerged) : null,
    gate,
  });
  console.log(
    `  ${v.id}: n=${merged.bets} hr=${merged.hitRate} $50=${merged.usd50}` +
      (baselineMerged
        ? ` Δn=${merged.bets - baselineMerged.bets} Δ$=${merged.usd50 - baselineMerged.usd50} pass=${gate.pass}`
        : '')
  );
}

const passing = results.filter((r) => r.id !== 'baseline_ev02_max230' && r.gate.pass);
passing.sort(
  (a, b) =>
    (b.deltaMerged?.usd50 ?? -9999) - (a.deltaMerged?.usd50 ?? -9999) ||
    (b.deltaMerged?.bets ?? 0) - (a.deltaMerged?.bets ?? 0)
);

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'shadow_only',
  baselineProfile: 'ev02_max230',
  windows: WINDOWS,
  rulesNote: {
    baseline: {
      ev: B.minimumExpectedValue,
      margin: B.minimumExpectedRunMargin,
      minOdds: B.minimumPickOdds,
      maxOdds: B.maximumPickOdds,
      earlyExitsHard: true,
      dropR3: DROP_R3_T,
      dropR2: [DROP_R2_MIN, DROP_R2_MAX],
    },
    nearMiss: 'strict 只差 margin∈[0.15,0.25)／earlyWorse／maxOdds∈(2.30,2.40]',
  },
  baseline: results.find((r) => r.id === 'baseline_ev02_max230'),
  variants: results,
  passingSortedByUsdLift: passing.map((r) => ({
    id: r.id,
    label: r.label,
    delta: r.deltaMerged,
    merged: r.merged,
  })),
  verdict: passing.length
    ? {
        status: 'has_shadow_candidates',
        top: passing.slice(0, 5).map((r) => r.id),
        note: '過雙窗$≥基線；仍須 expanding WF 才可考慮接入；禁止直接改正式常數',
      }
    : {
        status: 'no_variant_beats_baseline_dual_window',
        note: '本輪無變體同時滿足合併與雙窗 $≥基線',
      },
};

const outPath = new URL('../tmp-volume-lift-shadow-on-ev02.json', import.meta.url);
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`[volume-lift-shadow] wrote ${outPath.pathname}`);
console.log(`[volume-lift-shadow] verdict=${payload.verdict.status}`);
if (passing.length) {
  console.log('[volume-lift-shadow] top passing:');
  for (const r of passing.slice(0, 5)) {
    console.log(
      `  ${r.id}: Δn=${r.deltaMerged.bets} Δhr=${r.deltaMerged.hitRatePp}pp Δ$50=${r.deltaMerged.usd50}`
    );
  }
}
