import axios from 'axios';

const api = axios.create({ baseURL: '/api', timeout: 30000 });

export async function refreshData() {
  const { data } = await api.post('/refresh');
  return data;
}

/** 跨聯盟同步（棒球 + 足球） */
export async function refreshSlate() {
  const { data } = await api.post('/slate/refresh');
  return data;
}

export async function getSlate(params = {}) {
  const { data } = await api.get('/slate', { params });
  return data;
}

export async function getSlateStatus() {
  const { data } = await api.get('/slate/status');
  return data;
}

export async function getLiveRecommendations(params = {}) {
  const { data } = await api.get('/live', { params });
  return data;
}

export async function getLiveStatus() {
  const { data } = await api.get('/live/status');
  return data;
}

export async function refreshLive() {
  const { data } = await api.post('/live/refresh');
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
