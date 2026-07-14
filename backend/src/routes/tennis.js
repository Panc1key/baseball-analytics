import express from 'express';
import {
  tennisFullRefresh,
  getTennisStatus,
  getTennisRecommendations,
  getTennisUpcomingGames,
  getTennisBettingMeta,
  getTennisMarketsInfo,
  syncTennisData,
  runTennisAnalysis,
} from '../tennis/TennisAnalysisEngine.js';

const router = express.Router();

router.get('/leagues', (_req, res) => {
  const status = getTennisStatus();
  res.json({ success: true, data: status.activeSports || [] });
});

router.get('/status', (_req, res) => {
  res.json({ success: true, data: getTennisStatus() });
});

router.get('/games', (req, res) => {
  res.json({ success: true, data: getTennisUpcomingGames(req.query.league) });
});

router.get('/recommendations', (req, res) => {
  const recs = getTennisRecommendations({
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
    meta: getTennisBettingMeta(),
  });
});

router.get('/markets', (_req, res) => {
  res.json({ success: true, data: getTennisMarketsInfo() });
});

router.post('/sync', async (_req, res) => {
  try {
    const data = await syncTennisData();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/analyze', async (_req, res) => {
  try {
    const data = await runTennisAnalysis();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/refresh', async (_req, res) => {
  try {
    const data = await tennisFullRefresh();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
