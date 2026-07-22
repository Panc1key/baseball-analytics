import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBullpenWorkloadVector,
  buildMlbTeamFeatureVector,
  buildRecentBoxscoreVector,
  fitMlbBaseline,
  liveVectorFromOfficialHistory,
  MLB_FOUNDATION_FEATURE_KEYS,
  predictMlbBaseline,
} from '../src/services/MlbHistoricalBaseline.js';

test('MLB 基準模型預測只使用特徵權重，不需要市場機率', () => {
  const model = {
    featureKeys: ['seasonWinPctDiff'],
    means: { seasonWinPctDiff: 0 },
    scales: { seasonWinPctDiff: 0.1 },
    weights: { seasonWinPctDiff: 0.4 },
    intercept: 0,
  };
  assert.equal(predictMlbBaseline(model, { seasonWinPctDiff: 0 }), 0.5);
  assert.ok(predictMlbBaseline(model, { seasonWinPctDiff: 0.1 }) > 0.5);
  assert.ok(predictMlbBaseline(model, { seasonWinPctDiff: -0.1 }) < 0.5);
});

test('MLB 地基模型契約固定為十項可審計特徵', () => {
  assert.equal(MLB_FOUNDATION_FEATURE_KEYS.length, 10);
  assert.equal(new Set(MLB_FOUNDATION_FEATURE_KEYS).size, 10);
  assert.ok(MLB_FOUNDATION_FEATURE_KEYS.includes('pitcherKMinusBb9Diff'));
});

test('歷史與即時牛棚負荷共用同一個差值方向', () => {
  const vector = buildBullpenWorkloadVector(
    { pitchesLast3: 180, appearancesLast3: 12 },
    { pitchesLast3: 120, appearancesLast3: 8 }
  );

  assert.deepEqual(vector, {
    bullpenPitchesLast3Diff: -60,
    bullpenAppearancesLast3Diff: -4,
  });
  assert.equal(buildBullpenWorkloadVector(null, null), null);
});

test('近期打擊與牛棚品質轉成固定方向的 PIT 差值', () => {
  const vector = buildRecentBoxscoreVector(
    {
      batting: { obp: 0.34, slg: 0.44, kRate: 0.2, bbRate: 0.09 },
      bullpen: { era: 3, whip: 1.1, kMinusBbRate: 0.18, hr9: 0.8 },
    },
    {
      batting: { obp: 0.31, slg: 0.39, kRate: 0.24, bbRate: 0.07 },
      bullpen: { era: 4.5, whip: 1.4, kMinusBbRate: 0.1, hr9: 1.3 },
    }
  );

  assert.ok(vector.battingObp14Diff > 0);
  assert.ok(vector.battingSlg14Diff > 0);
  assert.ok(vector.battingKRate14Diff > 0);
  assert.ok(vector.battingBbRate14Diff > 0);
  assert.ok(vector.bullpenEra7Diff > 0);
  assert.ok(vector.bullpenWhip7Diff > 0);
  assert.ok(vector.bullpenKMinusBb7Diff > 0);
  assert.ok(vector.bullpenHr9Diff > 0);
});

test('即時官方歷史資料可轉為與回放相同的隊級與投手特徵', () => {
  const vector = liveVectorFromOfficialHistory(
    {
      record: {
        wins: 60, losses: 40, homeWins: 35, homeLosses: 15, last10Wins: 7, last10Losses: 3,
      },
      offense: { runsPerGame: 5.2 },
      pitching: { runsAllowedPerGame: 3.8 },
    },
    {
      record: {
        wins: 45, losses: 55, awayWins: 20, awayLosses: 30, last10Wins: 4, last10Losses: 6,
      },
      offense: { runsPerGame: 4.1 },
      pitching: { runsAllowedPerGame: 4.9 },
    },
    { era: 3.1, whip: 1.05, strikeoutsPer9: 9.5, walksPer9: 2.1 },
    { era: 4.4, whip: 1.33, strikeoutsPer9: 7.8, walksPer9: 3.4 },
    null,
    null,
    { pitchesLast3: 180, appearancesLast3: 12 },
    { pitchesLast3: 120, appearancesLast3: 8 }
  );

  assert.ok(vector.seasonWinPctDiff > 0);
  assert.ok(vector.venueRecordDiff > 0);
  assert.ok(vector.last10WinPctDiff > 0);
  assert.ok(vector.recentRunsDiff > 0);
  assert.ok(vector.recentRunsAllowedDiff > 0);
  assert.ok(vector.pitcherEraDiff > 0);
  assert.ok(vector.pitcherWhipDiff > 0);
  assert.ok(vector.pitcherK9Diff > 0);
  assert.ok(vector.pitcherBb9Diff > 0);
  assert.equal(vector.bullpenPitchesLast3Diff, -60);
  assert.equal(vector.bullpenAppearancesLast3Diff, -4);
});

test('歷史與即時隊級資料共用同一個特徵契約', () => {
  const home = {
    seasonWinPct: 0.6,
    homeWinPct: 0.7,
    awayWinPct: 0.5,
    last10WinPct: 0.7,
    recentRunsPerGame: 5.2,
    recentRunsAllowedPerGame: 3.8,
  };
  const away = {
    seasonWinPct: 0.45,
    homeWinPct: 0.5,
    awayWinPct: 0.4,
    last10WinPct: 0.4,
    recentRunsPerGame: 4.1,
    recentRunsAllowedPerGame: 4.9,
  };
  const vector = buildMlbTeamFeatureVector(home, away);
  assert.ok(Math.abs(vector.seasonWinPctDiff - 0.15) < 1e-9);
  assert.ok(Math.abs(vector.venueRecordDiff - 0.3) < 1e-9);
  assert.ok(Math.abs(vector.last10WinPctDiff - 0.3) < 1e-9);
  assert.ok(Math.abs(vector.recentRunsDiff - 1.1) < 1e-9);
  assert.ok(Math.abs(vector.recentRunsAllowedDiff - 1.1) < 1e-9);
});

test('模型依時間保留獨立 validation 與 final test', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    commenceTime: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    features: { vector: { seasonWinPctDiff: (index % 5) / 10 } },
    homeWin: index % 2,
  }));
  const fit = fitMlbBaseline(rows, { featureKeys: ['seasonWinPctDiff'], epochs: 5 });
  assert.equal(fit.train.length, 60);
  assert.equal(fit.validation.length, 20);
  assert.equal(fit.test.length, 20);
  assert.ok(Date.parse(fit.train.at(-1).commenceTime) < Date.parse(fit.validation[0].commenceTime));
  assert.ok(Date.parse(fit.validation.at(-1).commenceTime) < Date.parse(fit.test[0].commenceTime));
});
