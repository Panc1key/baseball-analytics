import db from '../src/db/database.js';
import { getLatestMlbExpectedRunsValidation } from '../src/services/MlbExpectedRunsModel.js';

const model = getLatestMlbExpectedRunsValidation()?.model;
console.log(JSON.stringify({
  selectedFeatures: model?.featureKeys,
  parkWeight: model?.weights?.parkFactor ?? null,
  weatherWeights: {
    gameTemperatureC: model?.weights?.gameTemperatureC ?? null,
    gameWindSpeedKph: model?.weights?.gameWindSpeedKph ?? null,
    gamePrecipProbability: model?.weights?.gamePrecipProbability ?? null,
  },
  fallbackHasWeather: Boolean(
    model?.fallbackModel?.featureKeys?.includes('gameWindSpeedKph')
  ),
  weatherCache: db.prepare(`
    SELECT
      COUNT(*) AS n,
      SUM(CASE WHEN wind_direction IS NOT NULL THEN 1 ELSE 0 END) AS withDir,
      SUM(CASE WHEN wind_speed_kph IS NOT NULL THEN 1 ELSE 0 END) AS withWind
    FROM mlb_game_weather_cache
  `).get(),
}, null, 2));
