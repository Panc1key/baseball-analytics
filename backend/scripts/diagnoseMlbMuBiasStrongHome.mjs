/**
 * 診斷：預期得分 μ 在強主場下是否系統偏誤，以及是否驅動毒客選邊。
 *
 * 不改常數；只報表。
 * 用法：node scripts/diagnoseMlbMuBiasStrongHome.mjs
 * 產物：tmp-mu-bias-strong-home.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import {
  MLB_FROZEN_B_SHADOW_SPEC,
  applyFormalLockedBResidual,
} from '../src/services/MlbFrozenBShadow.js';

const WINDOWS = [
  { id: '2024', from: '2024-04-01', to: '2024-09-30' },
  { id: '2025', from: '2025-04-01', to: '2025-09-30' },
  { id: '2026', from: '2026-04-01', to: '2026-07-22' },
];

const BINS = [
  { id: 'hwp_<0.45', lo: 0, hi: 0.45 },
  { id: 'hwp_0.45_0.55', lo: 0.45, hi: 0.55 },
  { id: 'hwp_0.55_0.62', lo: 0.55, hi: 0.62 },
  { id: 'hwp_0.62_0.65', lo: 0.62, hi: 0.65 },
  { id: 'hwp_>=0.65', lo: 0.65, hi: 2 },
];

function round(n, d = 4) {
  if (!Number.isFinite(n)) return null;
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function mean(xs) {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function mae(xs) {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + Math.abs(b), 0) / xs.length;
}

function binId(hwp) {
  for (const b of BINS) {
    if (hwp >= b.lo && hwp < b.hi) return b.id;
  }
  return null;
}

function summarizeSlice(rows, predKey) {
  const homeBias = [];
  const awayBias = [];
  const marginBias = [];
  const totalBias = [];
  let dirOk = 0;
  let homeWonWhenMuAway = 0;
  let muAwayN = 0;
  let homeWon = 0;

  for (const r of rows) {
    const ph = r[predKey].homeExpectedRuns;
    const pa = r[predKey].awayExpectedRuns;
    homeBias.push(r.homeScore - ph);
    awayBias.push(r.awayScore - pa);
    marginBias.push(r.homeScore - r.awayScore - (ph - pa));
    totalBias.push(r.homeScore + r.awayScore - (ph + pa));
    const predHome = ph >= pa;
    if (predHome === r.homeWon) dirOk += 1;
    if (r.homeWon) homeWon += 1;
    if (pa > ph) {
      muAwayN += 1;
      if (r.homeWon) homeWonWhenMuAway += 1;
    }
  }
  const n = rows.length;
  return {
    n,
    homeWinRate: round(homeWon / n),
    directionHit: round(dirOk / n),
    homeBiasMean: round(mean(homeBias), 3),
    awayBiasMean: round(mean(awayBias), 3),
    marginBiasMean: round(mean(marginBias), 3),
    totalBiasMean: round(mean(totalBias), 3),
    homeMae: round(mae(homeBias), 3),
    awayMae: round(mae(awayBias), 3),
    whenMuPicksAway: {
      n: muAwayN,
      share: round(muAwayN / n),
      actualHomeWinRate: muAwayN ? round(homeWonWhenMuAway / muAwayN) : null,
      note:
        '若 μ 選客但實際主勝率仍明顯 >0.5，代表 μ 方向在該切片系統偏客',
    },
  };
}

function loadRows(from, to, model) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
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
    const hs = Number(row.homeScore);
    const as = Number(row.awayScore);
    if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) continue;
    const homeWinPct = Number(features?.home?.homeWinPct);
    if (!Number.isFinite(homeWinPct)) continue;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }

    const raw = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const locked = applyFormalLockedBResidual(model, raw, features, {
      totalLine: 8.5,
    });
    out.push({
      homeScore: hs,
      awayScore: as,
      homeWon: hs > as,
      homeWinPct,
      bin: binId(homeWinPct),
      raw: {
        homeExpectedRuns: raw.homeExpectedRuns,
        awayExpectedRuns: raw.awayExpectedRuns,
      },
      locked: {
        homeExpectedRuns: locked.homeExpectedRuns,
        awayExpectedRuns: locked.awayExpectedRuns,
      },
    });
  }
  return out;
}

const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) {
  console.error('No expected-runs model in DB');
  process.exit(1);
}

const byWindow = {};
const pooled = [];

for (const w of WINDOWS) {
  console.log(`Loading ${w.id}...`);
  const rows = loadRows(w.from, w.to, model);
  pooled.push(...rows.map((r) => ({ ...r, window: w.id })));
  const bins = {};
  for (const b of BINS) {
    const slice = rows.filter((r) => r.bin === b.id);
    bins[b.id] = {
      raw: summarizeSlice(slice, 'raw'),
      lockedB: summarizeSlice(slice, 'locked'),
    };
  }
  byWindow[w.id] = {
    n: rows.length,
    overall: {
      raw: summarizeSlice(rows, 'raw'),
      lockedB: summarizeSlice(rows, 'locked'),
    },
    bins,
  };
  console.log(
    w.id,
    'n=',
    rows.length,
    'strong>=0.65 awayBias raw=',
    bins['hwp_>=0.65'].raw.awayBiasMean,
    'locked=',
    bins['hwp_>=0.65'].lockedB.awayBiasMean,
    'muAway actualHomeWR=',
    bins['hwp_>=0.65'].raw.whenMuPicksAway.actualHomeWinRate
  );
}

const focusSlices = {
  'hwp_>=0.62': pooled.filter((r) => r.homeWinPct >= 0.62),
  'hwp_>=0.65': pooled.filter((r) => r.homeWinPct >= 0.65),
  'muAway_and_hwp_>=0.62': pooled.filter(
    (r) => r.homeWinPct >= 0.62 && r.raw.awayExpectedRuns > r.raw.homeExpectedRuns
  ),
  'muAway_and_hwp_>=0.65': pooled.filter(
    (r) => r.homeWinPct >= 0.65 && r.raw.awayExpectedRuns > r.raw.homeExpectedRuns
  ),
  'muAway_and_hwp_0.62_0.65': pooled.filter(
    (r) =>
      r.homeWinPct >= 0.62 &&
      r.homeWinPct < 0.65 &&
      r.raw.awayExpectedRuns > r.raw.homeExpectedRuns
  ),
};

const focus = {};
for (const [k, rows] of Object.entries(focusSlices)) {
  focus[k] = {
    n: rows.length,
    raw: summarizeSlice(rows, 'raw'),
    lockedB: summarizeSlice(rows, 'locked'),
    byWindow: Object.fromEntries(
      WINDOWS.map((w) => {
        const s = rows.filter((r) => r.window === w.id);
        return [
          w.id,
          {
            n: s.length,
            raw: summarizeSlice(s, 'raw'),
            lockedB: summarizeSlice(s, 'locked'),
          },
        ];
      })
    ),
  };
}

// μ 特徵是否含 homeWinPct？
const featureKeys = model.featureKeys || [];
const homeWinPctInMu = featureKeys.includes('homeWinPct');

const verdict = (() => {
  const strong = focus['hwp_>=0.65']?.raw;
  const muAwayStrong = focus['muAway_and_hwp_>=0.65']?.raw;
  const brewersLike = focus['muAway_and_hwp_0.62_0.65']?.raw;
  const awayBiasStrong = strong?.awayBiasMean;
  const marginBiasStrong = strong?.marginBiasMean;
  const homeWrWhenMuAway = muAwayStrong?.homeWinRate;

  const muBiasedAway =
    Number.isFinite(awayBiasStrong) &&
    awayBiasStrong < -0.15 &&
    Number.isFinite(marginBiasStrong) &&
    marginBiasStrong > 0.2;

  const directionBroken =
    Number.isFinite(homeWrWhenMuAway) && homeWrWhenMuAway >= 0.55;

  const brewersGap =
    Number.isFinite(brewersLike?.homeWinRate) && brewersLike.homeWinRate >= 0.55;

  let primary = 'mixed';
  if (muBiasedAway && directionBroken) primary = 'mu_bias_drives_toxic_away';
  else if (directionBroken && !muBiasedAway)
    primary = 'direction_ok_ish_but_mu_away_still_loses';
  else if (muBiasedAway) primary = 'mu_level_bias_exists';
  else primary = 'mu_not_main_culprit_selection_or_odds';

  return {
    primary,
    homeWinPctInMuFeatures: homeWinPctInMu,
    lockedResidualB: MLB_FROZEN_B_SHADOW_SPEC.residual.b,
    lockedResidualNote:
      '正式殘差只修 away μ（a=0）；幅度很小，無法單獨消掉強主場偏差',
    evidence: {
      strongHomeAwayBiasRaw: awayBiasStrong,
      strongHomeMarginBiasRaw: marginBiasStrong,
      whenMuAwayStrongHomeActualHomeWR: homeWrWhenMuAway,
      brewersLike062065WhenMuAwayHomeWR: brewersLike?.homeWinRate,
      brewersLikeN: brewersLike?.n,
      muBiasedAway,
      directionBroken,
      brewersGap,
    },
  };
})();

const report = {
  experimentId: 'diagnose-mu-bias-strong-home-2026-08-07',
  modelId: validation?.id ?? null,
  modelVersion: validation?.modelVersion ?? validation?.version ?? null,
  featureKeysSample: featureKeys.slice(0, 8),
  featureKeyCount: featureKeys.length,
  byWindow,
  focus,
  verdict,
};

fs.writeFileSync(
  new URL('../tmp-mu-bias-strong-home.json', import.meta.url),
  JSON.stringify(report, null, 2)
);
console.log('\nVERDICT', JSON.stringify(verdict, null, 2));
console.log('Wrote tmp-mu-bias-strong-home.json');
