/**
 * 近 N 個月：基準 vs Phase2 regime 的勝方命中率（方向）。
 * 勝方 = 預期得分較高的一邊；平手場排除。
 */
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  predictMlbGameRunsWithRegime,
} from '../src/services/MlbExpectedRunsModel.js';
import { labelGameRegimeFromBoxscore } from '../src/services/MlbGameRegimeService.js';

const months = Number(process.argv[2] || 3);
const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) throw new Error('mlb_expected_runs_model_missing');

const since = new Date();
since.setUTCMonth(since.getUTCMonth() - months);
const sinceIso = since.toISOString().slice(0, 10);

const officialRows = db.prepare(`
  SELECT f.game_id AS gameId,
         f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
         g.home_team AS homeTeam,
         g.away_team AS awayTeam,
         g.home_score AS homeScore,
         g.away_score AS awayScore,
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
    AND date(f.commence_time) >= date(?)
  ORDER BY f.commence_time
`).all(MLB_BASELINE_FEATURE_VERSION, sinceIso);

const hashRows = db.prepare(`
  SELECT f.game_id AS gameId,
         f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
         g.home_team AS homeTeam,
         g.away_team AS awayTeam,
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
    AND g.home_score IS NOT NULL
    AND g.away_score IS NOT NULL
    AND f.game_id NOT LIKE 'mlb-official-%'
    AND date(f.commence_time) >= date(?)
  GROUP BY f.game_id
  ORDER BY f.commence_time
`).all(MLB_BASELINE_FEATURE_VERSION, sinceIso);

const seen = new Set();
const rows = [];
for (const row of [...officialRows, ...hashRows]) {
  if (seen.has(row.gameId)) continue;
  seen.add(row.gameId);
  rows.push(row);
}

function bucket() {
  return {
    nDecided: 0,
    hitsBase: 0,
    hitsRegime: 0,
    ties: 0,
    byRegime: {
      duel: { n: 0, hitsBase: 0, hitsRegime: 0 },
      normal: { n: 0, hitsBase: 0, hitsRegime: 0 },
      blowup: { n: 0, hitsBase: 0, hitsRegime: 0 },
    },
  };
}

const overall = bucket();
const byMonth = new Map();

for (const row of rows) {
  let features;
  let box;
  try {
    features = JSON.parse(row.featuresJson);
    box = row.boxJson ? JSON.parse(row.boxJson) : null;
  } catch {
    continue;
  }
  const homeScore = Number(row.homeScore);
  const awayScore = Number(row.awayScore);
  const monthKey = String(row.commenceTime).slice(0, 7);
  if (!byMonth.has(monthKey)) byMonth.set(monthKey, bucket());
  const month = byMonth.get(monthKey);

  const label = box
    ? labelGameRegimeFromBoxscore(box, { homeScore, awayScore })
    : { regime: 'normal' };
  const trueRegime = label.regime || 'normal';

  const base = predictMlbGameRuns(model, features);
  const regime = predictMlbGameRunsWithRegime(model, features);
  const actHome = homeScore > awayScore;
  const tie = homeScore === awayScore;

  const apply = (target) => {
    if (tie) {
      target.ties += 1;
      return;
    }
    const baseHit = (base.homeExpectedRuns >= base.awayExpectedRuns) === actHome ? 1 : 0;
    const regimeHit =
      (regime.homeExpectedRuns >= regime.awayExpectedRuns) === actHome ? 1 : 0;
    target.nDecided += 1;
    target.hitsBase += baseHit;
    target.hitsRegime += regimeHit;
    const rg = target.byRegime[trueRegime] || target.byRegime.normal;
    rg.n += 1;
    rg.hitsBase += baseHit;
    rg.hitsRegime += regimeHit;
  };

  apply(overall);
  apply(month);
}

function rate(hits, n) {
  return n > 0 ? Number((hits / n).toFixed(4)) : null;
}

function summarize(b) {
  const out = {
    decidedGames: b.nDecided,
    tiesExcluded: b.ties,
    baselineDirectionHitRate: rate(b.hitsBase, b.nDecided),
    regimeDirectionHitRate: rate(b.hitsRegime, b.nDecided),
    delta: b.nDecided
      ? Number(((b.hitsRegime - b.hitsBase) / b.nDecided).toFixed(4))
      : null,
    byTrueRegime: {},
  };
  for (const key of ['duel', 'normal', 'blowup']) {
    const r = b.byRegime[key];
    out.byTrueRegime[key] = {
      n: r.n,
      baseline: rate(r.hitsBase, r.n),
      regime: rate(r.hitsRegime, r.n),
    };
  }
  return out;
}

const out = {
  ok: true,
  modelVersion: validation.modelVersion,
  windowMonths: months,
  since: sinceIso,
  through: new Date().toISOString().slice(0, 10),
  note: [
    'directionHitRate = 預期得分較高那邊是否真的贏（平手排除）',
    '先前 ~55.9% 是含 2024-2025 的大樣本；本報告只看近 N 個月',
    '這不是下注 ROI，只是勝方方向命中率',
  ],
  sampleGamesScanned: rows.length,
  overall: summarize(overall),
  byMonth: Object.fromEntries(
    [...byMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => [k, summarize(v)])
  ),
};

console.log(JSON.stringify(out, null, 2));
