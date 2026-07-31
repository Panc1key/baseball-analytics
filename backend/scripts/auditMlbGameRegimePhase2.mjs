/**
 * Phase 2 審計：崩盤識別為主，比分只考核非崩盤場。
 * 崩盤 15 分與 100 分同等——不把 blowup total MAE 當過關條件。
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  predictMlbGameRunsWithRegime,
} from '../src/services/MlbExpectedRunsModel.js';
import {
  MLB_GAME_REGIME_PHASE2_VERSION,
  evaluateRegimePhase2Pass,
  labelGameRegimeFromBoxscore,
  resolveOfficialGamePk,
} from '../src/services/MlbGameRegimeService.js';

const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) {
  console.error(JSON.stringify({ ok: false, error: 'mlb_expected_runs_model_missing' }));
  process.exit(1);
}

const limit = Number(process.argv[2] || 0);

const officialRows = db.prepare(`
  SELECT f.game_id AS gameId,
         f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
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
    AND f.game_id LIKE 'mlb-official-%'
  ORDER BY f.commence_time
`).all(MLB_BASELINE_FEATURE_VERSION);

const snapshotRows = db.prepare(`
  SELECT f.game_id AS gameId,
         f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
         g.home_score AS homeScore,
         g.away_score AS awayScore,
         s.official_game_pk AS gamePk,
         b.payload_json AS boxJson
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  JOIN mlb_probable_starter_snapshots s
    ON s.game_id = f.game_id AND s.status = 'complete' AND s.official_game_pk IS NOT NULL
  JOIN mlb_boxscore_cache b ON b.game_pk = s.official_game_pk
  WHERE f.feature_version = ?
    AND g.completed = 1
    AND g.home_score IS NOT NULL
    AND f.game_id NOT LIKE 'mlb-official-%'
  GROUP BY f.game_id
  ORDER BY f.commence_time
`).all(MLB_BASELINE_FEATURE_VERSION);

const seen = new Set();
const rows = [];
for (const row of [...officialRows, ...snapshotRows]) {
  if (seen.has(row.gameId)) continue;
  seen.add(row.gameId);
  rows.push(row);
  if (limit > 0 && rows.length >= limit) break;
}

function mean(arr) {
  const vals = arr.filter((v) => Number.isFinite(v));
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

function mae(pairs) {
  if (!pairs.length) return null;
  return mean(pairs.map(([p, a]) => Math.abs(p - a)));
}

function brier(pairs) {
  if (!pairs.length) return null;
  return mean(pairs.map(([p, y]) => (p - y) ** 2));
}

function summarizeMode(gamesRows, mode) {
  const sideAll = [];
  const sideNonBlowup = [];
  const totalBlowup = [];
  const direction = [];
  const directionNonBlowup = [];
  const winPairs = [];
  let blowupPred = 0;
  let blowupTp = 0;
  let blowupFp = 0;
  let blowupFn = 0;

  for (const row of gameRows) {
    const pred = mode === 'regime' ? row.regimePred : row.basePred;
    const homePred = pred.homeExpectedRuns;
    const awayPred = pred.awayExpectedRuns;
    sideAll.push([homePred, row.homeScore], [awayPred, row.awayScore]);
    if (row.trueRegime !== 'blowup') {
      sideNonBlowup.push([homePred, row.homeScore], [awayPred, row.awayScore]);
    } else {
      totalBlowup.push([homePred + awayPred, row.homeScore + row.awayScore]);
    }

    const predHomeWins = homePred >= awayPred;
    const actHomeWins = row.homeScore > row.awayScore;
    const actTie = row.homeScore === row.awayScore;
    if (!actTie) {
      const hit = predHomeWins === actHomeWins ? 1 : 0;
      direction.push(hit);
      if (row.trueRegime !== 'blowup') directionNonBlowup.push(hit);
    }

    const pHome = pred.markets?.homeWinProbability;
    if (Number.isFinite(pHome) && !actTie) {
      winPairs.push([pHome, actHomeWins ? 1 : 0]);
    }

    const flaggedBlowup =
      mode === 'regime'
        ? pred.regime?.strengths?.dominant === 'blowup' ||
          pred.regime?.predicted === 'blowup' ||
          (pred.regime?.blowupScore ?? 0) >= 4
        : false;
    // baseline 沒有 regime：用相同賽前分數門檻作對照檢測器
    const baselineFlag =
      mode === 'base'
        ? row.scored?.blowupScore >= 4 && row.scored.blowupScore > row.scored.duelScore
        : flaggedBlowup;
    const isBlowupFlag = mode === 'regime' ? flaggedBlowup : baselineFlag;

    if (isBlowupFlag) {
      blowupPred += 1;
      if (row.trueRegime === 'blowup') blowupTp += 1;
      else blowupFp += 1;
    } else if (row.trueRegime === 'blowup') {
      blowupFn += 1;
    }
  }

  const precision = blowupTp + blowupFp > 0 ? blowupTp / (blowupTp + blowupFp) : null;
  const recall = blowupTp + blowupFn > 0 ? blowupTp / (blowupTp + blowupFn) : null;
  const baseRate = gameRows.filter((r) => r.trueRegime === 'blowup').length / gameRows.length;
  const lift = precision != null && baseRate > 0 ? precision / baseRate : null;

  return {
    n: gameRows.length,
    blowupDetection: {
      predicted: blowupPred,
      precision: precision == null ? null : Number(precision.toFixed(4)),
      recall: recall == null ? null : Number(recall.toFixed(4)),
      baseRate: Number(baseRate.toFixed(4)),
      lift: lift == null ? null : Number(lift.toFixed(3)),
      note: '崩盤只需識別；15 分與 100 分同等，不看 total MAE 過關',
    },
    directionHitRate: direction.length ? Number(mean(direction).toFixed(4)) : null,
    directionHitRateNonBlowup: directionNonBlowup.length
      ? Number(mean(directionNonBlowup).toFixed(4))
      : null,
    sideMaeAll: Number(mae(sideAll)?.toFixed(4)),
    sideMaeNonBlowup: Number(mae(sideNonBlowup)?.toFixed(4)),
    blowupTotalMae_ignoredForPass: Number(mae(totalBlowup)?.toFixed(4)),
    moneylineBrier: Number(brier(winPairs)?.toFixed(4)),
  };
}

const gameRows = [];
for (const row of rows) {
  let features;
  let boxscore;
  try {
    features = JSON.parse(row.featuresJson);
    boxscore = JSON.parse(row.boxJson);
  } catch {
    continue;
  }
  const label = labelGameRegimeFromBoxscore(boxscore, {
    homeScore: row.homeScore,
    awayScore: row.awayScore,
  });
  if (!label.regime) continue;
  const basePred = predictMlbGameRuns(model, features);
  const regimePred = predictMlbGameRunsWithRegime(model, features);
  gameRows.push({
    gameId: row.gameId,
    gamePk: row.gamePk || resolveOfficialGamePk(row.gameId),
    commenceTime: row.commenceTime,
    homeScore: Number(row.homeScore),
    awayScore: Number(row.awayScore),
    trueRegime: label.regime,
    scored: regimePred.regime
      ? {
          duelScore: regimePred.regime.duelScore,
          blowupScore: regimePred.regime.blowupScore,
          predicted: regimePred.regime.predicted,
        }
      : null,
    basePred,
    regimePred,
  });
}

const baseline = summarizeMode(gameRows, 'base');
const adjusted = summarizeMode(gameRows, 'regime');
const pass = evaluateRegimePhase2Pass({ baseline, adjusted });

const out = {
  ok: true,
  phase: 2,
  regimeVersion: MLB_GAME_REGIME_PHASE2_VERSION,
  modelVersion: validation.modelVersion,
  philosophy: {
    duel: 'compress_dispersion_only',
    blowup: 'detect_only_widen_dispersion',
    passUses: [
      'blowup_detection_lift_or_precision_or_recall',
      'direction_hit_rate',
      'side_mae_non_blowup',
    ],
    passIgnores: ['blowup_total_mae'],
  },
  n: gameRows.length,
  baseline,
  adjusted,
  deltas: {
    directionHitRate: Number(
      ((adjusted.directionHitRate ?? 0) - (baseline.directionHitRate ?? 0)).toFixed(4)
    ),
    directionHitRateNonBlowup: Number(
      ((adjusted.directionHitRateNonBlowup ?? 0) -
        (baseline.directionHitRateNonBlowup ?? 0)).toFixed(4)
    ),
    sideMaeNonBlowup: Number(
      ((adjusted.sideMaeNonBlowup ?? 0) - (baseline.sideMaeNonBlowup ?? 0)).toFixed(4)
    ),
    blowupLift: Number(
      ((adjusted.blowupDetection.lift ?? 0) - (baseline.blowupDetection.lift ?? 0)).toFixed(3)
    ),
    moneylineBrier: Number(
      ((adjusted.moneylineBrier ?? 0) - (baseline.moneylineBrier ?? 0)).toFixed(4)
    ),
  },
  passCriteria: pass,
  nextStepHint: pass.phase2Promising
    ? 'Phase 2 soft 調整方向正確：可繼續強化賽前波動特徵後再考慮進 live 研究路徑'
    : 'Phase 2 尚未過關：優先補提早退場／爆分次數等賽前特徵，再調 soft 參數',
};

fs.writeFileSync('tmp-regime-phase2.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
