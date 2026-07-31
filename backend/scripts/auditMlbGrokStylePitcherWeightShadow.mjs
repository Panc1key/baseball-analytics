/**
 * 影子：Grok 靈感相關「細微權重」對鎖定 B 是正／負收益？
 * 代理皆為賽前可知（不做滾球）：
 *  - spotStart：本季 GS≤3 或 場均局數&lt;4（偏臨時／牛棚轉任）
 *  - returnLike：休息≥12 日 或 賽季ERA≥6（傷愈／極端失準）
 *  - mismatchVsElite：選邊 ERA 比對手差 ≥1.5，且對手 ERA≤3.5、對手GS≥5（類似紅人對 Skenes）
 *  - bpHeavy：己方近3場牛棚球數 − 對手 ≥40
 *
 * 模式：日內排序加減分（不改門檻）；另測硬跳過 mismatch
 * 產物：tmp-shadow-grok-style-pitcher-weights.json
 * 用法：node scripts/auditMlbGrokStylePitcherWeightShadow.mjs
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
import {
  applyFrozenResidualToPrediction,
  applyFrozenToxicShrink,
  MLB_FROZEN_B_SHADOW_SPEC,
} from '../src/services/MlbFrozenBShadow.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const RULES = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: 2,
};
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;

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

function sidePitcher(features, side) {
  const p = features?.pitchers || {};
  const season = p[side] || {};
  const recent = p[`${side}Recent`] || {};
  const gs = Number(season.gamesStarted);
  const ip = Number(season.inningsPitched);
  const era = Number(season.era);
  const rest = Number(recent.restDays);
  const ipPerGs = Number.isFinite(gs) && gs > 0 && Number.isFinite(ip) ? ip / gs : null;
  const spotStart =
    (Number.isFinite(gs) && gs > 0 && gs <= 3) ||
    (Number.isFinite(ipPerGs) && ipPerGs > 0 && ipPerGs < 4 && Number.isFinite(gs) && gs <= 8);
  const returnLike =
    (Number.isFinite(rest) && rest >= 12) || (Number.isFinite(era) && era >= 6);
  const bpPitches = Number(features?.bullpen?.[side]?.pitchesLast3);
  return {
    gs: Number.isFinite(gs) ? gs : null,
    era: Number.isFinite(era) ? era : null,
    rest: Number.isFinite(rest) ? rest : null,
    ipPerGs,
    spotStart: Boolean(spotStart),
    returnLike: Boolean(returnLike),
    bpPitches: Number.isFinite(bpPitches) ? bpPitches : null,
  };
}

function flagsForPick(features, pickHome) {
  const mine = sidePitcher(features, pickHome ? 'home' : 'away');
  const opp = sidePitcher(features, pickHome ? 'away' : 'home');
  const mismatchVsElite =
    Number.isFinite(mine.era) &&
    Number.isFinite(opp.era) &&
    mine.era - opp.era >= 1.5 &&
    opp.era <= 3.5 &&
    (opp.gs == null || opp.gs >= 5);
  const bpHeavy =
    mine.bpPitches != null &&
    opp.bpPitches != null &&
    mine.bpPitches - opp.bpPitches >= 40;
  return {
    spotStart: mine.spotStart,
    returnLike: mine.returnLike,
    mismatchVsElite: Boolean(mismatchVsElite),
    bpHeavy: Boolean(bpHeavy),
    mineEra: mine.era,
    oppEra: opp.era,
    eraGap: Number.isFinite(mine.era) && Number.isFinite(opp.era) ? mine.era - opp.era : null,
  };
}

function summarize(bets) {
  if (!bets.length) return { n: 0, hr: null, usd50: 0 };
  let hits = 0;
  let unit = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  return {
    n: bets.length,
    hr: Number((hits / bets.length).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}

function selectDays(cands, { scoreFn, skipFn } = {}) {
  const byDay = new Map();
  for (const c of cands) {
    if (skipFn?.(c)) continue;
    const score = scoreFn ? scoreFn(c) : c.baseScore;
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day).push({ ...c, score });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    let slots = [...byDay.get(day)].sort(
      (a, b) => b.score - a.score || b.margin - a.margin
    );
    slots = slots.slice(0, 3);
    if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
    if (
      slots.length >= 2 &&
      slots[1].pickOdds >= DROP_R2_MIN &&
      slots[1].pickOdds < DROP_R2_MAX
    ) {
      slots = [slots[0], ...slots.slice(2)];
    }
    slots.forEach((s, i) => out.push({ ...s, rank: i + 1 }));
  }
  return out;
}

console.log('[grok-style-shadow] building candidate pool…');
const validation = getLatestMlbExpectedRunsValidation();
const model = validation.model;
const pool = [];

for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
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
    const hs = Number(row.homeScore);
    const as = Number(row.awayScore);
    if (hs === as) continue;

    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
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

    const base = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const adj = applyFrozenResidualToPrediction(model, base, homeWinPct - 0.5, {
      totalLine: 8.5,
    });
    const ph = adj.homeExpectedRuns;
    const pa = adj.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? Number(adj.markets?.homeWinProbability)
      : Number(adj.markets?.awayWinProbability);
    if (!Number.isFinite(modelProb)) continue;

    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < RULES.minimumPickOdds || pickOdds > RULES.maximumPickOdds) continue;

    modelProb = applyFrozenToxicShrink(modelProb, pickOdds, { pickHome, homeWinPct });
    const margin = Math.abs(ph - pa);
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    if (modelProb < RULES.minimumModelProbability) continue;
    if (margin < RULES.minimumExpectedRunMargin) continue;
    if (ev < RULES.minimumExpectedValue) continue;

    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? Number(sig.homeEarlyExitsLast3) || 0
      : Number(sig.awayEarlyExitsLast3) || 0;
    const oppEarly = pickHome
      ? Number(sig.awayEarlyExitsLast3) || 0
      : Number(sig.homeEarlyExitsLast3) || 0;
    const pickEarlyExitsHigher = pickEarly > oppEarly;

    const baseScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb, pickEarlyExitsHigher },
      RULES
    );
    const flags = flagsForPick(features, pickHome);

    pool.push({
      day: hk(row.commenceTime),
      window: w.key,
      pickOdds,
      hit: pickHome === hs > as,
      margin,
      ev,
      baseScore,
      flags,
    });
  }
}

const baselinePicks = selectDays(pool);
const baseline = summarize(baselinePicks);
const byWindow = (picks, key) => summarize(picks.filter((b) => b.window === key));

function variant(name, opts) {
  const picks = selectDays(pool, opts);
  const merged = summarize(picks);
  return {
    name,
    merged,
    byWindow: {
      '2025': byWindow(picks, '2025'),
      '2026': byWindow(picks, '2026'),
    },
    deltaVsBase: {
      n: merged.n - baseline.n,
      hrPp: Number((((merged.hr ?? 0) - (baseline.hr ?? 0)) * 100).toFixed(2)),
      usd50: merged.usd50 - baseline.usd50,
      y25: byWindow(picks, '2025').usd50 - byWindow(baselinePicks, '2025').usd50,
      y26: byWindow(picks, '2026').usd50 - byWindow(baselinePicks, '2026').usd50,
    },
    dualGeBase:
      byWindow(picks, '2025').usd50 >= byWindow(baselinePicks, '2025').usd50 &&
      byWindow(picks, '2026').usd50 >= byWindow(baselinePicks, '2026').usd50,
  };
}

// flag prevalence on baseline picks
const flagPrev = {
  spotStart: 0,
  returnLike: 0,
  mismatchVsElite: 0,
  bpHeavy: 0,
};
for (const b of baselinePicks) {
  for (const k of Object.keys(flagPrev)) if (b.flags[k]) flagPrev[k] += 1;
}

const lambdas = [0.05, 0.1, 0.15, 0.25];
const variants = [
  variant('baseline_locked_b', {}),
  ...lambdas.map((λ) =>
    variant(`penalize_spot_l${λ}`, {
      scoreFn: (c) => c.baseScore - (c.flags.spotStart ? λ : 0),
    })
  ),
  ...lambdas.map((λ) =>
    variant(`penalize_return_l${λ}`, {
      scoreFn: (c) => c.baseScore - (c.flags.returnLike ? λ : 0),
    })
  ),
  ...lambdas.map((λ) =>
    variant(`penalize_mismatch_elite_l${λ}`, {
      scoreFn: (c) => c.baseScore - (c.flags.mismatchVsElite ? λ : 0),
    })
  ),
  ...lambdas.map((λ) =>
    variant(`penalize_bp_heavy_l${λ}`, {
      scoreFn: (c) => c.baseScore - (c.flags.bpHeavy ? λ : 0),
    })
  ),
  ...lambdas.map((λ) =>
    variant(`penalize_spot_or_return_l${λ}`, {
      scoreFn: (c) =>
        c.baseScore - (c.flags.spotStart || c.flags.returnLike ? λ : 0),
    })
  ),
  variant('skip_mismatch_elite', {
    skipFn: (c) => c.flags.mismatchVsElite,
  }),
  variant('skip_spot', { skipFn: (c) => c.flags.spotStart }),
  variant('skip_return', { skipFn: (c) => c.flags.returnLike }),
  // 反向：獎勵「先發質量優勢」（Grok 敘事選強投）— 若選邊 ERA 明顯更好
  ...lambdas.map((λ) =>
    variant(`boost_era_advantage_l${λ}`, {
      scoreFn: (c) => {
        const gap = c.flags.eraGap;
        // eraGap = mine - opp；負值=我較好
        const adv = Number.isFinite(gap) && gap <= -1.0;
        return c.baseScore + (adv ? λ : 0);
      },
    })
  ),
];

const positive = variants.filter(
  (v) => v.name !== 'baseline_locked_b' && v.deltaVsBase.usd50 > 0 && v.dualGeBase
);
const best = [...variants]
  .filter((v) => v.name !== 'baseline_locked_b')
  .sort((a, b) => b.deltaVsBase.usd50 - a.deltaVsBase.usd50)[0];

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'shadow_only_no_formal_change',
  baselineProfile: 'locked B = ev02_max230 + frozen_b+shrink + earlySoft',
  overlayId: MLB_FROZEN_B_SHADOW_SPEC.id,
  note:
    '代理特徵非完美標籤（無正式 opener／IL 旗標）；測的是「若用這類賽前代理加減權會怎樣」',
  baseline,
  baselineByWindow: {
    '2025': byWindow(baselinePicks, '2025'),
    '2026': byWindow(baselinePicks, '2026'),
  },
  flagPrevalenceOnBaselinePicks: {
    ...flagPrev,
    n: baselinePicks.length,
  },
  variants,
  verdict: {
    anyDualWindowPositive: positive.length > 0,
    positiveCount: positive.length,
    positiveNames: positive.map((v) => v.name),
    bestByMergedUsd: best
      ? {
          name: best.name,
          delta: best.deltaVsBase,
          dual: best.dualGeBase,
        }
      : null,
    plain:
      positive.length === 0
        ? '目前這批代理加減權／硬跳過：沒有「合併$提升且雙窗都不差於基線」的候選 → 不建議接入正式。'
        : '有通過雙窗的正向候選，可再 WF 後考慮影子升格。',
  },
};

fs.writeFileSync(
  new URL('../tmp-shadow-grok-style-pitcher-weights.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);

console.log('baseline', baseline, payload.baselineByWindow);
console.log('flagPrev', flagPrev);
console.log('\n=== deltas (usd50 / dual) ===');
for (const v of variants) {
  if (v.name === 'baseline_locked_b') continue;
  const d = v.deltaVsBase;
  console.log(
    `${v.name}: Δn=${d.n} Δhr=${d.hrPp}pp Δ$=${d.usd50} y25=${d.y25} y26=${d.y26} dual=${v.dualGeBase}`
  );
}
console.log('\nverdict', payload.verdict.plain);
console.log('wrote tmp-shadow-grok-style-pitcher-weights.json');
