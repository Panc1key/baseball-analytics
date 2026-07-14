import {
  OddsApiClient,
  isOddsQuotaExhaustedError,
} from '../services/OddsApiClient.js';
import { BASKETBALL_LEAGUES, BASKETBALL_BULK_MARKETS } from './config.js';

export async function fetchBasketballOdds() {
  const client = new OddsApiClient();
  const results = {};

  for (const [code, league] of Object.entries(BASKETBALL_LEAGUES)) {
    try {
      const games = await client.getUpcomingOdds(league.key, {
        regions: league.region,
        markets: BASKETBALL_BULK_MARKETS,
      });
      results[code] = { league, games, error: null };
    } catch (err) {
      results[code] = { league, games: [], error: err.message };
      if (isOddsQuotaExhaustedError(err)) {
        console.warn('[basketball-odds] 額度耗盡，停止後續聯盟主盤');
        break;
      }
    }
  }

  return { results, quota: client.getQuota() };
}

export async function fetchBasketballScores() {
  const client = new OddsApiClient();
  const results = {};

  for (const [code, league] of Object.entries(BASKETBALL_LEAGUES)) {
    try {
      const scores = await client.getScores(league.key, 3);
      results[code] = { league, scores, error: null };
    } catch (err) {
      results[code] = { league, scores: [], error: err.message };
      if (isOddsQuotaExhaustedError(err)) {
        console.warn('[basketball-scores] 額度耗盡，停止後續聯盟比分');
        break;
      }
    }
  }

  return { results, quota: client.getQuota() };
}
