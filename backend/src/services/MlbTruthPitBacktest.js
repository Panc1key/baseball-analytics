/**
 * 嚴格 point-in-time 回放。
 *
 * 此回放絕不呼叫當前 MLB API，也不重跑舊模型；只讀取每場開賽前已保存的
 * mlb_prematch_truth_snapshots 與其研究輸出。沒有賽前快照的歷史場次會
 * 被排除，而不是以今日資料補算。
 */
import db from '../db/database.js';

function binaryMetrics(points) {
  if (!points.length) return { samples: 0, brier: null, logLoss: null };
  let brier = 0;
  let logLoss = 0;
  for (const { p, y } of points) {
    const probability = Math.max(0.001, Math.min(0.999, Number(p)));
    brier += (probability - y) ** 2;
    logLoss += -(y * Math.log(probability) + (1 - y) * Math.log(1 - probability));
  }
  return {
    samples: points.length,
    brier: brier / points.length,
    logLoss: logLoss / points.length,
  };
}

export function runMlbTruthPitBacktest({ from, to } = {}) {
  const params = [];
  let dateClause = '';
  if (from) {
    dateClause += ' AND datetime(g.commence_time) >= datetime(?)';
    params.push(from);
  }
  if (to) {
    dateClause += ' AND datetime(g.commence_time) <= datetime(?)';
    params.push(to);
  }

  const games = db.prepare(`
    SELECT g.id, g.home_team, g.away_team, g.home_score, g.away_score, g.commence_time
    FROM games g
    WHERE g.league = 'MLB'
      AND g.completed = 1
      AND g.home_score IS NOT NULL
      AND g.away_score IS NOT NULL
      ${dateClause}
    ORDER BY datetime(g.commence_time) ASC
  `).all(...params);

  const snapshotForGame = db.prepare(`
    SELECT t.id, t.captured_at, t.mandatory_complete, t.gate_status, c.pick, c.market_prob,
           c.model_prob, c.status AS candidate_status
    FROM mlb_prematch_truth_snapshots t
    LEFT JOIN mlb_paper_candidates c ON c.truth_snapshot_id = t.id
    WHERE t.game_id = ?
      AND datetime(t.captured_at) < datetime(?)
    ORDER BY datetime(t.captured_at) DESC, t.id DESC
    LIMIT 1
  `);

  const rows = [];
  const excluded = {
    noPrematchSnapshot: 0,
    noPairedMarket: 0,
    invalidPick: 0,
  };
  for (const game of games) {
    const snapshot = snapshotForGame.get(game.id, game.commence_time);
    if (!snapshot) {
      excluded.noPrematchSnapshot += 1;
      continue;
    }
    if (!Number.isFinite(Number(snapshot.market_prob)) || !Number.isFinite(Number(snapshot.model_prob))) {
      excluded.noPairedMarket += 1;
      continue;
    }
    if (snapshot.pick !== game.home_team && snapshot.pick !== game.away_team) {
      excluded.invalidPick += 1;
      continue;
    }
    const outcome = snapshot.pick === game.home_team
      ? Number(game.home_score) > Number(game.away_score)
      : Number(game.away_score) > Number(game.home_score);
    rows.push({
      gameId: game.id,
      commenceTime: game.commence_time,
      snapshotId: snapshot.id,
      capturedAt: snapshot.captured_at,
      mandatoryComplete: Boolean(snapshot.mandatory_complete),
      gateStatus: snapshot.gate_status,
      candidateStatus: snapshot.candidate_status,
      pick: snapshot.pick,
      marketProb: Number(snapshot.market_prob),
      modelProb: Number(snapshot.model_prob),
      outcome: outcome ? 1 : 0,
    });
  }

  return {
    mode: 'strict_point_in_time',
    warning: '此報告僅衡量已保存的賽前快照；資料不足場次被排除，不能作為盈利證據。',
    window: { from: from || null, to: to || null },
    gamesCompleted: games.length,
    rowsUsed: rows.length,
    excluded,
    modelMetrics: binaryMetrics(rows.map((row) => ({ p: row.modelProb, y: row.outcome }))),
    marketMetrics: binaryMetrics(rows.map((row) => ({ p: row.marketProb, y: row.outcome }))),
    rows,
  };
}

