import test from 'node:test';
import assert from 'node:assert/strict';

import {
  outdoorExposure,
  resolveMlbVenueMeta,
} from '../src/data/venueMeta.js';
import {
  buildMlbWeatherFeatureVector,
} from '../src/services/MlbGameWeatherService.js';
import {
  buildMlbExpectedRunsSideFeatures,
  MLB_EXPECTED_RUNS_FEATURE_KEYS,
  MLB_EXPECTED_RUNS_WEATHER_FEATURE_KEYS,
} from '../src/services/MlbExpectedRunsModel.js';

test('球場座標與屋頂類型可依主隊解析', () => {
  const coors = resolveMlbVenueMeta({ homeTeam: 'Colorado Rockies' });
  assert.equal(coors.venueName, 'Coors Field');
  assert.equal(coors.roof, 'open');
  assert.equal(outdoorExposure('fixed'), 0);
  assert.ok(outdoorExposure('retractable') < 1);
});

test('室內場天氣特徵應壓制風速與降雨', () => {
  const outdoor = buildMlbWeatherFeatureVector({
    temperatureC: 30,
    windSpeedKph: 40,
    precipitationProbability: 0.8,
    outdoorExposure: 1,
  });
  const indoor = buildMlbWeatherFeatureVector({
    temperatureC: 30,
    windSpeedKph: 40,
    precipitationProbability: 0.8,
    outdoorExposure: 0,
  });
  assert.equal(outdoor.gameWindSpeedKph, 40);
  assert.equal(indoor.gameWindSpeedKph, 0);
  assert.equal(indoor.gamePrecipProbability, 0);
});

test('預期得分向量包含天氣共享特徵', () => {
  assert.ok(MLB_EXPECTED_RUNS_WEATHER_FEATURE_KEYS.every((key) =>
    MLB_EXPECTED_RUNS_FEATURE_KEYS.includes(key)
  ));
  const vector = buildMlbExpectedRunsSideFeatures({
    homeTeam: 'San Francisco Giants',
    home: { recentGames: 10, recentRunsPerGame: 4.5, recentRunsAllowedPerGame: 4 },
    away: { recentGames: 10, recentRunsPerGame: 4, recentRunsAllowedPerGame: 4.2 },
    pitchers: {},
    weather: {
      temperatureC: 18,
      windSpeedKph: 25,
      precipitationProbability: 0.2,
      outdoorExposure: 1,
    },
  }, 'home');
  assert.equal(vector.gameTemperatureC, 18);
  assert.equal(vector.gameWindSpeedKph, 25);
  assert.ok(vector.parkFactor < 1);
});
