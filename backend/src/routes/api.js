import express from 'express';
import {
  syncAllData,
  runAnalysis,
  fullRefresh,
  getAppStatus,
  getRecommendations,
  getParlayRecommendations,
  getBettingStrategyMeta,
  getUpcomingGames,
  getBetStats,
  getModelPerformance,
  logBet,
  settleBet,
  getBetLog,
  LEAGUE_MARKETS_INFO,
} from '../services/AnalysisEngine.js';
import { getSlateByDate, slateFullRefresh, getSlateStatus } from '../services/SlateService.js';
import {
  getLiveRecommendations,
  getLiveStatus,
  runLiveAnalysis,
} from '../services/LiveAnalysisEngine.js';
import { getSlateCoverage } from '../services/ParlayBuilder.js';
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
    betStrategy: req.query.betStrategy || undefined,
    gamePicks: req.query.gamePicks === 'true',
    limit: parseInt(req.query.limit || '80', 10),
  });
  res.json({
    success: true,
    data: recs,
    meta: getBettingStrategyMeta(),
  });
});

/** 跨聯盟按日 Slate（香港時區） */
router.get('/slate', (req, res) => {
  const slate = getSlateByDate({
    from: req.query.from || undefined,
    to: req.query.to || undefined,
    days: parseInt(req.query.days || '7', 10),
    betStrategy: req.query.betStrategy || undefined,
    league: req.query.league || undefined,
    minEv: parseFloat(req.query.minEv || '0'),
    tier: req.query.tier || undefined,
    marketGroup: req.query.marketGroup || undefined,
  });
  res.json({ success: true, data: slate });
});

router.get('/slate/status', (_req, res) => {
  res.json({ success: true, data: getSlateStatus() });
});

router.post('/slate/refresh', async (_req, res) => {
  try {
    const data = await slateFullRefresh();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** 滾球推薦（棒球 v1：條件勝率 + 滾球獨贏/大小） */
router.get('/live', (req, res) => {
  const data = getLiveRecommendations({
    league: req.query.league || undefined,
    minEv: parseFloat(req.query.minEv || '0'),
    limit: parseInt(req.query.limit || '60', 10),
  });
  res.json({
    success: true,
    data,
    meta: getLiveStatus(),
  });
});

router.get('/live/status', (_req, res) => {
  res.json({ success: true, data: getLiveStatus() });
});

router.post('/live/analyze', async (_req, res) => {
  try {
    const data = await runLiveAnalysis();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/live/refresh', async (_req, res) => {
  try {
    // 先走完整同步（含比分/滾球賠率），再單獨回傳滾球結果
    const full = await fullRefresh();
    res.json({
      success: true,
      data: {
        ...full,
        live: full.liveAnalysis,
        status: getLiveStatus(),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/parlays', (req, res) => {
  const parlays = getParlayRecommendations(parseInt(req.query.limit || '40', 10));
  const coverage = getSlateCoverage();
  const fullSlate = parlays.find((p) => p.category === 'lottery_full_slate');
  res.json({
    success: true,
    data: parlays,
    meta: {
      ...getBettingStrategyMeta(),
      baseStake: config.parlayBetUsd,
      minLegOdds: config.minParlayLegOdds,
      maxLegOdds: config.parlaySlateMaxLegOdds ?? 3.0,
      maxLegs: config.maxParlayLegs,
      minLegProb: config.parlayLotteryMinProb,
      strategy: '當日全場大串 · 每場一腿主推 · $1 六合彩型',
      parlayMarkets: ['h2h', 'spreads', 'totals'],
      lotteryStyle: true,
      slateGames: coverage.slateGames,
      fullSlateLegs: fullSlate?.leg_count ?? fullSlate?.legs?.length ?? 0,
      mlbExpectedGames: coverage.mlbExpectedGames,
      gamesWithRecs: coverage.gamesWithRecs,
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

router.get('/model/performance', (req, res) => {
  const data = getModelPerformance({
    modelVersion: req.query.modelVersion || undefined,
    league: req.query.league || undefined,
  });
  res.json({
    success: true,
    data,
    meta: {
      modelVersion: config.modelVersion,
      note: '僅統計不可變快照中已結算的 win/loss；push/void 不納入命中率與 Brier',
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
  if (!['win', 'loss', 'push', 'void'].includes(result)) {
    return res.status(400).json({ success: false, error: 'result 須為 win/loss/push/void' });
  }
  settleBet(parseInt(req.params.id, 10), result, parseFloat(profit || 0));
  res.json({ success: true });
});

export default router;
