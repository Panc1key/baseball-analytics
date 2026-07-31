/**
 * 依球場批量回填 Open-Meteo Archive 天氣快取。
 * 用法: node scripts/backfillMlbGameWeather.mjs [fromDate]
 */
import db from '../src/db/database.js';
import { resolveMlbVenueMeta, outdoorExposure } from '../src/data/venueMeta.js';
import { weatherCoverageStats } from '../src/services/MlbGameWeatherService.js';

const from = process.argv[2] || '2025-05-01';

function ensureTable() {
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
  `);
}

function hourKey(iso) {
  return new Date(iso).toISOString().slice(0, 13);
}

function cacheKey(lat, lon, commenceTime) {
  return `${Number(lat).toFixed(3)}:${Number(lon).toFixed(3)}:${hourKey(commenceTime)}`;
}

function monthChunks(startIso, endIso) {
  const chunks = [];
  let cursor = new Date(`${startIso.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(endIso);
  while (cursor <= end) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const start = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const next = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
    chunks.push({ start, end: next < endIso.slice(0, 10) ? next : endIso.slice(0, 10) });
    cursor = new Date(Date.UTC(year, month + 1, 1));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchArchiveRange(meta, start, end) {
  const url = new URL('https://archive-api.open-meteo.com/v1/archive');
  url.searchParams.set('latitude', String(meta.latitude));
  url.searchParams.set('longitude', String(meta.longitude));
  url.searchParams.set('start_date', start);
  url.searchParams.set('end_date', end);
  url.searchParams.set(
    'hourly',
    'temperature_2m,precipitation,wind_speed_10m,wind_direction_10m'
  );
  url.searchParams.set('timezone', 'UTC');
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`open_meteo_${response.status}`);
  }
  return response.json();
}

ensureTable();

const games = db.prepare(`
  SELECT id, commence_time, home_team
  FROM games
  WHERE league = 'MLB'
    AND completed = 1
    AND datetime(commence_time) >= datetime(?)
    AND home_team NOT IN ('American League', 'National League')
  ORDER BY datetime(commence_time), id
`).all(from);

const byVenue = new Map();
let unresolved = 0;
for (const game of games) {
  const meta = resolveMlbVenueMeta({ homeTeam: game.home_team });
  if (!meta) {
    unresolved += 1;
    continue;
  }
  if (!byVenue.has(meta.venueName)) {
    byVenue.set(meta.venueName, { meta, games: [] });
  }
  byVenue.get(meta.venueName).games.push(game);
}

const upsert = db.prepare(`
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
    temperature_c = excluded.temperature_c,
    precipitation_probability = excluded.precipitation_probability,
    wind_speed_kph = excluded.wind_speed_kph,
    wind_direction = excluded.wind_direction,
    outdoor_exposure = excluded.outdoor_exposure,
    source = excluded.source,
    fetched_at = datetime('now')
`);

let written = 0;
let indoor = 0;
let apiCalls = 0;
let errors = 0;

for (const [venueName, bucket] of byVenue.entries()) {
  const { meta, games: venueGames } = bucket;
  const exposure = outdoorExposure(meta.roof);
  if (exposure === 0) {
    const tx = db.transaction((rows) => {
      for (const game of rows) {
        upsert.run({
          cache_key: cacheKey(meta.latitude, meta.longitude, game.commence_time),
          game_id: game.id,
          commence_time: new Date(game.commence_time).toISOString(),
          venue_name: venueName,
          latitude: meta.latitude,
          longitude: meta.longitude,
          temperature_c: 22,
          precipitation_probability: 0,
          wind_speed_kph: 0,
          wind_direction: null,
          outdoor_exposure: 0,
          source: 'indoor_neutral',
        });
        indoor += 1;
        written += 1;
      }
    });
    tx(venueGames);
    console.log(JSON.stringify({ venueName, mode: 'indoor', games: venueGames.length }));
    continue;
  }

  const times = venueGames.map((game) => game.commence_time).sort();
  const chunks = monthChunks(times[0], times.at(-1));
  const hourMap = new Map();
  for (const chunk of chunks) {
    try {
      const payload = await fetchArchiveRange(meta, chunk.start, chunk.end);
      apiCalls += 1;
      const hours = payload?.hourly?.time || [];
      for (let i = 0; i < hours.length; i += 1) {
        const key = String(hours[i]).slice(0, 13);
        const mm = Number(payload.hourly.precipitation?.[i]);
        hourMap.set(key, {
          temperatureC: payload.hourly.temperature_2m?.[i] ?? null,
          windSpeedKph: payload.hourly.wind_speed_10m?.[i] ?? null,
          windDirection: payload.hourly.wind_direction_10m?.[i] ?? null,
          precipitationProbability: Number.isFinite(mm) ? Math.min(1, mm / 5) : null,
        });
      }
      await sleep(200);
    } catch (error) {
      errors += 1;
      console.log(JSON.stringify({
        venueName,
        chunk,
        error: String(error?.message || error),
      }));
    }
  }

  const tx = db.transaction((rows) => {
    for (const game of rows) {
      const key = hourKey(game.commence_time);
      const hourly = hourMap.get(key);
      if (!hourly) continue;
      upsert.run({
        cache_key: cacheKey(meta.latitude, meta.longitude, game.commence_time),
        game_id: game.id,
        commence_time: new Date(game.commence_time).toISOString(),
        venue_name: venueName,
        latitude: meta.latitude,
        longitude: meta.longitude,
        temperature_c: hourly.temperatureC,
        precipitation_probability: hourly.precipitationProbability,
        wind_speed_kph: hourly.windSpeedKph,
        wind_direction: hourly.windDirection,
        outdoor_exposure: exposure,
        source: 'open_meteo_archive',
      });
      written += 1;
    }
  });
  tx(venueGames);
  console.log(JSON.stringify({
    venueName,
    mode: 'archive',
    games: venueGames.length,
    hoursCached: hourMap.size,
  }));
}

const linked = db.prepare(`
  SELECT COUNT(DISTINCT game_id) AS n
  FROM mlb_game_weather_cache
  WHERE game_id IS NOT NULL
    AND source IN ('open_meteo_archive', 'indoor_neutral', 'open_meteo_forecast')
`).get();

console.log(JSON.stringify({
  done: true,
  games: games.length,
  venues: byVenue.size,
  unresolved,
  written,
  indoor,
  apiCalls,
  errors,
  linkedGames: linked.n,
  coverage: weatherCoverageStats(),
}, null, 2));
