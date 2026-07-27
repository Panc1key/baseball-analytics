/**
 * MLB 比賽時段天氣（Open-Meteo）與本地快取。
 *
 * - 歷史完賽：Archive API 觀測（開賽時刻已知）
 * - 未來／近場：Forecast API
 * - 固定穹頂：回傳中性天氣，outdoorExposure = 0
 *
 * 訓練路徑只讀快取，不在 fit 時打外網。
 */
import db from '../db/database.js';
import {
  outdoorExposure,
  resolveMlbVenueMeta,
} from '../data/venueMeta.js';

const FALLBACK_WEATHER = Object.freeze({
  temperatureC: 22,
  windSpeedKph: 12,
  precipitationProbability: 0.15,
  windDirection: null,
});

function ensureWeatherTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_game_weather_cache (
      cache_key TEXT PRIMARY KEY,
      game_id TEXT,
      commence_time TEXT NOT NULL,
      venue_name TEXT,
      latitude REAL,
      longitude REAL,
      temperature_c REAL,
      precipitation_probability REAL,
      wind_speed_kph REAL,
      wind_direction REAL,
      outdoor_exposure REAL NOT NULL DEFAULT 1,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mlb_weather_game
      ON mlb_game_weather_cache(game_id);
    CREATE INDEX IF NOT EXISTS idx_mlb_weather_commence
      ON mlb_game_weather_cache(commence_time);
  `);
}

ensureWeatherTable();

function hourKey(iso) {
  return new Date(iso).toISOString().slice(0, 13);
}

function cacheKey({ latitude, longitude, commenceTime }) {
  return `${Number(latitude).toFixed(3)}:${Number(longitude).toFixed(3)}:${hourKey(commenceTime)}`;
}

function toFeaturePayload(row) {
  if (!row) return null;
  const exposure = Number(row.outdoor_exposure);
  const temperatureC = Number(row.temperature_c);
  const windSpeedKph = Number(row.wind_speed_kph);
  const precip = Number(row.precipitation_probability);
  return {
    temperatureC: Number.isFinite(temperatureC) ? temperatureC : FALLBACK_WEATHER.temperatureC,
    windSpeedKph: Number.isFinite(windSpeedKph) ? windSpeedKph : FALLBACK_WEATHER.windSpeedKph,
    precipitationProbability: Number.isFinite(precip)
      ? precip
      : FALLBACK_WEATHER.precipitationProbability,
    windDirection: row.wind_direction == null ? null : Number(row.wind_direction),
    outdoorExposure: Number.isFinite(exposure) ? exposure : 1,
    venueName: row.venue_name || null,
    source: row.source,
    forecastTime: hourKey(row.commence_time),
    coordinates: {
      latitude: row.latitude,
      longitude: row.longitude,
    },
  };
}

function upsertWeatherRow(row) {
  db.prepare(`
    INSERT INTO mlb_game_weather_cache (
      cache_key, game_id, commence_time, venue_name, latitude, longitude,
      temperature_c, precipitation_probability, wind_speed_kph, wind_direction,
      outdoor_exposure, source, fetched_at
    ) VALUES (
      @cache_key, @game_id, @commence_time, @venue_name, @latitude, @longitude,
      @temperature_c, @precipitation_probability, @wind_speed_kph, @wind_direction,
      @outdoor_exposure, @source, datetime('now')
    )
    ON CONFLICT(cache_key) DO UPDATE SET
      game_id = excluded.game_id,
      commence_time = excluded.commence_time,
      venue_name = excluded.venue_name,
      temperature_c = excluded.temperature_c,
      precipitation_probability = excluded.precipitation_probability,
      wind_speed_kph = excluded.wind_speed_kph,
      wind_direction = excluded.wind_direction,
      outdoor_exposure = excluded.outdoor_exposure,
      source = excluded.source,
      fetched_at = datetime('now')
  `).run(row);
}

function readCached(key) {
  return db.prepare(`
    SELECT * FROM mlb_game_weather_cache WHERE cache_key = ?
  `).get(key);
}

function readCachedByGame(gameId) {
  if (!gameId) return null;
  return db.prepare(`
    SELECT * FROM mlb_game_weather_cache
    WHERE game_id = ?
    ORDER BY datetime(fetched_at) DESC
    LIMIT 1
  `).get(gameId);
}

function pickHourly(payload, commenceTime, {
  temperatureKey = 'temperature_2m',
  windKey = 'wind_speed_10m',
  directionKey = 'wind_direction_10m',
  precipKey = null,
} = {}) {
  const target = hourKey(commenceTime);
  const times = payload?.hourly?.time || [];
  const index = times.findIndex((time) => String(time).slice(0, 13) === target);
  if (index < 0) return null;
  let precipitationProbability = null;
  if (precipKey === 'precipitation_probability') {
    precipitationProbability = payload.hourly.precipitation_probability?.[index] ?? null;
    if (precipitationProbability != null) precipitationProbability /= 100;
  } else if (precipKey === 'precipitation') {
    const mm = Number(payload.hourly.precipitation?.[index]);
    precipitationProbability = Number.isFinite(mm) ? Math.min(1, mm / 5) : null;
  }
  return {
    temperatureC: payload.hourly[temperatureKey]?.[index] ?? null,
    windSpeedKph: payload.hourly[windKey]?.[index] ?? null,
    windDirection: payload.hourly[directionKey]?.[index] ?? null,
    precipitationProbability,
    forecastTime: times[index] ?? null,
  };
}

async function fetchOpenMeteo({ latitude, longitude, commenceTime, mode }) {
  const commenceDate = new Date(commenceTime);
  if (!Number.isFinite(commenceDate.getTime())) return null;
  const day = commenceDate.toISOString().slice(0, 10);
  if (mode === 'archive') {
    const url = new URL('https://archive-api.open-meteo.com/v1/archive');
    url.searchParams.set('latitude', String(latitude));
    url.searchParams.set('longitude', String(longitude));
    url.searchParams.set('start_date', day);
    url.searchParams.set('end_date', day);
    url.searchParams.set(
      'hourly',
      'temperature_2m,precipitation,wind_speed_10m,wind_direction_10m'
    );
    url.searchParams.set('timezone', 'UTC');
    const response = await fetch(url);
    if (!response.ok) return null;
    const payload = await response.json();
    return pickHourly(payload, commenceTime, { precipKey: 'precipitation' });
  }
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set(
    'hourly',
    'temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m'
  );
  url.searchParams.set('timezone', 'UTC');
  const response = await fetch(url);
  if (!response.ok) return null;
  const payload = await response.json();
  return pickHourly(payload, commenceTime, { precipKey: 'precipitation_probability' });
}

function indoorNeutralPayload(meta, commenceTime, gameId = null) {
  const key = cacheKey({
    latitude: meta.latitude,
    longitude: meta.longitude,
    commenceTime,
  });
  const row = {
    cache_key: key,
    game_id: gameId,
    commence_time: new Date(commenceTime).toISOString(),
    venue_name: meta.venueName,
    latitude: meta.latitude,
    longitude: meta.longitude,
    temperature_c: FALLBACK_WEATHER.temperatureC,
    precipitation_probability: 0,
    wind_speed_kph: 0,
    wind_direction: null,
    outdoor_exposure: 0,
    source: 'indoor_neutral',
  };
  upsertWeatherRow(row);
  return toFeaturePayload(row);
}

/**
 * 同步讀取快取／室內中性值。訓練與即時特徵建構使用。
 */
export function getCachedMlbGameWeather({
  gameId = null,
  commenceTime,
  venueName = null,
  homeTeam = null,
} = {}) {
  if (gameId) {
    const byGame = readCachedByGame(gameId);
    if (byGame) return toFeaturePayload(byGame);
  }
  const meta = resolveMlbVenueMeta({ venueName, homeTeam });
  if (!meta || !commenceTime) {
    return {
      ...FALLBACK_WEATHER,
      outdoorExposure: 1,
      venueName: null,
      source: 'fallback_missing_venue',
      forecastTime: null,
      coordinates: null,
    };
  }
  const key = cacheKey({
    latitude: meta.latitude,
    longitude: meta.longitude,
    commenceTime,
  });
  const cached = readCached(key);
  if (cached) return toFeaturePayload(cached);
  const exposure = outdoorExposure(meta.roof);
  if (exposure === 0) {
    return indoorNeutralPayload(meta, commenceTime, gameId);
  }
  return {
    temperatureC: FALLBACK_WEATHER.temperatureC,
    windSpeedKph: FALLBACK_WEATHER.windSpeedKph,
    precipitationProbability: FALLBACK_WEATHER.precipitationProbability,
    windDirection: null,
    outdoorExposure: exposure,
    venueName: meta.venueName,
    source: 'fallback_uncached',
    forecastTime: null,
    coordinates: { latitude: meta.latitude, longitude: meta.longitude },
  };
}

/**
 * 拉取並快取單場天氣。歷史用 archive，未來用 forecast。
 */
export async function fetchAndCacheMlbGameWeather({
  gameId = null,
  commenceTime,
  venueName = null,
  homeTeam = null,
  force = false,
} = {}) {
  const meta = resolveMlbVenueMeta({ venueName, homeTeam });
  if (!meta || !commenceTime) return null;
  const exposure = outdoorExposure(meta.roof);
  if (exposure === 0) {
    return indoorNeutralPayload(meta, commenceTime, gameId);
  }
  const key = cacheKey({
    latitude: meta.latitude,
    longitude: meta.longitude,
    commenceTime,
  });
  if (!force) {
    const cached = readCached(key);
    if (cached && cached.source !== 'fallback_uncached') {
      if (gameId && !cached.game_id) {
        db.prepare(`
          UPDATE mlb_game_weather_cache SET game_id = ? WHERE cache_key = ?
        `).run(gameId, key);
      }
      return toFeaturePayload(cached);
    }
  }
  const commenceMs = Date.parse(commenceTime);
  const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
  const mode = commenceMs < Date.now() - fiveDaysMs ? 'archive' : 'forecast';
  const hourly = await fetchOpenMeteo({
    latitude: meta.latitude,
    longitude: meta.longitude,
    commenceTime,
    mode,
  });
  if (!hourly) return getCachedMlbGameWeather({ gameId, commenceTime, venueName, homeTeam });
  const row = {
    cache_key: key,
    game_id: gameId,
    commence_time: new Date(commenceTime).toISOString(),
    venue_name: meta.venueName,
    latitude: meta.latitude,
    longitude: meta.longitude,
    temperature_c: hourly.temperatureC,
    precipitation_probability: hourly.precipitationProbability,
    wind_speed_kph: hourly.windSpeedKph,
    wind_direction: hourly.windDirection,
    outdoor_exposure: exposure,
    source: mode === 'archive' ? 'open_meteo_archive' : 'open_meteo_forecast',
  };
  upsertWeatherRow(row);
  return toFeaturePayload(row);
}

/**
 * 轉成預期得分模型共享環境特徵。
 * 風速／降雨乘 outdoorExposure，室內場自動壓到接近中性。
 */
export function buildMlbWeatherFeatureVector(weather) {
  const payload = weather || FALLBACK_WEATHER;
  const exposure = Number.isFinite(Number(payload.outdoorExposure))
    ? Number(payload.outdoorExposure)
    : 1;
  const temperatureC = Number(payload.temperatureC);
  const windSpeedKph = Number(payload.windSpeedKph);
  const precip = Number(payload.precipitationProbability);
  return {
    gameTemperatureC: Number.isFinite(temperatureC)
      ? temperatureC
      : FALLBACK_WEATHER.temperatureC,
    gameWindSpeedKph: (Number.isFinite(windSpeedKph)
      ? windSpeedKph
      : FALLBACK_WEATHER.windSpeedKph) * exposure,
    gamePrecipProbability: (Number.isFinite(precip)
      ? precip
      : FALLBACK_WEATHER.precipitationProbability) * exposure,
    outdoorExposure: exposure,
  };
}

export function weatherCoverageStats() {
  ensureWeatherTable();
  return db.prepare(`
    SELECT
      source,
      COUNT(*) AS rows
    FROM mlb_game_weather_cache
    GROUP BY source
    ORDER BY rows DESC
  `).all();
}

export { FALLBACK_WEATHER };
