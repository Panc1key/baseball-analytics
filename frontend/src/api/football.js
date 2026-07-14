import axios from 'axios';

const footballApi = axios.create({ baseURL: '/api/football', timeout: 60000 });

export async function refreshFootball() {
  const { data } = await footballApi.post('/refresh');
  return data;
}

export async function getFootballStatus() {
  const { data } = await footballApi.get('/status');
  return data;
}

export async function getFootballRecommendations(params = {}) {
  const { data } = await footballApi.get('/recommendations', { params });
  return data;
}

export async function getFootballMarkets() {
  const { data } = await footballApi.get('/markets');
  return data;
}

export async function getFootballGames(league) {
  const { data } = await footballApi.get('/games', { params: { league } });
  return data;
}
