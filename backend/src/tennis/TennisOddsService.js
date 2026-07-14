import {
  OddsApiClient,
  isOddsQuotaExhaustedError,
} from '../services/OddsApiClient.js';
import { TENNIS_BULK_MARKETS, tennisLeagueCodeFromKey } from './config.js';

/**
 * 只抓目前 active 的 tennis_*（耗額度可控）
 */
export async function discoverActiveTennisSports() {
  const client = new OddsApiClient();
  const sports = await client.listSports({ all: true });
  const active = (Array.isArray(sports) ? sports : []).filter(
    (s) => s.active && String(s.key || '').startsWith('tennis_')
  );
  return {
    sports: active.map((s) => ({
      key: s.key,
      title: s.title,
      code: tennisLeagueCodeFromKey(s.key),
      group: s.group,
      description: s.description,
    })),
    quota: client.getQuota(),
  };
}

export async function fetchTennisOdds(activeSports) {
  const client = new OddsApiClient();
  const results = {};

  for (const sport of activeSports || []) {
    const code = sport.code || tennisLeagueCodeFromKey(sport.key);
    try {
      const games = await client.getUpcomingOdds(sport.key, {
        regions: 'us,uk,eu',
        markets: TENNIS_BULK_MARKETS,
      });
      results[code] = {
        league: { code, key: sport.key, name: sport.title || code, region: 'us,uk,eu' },
        games,
        error: null,
      };
    } catch (err) {
      results[code] = {
        league: { code, key: sport.key, name: sport.title || code },
        games: [],
        error: err.message,
      };
      if (isOddsQuotaExhaustedError(err)) {
        console.warn('[tennis-odds] 額度耗盡，停止後續賽事主盤');
        break;
      }
    }
  }

  return { results, quota: client.getQuota() };
}

export async function fetchTennisScores(activeSports) {
  const client = new OddsApiClient();
  const results = {};

  for (const sport of activeSports || []) {
    const code = sport.code || tennisLeagueCodeFromKey(sport.key);
    try {
      const scores = await client.getScores(sport.key, 3);
      results[code] = {
        league: { code, key: sport.key, name: sport.title || code },
        scores,
        error: null,
      };
    } catch (err) {
      results[code] = {
        league: { code, key: sport.key, name: sport.title || code },
        scores: [],
        error: err.message,
      };
      if (isOddsQuotaExhaustedError(err)) {
        console.warn('[tennis-scores] 額度耗盡，停止後續賽事比分');
        break;
      }
    }
  }

  return { results, quota: client.getQuota() };
}
