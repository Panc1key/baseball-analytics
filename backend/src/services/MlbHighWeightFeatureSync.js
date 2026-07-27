/**
 * 高權重特徵同步：PIT 先發身份 → historical feature rows。
 *
 * 不做天氣／風向幾何。只保證：
 * 1) 有 complete probable snapshot 的場次，feature row 使用同一身份
 * 2) 投手能力與 live 共用 gameLog 聚合
 * 3) 持久化 venueName / homeTeam，消除 parkFactor 解析 skew
 */
import db from '../db/database.js';
import { resolveMlbVenueName } from '../data/venueMeta.js';
import { MLB_BASELINE_FEATURE_VERSION } from './MlbHistoricalBaseline.js';
import { resolveMlbProbableStarterSnapshot } from './MlbProbableStarterService.js';
import {
  getMlbPitcherPregameFeaturesFromGameLog,
  getMlbPitcherRecentStartFeatures,
  getVenueName,
  getMlbScheduleAround,
  matchMlbOfficialGame,
} from './MlbStatsService.js';

function loadFeatureRow(gameId) {
  return db.prepare(`
    SELECT f.game_id AS gameId,
           f.commence_time AS commenceTime,
           f.features_json AS featuresJson,
           g.home_team AS homeTeam,
           g.away_team AS awayTeam,
           g.official_date AS officialDate,
           g.home_score AS homeScore,
           g.away_score AS awayScore
    FROM mlb_historical_feature_rows f
    JOIN games g ON g.id = f.game_id
    WHERE f.game_id = ?
      AND f.feature_version = ?
  `).get(gameId, MLB_BASELINE_FEATURE_VERSION);
}

function persistFeatureJson(gameId, commenceTime, features, homeWin) {
  db.prepare(`
    INSERT INTO mlb_historical_feature_rows
      (game_id, commence_time, feature_version, features_json, home_win)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(game_id) DO UPDATE SET
      commence_time = excluded.commence_time,
      feature_version = excluded.feature_version,
      features_json = excluded.features_json,
      home_win = excluded.home_win,
      created_at = datetime('now')
  `).run(
    gameId,
    commenceTime,
    MLB_BASELINE_FEATURE_VERSION,
    JSON.stringify(features),
    homeWin
  );
}

export function listCompletePitGameIds({ onlyMissingFeatureSync = false } = {}) {
  const rows = db.prepare(`
    SELECT DISTINCT s.game_id AS gameId
    FROM mlb_probable_starter_snapshots s
    WHERE s.status = 'complete'
      AND datetime(s.captured_at) < datetime(s.commence_time)
    ORDER BY s.game_id
  `).all();
  if (!onlyMissingFeatureSync) {
    return rows.map((row) => row.gameId);
  }
  return rows
    .map((row) => row.gameId)
    .filter((gameId) => {
      const feature = loadFeatureRow(gameId);
      if (!feature) return true;
      try {
        const parsed = JSON.parse(feature.featuresJson);
        return parsed?.pitchers?.identityMode !== 'pit_probable';
      } catch {
        return true;
      }
    });
}

