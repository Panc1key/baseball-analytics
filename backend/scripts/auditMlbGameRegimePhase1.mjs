/**
 * Phase 1：賽事型態分離度審計。
 * 用官方 feature rows + boxscore cache 打賽後標籤，再測賽前規則能否分開。
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  MLB_GAME_REGIME_VERSION,
  buildPregameRegimeSignals,
  evaluateRegimePassCriteria,
  labelGameRegimeFromBoxscore,
  resolveOfficialGamePk,
  scoreGameRegimeFromPregame,
  summarizeRegimeSeparation,
} from '../src/services/MlbGameRegimeService.js';

const limit = Number(process.argv[2] || 0); // 0 = all

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
  ORDER BY f.commence_time
`).all(MLB_BASELINE_FEATURE_VERSION);

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
  const label = labelGameRegimeFromBoxscore(boxscore, {
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
    predicted: scored.predicted,
    duelScore: scored.duelScore,
    blowupScore: scored.blowupScore,
    ...signals,
  });
}

const summary = summarizeRegimeSeparation(evaluated);
const pass = evaluateRegimePassCriteria(summary);

// 季節切片：2025 development vs 2026 observed
function sliceYear(year) {
  const subset = evaluated.filter((r) => String(r.commenceTime).startsWith(String(year)));
  if (subset.length < 50) return { n: subset.length, note: 'insufficient' };
  const s = summarizeRegimeSeparation(subset);
  return {
    n: s.n,
    baseRates: s.baseRates,
    lifts: s.lifts,
    meanTotalByPredicted: s.meanTotalByPredicted,
    ruleAccuracy: s.ruleClassifier.accuracy,
    pass: evaluateRegimePassCriteria(s),
  };
}

const examples = {
  trueDuel: evaluated.filter((r) => r.trueRegime === 'duel').slice(0, 5).map((r) => ({
    matchup: r.matchup,
    date: String(r.commenceTime).slice(0, 10),
    total: r.totalRuns,
    predicted: r.predicted,
    duelScore: r.duelScore,
    blowupScore: r.blowupScore,
  })),
  trueBlowup: evaluated.filter((r) => r.trueRegime === 'blowup').slice(0, 5).map((r) => ({
    matchup: r.matchup,
    date: String(r.commenceTime).slice(0, 10),
    total: r.totalRuns,
    predicted: r.predicted,
    duelScore: r.duelScore,
    blowupScore: r.blowupScore,
    reason: r.trueReason,
  })),
};

const out = {
  ok: true,
  regimeVersion: MLB_GAME_REGIME_VERSION,
  featureVersion: MLB_BASELINE_FEATURE_VERSION,
  scanned: rows.length,
  labeled: evaluated.length,
  skipped,
  summary,
  passCriteria: pass,
  bySeason: {
    y2025: sliceYear(2025),
    y2026: sliceYear(2026),
  },
  examples,
  nextStepHint: pass.phase1Promising
    ? 'Phase 1 有分離訊號：可進 Phase 2（依型態調 dispersion／不對稱對手得分）'
    : 'Phase 1 分離偏弱：先收緊賽前規則或補雙重賽／opener 特徵，再進 Phase 2',
};

fs.writeFileSync('tmp-regime-phase1.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
