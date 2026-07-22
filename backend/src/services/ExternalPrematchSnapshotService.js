/**
 * Python collector 的單向匯入邊界。
 *
 * 本 service 不解析或信任任意賽後資料：只有 collector 已分類為 prematch，
 * 且 capturedAt 嚴格早於 commenceAt 的快照能進入分析資料庫。
 */
import fs from 'fs';
import path from 'path';
import db from '../db/database.js';

function validIso(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}

function validateSnapshot(item) {
  if (!item || typeof item !== 'object') return 'snapshot_not_object';
  if (!item.endpointKind || !item.capturedAt || !item.commenceAt || !item.payload) {
    return 'required_field_missing';
  }
  const captured = validIso(item.capturedAt);
  const commence = validIso(item.commenceAt);
  if (captured == null || commence == null) return 'invalid_timestamp';
  if (captured >= commence) return 'not_prematch_timestamp';
  if (item.endpointKind !== 'lineups') return 'endpoint_not_allowed_for_prematch';
  if (!item.payloadSha256 || !item.sourceUrl || item.payloadId == null) return 'audit_metadata_missing';
  return null;
}

export function importCollectorPrematchSnapshots(filePath, source = 'sofascore', gameId = null) {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`找不到 collector 匯出檔：${absolutePath}`);
  const parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('collector 匯出格式必須為 JSON 陣列');

  const insert = db.prepare(`
    INSERT OR IGNORE INTO external_prematch_payloads
      (source, source_event_id, game_id, collector_payload_id, endpoint_kind, captured_at,
       commence_at, source_url, payload_sha256, parser_version, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rejected = [];
  let imported = 0;
  const transaction = db.transaction(() => {
    for (const [index, item] of parsed.entries()) {
      const reason = validateSnapshot(item);
      if (reason) {
        rejected.push({ index, reason });
        continue;
      }
      const result = insert.run(
        source,
        String(item.sourceEventId || item.eventId || 'unknown'),
        gameId,
        Number(item.payloadId),
        item.endpointKind,
        item.capturedAt,
        item.commenceAt,
        item.sourceUrl,
        item.payloadSha256,
        item.parserVersion,
        JSON.stringify(item.payload)
      );
      imported += result.changes;
    }
  });
  transaction();
  return { source, gameId, filePath: absolutePath, total: parsed.length, imported, rejected };
}

export function getExternalPrematchPayloads(sourceEventId, source = 'sofascore') {
  return db.prepare(`
    SELECT source, source_event_id, collector_payload_id, endpoint_kind, captured_at,
           commence_at, source_url, payload_sha256, parser_version, imported_at
    FROM external_prematch_payloads
    WHERE source = ? AND source_event_id = ?
    ORDER BY datetime(captured_at) DESC
  `).all(source, String(sourceEventId));
}

/** 提供新 MLB 真實資料管線使用；回傳最近一筆已審核的賽前打線快照。 */
export function getExternalLineupEvidence(gameId, source = 'sofascore') {
  const row = db.prepare(`
    SELECT source_event_id, captured_at, commence_at, source_url, payload_sha256,
           parser_version, payload_json
    FROM external_prematch_payloads
    WHERE source = ?
      AND game_id = ?
      AND endpoint_kind = 'lineups'
      AND datetime(captured_at) < datetime(commence_at)
    ORDER BY datetime(captured_at) DESC
    LIMIT 1
  `).get(source, gameId);
  if (!row) return null;
  return {
    sourceEventId: row.source_event_id,
    capturedAt: row.captured_at,
    commenceAt: row.commence_at,
    sourceUrl: row.source_url,
    payloadSha256: row.payload_sha256,
    parserVersion: row.parser_version,
    payload: JSON.parse(row.payload_json),
  };
}
