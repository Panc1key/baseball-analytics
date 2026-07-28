import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachDailyResearchRanks,
  selectExpectedRunsResearchDirection,
  selectResearchDirection,
  runMlbDailyTopWalkForward,
} from '../src/services/MlbResearchRanker.js';
import { fitMlbBaseline } from '../src/services/MlbHistoricalBaseline.js';

test('舊版研究方向必須選正 edge 最大邊，不可用模型>50%', () => {
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

test('預期得分研究方向使用勝率分類，不再用 edge 選邊', () => {
  const direction = selectExpectedRunsResearchDirection({
    homeTeam: 'Home',
    awayTeam: 'Away',
    classification: {
      side: 'home',
      modelProbability: 0.58,
      marketProbability: 0.52,
      odds: 1.85,
      edge: 0.06,
      expectedValue: 0.073,
      expectedRunMargin: 0.8,
      tier: 'recommendation',
      reasons: [],
    },
    market: {
      homeProb: 0.52,
      awayProb: 0.48,
      homeOdds: 1.85,
      awayOdds: 2.05,
      bookmaker: 'Test',
    },
  });
  assert.equal(direction.pick, 'Home');
  assert.equal(direction.tier, 'recommendation');
  assert.equal(direction.expectedRunMargin, 0.8);
});

test('每日嚴格方向才進 Top；價值觀察與無訊號不湊數', () => {
  const ranked = attachDailyResearchRanks([
    {
      gameId: 'a',
      commenceTime: '2026-07-20T04:00:00.000Z',
      expectedRuns: {
        moneylineClassification: {
          tier: 'value_watch',
          modelProbability: 0.51,
          expectedRunMargin: 0.1,
          expectedValue: 0.2,
        },
      },
    },
    {
      gameId: 'b',
      commenceTime: '2026-07-20T07:00:00.000Z',
      expectedRuns: {
        moneylineClassification: {
          tier: 'recommendation',
          modelProbability: 0.61,
          expectedRunMargin: 1.2,
          expectedValue: 0.08,
        },
      },
    },
    {
      gameId: 'c',
      commenceTime: '2026-07-20T10:00:00.000Z',
      expectedRuns: {
        moneylineClassification: {
          tier: 'recommendation',
          modelProbability: 0.57,
          expectedRunMargin: 0.7,
          expectedValue: 0.05,
        },
      },
    },
    {
      gameId: 'd',
      commenceTime: '2026-07-20T12:00:00.000Z',
      expectedRuns: {
        moneylineClassification: {
          tier: 'blocked',
          modelProbability: 0.53,
          expectedRunMargin: 0.2,
          expectedValue: -0.01,
        },
      },
    },
  ]);
  assert.equal(ranked.find((row) => row.gameId === 'b').dailyRank, 1);
  assert.equal(ranked.find((row) => row.gameId === 'b').researchTier, 'top1_observation');
  assert.equal(ranked.find((row) => row.gameId === 'c').dailyRank, 2);
  assert.equal(ranked.find((row) => row.gameId === 'c').researchTier, 'top3_observation');
  assert.equal(ranked.find((row) => row.gameId === 'a').dailyRank, null);
  assert.equal(ranked.find((row) => row.gameId === 'a').researchTier, 'value_watch');
  assert.equal(ranked.find((row) => row.gameId === 'd').researchTier, 'blocked');
});

test('日內 Top 對高 EV 毒區罰分後改由較健康 EV 領先', () => {
  const ranked = attachDailyResearchRanks([
    {
      gameId: 'toxic',
      commenceTime: '2026-07-21T04:00:00.000Z',
      expectedRuns: {
        moneylineClassification: {
          tier: 'recommendation',
          modelProbability: 0.545,
          expectedRunMargin: 0.6,
          expectedValue: 0.16,
        },
      },
    },
    {
      gameId: 'healthy',
      commenceTime: '2026-07-21T07:00:00.000Z',
      expectedRuns: {
        moneylineClassification: {
          tier: 'recommendation',
          modelProbability: 0.55,
          expectedRunMargin: 0.4,
          expectedValue: 0.08,
        },
      },
    },
  ]);
  assert.equal(ranked.find((row) => row.gameId === 'healthy').dailyRank, 1);
  assert.equal(ranked.find((row) => row.gameId === 'toxic').dailyRank, 2);
  assert.ok(
    ranked.find((row) => row.gameId === 'healthy').dailyRankScore >
      ranked.find((row) => row.gameId === 'toxic').dailyRankScore
  );
});

test('第3名 margin 低於 dropThirdIfMarginBelow 時當日只取 Top2', () => {
  const rows = [
    {
      gameId: 'r1',
      commenceTime: '2026-07-22T04:00:00.000Z',
      expectedRuns: {
        moneylineClassification: {
          tier: 'recommendation',
          modelProbability: 0.58,
          expectedRunMargin: 0.9,
          expectedValue: 0.1,
          odds: 2.05,
        },
      },
    },
    {
      gameId: 'r2',
      commenceTime: '2026-07-22T07:00:00.000Z',
      expectedRuns: {
        moneylineClassification: {
          tier: 'recommendation',
          modelProbability: 0.56,
          expectedRunMargin: 0.7,
          expectedValue: 0.07,
          odds: 2.1,
        },
      },
    },
    {
      gameId: 'r3',
      commenceTime: '2026-07-22T10:00:00.000Z',
      expectedRuns: {
        moneylineClassification: {
          tier: 'recommendation',
          modelProbability: 0.54,
          expectedRunMargin: 0.3,
          expectedValue: 0.05,
          odds: 2.0,
        },
      },
    },
  ];
  const withDrop = attachDailyResearchRanks(rows, {
    dailyTopK: 3,
    dropThirdIfMarginBelow: 0.5,
    highEvRankPenaltyLambda: 0,
  });
  assert.equal(withDrop.find((r) => r.gameId === 'r1').researchTier, 'top1_observation');
  assert.equal(withDrop.find((r) => r.gameId === 'r2').researchTier, 'top3_observation');
  assert.equal(withDrop.find((r) => r.gameId === 'r3').researchTier, 'strict_observation');
  assert.equal(withDrop.find((r) => r.gameId === 'r3').dailyTopKApplied, 2);

  const noDrop = attachDailyResearchRanks(rows, {
    dailyTopK: 3,
    dropThirdIfMarginBelow: null,
    highEvRankPenaltyLambda: 0,
  });
  assert.equal(noDrop.find((r) => r.gameId === 'r3').researchTier, 'top3_observation');
  assert.equal(noDrop.find((r) => r.gameId === 'r3').dailyTopKApplied, 3);
});

test('第2名賠率落在低賠帶時去掉 R2（可保留 R3）', () => {
  const rows = [
    {
      gameId: 'r1',
      commenceTime: '2026-07-23T04:00:00.000Z',
      expectedRuns: {
        moneylineClassification: {
          tier: 'recommendation',
          modelProbability: 0.58,
          expectedRunMargin: 0.9,
          expectedValue: 0.1,
          odds: 2.1,
        },
      },
    },
    {
      gameId: 'r2',
      commenceTime: '2026-07-23T07:00:00.000Z',
      expectedRuns: {
        moneylineClassification: {
          tier: 'recommendation',
          modelProbability: 0.56,
          expectedRunMargin: 0.7,
          expectedValue: 0.07,
          odds: 1.9,
        },
      },
    },
    {
      gameId: 'r3',
      commenceTime: '2026-07-23T10:00:00.000Z',
      expectedRuns: {
        moneylineClassification: {
          tier: 'recommendation',
          modelProbability: 0.54,
          expectedRunMargin: 0.8,
          expectedValue: 0.05,
          odds: 2.05,
        },
      },
    },
  ];
  const ranked = attachDailyResearchRanks(rows, {
    dailyTopK: 3,
    dropThirdIfMarginBelow: 0.5,
    dropSecondIfOddsBelow: 1.95,
    dropSecondIfOddsMin: 1.85,
    highEvRankPenaltyLambda: 0,
  });
  assert.equal(ranked.find((r) => r.gameId === 'r1').researchTier, 'top1_observation');
  assert.equal(ranked.find((r) => r.gameId === 'r2').researchTier, 'strict_observation');
  assert.equal(ranked.find((r) => r.gameId === 'r3').researchTier, 'top3_observation');
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
