import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMlbExpectedRunsExamples,
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
  fitMlbExpectedRunsModel,
  MLB_EXPECTED_RUNS_FALLBACK_FEATURE_KEYS,
  MLB_EXPECTED_RUNS_FEATURE_KEYS,
  negativeBinomialPmf,
  predictMlbExpectedRunsMean,
  shrinkRate,
} from '../src/services/MlbExpectedRunsModel.js';

test('MLB 預期得分 v2 使用固定且不含市場的特徵契約', () => {
  assert.equal(MLB_EXPECTED_RUNS_FEATURE_KEYS.length, 17);
  assert.ok(!MLB_EXPECTED_RUNS_FEATURE_KEYS.some((key) =>
    /odds|market|price/i.test(key)
  ));
  assert.ok(!MLB_EXPECTED_RUNS_FALLBACK_FEATURE_KEYS.some((key) =>
    /starter|pitcher/i.test(key)
  ));
});

test('極端小樣本投手數據必須向聯盟均值收縮', () => {
  const shrunkEra = shrinkRate(67.5, 2 / 3, 4.3, 30);
  assert.ok(shrunkEra < 6);
  assert.ok(shrunkEra > 4.3);
  assert.equal(shrinkRate(67.5, 0, 4.3, 30), 4.3);
});

test('負二項機率與聯合比分分布正規化', () => {
  const marginalMass = Array.from({ length: 60 }, (_, runs) =>
    negativeBinomialPmf(runs, 4.5, 6)
  ).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(marginalMass - 1) < 1e-6);

  const distribution = buildMlbScoreDistribution({
    homeMean: 4.8,
    awayMean: 3.9,
    homeDispersion: 6,
    awayDispersion: 6,
  });
  const jointMass = distribution.reduce((sum, cell) => sum + cell.probability, 0);
  assert.ok(Math.abs(jointMass - 1) < 1e-9);
});

test('同一比分分布推導獨贏、讓分與大小球', () => {
  const distribution = buildMlbScoreDistribution({
    homeMean: 5.2,
    awayMean: 3.4,
    homeDispersion: 8,
    awayDispersion: 8,
  });
  const markets = deriveMlbScoreMarkets(distribution, {
    totalLine: 8.5,
    homeSpread: -1.5,
  });
  assert.ok(markets.homeWinProbability > 0.6);
  assert.ok(markets.homeSpread.coverProbability > 0.45);
  assert.ok(markets.total.overProbability > 0.4);
  assert.ok(Math.abs(
    markets.homeWinProbability + markets.awayWinProbability - 1
  ) < 1e-9);
});

test('Poisson 均值回歸能學到進攻得分方向', () => {
  const examples = Array.from({ length: 300 }, (_, index) => {
    const offense = 2.5 + (index % 10) * 0.4;
    const vector = Object.fromEntries(
      MLB_EXPECTED_RUNS_FEATURE_KEYS.map((key) => [key, 0])
    );
    vector.offenseRecentRpg = offense;
    vector.opponentRecentRaRpg = 4.4;
    vector.opponentStarterEra = 4.3;
    vector.opponentStarterWhip = 1.3;
    vector.opponentStarterKMinusBb9 = 5.5;
    vector.opponentStarterRecentEra = 4.3;
    vector.opponentStarterRestDays = 4;
    vector.opponentStarterRecentPitches = 90;
    vector.opponentBullpenEra = 4.3;
    vector.opponentBullpenWhip = 1.3;
    return {
      vector,
      targetRuns: Math.max(0, Math.round(offense + ((index % 3) - 1))),
    };
  });
  const model = fitMlbExpectedRunsModel(examples, { epochs: 500 });
  assert.ok(
    predictMlbExpectedRunsMean(model, examples.at(-1).vector) >
    predictMlbExpectedRunsMean(model, examples[0].vector)
  );
});

test('歷史比賽拆成主客兩筆得分訓練資料', () => {
  const rows = [{
    gameId: 'g1',
    commenceTime: '2026-04-01T00:00:00Z',
    homeScore: 6,
    awayScore: 3,
    features: {
      home: { recentGames: 10, recentRunsPerGame: 5, recentRunsAllowedPerGame: 4 },
      away: { recentGames: 10, recentRunsPerGame: 4, recentRunsAllowedPerGame: 5 },
      pitchers: {},
      recentBoxscore: {},
    },
  }];
  const examples = buildMlbExpectedRunsExamples(rows);
  assert.equal(examples.length, 2);
  assert.equal(examples[0].targetRuns, 6);
  assert.equal(examples[1].targetRuns, 3);
  assert.equal(examples[0].vector.isHome, 1);
  assert.equal(examples[1].vector.isHome, 0);
});
