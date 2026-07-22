/**
 * MLB probable starter 的嚴格賽前身份帳。
 *
 * 只保存 capturedAt < commenceTime 的官方賽程快照。賽後 boxscore 的實際
 * 先發不得透過本 service 寫入，以避免歷史訓練使用事後身份。
 */
import db from '../db/database.js';

function validTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}

function normalizePitcher(pitcher) {
  const id = Number(pitcher?.id);
  const name = String(pitcher?.name || pitcher?.fullName || '').trim();
  if (!Number.isFinite(id) || !name) return null;
  return { id, name };
}

export function recordMlbProbableStarterSnapshot({
  gameId,
  officialGamePk = null,
  commenceTime,
  capturedAt,
  pitchers,
  source = 'mlb_stats_api_schedule',
}) {
  const captured = validTime(capturedAt);
  const commence = validTime(commenceTime);
  if (!gameId || captured == null || commence == null) {
    return { ok: false, reason: 'starter_snapshot_required_field_missing' };
  }
  if (captured >= commence) {
    return { ok: false, reason: 'starter_snapshot_not_prematch' };
  }
  const home = normalizePitcher(pitchers?.home);
  const away = normalizePitcher(pitchers?.away);
  if (!home && !away) {
    return { ok: false, reason: 'starter_snapshot_pitchers_missing' };
  }
  const status = home && away ? 'complete' : 'partial';
  const result = db.prepare(`
    INSERT OR IGNORE INTO mlb_probable_starter_snapshots
      (game_id, official_game_pk, commence_time, captured_at, source, status,
       home_pitcher_id, home_pitcher_name, away_pitcher_id, away_pitcher_name,
       payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    gameId,
    Number.isFinite(Number(officialGamePk)) ? Number(officialGamePk) : null,
    commenceTime,
    capturedAt,
    source,
    status,
    home?.id ?? null,
    home?.name ?? null,
    away?.id ?? null,
    away?.name ?? null,
    JSON.stringify({ confirmationLevel: 'probable', home, away })
  );
  return {
    ok: true,
    inserted: result.changes === 1,
    status,
    home,
    away,
  };
}

export function resolveMlbProbableStarterSnapshot(gameId, commenceTime) {
  const row = db.prepare(`
    SELECT *
    FROM mlb_probable_starter_snapshots
    WHERE game_id = ?
      AND datetime(captured_at) < datetime(?)
      AND datetime(captured_at) < datetime(commence_time)
    ORDER BY datetime(captured_at) DESC, id DESC
    LIMIT 1
  `).get(gameId, commenceTime);
  if (!row) return { ok: false, reason: 'pregame_probable_starter_snapshot_missing' };
  return {
    ok: true,
    snapshotId: row.id,
    gameId: row.game_id,
    officialGamePk: row.official_game_pk,
    commenceTime: row.commence_time,
    capturedAt: row.captured_at,
    source: row.source,
    status: row.status,
    home: row.home_pitcher_id
      ? { id: row.home_pitcher_id, name: row.home_pitcher_name }
      : null,
    away: row.away_pitcher_id
      ? { id: row.away_pitcher_id, name: row.away_pitcher_name }
      : null,
  };
}

export function backfillMlbProbableStarterSnapshotsFromTruth() {
  const rows = db.prepare(`
    SELECT game_id, commence_time, captured_at, evidence_json
    FROM mlb_prematch_truth_snapshots
    WHERE datetime(captured_at) < datetime(commence_time)
    ORDER BY datetime(captured_at), id
  `).all();
  let inserted = 0;
  let rejected = 0;
  for (const row of rows) {
    try {
      const evidence = JSON.parse(row.evidence_json || '[]');
      const starter = evidence.find((item) =>
        item.key === 'starting_pitchers' &&
        item.values?.confirmationLevel === 'probable'
      );
      const fixture = evidence.find((item) => item.key === 'fixture');
      const result = recordMlbProbableStarterSnapshot({
        gameId: row.game_id,
        officialGamePk: fixture?.values?.gamePk ?? null,
        commenceTime: row.commence_time,
        capturedAt: starter?.capturedAt || row.captured_at,
        pitchers: {
          home: starter?.values?.home,
          away: starter?.values?.away,
        },
        source: 'mlb_truth_snapshot_backfill',
      });
      if (result.ok && result.inserted) inserted += 1;
      else if (!result.ok) rejected += 1;
    } catch {
      rejected += 1;
    }
  }
  return { scanned: rows.length, inserted, rejected };
}

export function getMlbProbableStarterCoverage() {
  const result = db.prepare(`
    SELECT
      COUNT(*) AS snapshots,
      COUNT(DISTINCT game_id) AS games,
      SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completeSnapshots,
      MIN(captured_at) AS fromCapturedAt,
      MAX(captured_at) AS toCapturedAt
    FROM mlb_probable_starter_snapshots
    WHERE datetime(captured_at) < datetime(commence_time)
  `).get();
  return {
    snapshots: Number(result.snapshots || 0),
    games: Number(result.games || 0),
    completeSnapshots: Number(result.completeSnapshots || 0),
    fromCapturedAt: result.fromCapturedAt ?? null,
    toCapturedAt: result.toCapturedAt ?? null,
  };
}