export function getHighWeightFeatureCoverage() {
  const featureRows = db.prepare(`
    SELECT f.features_json AS featuresJson,
           substr(f.commence_time, 1, 4) AS season
    FROM mlb_historical_feature_rows f
    WHERE f.feature_version = ?
      AND datetime(f.commence_time) >= datetime('2025-01-01')
  `).all(MLB_BASELINE_FEATURE_VERSION);

  const bySeason = new Map();
  for (const row of featureRows) {
    const season = row.season;
    if (!bySeason.has(season)) {
      bySeason.set(season, {
        season,
        featureRows: 0,
        pitProbableRows: 0,
        oracleRows: 0,
        withVenueName: 0,
        withRecentBoxscore: 0,
      });
    }
    const bucket = bySeason.get(season);
    bucket.featureRows += 1;
    try {
      const features = JSON.parse(row.featuresJson);
      const mode = features?.pitchers?.identityMode;
      if (mode === 'pit_probable') bucket.pitProbableRows += 1;
      else if (mode === 'postgame_actual_oracle') bucket.oracleRows += 1;
      if (features?.venueName) bucket.withVenueName += 1;
      if (features?.recentBoxscore?.home?.batting) bucket.withRecentBoxscore += 1;
    } catch {
      // ignore malformed
    }
  }

  const seasons = [...bySeason.values()].map((bucket) => ({
    ...bucket,
    pitRate: bucket.featureRows
      ? bucket.pitProbableRows / bucket.featureRows
      : 0,
  }));
  const completePitIds = listCompletePitGameIds();
  const needingSync = listCompletePitGameIds({ onlyMissingFeatureSync: true });
  return {
    seasons,
    completePitSnapshots: completePitIds.length,
    featureRowsNeedingPitSync: needingSync.length,
    note:
      '高權重路徑以 batting + park + starter 為主；PIT 先發覆蓋必須反映在 feature rows，不只 snapshots。',
  };
}

async function resolveOfficialMeta(row) {
  if (String(row.gameId).startsWith('mlb-official-')) {
    return {
      gamePk: Number(String(row.gameId).slice('mlb-official-'.length)),
      officialDate: row.officialDate ?? String(row.commenceTime).slice(0, 10),
      venueName: resolveMlbVenueName({ homeTeam: row.homeTeam }),
    };
  }
  try {
    const schedule = await getMlbScheduleAround(row.commenceTime);
    const official = matchMlbOfficialGame({
      home_team: row.homeTeam,
      away_team: row.awayTeam,
      commence_time: row.commenceTime,
    }, schedule);
    return {
      gamePk: official?.gamePk ?? null,
      officialDate: official?.officialDate ?? row.officialDate ??
        String(row.commenceTime).slice(0, 10),
      venueName: getVenueName(official) ||
        resolveMlbVenueName({ homeTeam: row.homeTeam }),
    };
  } catch {
    return {
      gamePk: null,
      officialDate: row.officialDate ?? String(row.commenceTime).slice(0, 10),
      venueName: resolveMlbVenueName({ homeTeam: row.homeTeam }),
    };
  }
}

/**
 * 將 complete PIT snapshot 同步進既有 historical feature rows。
 * 只重寫 pitchers / venue 身分欄位，不重算整季 batting 歷史。
 */
export async function syncPitProbableIntoFeatureRows({
  gameIds = null,
  concurrency = 4,
} = {}) {
  const targets = gameIds?.length
    ? gameIds
    : listCompletePitGameIds({ onlyMissingFeatureSync: true });
  let updated = 0;
  let skipped = 0;
  let missingFeatureRow = 0;
  let failed = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      const gameId = targets[index];
      try {
        const row = loadFeatureRow(gameId);
        if (!row) {
          missingFeatureRow += 1;
          continue;
        }
        const snapshot = resolveMlbProbableStarterSnapshot(
          gameId,
          row.commenceTime
        );
        if (!snapshot.ok || snapshot.status !== 'complete') {
          skipped += 1;
          continue;
        }
        const features = JSON.parse(row.featuresJson);
        if (features?.pitchers?.identityMode === 'pit_probable' &&
          features?.pitchers?.identitySnapshotId === snapshot.snapshotId &&
          features?.venueName) {
          skipped += 1;
          continue;
        }
        const official = await resolveOfficialMeta(row);
        const pitOptions = {
          cutoffDate: official.officialDate,
          excludeGamePk: official.gamePk,
        };
        const [homePitcher, awayPitcher, homeRecent, awayRecent] = await Promise.all([
          getMlbPitcherPregameFeaturesFromGameLog(
            snapshot.home.id,
            row.commenceTime,
            pitOptions
          ),
          getMlbPitcherPregameFeaturesFromGameLog(
            snapshot.away.id,
            row.commenceTime,
            pitOptions
          ),
          getMlbPitcherRecentStartFeatures(
            snapshot.home.id,
            row.commenceTime,
            pitOptions
          ),
          getMlbPitcherRecentStartFeatures(
            snapshot.away.id,
            row.commenceTime,
            pitOptions
          ),
        ]);
        features.homeTeam = row.homeTeam;
        features.awayTeam = row.awayTeam;
        features.venueName = official.venueName ||
          resolveMlbVenueName({ homeTeam: row.homeTeam });
        features.pitchers = {
          source:
            'MLB Stats API schedule probable starter snapshot; strict pregame identity',
          identityMode: 'pit_probable',
          identitySnapshotId: snapshot.snapshotId,
          homeIdentity: {
            id: snapshot.home.id,
            name: snapshot.home.name,
          },
          awayIdentity: {
            id: snapshot.away.id,
            name: snapshot.away.name,
          },
          home: homePitcher,
          away: awayPitcher,
          homeRecent,
          awayRecent,
        };
        const homeWin = Number(row.homeScore) > Number(row.awayScore) ? 1 : 0;
        persistFeatureJson(gameId, row.commenceTime, features, homeWin);
        updated += 1;
      } catch {
        failed += 1;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(1, targets.length)) },
      () => worker()
    )
  );

  return {
    targets: targets.length,
    updated,
    skipped,
    missingFeatureRow,
    failed,
    coverage: getHighWeightFeatureCoverage(),
  };
}

