import express from 'express';
import {
  syncAllData,
  runAnalysis,
  fullRefresh,
  getAppStatus,
  getRecommendations,
  getParlayRecommendations,
  getUpcomingGames,
  getBetStats,
  logBet,
  settleBet,
  getBetLog,
  LEAGUE_MARKETS_INFO,
} from '../services/AnalysisEngine.js';
import { config, LEAGUES } from '../config.js';

const router = express.Router();

router.get('/leagues', (_req, res) => {
  res.json({ success: true, data: LEAGUES });
});

router.post('/sync', async (_req, res) => {
  try {
    const result = await syncAllData();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/analyze', async (_req, res) => {
  try {
    const result = await runAnalysis();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/refresh', async (_req, res) => {
  try {
    const data = await fullRefresh();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/status', (_req, res) => {
  res.json({
    success: true,
    data: {
      ...getAppStatus(),
      minEvThreshold: config.minEvThreshold,
      recommendPrimaryScore: config.recommendPrimaryScore,
      recommendWatchScore: config.recommendWatchScore,
      enablePlayerProps: config.enablePlayerProps,
    },
  });
});

router.get('/games', (req, res) => {
  const games = getUpcomingGames(req.query.league);
  res.json({ success: true, data: games });
});

router.get('/recommendations', (req, res) => {
  const recs = getRecommendations({
    league: req.query.league,
    minEv: parseFloat(req.query.minEv || '0'),
    market: req.query.market || undefined,
    marketGroup: req.query.marketGroup || undefined,
    tier: req.query.tier || undefined,
    limit: parseInt(req.query.limit || '80', 10),
  });
  res.json({ success: true, data: recs });
});

router.get('/parlays', (req, res) => {
  const parlays = getParlayRecommendations(parseInt(req.query.limit || '40', 10));
  res.json({
    success: true,
    data: parlays,
    meta: {
      baseStake: config.parlayBetUsd,
      minLegOdds: config.minParlayLegOdds,
      maxLegs: config.maxParlayLegs,
      minLegEv: config.parlayMinLegEv,
      strategy: '均注正 EV · 每腿須正優勢 · 長期盈利導向',
    },
  });
});

router.get('/markets', (_req, res) => {
  res.json({ success: true, data: LEAGUE_MARKETS_INFO });
});

router.get('/config', (_req, res) => {
  res.json({
    success: true,
    data: {
      ...getAppStatus(),
      minEvThreshold: config.minEvThreshold,
      recommendPrimaryScore: config.recommendPrimaryScore,
      recommendWatchScore: config.recommendWatchScore,
      enablePlayerProps: config.enablePlayerProps,
    },
  });
});

router.get('/bets/stats', (_req, res) => {
  res.json({ success: true, data: getBetStats() });
});

router.get('/bets', (req, res) => {
  res.json({ success: true, data: getBetLog(parseInt(req.query.limit || '100', 10)) });
});

router.post('/bets', (req, res) => {
  try {
    const { recType, recId, gameId, league, market, pick, stake, oddsDecimal } = req.body;
    if (!pick || !stake || !oddsDecimal) {
      return res.status(400).json({ success: false, error: '缺少必要欄位' });
    }
    const id = logBet({
      recType: recType || 'manual',
      recId,
      gameId,
      league,
      market,
      pick,
      stake: parseFloat(stake),
      oddsDecimal: parseFloat(oddsDecimal),
    });
    res.json({ success: true, data: { id } });
  } catch (err) {
    if (err.code === 'DUPLICATE_BET') {
      return res.status(409).json({ success: false, error: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/bets/:id/settle', (req, res) => {
  const { result, profit } = req.body;
  if (!['win', 'loss', 'push'].includes(result)) {
    return res.status(400).json({ success: false, error: 'result 須為 win/loss/push' });
  }
  settleBet(parseInt(req.params.id, 10), result, parseFloat(profit || 0));
  res.json({ success: true });
});

export default router;
