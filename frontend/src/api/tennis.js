import axios from 'axios';

const api = axios.create({ baseURL: '/api/tennis', timeout: 90000 });

export async function refreshTennis() {
  const { data } = await api.post('/refresh');
  return data;
}

export async function getTennisStatus() {
  const { data } = await api.get('/status');
  return data;
}

export async function getTennisRecommendations(params = {}) {
  const { data } = await api.get('/recommendations', { params });
  return data;
}

export async function getTennisMarkets() {
  const { data } = await api.get('/markets');
  return data;
}
