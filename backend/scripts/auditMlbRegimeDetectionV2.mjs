/**
 * 型態 detection precision 審計（v2）。
 *
 * KPI：賽前 predicted vs 賽後 labelGameRegimeV2FromBoxscore
 * 不以大小球 lean 命中率過關。
 *
 * 用法：
 *   node scripts/auditMlbRegimeDetectionV2.mjs [months]
 * months=0 表示全樣本；預設 3。
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  MLB_GAME_REGIME_DETECTION_VERSION,
  buildPregameRegimeSignals,
  evaluateRegimeDetectionV2Pass,
  labelGameRegimeV2FromBoxscore,
  resolveOfficialGamePk,
  scoreGameRegimeFromPregame,
  summarizeRegimeDetectionV2,
} from '../src/services/MlbGameRegimeService.js';

const monthsArg = process.argv[2];
const months = monthsArg == null || monthsArg === '' ? 3 : Number(monthsArg);
const sinceIso = (() => {
  if (!Number.isFinite(months) || months <= 0) return null;
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - months);
  return since.toISOString().slice(0, 10);
})();

const officialRows = db.prepare(`
  SELECT f.game_id AS gameId,
         f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
         g.home_team AS homeTeam,
         g.away_team AS awayTeam,
         g.home_score AS homeScore,
         g.away_score AS awayScore,
         CAST(REPLACE(f.game_id, 'mlb-official-', '') AS INTEGER) AS gamePk,
         b.payload_json AS boxJson
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  JOIN mlb_boxscore_cache b
    ON b.game_pk = CAST(REPLACE(f.game_id, 'mlb-official-', '') AS INTEGER)
  WHERE f.feature_version = ?
    AND g.completed = 1
    AND g.home_score IS NOT NULL
    AND g.away_score IS NOT NULL
    AND f.game_id LIKE 'mlb-official-%'
    AND (? IS NULL OR date(f.commence_time) >= date(?))
  ORDER BY f.commence_time
`).all(MLB_BASELINE_FEATURE_VERSION, sinceIso, sinceIso);

const snapshotRows = db.prepare(`
  SELECT f.game_id AS gameId,
         f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
         g.home_team AS homeTeam,
         g.away_team AS awayTeam,
         g.home_score AS homeScore,
         g.away_score AS awayScore,
         s.official_game_pk AS gamePk,
         b.payload_json AS boxJson
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  JOIN mlb_probable_starter_snapshots s
    ON s.game_id = f.game_id
   AND s.status = 'complete'
   AND s.official_game_pk IS NOT NULL
  JOIN mlb_boxscore_cache b ON b.game_pk = s.official_game_pk
  WHERE f.feature_version = ?
    AND g.completed = 1
    AND g.home_score IS NOT NULL
    AND g.away_score IS NOT NULL
    AND f.game_id NOT LIKE 'mlb-official-%'
    AND (? IS NULL OR date(f.commence_time) >= date(?))
  GROUP BY f.game_id
  ORDER BY f.commence_time
`).all(MLB_BASELINE_FEATURE_VERSION, sinceIso, sinceIso);

const seen = new Set();
const rows = [];
for (const row of [...officialRows, ...snapshotRows]) {
  if (seen.has(row.gameId)) continue;
  seen.add(row.gameId);
  rows.push(row);
}

const FEATURE_KEYS = [
  'avgRecentEra',
  'maxRecentEra',
  'maxEraGap',
  'avgExpIp',
  'minExpIp',
  'avgBullpenPitches',
  'maxBullpenPitches',
  'eitherPitchingBlowupRisk',
  'bothPitchingStable',
];

function meanFinite(vals) {
  const xs = vals.filter((v) => Number.isFinite(v));
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}

function featureMeans(subset) {
  const out = { n: subset.length };
  for (const key of FEATURE_KEYS) {
    const m = meanFinite(subset.map((r) => r[key]));
    out[key] = m == null ? null : Number(m.toFixed(4));
  }
  return out;
}

const evaluated = [];
let skipped = 0;
for (const row of rows) {
  let features;
  let boxscore;
  try {
    features = JSON.parse(row.featuresJson);
    boxscore = JSON.parse(row.boxJson);
  } catch {
    skipped += 1;
    continue;
  }
  const label = labelGameRegimeV2FromBoxscore(boxscore, {
    homeScore: row.homeScore,
    awayScore: row.awayScore,
  });
  if (!label.regime) {
    skipped += 1;
    continue;
  }
  const signals = buildPregameRegimeSignals(features);
  const scored = scoreGameRegimeFromPregame(signals);
  evaluated.push({
    gameId: row.gameId,
    gamePk: row.gamePk || resolveOfficialGamePk(row.gameId),
    commenceTime: row.commenceTime,
    matchup: `${row.awayTeam} @ ${row.homeTeam}`,
    trueRegime: label.regime,
    trueReason: label.reason,
    totalRuns: label.totalRuns,
    margin: label.margin,
    predicted: scored.predicted,
    duelScore: scored.duelScore,
    oneSidedScore: scored.oneSidedScore,
    highTotalScore: scored.highTotalScore,
    blowupScore: scored.blowupScore,
    ...signals,
  });
}

const summary = summarizeRegimeDetectionV2(evaluated);
const pass = evaluateRegimeDetectionV2Pass(summary);

function errorSlice(predicted, trueOk) {
  const preds = evaluated.filter((r) => r.predicted === predicted);
  const tp = preds.filter((r) => r.trueRegime === trueOk);
  const fp = preds.filter((r) => r.trueRegime !== trueOk);
  return {
    predicted,
    truePositive: featureMeans(tp),
    falsePositive: featureMeans(fp),
    fpExamples: fp.slice(0, 8).map((r) => ({
      matchup: r.matchup,
      date: String(r.commenceTime).slice(0, 10),
      total: r.totalRuns,
      margin: r.margin,
      trueRegime: r.trueRegime,
      trueReason: r.trueReason,
      duelScore: r.duelScore,
      oneSidedScore: r.oneSidedScore,
      highTotalScore: r.highTotalScore,
    })),
  };
}

const errorAnalysis = {
  duel: errorSlice('duel', 'duel'),
  high_total: errorSlice('high_total', 'high_total'),
  one_sided: errorSlice('one_sided', 'one_sided'),
};

const featureHint = (() => {
  const hints = [];
  const duelFp = errorAnalysis.duel.falsePositive;
  const duelTp = errorAnalysis.duel.truePositive;
  if (duelFp.n >= 10 && duelTp.n >= 10) {
    if (
      duelFp.maxBullpenPitches != null &&
      duelTp.maxBullpenPitches != null &&
      duelFp.maxBullpenPitches > duelTp.maxBullpenPitches + 20
    ) {
      hints.push('duel_FP_higher_bullpen_load → 加強牛棚過載對 duel 的否決');
    }
    if (
      duelFp.maxRecentEra != null &&
      duelTp.maxRecentEra != null &&
      duelFp.maxRecentEra > duelTp.maxRecentEra + 0.4
    ) {
      hints.push('duel_FP_higher_maxRecentEra → 雙邊都緊門檻再收緊／加入提早退場');
    }
  }
  const htFp = errorAnalysis.high_total.falsePositive;
  const htTp = errorAnalysis.high_total.truePositive;
  if (htFp.n >= 3 && htTp.n >= 3) {
    if (
      htTp.eitherPitchingBlowupRisk != null &&
      htFp.eitherPitchingBlowupRisk != null &&
      htTp.eitherPitchingBlowupRisk > htFp.eitherPitchingBlowupRisk + 0.2
    ) {
      hints.push('high_total_TP_higher_blowup_risk → 爆分次數／提早退場特徵值得加');
    }
    if (
      htTp.avgBullpenPitches != null &&
      htFp.avgBullpenPitches != null &&
      htTp.avgBullpenPitches > htFp.avgBullpenPitches + 10
    ) {
      hints.push('high_total_TP_higher_bullpen_load → 雙邊牛棚確認繼續保留／加權');
    }
  }
  if (
    errorAnalysis.duel.falsePositive.n >= 50 &&
    summary.detection?.byClass?.duel?.precision != null &&
    summary.detection.byClass.duel.precision < (summary.baseRates?.duel || 0) * 1.3
  ) {
    hints.push('duel_precision_near_baseRate → 近況 ERA 不夠；優先補提早退場／單場爆分否決');
  }
  if (
    summary.detection?.byClass?.high_total?.precision != null &&
    summary.detection.byClass.high_total.precision < 0.12
  ) {
    hints.push('high_total_precision_very_low → 不要擴大 over lean；先做爆分結構特徵');
  }
  if (!hints.length) {
    hints.push('樣本或分離不足：優先補近3場提早退場、單場爆分、opener／雙重賽');
  }
  return hints;
})();

const out = {
  ok: true,
  detectionVersion: MLB_GAME_REGIME_DETECTION_VERSION,
  featureVersion: MLB_BASELINE_FEATURE_VERSION,
  windowMonths: Number.isFinite(months) && months > 0 ? months : 'all',
  since: sinceIso,
  scanned: rows.length,
  labeled: evaluated.length,
  skipped,
  summary,
  passCriteria: pass,
  errorAnalysis,
  nextFeatureHints: featureHint,
  note: [
    '主 KPI：duel／one_sided／high_total 的 precision、meanTotal／meanMargin 分離',
    '不以 totals lean 命中率過關',
    'actionable 前需 detectionPromising 且後續特徵抬升 precision',
  ],
};

fs.writeFileSync('tmp-regime-detection-v2.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
