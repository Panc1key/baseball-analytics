import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMlbExpectedRunsExamples,
  buildMlbExpectedRunsSideFeatures,
  buildMlbScoreDistribution,
  calibrateMlbScoreMarkets,
  applyProbabilityTemperature,
  classifyMlbMoneylineCandidate,
  compareMlbMoneylineDailyRank,
  deriveMlbScoreMarkets,
  explainMlbExpectedRunsMean,
  fitMlbExpectedRunsModel,
  MLB_EXPECTED_RUNS_FALLBACK_FEATURE_KEYS,
  MLB_EXPECTED_RUNS_FEATURE_KEYS,
  MLB_MONEYLINE_RECOMMENDATION_RULES,
  MLB_MONEYLINE_RULE_PROFILES,
  negativeBinomialPmf,
  predictMlbExpectedRunsMean,
  scoreMlbMoneylineDailyRank,
  shrinkRate,
} from '../src/services/MlbExpectedRunsModel.js';
import { MLB_PAPER_RULE_FREEZE } from '../src/services/MlbPaperRuleFreeze.js';

test('正式獨贏規則鎖定凍結點 frozen_v1／min185', () => {
  assert.ok(['frozen_v1', 'min185'].includes(MLB_MONEYLINE_RECOMMENDATION_RULES.id));
  assert.equal(MLB_MONEYLINE_RECOMMENDATION_RULES.minimumPickOdds, 1.85);
  assert.equal(MLB_MONEYLINE_RECOMMENDATION_RULES.dailyTopK, 3);
  assert.equal(MLB_MONEYLINE_RECOMMENDATION_RULES.requireBothPitcherIdentities, true);
  assert.equal(MLB_MONEYLINE_RULE_PROFILES.frozen_v1.freezeId, MLB_PAPER_RULE_FREEZE.freezeId);
  assert.equal(MLB_MONEYLINE_RULE_PROFILES.frozen_v1.minimumPickOdds, 1.85);
  assert.equal(MLB_MONEYLINE_RULE_PROFILES.min185.minimumPickOdds, 1.85);
  assert.equal(MLB_MONEYLINE_RULE_PROFILES.base_p2.minimumPickOdds, null);
  assert.equal(MLB_MONEYLINE_RULE_PROFILES.base_p2.requireBothPitcherIdentities, false);
  assert.equal(MLB_MONEYLINE_RULE_PROFILES.sweet_195_220.minimumPickOdds, 1.95);
});

test('MLB 預期得分 v4.5 使用高權重特徵契約且不含市場', () => {
  assert.equal(MLB_EXPECTED_RUNS_FEATURE_KEYS.length, 29);
  assert.ok(!MLB_EXPECTED_RUNS_FEATURE_KEYS.some((key) =>
    /odds|market|price/i.test(key)
  ));
  assert.ok(MLB_EXPECTED_RUNS_FEATURE_KEYS.includes('offenseObp'));
  assert.ok(MLB_EXPECTED_RUNS_FEATURE_KEYS.includes('parkFactor'));
  assert.ok(MLB_EXPECTED_RUNS_FEATURE_KEYS.includes('gameWindSpeedKph'));
  assert.ok(MLB_EXPECTED_RUNS_FEATURE_KEYS.includes('opponentBullpenEraContribution'));
  assert.ok(MLB_EXPECTED_RUNS_FEATURE_KEYS.includes('opponentStarterFipContribution'));
  assert.ok(MLB_EXPECTED_RUNS_FEATURE_KEYS.includes('opponentBullpenPitchesLast3'));
  assert.ok(MLB_EXPECTED_RUNS_FEATURE_KEYS.includes('offenseVsStarterEraGap'));
  assert.ok(MLB_EXPECTED_RUNS_FEATURE_KEYS.includes('offenseOpsVsStarterHand'));
  assert.ok(MLB_EXPECTED_RUNS_FEATURE_KEYS.includes('opponentStarterOpsVsLhb'));
  assert.ok(!MLB_EXPECTED_RUNS_FEATURE_KEYS.some((key) => /known/i.test(key)));
  assert.ok(!MLB_EXPECTED_RUNS_FALLBACK_FEATURE_KEYS.some((key) =>
    /starter|pitcher/i.test(key)
  ));
});

