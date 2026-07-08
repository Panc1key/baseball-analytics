import axios from 'axios';

const api = axios.create({ baseURL: '/api', timeout: 30000 });

export async function refreshData() {
  const { data } = await api.post('/refresh');
  return data;
}

export async function getStatus() {
  const { data } = await api.get('/status');
  return data;
}

export async function getRecommendations(params = {}) {
  const { data } = await api.get('/recommendations', { params });
  return data;
}

export async function getParlays(limit = 40) {
  const { data } = await api.get('/parlays', { params: { limit } });
  return data;
}

export async function getMarkets() {
  const { data } = await api.get('/markets');
  return data;
}

export async function getConfig() {
  const { data } = await api.get('/config');
  return data;
}

export async function getBetStats() {
  const { data } = await api.get('/bets/stats');
  return data;
}

export async function getBetLog(limit = 50) {
  const { data } = await api.get('/bets', { params: { limit } });
  return data;
}

export async function logBet(payload) {
  const { data } = await api.post('/bets', payload);
  return data;
}

export async function settleBet(id, result, profit) {
  const { data } = await api.patch(`/bets/${id}/settle`, { result, profit });
  return data;
}

export default api;
