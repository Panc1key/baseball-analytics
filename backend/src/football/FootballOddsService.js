/**
 * 足球賠率抓取（The Odds API）
 */
import {
  OddsApiClient,
  isOddsQuotaExhaustedError,
  remainingQuota,
} from '../services/OddsApiClient.js';
import { FOOTBALL_LEAGUES, SOCCER_BULK_MARKETS, SOCCER_CORNERS_MARKETS, SOCCER_PROP_MARKETS, footballConfig } from './config.js';

/** 將逐場角球 market 併入主盤 bookmakers */
export function mergeCornersBookmakers(baseBooks, cornersBooks) {
  const byTitle = new Map(
    (baseBooks || []).map((b) => [b.title, { ...b, markets: [...(b.markets || [])] }])
  );

  for (const book of cornersBooks || []) {
    const existing = byTitle.get(book.title);
    if (existing) {
      const keys = new Set(existing.markets.map((m) => m.key));
      for (const market of book.markets || []) {
        if (!keys.has(market.key)) existing.markets.push(market);
      }
    } else {
      byTitle.set(book.title, book);
    }
  }

  return [...byTitle.values()];
}

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
      if (isOddsQuotaExhaustedError(err)) {
        console.warn('[football-odds] 額度耗盡，停止後續聯盟主盤');
        break;
      }
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
      if (isOddsQuotaExhaustedError(err)) {
        console.warn('[football-scores] 額度耗盡，停止後續聯盟比分');
        break;
      }
    }
  }

  return { results, quota: client.getQuota() };
}

export async function fetchFootballPlayerProps(games, leagueKey, maxGames = footballConfig.maxPropGames) {
  if (!footballConfig.enablePlayerProps || !games?.length) {
    return { propsByGameId: {}, quota: null, aborted: false };
  }

  const client = new OddsApiClient();
  const propsByGameId = {};
  const sorted = [...games]
    .filter((g) => g.commence_time && new Date(g.commence_time) > new Date())
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
    .slice(0, maxGames);

  const markets = SOCCER_PROP_MARKETS.join(',');
  let aborted = false;

  for (const game of sorted) {
    try {
      const event = await client.getEventOdds(leagueKey, game.id, markets, {
        regions: 'us,eu',
      });
      const bookmakers = Array.isArray(event) ? event : event?.bookmakers || [];
      propsByGameId[game.id] = bookmakers;

      const left = remainingQuota(client.getQuota());
      if (left != null && left < 8) {
        console.warn(`[football-props] 剩餘額度 ${left}，停止球員盤（每場 event-odds 很燒額度）`);
        aborted = true;
        break;
      }
    } catch (err) {
      console.warn(`[football-props] ${game.id}:`, err.message);
      propsByGameId[game.id] = [];
      if (isOddsQuotaExhaustedError(err)) {
        console.warn('[football-props] 額度耗盡，立刻停止本聯盟球員盤（不再逐場重試）');
        aborted = true;
        break;
      }
    }
  }

  return { propsByGameId, quota: client.getQuota(), aborted };
}

export async function fetchFootballCorners(
  games,
  leagueKey,
  region = 'us',
  maxGames = footballConfig.maxCornersGames
) {
  if (!footballConfig.enableCorners || !games?.length) {
    return { cornersByGameId: {}, quota: null, aborted: false };
  }

  const client = new OddsApiClient();
  const cornersByGameId = {};
  const sorted = [...games]
    .filter((g) => g.commence_time && new Date(g.commence_time) > new Date())
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
    .slice(0, maxGames);

  let aborted = false;

  for (const game of sorted) {
    try {
      const event = await client.getEventOdds(leagueKey, game.id, SOCCER_CORNERS_MARKETS, {
        regions: region,
      });
      const bookmakers = Array.isArray(event) ? event : event?.bookmakers || [];
      cornersByGameId[game.id] = bookmakers;
      const left = remainingQuota(client.getQuota());
      if (left != null && left < 5) {
        console.warn(`[football/corners] 剩餘額度 ${left}，停止角球盤`);
        aborted = true;
        break;
      }
    } catch (err) {
      console.warn(`[football/corners] ${game.id} 失敗:`, err.message);
      cornersByGameId[game.id] = [];
      if (isOddsQuotaExhaustedError(err)) {
        console.warn('[football/corners] 額度耗盡，停止角球盤請求');
        aborted = true;
        break;
      }
    }
  }

  return { cornersByGameId, quota: client.getQuota(), aborted };
}

export async function listActiveFootballSports() {
  const client = new OddsApiClient();
  const sports = await client.listSports();
  const keys = Object.values(FOOTBALL_LEAGUES).map((l) => l.key);
  return sports.filter((s) => keys.includes(s.key) || s.key?.startsWith('soccer_'));
}
