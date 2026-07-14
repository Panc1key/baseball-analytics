import axios from 'axios';

const api = axios.create({ baseURL: '/api/basketball', timeout: 90000 });

export async function refreshBasketball() {
  const { data } = await api.post('/refresh');
  return data;
}

export async function getBasketballStatus() {
  const { data } = await api.get('/status');
  return data;
}

export async function getBasketballRecommendations(params = {}) {
  const { data } = await api.get('/recommendations', { params });
  return data;
}

export async function getBasketballMarkets() {
  const { data } = await api.get('/markets');
  return data;
}
