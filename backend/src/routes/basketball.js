import express from 'express';
import {
  basketballFullRefresh,
  getBasketballStatus,
  getBasketballRecommendations,
  getBasketballUpcomingGames,
  getBasketballBettingMeta,
  BASKETBALL_MARKETS_INFO,
  syncBasketballData,
  runBasketballAnalysis,
} from '../basketball/BasketballAnalysisEngine.js';
import { BASKETBALL_LEAGUES } from '../basketball/config.js';

const router = express.Router();

router.get('/leagues', (_req, res) => {
  res.json({ success: true, data: BASKETBALL_LEAGUES });
});

router.get('/status', (_req, res) => {
  res.json({ success: true, data: getBasketballStatus() });
});

router.get('/games', (req, res) => {
  res.json({ success: true, data: getBasketballUpcomingGames(req.query.league) });
});

router.get('/recommendations', (req, res) => {
  const recs = getBasketballRecommendations({
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
    meta: getBasketballBettingMeta(),
  });
});

router.get('/markets', (_req, res) => {
  res.json({ success: true, data: BASKETBALL_MARKETS_INFO });
});

router.post('/sync', async (_req, res) => {
  try {
    const data = await syncBasketballData();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/analyze', async (_req, res) => {
  try {
    const data = await runBasketballAnalysis();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/refresh', async (_req, res) => {
  try {
    const data = await basketballFullRefresh();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
