import { config, LEAGUES } from '../config.js';
import { MLB_PROP_MARKETS } from './PlayerPropAnalyzer.js';

const BASE_URL = 'https://api.the-odds-api.com/v4';

export class OddsApiError extends Error {
  constructor(status, body) {
    super(`Odds API 錯誤 ${status}: ${body}`);
    this.name = 'OddsApiError';
    this.status = status;
    this.body = body;
    this.isQuotaExhausted =
      status === 401 ||
      status === 429 ||
      /OUT_OF_USAGE_CREDITS|quota has been reached/i.test(body || '');
  }
}

export function isOddsQuotaExhaustedError(err) {
  return Boolean(err?.isQuotaExhausted || /OUT_OF_USAGE_CREDITS|quota has been reached/i.test(err?.message || ''));
}

export function remainingQuota(quota) {
  const n = parseInt(quota?.remaining, 10);
  return Number.isFinite(n) ? n : null;
}

export class OddsApiClient {
  constructor(apiKey = config.oddsApiKey) {
    this.apiKey = apiKey;
    this.lastQuota = null;
  }

  async request(path, params = {}) {
    if (!this.apiKey) {
      throw new Error('未設定 ODDS_API_KEY，請至 https://the-odds-api.com 申請免費 key');
    }

    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set('apiKey', this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString());
    this.lastQuota = {
      remaining: res.headers.get('x-requests-remaining'),
      used: res.headers.get('x-requests-used'),
    };

    if (!res.ok) {
      const body = await res.text();
      throw new OddsApiError(res.status, body);
    }

    return res.json();
  }

  async getUpcomingOdds(leagueKey, options = {}) {
    const {
      regions = 'us',
      markets = 'h2h,spreads,totals',
      oddsFormat = 'decimal',
    } = options;

    return this.request(`/sports/${leagueKey}/odds`, {
      regions,
      markets,
      oddsFormat,
    });
  }

  async getEventOdds(sportKey, eventId, markets, options = {}) {
    const { regions = 'us', oddsFormat = 'decimal' } = options;
    return this.request(`/sports/${sportKey}/events/${eventId}/odds`, {
      regions,
      markets: Array.isArray(markets) ? markets.join(',') : markets,
      oddsFormat,
    });
  }

  async getScores(leagueKey, daysFrom = 3) {
    return this.request(`/sports/${leagueKey}/scores`, {
      daysFrom: Math.min(daysFrom, 3),
      dateFormat: 'iso',
    });
  }

  async listSports({ all = false } = {}) {
    return this.request('/sports', { all: all ? 'true' : 'false' });
  }

  getQuota() {
    return this.lastQuota;
  }
}

export async function fetchAllLeagueOdds() {
  const client = new OddsApiClient();
  const results = {};

  for (const [code, league] of Object.entries(LEAGUES)) {
    try {
      const games = await client.getUpcomingOdds(league.key, {
        regions: league.region,
      });
      results[code] = { league, games, error: null };
    } catch (err) {
      results[code] = { league, games: [], error: err.message };
      if (isOddsQuotaExhaustedError(err)) {
        console.warn('[odds] 額度耗盡，停止後續聯盟主盤請求');
        break;
      }
    }
  }

  return { results, quota: client.getQuota() };
}

export async function fetchMlbPlayerProps(games, maxGames = 6) {
  if (!config.enablePlayerProps || !games?.length) {
    return { propsByGameId: {}, quota: null, aborted: false };
  }

  const client = new OddsApiClient();
  const propsByGameId = {};
  const sorted = [...games]
    .filter((g) => g.commence_time && new Date(g.commence_time) > new Date())
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
    .slice(0, maxGames);

  const markets = MLB_PROP_MARKETS.join(',');
  let aborted = false;

  for (const game of sorted) {
    try {
      const event = await client.getEventOdds('baseball_mlb', game.id, markets, {
        regions: 'us',
      });
      propsByGameId[game.id] = event.bookmakers || [];
      const left = remainingQuota(client.getQuota());
      if (left != null && left < 5) {
        console.warn(`[props] 剩餘額度 ${left}，停止 MLB 球員盤`);
        aborted = true;
        break;
      }
    } catch (err) {
      console.warn(`[props] ${game.id} 失敗:`, err.message);
      propsByGameId[game.id] = [];
      if (isOddsQuotaExhaustedError(err)) {
        console.warn('[props] 額度耗盡，停止 MLB 球員盤請求');
        aborted = true;
        break;
      }
    }
  }

  return { propsByGameId, quota: client.getQuota(), aborted };
}

export async function fetchAllLeagueScores() {
  const client = new OddsApiClient();
  const results = {};

  for (const [code, league] of Object.entries(LEAGUES)) {
    try {
      const scores = await client.getScores(league.key, 3);
      results[code] = { league, scores, error: null };
    } catch (err) {
      results[code] = { league, scores: [], error: err.message };
      if (isOddsQuotaExhaustedError(err)) {
        console.warn('[scores] 額度耗盡，停止後續聯盟比分請求');
        break;
      }
    }
  }

  return { results, quota: client.getQuota() };
}