/**
 * 為尚無 venueName 的 feature rows 補上主場場地名稱（parkFactor 高權重路徑）。
 */
export function backfillVenueNameOnFeatureRows({ limit = 0 } = {}) {
  const rows = db.prepare(`
    SELECT f.game_id AS gameId,
           f.commence_time AS commenceTime,
           f.features_json AS featuresJson,
           f.home_win AS homeWin,
           g.home_team AS homeTeam,
           g.away_team AS awayTeam
    FROM mlb_historical_feature_rows f
    JOIN games g ON g.id = f.game_id
    WHERE f.feature_version = ?
      AND datetime(f.commence_time) >= datetime('2025-01-01')
  `).all(MLB_BASELINE_FEATURE_VERSION);

  let updated = 0;
  let scanned = 0;
  for (const row of rows) {
    scanned += 1;
    if (limit > 0 && updated >= limit) break;
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    if (features.venueName && features.homeTeam) continue;
    features.homeTeam = row.homeTeam;
    features.awayTeam = row.awayTeam;
    features.venueName = resolveMlbVenueName({ homeTeam: row.homeTeam });
    persistFeatureJson(row.gameId, row.commenceTime, features, row.homeWin);
    updated += 1;
  }
  return { scanned, updated };
}

/**
 * 舊 feature rows 若有投手但無 identityMode，標記為 oracle，避免覆蓋率把「未知」當 PIT。
 */
export function labelLegacyOracleStarterIdentity({ limit = 0 } = {}) {
  const rows = db.prepare(`
    SELECT f.game_id AS gameId,
           f.commence_time AS commenceTime,
           f.features_json AS featuresJson,
           f.home_win AS homeWin
    FROM mlb_historical_feature_rows f
    WHERE f.feature_version = ?
      AND datetime(f.commence_time) >= datetime('2025-01-01')
  `).all(MLB_BASELINE_FEATURE_VERSION);

  let updated = 0;
  let scanned = 0;
  for (const row of rows) {
    scanned += 1;
    if (limit > 0 && updated >= limit) break;
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    if (features?.pitchers?.identityMode) continue;
    if (!features?.pitchers?.home && !features?.pitchers?.away) continue;
    features.pitchers = {
      ...features.pitchers,
      identityMode: 'postgame_actual_oracle',
      source: features.pitchers.source ||
        'MLB Stats API postmatch boxscore actual starter; oracle identity only',
    };
    persistFeatureJson(row.gameId, row.commenceTime, features, row.homeWin);
    updated += 1;
  }
  return { scanned, updated };
}
