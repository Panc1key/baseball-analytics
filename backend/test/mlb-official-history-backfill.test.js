import test from 'node:test';
import assert from 'node:assert/strict';

import { officialScheduleGameRow } from '../src/services/MlbOfficialHistoryBackfill.js';

test('官方歷史回填只接受例行賽完賽且非和局場次', () => {
  const row = officialScheduleGameRow({
    gamePk: 123,
    gameType: 'R',
    officialDate: '2025-07-01',
    gameDate: '2025-07-01T23:05:00Z',
    status: { abstractGameState: 'Final' },
    teams: {
      home: { score: 5, team: { name: 'Home Team' } },
      away: { score: 3, team: { name: 'Away Team' } },
    },
  });

  assert.deepEqual(row, {
    id: 'mlb-official-123',
    league: 'MLB',
    commenceTime: '2025-07-01T23:05:00Z',
    officialDate: '2025-07-01',
    homeTeam: 'Home Team',
    awayTeam: 'Away Team',
    homeScore: 5,
    awayScore: 3,
    status: 'completed',
  });
  assert.equal(officialScheduleGameRow({
    gamePk: 124,
    gameType: 'S',
    gameDate: '2025-03-01T18:00:00Z',
    status: { abstractGameState: 'Final' },
    teams: {
      home: { score: 1, team: { name: 'Home Team' } },
      away: { score: 0, team: { name: 'Away Team' } },
    },
  }), null);
});
