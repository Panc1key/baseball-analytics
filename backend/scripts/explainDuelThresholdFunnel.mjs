/**
 * 說明用：投手戰門檻敏感度（為什麼 925→24）。
 */
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  buildPregameRegimeSignals,
  labelGameRegimeV2FromBoxscore,
  scoreGameRegimeFromPregame,
} from '../src/services/MlbGameRegimeService.js';

const officialRows = db.prepare(`
  SELECT f.features_json AS featuresJson,
         g.home_score AS homeScore,
         g.away_score AS awayScore,
         b.payload_json AS boxJson
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  JOIN mlb_boxscore_cache b
    ON b.game_pk = CAST(REPLACE(f.game_id, 'mlb-official-', '') AS INTEGER)
  WHERE f.feature_version = ?
    AND g.completed = 1
    AND f.game_id LIKE 'mlb-official-%'
`).all(MLB_BASELINE_FEATURE_VERSION);

const snapshotRows = db.prepare(`
  SELECT f.features_json AS featuresJson,
         g.home_score AS homeScore,
         g.away_score AS awayScore,
         b.payload_json AS boxJson
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  JOIN mlb_probable_starter_snapshots s
    ON s.game_id = f.game_id AND s.status = 'complete' AND s.official_game_pk IS NOT NULL
  JOIN mlb_boxscore_cache b ON b.game_pk = s.official_game_pk
  WHERE f.feature_version = ?
    AND g.completed = 1
    AND f.game_id NOT LIKE 'mlb-official-%'
  GROUP BY f.game_id
`).all(MLB_BASELINE_FEATURE_VERSION);

const rows = [...officialRows, ...snapshotRows];
const funnel = {
  total: 0,
  bothTightDeep: 0,
  afterVolVeto: 0,
  afterParkVeto: 0,
  scoreAtLeast5: 0,
  scoreAtLeast6: 0,
  scoreAtLeast7: 0,
};
const byThreshold = {
  4: { n: 0, tp: 0 },
  5: { n: 0, tp: 0 },
  6: { n: 0, tp: 0 },
  7: { n: 0, tp: 0 },
};

for (const row of rows) {
  let features;
  let box;
  try {
    features = JSON.parse(row.featuresJson);
    box = JSON.parse(row.boxJson);
  } catch {
    continue;
  }
  const truth = labelGameRegimeV2FromBoxscore(box, {
    homeScore: row.homeScore,
    awayScore: row.awayScore,
  });
  if (!truth.regime) continue;
  funnel.total += 1;
  const signals = buildPregameRegimeSignals(features);
  const scored = scoreGameRegimeFromPregame(signals);
  const reasons = scored.reasons || [];
  const homeTight = signals.homeRecentEra != null && signals.homeRecentEra <= 3.8;
  const awayTight = signals.awayRecentEra != null && signals.awayRecentEra <= 3.8;
  const homeDeep = signals.homeExpIp != null && signals.homeExpIp >= 5.5;
  const awayDeep = signals.awayExpIp != null && signals.awayExpIp >= 5.5;
  if (homeTight && awayTight && homeDeep && awayDeep) funnel.bothTightDeep += 1;
  if (!reasons.includes('recent_start_volatility_vetoes_duel') && homeTight && awayTight && homeDeep && awayDeep) {
    funnel.afterVolVeto += 1;
  }
  if (
    !reasons.includes('recent_start_volatility_vetoes_duel') &&
    !reasons.includes('hitter_park_vetoes_duel') &&
    homeTight && awayTight && homeDeep && awayDeep
  ) {
    funnel.afterParkVeto += 1;
  }
  if (scored.duelScore >= 5) funnel.scoreAtLeast5 += 1;
  if (scored.duelScore >= 6) funnel.scoreAtLeast6 += 1;
  if (scored.duelScore >= 7) funnel.scoreAtLeast7 += 1;

  const ranked = Object.entries(scored.scores).sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const second = ranked[1][1];
  for (const T of [4, 5, 6, 7]) {
    if (top === 'duel' && topScore >= T && topScore >= second + 2) {
      byThreshold[T].n += 1;
      if (truth.regime === 'duel') byThreshold[T].tp += 1;
    }
  }
}

const out = {
  funnel,
  byThreshold: Object.fromEntries(
    Object.entries(byThreshold).map(([t, v]) => [
      t,
      {
        predicted: v.n,
        precision: v.n ? Number((v.tp / v.n).toFixed(4)) : null,
        share: funnel.total ? Number((v.n / funnel.total).toFixed(4)) : null,
      },
    ])
  ),
};
console.log(JSON.stringify(out, null, 2));
