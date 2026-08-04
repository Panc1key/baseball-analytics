/**
 * 亞聯先發快照（研究）
 * 不進正式推薦 / Locked B。
 */
import db from '../db/database.js';

function validTime(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : null;
}

export function asianPitcherKey({ league, id, name }) {
  if (id != null && Number.isFinite(Number(id))) return `${league}:${Number(id)}`;
  const n = String(name || '')
    .trim()
    .replace(/\s+/g, '');
  if (!n) return null;
  return `${league}:name:${n}`;
}

/**
 * @param {object} row
 */
export function recordAsianStarterSnapshot({
  league,
  gameId,
  commenceTime,
  capturedAt,
  source,
  captureKind,
  home = null,
  away = null,
  homeStats = null,
  awayStats = null,
  statsAsofKind = null,
  allowPostStart = false,
}) {
  if (!['NPB', 'KBO'].includes(league)) {
    return { ok: false, reason: 'invalid_league' };
  }
  const captured = validTime(capturedAt);
  const commence = validTime(commenceTime);
  if (!gameId || captured == null || commence == null) {
    return { ok: false, reason: 'required_field_missing' };
  }
  if (!allowPostStart && captured >= commence) {
    return { ok: false, reason: 'not_prematch' };
  }
  const homeKey = home
    ? asianPitcherKey({ league, id: home.id, name: home.name })
    : null;
  const awayKey = away
    ? asianPitcherKey({ league, id: away.id, name: away.name })
    : null;
  if (!homeKey && !awayKey) return { ok: false, reason: 'pitchers_missing' };

  const status = homeKey && awayKey ? 'complete' : 'partial';
  const payload = {
    home,
    away,
    homeStats,
    awayStats,
    captureKind,
    statsAsofKind,
  };
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO asian_probable_starter_snapshots
        (league, game_id, commence_time, captured_at, source, capture_kind, status,
         home_pitcher_key, home_pitcher_id, home_pitcher_name,
         away_pitcher_key, away_pitcher_id, away_pitcher_name,
         home_era, home_whip, away_era, away_whip, stats_asof_kind, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      league,
      gameId,
      commenceTime,
      capturedAt,
      source,
      captureKind,
      status,
      homeKey,
      home?.id != null ? Number(home.id) : null,
      home?.name || null,
      awayKey,
      away?.id != null ? Number(away.id) : null,
      away?.name || null,
      homeStats?.era ?? null,
      homeStats?.whip ?? null,
      awayStats?.era ?? null,
      awayStats?.whip ?? null,
      statsAsofKind,
      JSON.stringify(payload)
    );
  return { ok: true, inserted: result.changes === 1, status, homeKey, awayKey };
}

function mapRow(row) {
  if (!row) return null;
  return {
    snapshotId: row.id,
    league: row.league,
    gameId: row.game_id,
    commenceTime: row.commence_time,
    capturedAt: row.captured_at,
    source: row.source,
    captureKind: row.capture_kind,
    status: row.status,
    statsAsofKind: row.stats_asof_kind,
    home: row.home_pitcher_key
      ? {
          key: row.home_pitcher_key,
          id: row.home_pitcher_id,
          name: row.home_pitcher_name,
          era: row.home_era,
          whip: row.home_whip,
        }
      : null,
    away: row.away_pitcher_key
      ? {
          key: row.away_pitcher_key,
          id: row.away_pitcher_id,
          name: row.away_pitcher_name,
          era: row.away_era,
          whip: row.away_whip,
        }
      : null,
  };
}

/** 取該場最新一筆快照（研究回放可含 historical） */
export function resolveAsianStarterSnapshot(league, gameId, { preferComplete = true } = {}) {
  if (preferComplete) {
    const complete = db
      .prepare(
        `SELECT * FROM asian_probable_starter_snapshots
         WHERE league = ? AND game_id = ? AND status = 'complete'
         ORDER BY datetime(captured_at) DESC, id DESC LIMIT 1`
      )
      .get(league, gameId);
    if (complete) return mapRow(complete);
  }
  const any = db
    .prepare(
      `SELECT * FROM asian_probable_starter_snapshots
       WHERE league = ? AND game_id = ?
       ORDER BY datetime(captured_at) DESC, id DESC LIMIT 1`
    )
    .get(league, gameId);
  return mapRow(any);
}

export function loadAsianStarterSnapshotMap(league) {
  const rows = db
    .prepare(
      `SELECT * FROM asian_probable_starter_snapshots
       WHERE league = ?
       ORDER BY datetime(captured_at) ASC, id ASC`
    )
    .all(league);
  const byGame = new Map();
  const sourceRank = (src) => {
    if (String(src || '').includes('stats_first_pitcher')) return 3;
    if (String(src || '').includes('GetKboGameList')) return 2;
    if (String(src || '').includes('senpatsu')) return 1;
    return 0;
  };
  for (const row of rows) {
    const mapped = mapRow(row);
    const prev = byGame.get(row.game_id);
    if (!prev) {
      byGame.set(row.game_id, mapped);
      continue;
    }
    if (prev.status !== 'complete' && mapped.status === 'complete') {
      byGame.set(row.game_id, mapped);
      continue;
    }
    if (prev.status === 'complete' && mapped.status !== 'complete') continue;
    if (sourceRank(mapped.source) >= sourceRank(prev.source)) {
      byGame.set(row.game_id, mapped);
    }
  }
  return byGame;
}

/**
 * 滾動先發特徵（PIT）：只用開賽前該投手已出現過的場次
 * hist: Map<pitcherKey, { commence, runsAllowed }[]>
 */
export function summarizePitcherHistory(histEntries, asOfCommence) {
  const cut = Date.parse(asOfCommence);
  const prior = (histEntries || []).filter((e) => Date.parse(e.commence) < cut);
  if (!prior.length) {
    return {
      starts: 0,
      restDays: 5,
      raRpg: 4.5,
      known: 0,
    };
  }
  const last = prior[prior.length - 1];
  const restDays = Math.max(
    0,
    Math.min(10, (cut - Date.parse(last.commence)) / (24 * 3600 * 1000))
  );
  const ra = prior.reduce((s, e) => s + e.runsAllowed, 0) / prior.length;
  return {
    starts: prior.length,
    restDays,
    raRpg: ra,
    known: 1,
  };
}

export function appendPitcherHistory(histMap, pitcherKey, commence, runsAllowed) {
  if (!pitcherKey) return;
  if (!histMap.has(pitcherKey)) histMap.set(pitcherKey, []);
  histMap.get(pitcherKey).push({ commence, runsAllowed: Number(runsAllowed) || 0 });
}
