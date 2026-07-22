import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachDailyResearchRanks,
  selectResearchDirection,
  runMlbDailyTopWalkForward,
} from '../src/services/MlbResearchRanker.js';
import { fitMlbBaseline } from '../src/services/MlbHistoricalBaseline.js';

test('研究方向必須選正 edge 最大邊，不可用模型>50%', () => {
  const direction = selectResearchDirection({
    homeTeam: 'Home',
    awayTeam: 'Away',
    homeModelProb: 0.51,
    awayModelProb: 0.49,
    market: {
      homeProb: 0.6,
      awayProb: 0.4,
      homeOdds: 1.67,
      awayOdds: 2.5,
      bookmaker: 'Test',
    },
  });
  assert.equal(direction.pick, 'Away');
  assert.equal(direction.side, 'away');
  assert.ok(Math.abs(direction.edge - 0.09) < 1e-9);
  assert.ok(direction.ev > 0);
});

test('每日研究方向依 edge 標註 Top1/Top3', () => {
  const ranked = attachDailyResearchRanks([
    {
      gameId: 'a',
      commenceTime: '2026-07-20T04:00:00.000Z',
      research: { edge: 0.02 },
    },
    {
      gameId: 'b',
      commenceTime: '2026-07-20T07:00:00.000Z',
      research: { edge: 0.11 },
    },
    {
      gameId: 'c',
      commenceTime: '2026-07-20T10:00:00.000Z',
      research: { edge: 0.05 },
    },
  ]);
  assert.equal(ranked.find((row) => row.gameId === 'b').dailyRank, 1);
  assert.equal(ranked.find((row) => row.gameId === 'b').researchTier, 'top1_observation');
  assert.equal(ranked.find((row) => row.gameId === 'c').researchTier, 'top3_observation');
  assert.equal(ranked.find((row) => row.gameId === 'a').researchTier, 'top3_observation');
});

test('walk-forward 訓練可關閉 holdout', () => {
  const rows = Array.from({ length: 80 }, (_, index) => ({
    gameId: `g${index}`,
    commenceTime: `2026-04-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    homeWin: index % 2,
    features: {
      vector: {
        seasonWinPctDiff: (index % 5) / 10 - 0.2,
        venueRecordDiff: (index % 3) / 10 - 0.1,
        last10WinPctDiff: (index % 4) / 10 - 0.15,
        recentRunsDiff: (index % 6) - 2.5,
        recentRunsAllowedDiff: (index % 7) - 3,
      },
    },
  }));
  const fitted = fitMlbBaseline(rows, { holdout: false, epochs: 50 });
  assert.equal(fitted.train.length, 80);
  assert.equal(fitted.validation.length, 0);
  assert.equal(fitted.test.length, 0);
  assert.ok(fitted.model.featureKeys.length >= 5);
});

test('研究 walk-forward 回傳紙上摘要結構', () => {
  const report = runMlbDailyTopWalkForward({ days: 30, minTrainGames: 60, topN: 3 });
  assert.equal(report.mode, 'research_walk_forward_paper');
  assert.ok(report.summary.top1);
  assert.ok(report.summary.top3);
  assert.ok(report.summary.marketFavoriteTop1);
  assert.ok(report.warning.includes('不構成正式推薦'));
});
