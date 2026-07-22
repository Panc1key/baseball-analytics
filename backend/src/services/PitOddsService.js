/**
 * 賽前賠率唯一讀取契約。
 *
 * games.raw_odds 只是可變快取，禁止用於歷史回放或可審計研究。
 * 任何 PIT 分析只能使用 odds_snapshots 中 captured_at < commence_time 的快照。
 */
import db from '../db/database.js';

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isoTime(value) {
  const raw = String(value || '');
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/**
 * 取開賽前最後一筆有效賠率快照。
 * 無合格快照時明確失敗，絕不 fallback 到 games.raw_odds。
 */
export function resolvePitOdds(gameId, commenceTime) {
  const commenceAt = isoTime(commenceTime);
  if (!gameId || !commenceAt) {
    return {
      ok: false,
      reason: 'invalid_game_or_commence_time',
      gameId: gameId || null,
      commenceAt,
    };
  }

  const snapshots = db.prepare(`
    SELECT id, game_id, league, captured_at, bookmakers_json, source
    FROM odds_snapshots
    WHERE game_id = ?
      AND datetime(captured_at) < datetime(?)
      AND source NOT LIKE '%_post_start'
    ORDER BY datetime(captured_at) DESC, id DESC
  `).all(gameId, commenceAt);

  for (const snapshot of snapshots) {
    const capturedAt = isoTime(snapshot.captured_at);
    if (!capturedAt || Date.parse(capturedAt) >= Date.parse(commenceAt)) continue;
    const bookmakers = parseJsonArray(snapshot.bookmakers_json);
    if (!bookmakers.length) continue;
    return {
      ok: true,
      snapshotId: snapshot.id,
      gameId: snapshot.game_id,
      league: snapshot.league,
      capturedAt,
      commenceAt,
      source: snapshot.source,
      selectionPolicy: 'last_before_commence',
      bookmakers,
    };
  }

  return {
    ok: false,
    reason: 'no_pit_odds_snapshot',
    gameId,
    commenceAt,
  };
}

/**
 * 寫入賠率快照；是否屬於 PIT 由實際 capturedAt 與 commenceTime 決定。
 * post-start 資料可留作對帳，但永遠不會被 resolvePitOdds 選中。
 */
export function recordOddsSnapshot({
  gameId,
  league,
  commenceTime,
  capturedAt = new Date().toISOString(),
  bookmakers,
  source = 'odds_api',
}) {
  const commenceAt = isoTime(commenceTime);
  const capturedIso = isoTime(capturedAt);
  if (!gameId || !league || !commenceAt || !capturedIso || !Array.isArray(bookmakers)) {
    throw new Error('invalid_odds_snapshot');
  }
  const isPrematch = Date.parse(capturedIso) < Date.parse(commenceAt);
  const normalizedSource = isPrematch
    ? source
    : String(source).endsWith('_post_start')
      ? source
      : `${source}_post_start`;
  const result = db.prepare(`
    INSERT OR IGNORE INTO odds_snapshots
      (game_id, league, captured_at, bookmakers_json, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    gameId,
    league,
    capturedIso,
    JSON.stringify(bookmakers),
    normalizedSource
  );
  return {
    inserted: result.changes > 0,
    isPrematch,
    source: normalizedSource,
    capturedAt: capturedIso,
    commenceAt,
  };
}
