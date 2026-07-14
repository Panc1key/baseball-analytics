/**
 * 足球賠率抓取（The Odds API）
 */
import { OddsApiClient } from '../services/OddsApiClient.js';
import { FOOTBALL_LEAGUES, SOCCER_BULK_MARKETS, SOCCER_PROP_MARKETS, footballConfig } from './config.js';

export async function fetchFootballOdds() {
  const client = new OddsApiClient();
  const results = {};

  for (const [code, league] of Object.entries(FOOTBALL_LEAGUES)) {
    try {
      const games = await client.getUpcomingOdds(league.key, {
        regions: league.region,
        markets: SOCCER_BULK_MARKETS,
      });
      results[code] = { league, games, error: null };
    } catch (err) {
      results[code] = { league, games: [], error: err.message };
    }
  }

  return { results, quota: client.getQuota() };
}

export async function fetchFootballScores() {
  const client = new OddsApiClient();
  const results = {};

  for (const [code, league] of Object.entries(FOOTBALL_LEAGUES)) {
    try {
      const scores = await client.getScores(league.key, 3);
      results[code] = { league, scores, error: null };
    } catch (err) {
      results[code] = { league, scores: [], error: err.message };
    }
  }

  return { results, quota: client.getQuota() };
}

export async function fetchFootballPlayerProps(games, leagueKey, maxGames = footballConfig.maxPropGames) {
  if (!footballConfig.enablePlayerProps || !games?.length) {
    return { propsByGameId: {}, quota: null };
  }

  const client = new OddsApiClient();
  const propsByGameId = {};
  const sorted = [...games]
    .filter((g) => g.commence_time && new Date(g.commence_time) > new Date())
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
    .slice(0, maxGames);

  const markets = SOCCER_PROP_MARKETS.join(',');

  for (const game of sorted) {
    try {
      const event = await client.getEventOdds(leagueKey, game.id, markets, {
        regions: 'us,eu',
      });
      const bookmakers = Array.isArray(event) ? event : event?.bookmakers || [];
      propsByGameId[game.id] = bookmakers;
    } catch (err) {
      console.warn(`[football-props] ${game.id}:`, err.message);
      propsByGameId[game.id] = [];
    }
  }

  return { propsByGameId, quota: client.getQuota() };
}

export async function listActiveFootballSports() {
  const client = new OddsApiClient();
  const sports = await client.listSports();
  const keys = Object.values(FOOTBALL_LEAGUES).map((l) => l.key);
  return sports.filter((s) => keys.includes(s.key) || s.key?.startsWith('soccer_'));
}
