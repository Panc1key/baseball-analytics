import express from 'express';
import {
  footballFullRefresh,
  getFootballStatus,
  getFootballRecommendations,
  getFootballUpcomingGames,
  getFootballBettingMeta,
  FOOTBALL_MARKETS_INFO,
  syncFootballData,
  runFootballAnalysis,
} from '../football/FootballAnalysisEngine.js';
import { FOOTBALL_LEAGUES } from '../football/config.js';

const router = express.Router();

router.get('/leagues', (_req, res) => {
  res.json({ success: true, data: FOOTBALL_LEAGUES });
});

router.get('/status', (_req, res) => {
  res.json({ success: true, data: getFootballStatus() });
});

router.get('/games', (req, res) => {
  res.json({ success: true, data: getFootballUpcomingGames(req.query.league) });
});

router.get('/recommendations', (req, res) => {
  const recs = getFootballRecommendations({
    league: req.query.league,
    minEv: parseFloat(req.query.minEv || '0'),
    marketGroup: req.query.marketGroup,
    tier: req.query.tier,
    betStrategy: req.query.betStrategy,
    limit: parseInt(req.query.limit || '80', 10),
  });
  res.json({
    success: true,
    data: recs,
    meta: getFootballBettingMeta(),
  });
});

router.get('/markets', (_req, res) => {
  res.json({ success: true, data: FOOTBALL_MARKETS_INFO });
});

router.post('/sync', async (_req, res) => {
  try {
    const data = await syncFootballData();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/analyze', async (_req, res) => {
  try {
    const data = await runFootballAnalysis();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/refresh', async (_req, res) => {
  try {
    const data = await footballFullRefresh();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
