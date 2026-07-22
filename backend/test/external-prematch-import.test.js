import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import db from '../src/db/database.js';
import {
  getExternalLineupEvidence,
  getExternalPrematchPayloads,
  importCollectorPrematchSnapshots,
} from '../src/services/ExternalPrematchSnapshotService.js';

test('只匯入帶完整審計資料且早於開賽的 lineup 快照', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-import-'));
  const filePath = path.join(tempDir, 'prematch.json');
  const source = 'test-sofascore';
  const eventId = 'test-event-15506787';
  const gameId = 'test-odds-game';
  fs.writeFileSync(filePath, JSON.stringify([
    {
      payloadId: 901,
      sourceEventId: eventId,
      endpointKind: 'lineups',
      capturedAt: '2026-07-20T06:00:00Z',
      commenceAt: '2026-07-20T07:20:00Z',
      sourceUrl: 'https://www.sofascore.com/api/v1/event/test/lineups',
      payloadSha256: 'a'.repeat(64),
      parserVersion: 'sofascore-v1',
      payload: { home: { players: [] }, away: { players: [] } },
    },
    {
      payloadId: 902,
      sourceEventId: eventId,
      endpointKind: 'top-performers',
      capturedAt: '2026-07-20T06:00:00Z',
      commenceAt: '2026-07-20T07:20:00Z',
      sourceUrl: 'https://www.sofascore.com/api/v1/event/test/top-performers',
      payloadSha256: 'b'.repeat(64),
      parserVersion: 'sofascore-v1',
      payload: {},
    },
  ]));

  try {
    const result = importCollectorPrematchSnapshots(filePath, source, gameId);
    assert.equal(result.imported, 1);
    assert.deepEqual(result.rejected, [{ index: 1, reason: 'endpoint_not_allowed_for_prematch' }]);
    assert.equal(getExternalPrematchPayloads(eventId, source).length, 1);
    assert.equal(getExternalLineupEvidence(gameId, source).sourceEventId, eventId);
  } finally {
    db.prepare('DELETE FROM external_prematch_payloads WHERE source = ?').run(source);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