test('極端小樣本投手數據必須向聯盟均值收縮', () => {
  const shrunkEra = shrinkRate(67.5, 2 / 3, 4.3, 30);
  assert.ok(shrunkEra < 6);
  assert.ok(shrunkEra > 4.3);
  assert.equal(shrinkRate(67.5, 0, 4.3, 30), 4.3);
  assert.equal(shrinkRate(null, 20, 4.3, 30), 4.3);
  assert.equal(shrinkRate('', 20, 4.3, 30), 4.3);
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
    vector.opponentStarterRestDays = 4;
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

test('同口徑PIT打擊、牛棚、球場與天氣必須進入 v4.2 得分向量', () => {
  const base = {
    home: { recentGames: 20, recentRunsPerGame: 5, recentRunsAllowedPerGame: 4 },
    away: { recentGames: 20, recentRunsPerGame: 4, recentRunsAllowedPerGame: 5 },
    pitchers: {},
    homeTeam: 'San Francisco Giants',
    weather: {
      temperatureC: 16,
      windSpeedKph: 20,
      precipitationProbability: 0.1,
      outdoorExposure: 1,
    },
  };
  const withMismatchedSources = {
    ...base,
    recentBoxscore: {
      home: {
        batting: { gamesObserved: 30, obp: 0.4, slg: 0.6 },
        bullpen: { gamesObserved: 7, era: 1, whip: 0.8 },
      },
      away: {
        batting: { gamesObserved: 30, obp: 0.2, slg: 0.25 },
        bullpen: { gamesObserved: 7, era: 9, whip: 2 },
      },
    },
  };
  const baseVector = buildMlbExpectedRunsSideFeatures(base, 'home');
  const enrichedVector = buildMlbExpectedRunsSideFeatures(
    withMismatchedSources,
    'home'
  );
  assert.ok(baseVector.parkFactor < 1);
  assert.equal(baseVector.gameWindSpeedKph, 20);
  assert.notEqual(enrichedVector.offenseObp, baseVector.offenseObp);
  assert.notEqual(
    enrichedVector.opponentBullpenEraContribution,
    baseVector.opponentBullpenEraContribution
  );
});

test('得分解釋必須完整重建預測並標記離群特徵', () => {
  const examples = Array.from({ length: 300 }, (_, index) => ({
    targetRuns: 3 + (index % 4),
    vector: Object.fromEntries(MLB_EXPECTED_RUNS_FEATURE_KEYS.map((key) => [
      key,
      key === 'offenseRecentRpg' ? 3 + (index % 5) * 0.5 : 0,
    ])),
  }));
  const model = fitMlbExpectedRunsModel(examples, { epochs: 50 });
  const vector = { ...examples[0].vector, offenseRecentRpg: 20 };
  const explanation = explainMlbExpectedRunsMean(model, vector);
  assert.equal(explanation.expectedRuns, predictMlbExpectedRunsMean(model, vector));
  assert.ok(explanation.contributions.length === MLB_EXPECTED_RUNS_FEATURE_KEYS.length);
  assert.equal(explanation.dataQuality.outOfDistribution, true);
});

test('正式方向以預測勝方為主並拒絕低勝率高 EV 冷門', () => {
  const market = {
    homeOdds: 1.7,
    awayOdds: 2.4,
    homeProb: 0.58,
    awayProb: 0.42,
  };
  const lowProbabilityUnderdog = classifyMlbMoneylineCandidate({
    prediction: {
      homeExpectedRuns: 4.1,
      awayExpectedRuns: 4.2,
      dataQuality: { maximumAbsoluteZScore: 1 },
      markets: { homeWinProbability: 0.49, awayWinProbability: 0.51 },
    },
    market,
  });
  assert.equal(lowProbabilityUnderdog.side, 'away');
  assert.equal(lowProbabilityUnderdog.tier, 'value_watch');

  const thinMarginFavorite = classifyMlbMoneylineCandidate({
    prediction: {
      homeExpectedRuns: 4.35,
      awayExpectedRuns: 4.2,
      dataQuality: { maximumAbsoluteZScore: 1 },
      markets: { homeWinProbability: 0.58, awayWinProbability: 0.42 },
    },
    market,
  });
  assert.equal(thinMarginFavorite.side, 'home');
  assert.notEqual(thinMarginFavorite.tier, 'recommendation');
  assert.ok(
    thinMarginFavorite.reasons.includes('expected_run_margin_below_threshold')
  );

  const longshotBlocked = classifyMlbMoneylineCandidate({
    prediction: {
      homeExpectedRuns: 5.2,
      awayExpectedRuns: 4.1,
      dataQuality: { maximumAbsoluteZScore: 1 },
      markets: { homeWinProbability: 0.61, awayWinProbability: 0.39 },
    },
    market: {
      homeOdds: 2.5,
      awayOdds: 1.55,
      homeProb: 0.38,
      awayProb: 0.62,
    },
  });
  assert.equal(longshotBlocked.side, 'home');
  assert.notEqual(longshotBlocked.tier, 'recommendation');
  assert.ok(longshotBlocked.reasons.includes('pick_odds_above_maximum'));

  const identityOpts = {
    pitcherIdentity: { homeId: 1, awayId: 2 },
  };

  const shortOddsBlocked = classifyMlbMoneylineCandidate({
    prediction: {
      homeExpectedRuns: 5.2,
      awayExpectedRuns: 4.1,
      dataQuality: { maximumAbsoluteZScore: 1 },
      markets: { homeWinProbability: 0.61, awayWinProbability: 0.39 },
    },
    market,
    regimeSignals: {
      homeEarlyExitsLast3: 0,
      awayEarlyExitsLast3: 1,
    },
    ...identityOpts,
  });
  assert.notEqual(shortOddsBlocked.tier, 'recommendation');
  assert.ok(shortOddsBlocked.reasons.includes('pick_odds_below_minimum'));

  const earlyExitMarket = {
    homeOdds: 1.95,
    awayOdds: 1.9,
    homeProb: 0.5,
    awayProb: 0.5,
  };
  const earlyExitBlocked = classifyMlbMoneylineCandidate({
    prediction: {
      homeExpectedRuns: 5.2,
      awayExpectedRuns: 4.1,
      dataQuality: { maximumAbsoluteZScore: 1 },
      markets: { homeWinProbability: 0.61, awayWinProbability: 0.39 },
    },
    market: earlyExitMarket,
    regimeSignals: {
      homeEarlyExitsLast3: 2,
      awayEarlyExitsLast3: 0,
    },
    ...identityOpts,
  });
  assert.notEqual(earlyExitBlocked.tier, 'recommendation');
  assert.ok(
    earlyExitBlocked.reasons.includes('pick_early_exits_higher_than_opponent')
  );

  const missingIdentityBlocked = classifyMlbMoneylineCandidate({
    prediction: {
      homeExpectedRuns: 5.2,
      awayExpectedRuns: 4.1,
      dataQuality: { maximumAbsoluteZScore: 1 },
      markets: { homeWinProbability: 0.61, awayWinProbability: 0.39 },
    },
    market: earlyExitMarket,
    regimeSignals: {
      homeEarlyExitsLast3: 0,
      awayEarlyExitsLast3: 1,
    },
  });
  assert.notEqual(missingIdentityBlocked.tier, 'recommendation');
  assert.ok(
    missingIdentityBlocked.reasons.includes('pitcher_identity_incomplete')
  );

  const qualifiedFavorite = classifyMlbMoneylineCandidate({
    prediction: {
      homeExpectedRuns: 5.2,
      awayExpectedRuns: 4.1,
      dataQuality: { maximumAbsoluteZScore: 1 },
      markets: { homeWinProbability: 0.61, awayWinProbability: 0.39 },
    },
    market: earlyExitMarket,
    regimeSignals: {
      homeEarlyExitsLast3: 0,
      awayEarlyExitsLast3: 1,
    },
    ...identityOpts,
  });
  assert.equal(qualifiedFavorite.side, 'home');
  assert.equal(qualifiedFavorite.tier, 'recommendation');
  assert.ok(qualifiedFavorite.odds >= 1.85);
  assert.equal(qualifiedFavorite.bothPitcherIdentities, true);
});

test('日內排序對高 EV 毒區做 P2 罰分', () => {
  const healthy = scoreMlbMoneylineDailyRank({
    expectedValue: 0.08,
    modelProbability: 0.55,
  });
  const toxic = scoreMlbMoneylineDailyRank({
    expectedValue: 0.16,
    modelProbability: 0.545,
  });
  // 0.16 - 0.15 = 0.01 < 0.08 → 毒區高 EV 被排到後面
  assert.ok(healthy > toxic);
  assert.equal(Number(toxic.toFixed(4)), 0.01);
  assert.equal(
    compareMlbMoneylineDailyRank(
      { expectedValue: 0.08, modelProbability: 0.55, expectedRunMargin: 0.4 },
      { expectedValue: 0.16, modelProbability: 0.545, expectedRunMargin: 0.9 }
    ) < 0,
    true
  );
});

test('獨贏溫度校準會把極端概率往 0.5 收縮', () => {
  assert.ok(applyProbabilityTemperature(0.8, 2) < 0.8);
  assert.ok(applyProbabilityTemperature(0.8, 2) > 0.5);
  assert.equal(applyProbabilityTemperature(0.8, 1), 0.8);
  const calibrated = calibrateMlbScoreMarkets({
    homeWinProbability: 0.7,
    awayWinProbability: 0.3,
  }, 2);
  assert.ok(calibrated.homeWinProbability < 0.7);
  assert.ok(
    Math.abs(calibrated.homeWinProbability + calibrated.awayWinProbability - 1) < 1e-9
  );
});
