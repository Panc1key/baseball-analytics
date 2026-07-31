/**
 * 消融：先發 active_risk → 調高「對手」expected runs（非壓低己隊攻擊）
 * 對照錯誤框架：壓低風險先發那一隊的 expected runs
 * 指標：side MAE / total MAE / 受影響側的誤差方向
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { isActivePitcherRisk } from '../src/services/PitcherInjuryIntelService.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';

const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) {
  console.error(JSON.stringify({ ok: false, error: 'mlb_expected_runs_model_missing' }));
  process.exit(1);
}

function parseFlags(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function mean(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
}

function mae(pairs) {
  if (!pairs.length) return null;
  return mean(pairs.map(([p, a]) => Math.abs(p - a)));
}

function rmse(pairs) {
  if (!pairs.length) return null;
  return Math.sqrt(mean(pairs.map(([p, a]) => (p - a) ** 2)));
}

function bias(pairs) {
  if (!pairs.length) return null;
  return mean(pairs.map(([p, a]) => p - a));
}

const cacheRows = db.prepare(`
  SELECT game_id, pitcher_id, pitcher_name, flags_json, fetched_at
  FROM mlb_pitcher_injury_intel_cache
  WHERE status IN ('ok', 'partial')
    AND flags_json IS NOT NULL
  ORDER BY datetime(fetched_at) DESC
`).all();

// gameId -> { home, away }
const intelByGame = new Map();
for (const row of cacheRows) {
  const gameId = String(row.game_id || '').replace(/:trial10$/, '');
  const flags = parseFlags(row.flags_json);
  if (!flags) continue;
  const snap = db.prepare(`
    SELECT home_pitcher_name, away_pitcher_name, home_pitcher_id, away_pitcher_id
    FROM mlb_probable_starter_snapshots
    WHERE game_id = ? AND status = 'complete'
    ORDER BY datetime(captured_at) DESC
    LIMIT 1
  `).get(gameId);
  if (!snap) continue;
  let side = null;
  if (
    snap.home_pitcher_name === row.pitcher_name ||
    snap.home_pitcher_id === row.pitcher_id
  ) {
    side = 'home';
  } else if (
    snap.away_pitcher_name === row.pitcher_name ||
    snap.away_pitcher_id === row.pitcher_id
  ) {
    side = 'away';
  }
  if (!side) continue;
  const existing = intelByGame.get(gameId) || {};
  if (existing[side]) continue; // keep latest by fetched_at DESC
  existing[side] = {
    pitcher: row.pitcher_name,
    flags,
    active: isActivePitcherRisk(flags),
    timing: flags.risk_timing || 'none',
    confidence: Number(flags.confidence) || 0,
  };
  intelByGame.set(gameId, existing);
}

const games = [];
for (const [gameId, intel] of intelByGame) {
  const game = db.prepare(`
    SELECT id, home_score, away_score, completed, commence_time, home_team, away_team
    FROM games WHERE id = ?
  `).get(gameId);
  if (!game?.completed || game.home_score == null || game.away_score == null) continue;
  const featRow = db.prepare(`
    SELECT features_json
    FROM mlb_historical_feature_rows
    WHERE game_id = ? AND feature_version = ?
  `).get(gameId, MLB_BASELINE_FEATURE_VERSION);
  if (!featRow?.features_json) continue;
  let features;
  try {
    features = JSON.parse(featRow.features_json);
  } catch {
    continue;
  }
  const base = predictMlbGameRuns(model, features);
  games.push({
    gameId,
    commenceTime: game.commence_time,
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    homeScore: Number(game.home_score),
    awayScore: Number(game.away_score),
    homeActive: Boolean(intel.home?.active),
    awayActive: Boolean(intel.away?.active),
    homeTiming: intel.home?.timing || null,
    awayTiming: intel.away?.timing || null,
    homeConf: intel.home?.confidence ?? null,
    awayConf: intel.away?.confidence ?? null,
    baseHome: base.homeExpectedRuns,
    baseAway: base.awayExpectedRuns,
  });
}

const upliftGrid = [0.25, 0.5, 0.75, 1.0, 1.5];
const confScale = true; // uplift * confidence when available

function applyOpponentUplift(row, delta) {
  let home = row.baseHome;
  let away = row.baseAway;
  // 主隊先發有風險 → 客隊得分機會↑
  if (row.homeActive) {
    const scale = confScale ? Math.max(0.4, row.homeConf ?? 0.7) : 1;
    away += delta * scale;
  }
  // 客隊先發有風險 → 主隊得分機會↑
  if (row.awayActive) {
    const scale = confScale ? Math.max(0.4, row.awayConf ?? 0.7) : 1;
    home += delta * scale;
  }
  return { home, away };
}

function applyWrongOwnTeamDown(row, delta) {
  let home = row.baseHome;
  let away = row.baseAway;
  // 錯誤框架：風險先發那一隊「攻擊變弱」
  if (row.homeActive) {
    const scale = confScale ? Math.max(0.4, row.homeConf ?? 0.7) : 1;
    home -= delta * scale;
  }
  if (row.awayActive) {
    const scale = confScale ? Math.max(0.4, row.awayConf ?? 0.7) : 1;
    away -= delta * scale;
  }
  return { home, away };
}

function scorePredictions(rows, predictFn) {
  const sidePairs = [];
  const totalPairs = [];
  const affectedPairs = []; // 被上調／下調那一側 vs 實際
  const unaffectedPairs = [];
  const gamesWithSignal = [];

  for (const row of rows) {
    const pred = predictFn(row);
    sidePairs.push([pred.home, row.homeScore], [pred.away, row.awayScore]);
    totalPairs.push([pred.home + pred.away, row.homeScore + row.awayScore]);

    const touched = row.homeActive || row.awayActive;
    if (touched) gamesWithSignal.push(row.gameId);

    // 對手側：homeActive → away is boosted; awayActive → home is boosted
    if (row.homeActive) {
      affectedPairs.push([pred.away, row.awayScore]);
      unaffectedPairs.push([pred.home, row.homeScore]);
    }
    if (row.awayActive) {
      affectedPairs.push([pred.home, row.homeScore]);
      unaffectedPairs.push([pred.away, row.awayScore]);
    }
  }

  return {
    nGames: rows.length,
    nGamesWithSignal: new Set(gamesWithSignal).size,
    nAffectedSides: affectedPairs.length,
    sideMae: mae(sidePairs),
    sideRmse: rmse(sidePairs),
    sideBias: bias(sidePairs),
    totalMae: mae(totalPairs),
    totalBias: bias(totalPairs),
    affectedMae: mae(affectedPairs),
    affectedBias: bias(affectedPairs),
    unaffectedMae: mae(unaffectedPairs),
  };
}

function summarize(metrics) {
  const r = (v) => (v == null ? null : Number(v.toFixed(4)));
  return {
    nGames: metrics.nGames,
    nGamesWithSignal: metrics.nGamesWithSignal,
    nAffectedSides: metrics.nAffectedSides,
    sideMae: r(metrics.sideMae),
    sideRmse: r(metrics.sideRmse),
    sideBias: r(metrics.sideBias),
    totalMae: r(metrics.totalMae),
    totalBias: r(metrics.totalBias),
    affectedMae: r(metrics.affectedMae),
    affectedBias: r(metrics.affectedBias),
    unaffectedMae: r(metrics.unaffectedMae),
  };
}

const baseline = scorePredictions(games, (row) => ({
  home: row.baseHome,
  away: row.baseAway,
}));

const opponentSweep = upliftGrid.map((delta) => {
  const m = scorePredictions(games, (row) => applyOpponentUplift(row, delta));
  return {
    delta,
    framing: 'opponent_scoring_uplift',
    ...summarize(m),
    sideMaeDeltaVsBase: Number((m.sideMae - baseline.sideMae).toFixed(4)),
    affectedMaeDeltaVsBase: m.affectedMae == null
      ? null
      : Number((m.affectedMae - baseline.affectedMae).toFixed(4)),
    totalMaeDeltaVsBase: Number((m.totalMae - baseline.totalMae).toFixed(4)),
  };
});

const wrongSweep = upliftGrid.map((delta) => {
  const m = scorePredictions(games, (row) => applyWrongOwnTeamDown(row, delta));
  return {
    delta,
    framing: 'own_team_offense_down_WRONG',
    ...summarize(m),
    sideMaeDeltaVsBase: Number((m.sideMae - baseline.sideMae).toFixed(4)),
    affectedMaeDeltaVsBase: m.affectedMae == null
      ? null
      : Number((m.affectedMae - baseline.affectedMae).toFixed(4)),
    totalMaeDeltaVsBase: Number((m.totalMae - baseline.totalMae).toFixed(4)),
  };
});

// 在有訊號場次上，看基準預測是否已經低估對手得分（才值得上調）
const signalGames = games.filter((g) => g.homeActive || g.awayActive);
const underpredictionCheck = signalGames.map((row) => {
  const details = [];
  if (row.homeActive) {
    details.push({
      opponentSide: 'away',
      predicted: row.baseAway,
      actual: row.awayScore,
      error: row.baseAway - row.awayScore, // <0 = 低估對手得分
    });
  }
  if (row.awayActive) {
    details.push({
      opponentSide: 'home',
      predicted: row.baseHome,
      actual: row.homeScore,
      error: row.baseHome - row.homeScore,
    });
  }
  return {
    gameId: row.gameId,
    homeActive: row.homeActive,
    awayActive: row.awayActive,
    homeTiming: row.homeTiming,
    awayTiming: row.awayTiming,
    details,
  };
});

const opponentErrors = underpredictionCheck.flatMap((g) => g.details.map((d) => d.error));
const underpredictedShare = opponentErrors.length
  ? opponentErrors.filter((e) => e < 0).length / opponentErrors.length
  : null;

const bestOpponent = [...opponentSweep].sort(
  (a, b) => a.sideMae - b.sideMae || a.affectedMae - b.affectedMae
)[0];
const bestWrong = [...wrongSweep].sort(
  (a, b) => a.sideMae - b.sideMae || a.affectedMae - b.affectedMae
)[0];

const out = {
  ok: true,
  hypothesis: 'active_risk pitcher => raise OPPONENT expected runs',
  modelVersion: validation.modelVersion,
  featureVersion: MLB_BASELINE_FEATURE_VERSION,
  confidenceScaled: confScale,
  sample: {
    gamesWithIntelAndFeatures: games.length,
    gamesWithActiveRisk: signalGames.length,
    activeSides: games.reduce(
      (n, g) => n + (g.homeActive ? 1 : 0) + (g.awayActive ? 1 : 0),
      0
    ),
  },
  baseline: summarize(baseline),
  underpredictionOnAffectedOpponent: {
    nSides: opponentErrors.length,
    meanError: opponentErrors.length ? Number(mean(opponentErrors).toFixed(4)) : null,
    underpredictedShare: underpredictedShare == null
      ? null
      : Number(underpredictedShare.toFixed(4)),
    note: 'meanError<0 表示基準已低估對手得分，上調才可能改善',
  },
  opponentUpliftSweep: opponentSweep,
  wrongOwnTeamDownSweep: wrongSweep,
  bestOpponentUplift: bestOpponent,
  bestWrongFraming: bestWrong,
  improvedVsBaseline: bestOpponent.sideMae < baseline.sideMae,
  examples: underpredictionCheck.slice(0, 12),
  verdictRules: [
    '若 opponent uplift 的 sideMae / affectedMae 明顯低於 baseline，邏輯被資料支持',
    '若 underpredictedShare 接近 0.5 且 meanError≈0，表示基準已無系統性低估，硬上調只會變差',
    '若 wrong framing 也差不多或更好，則不是「對手得分機會」因果在起作用',
  ],
};

fs.writeFileSync('tmp-ablate-opponent-uplift.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
