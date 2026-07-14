/**
 * 雙軌投注策略分類
 * - flat_bet：均注精選（同一場可多盤口，依序位與門檻）
 * - parlay_anchor：串關錨腿（低水 + 高勝率）
 */

import { config } from '../config.js';

const MAIN_MARKETS = new Set(['h2h', 'spreads', 'totals']);
const PROP_MARKET_PREFIX = /^(batter_|pitcher_)/;

export function isMainMarket(market) {
  return MAIN_MARKETS.has(market);
}

export function isPropMarket(market) {
  return PROP_MARKET_PREFIX.test(market || '');
}

function pickNum(rec, ...keys) {
  for (const k of keys) {
    const v = rec[k];
    if (v != null && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}

function passesBaseGates(rec) {
  const tier = rec.tier;
  const market = rec.market;
  const ev = pickNum(rec, 'ev');
  const edge = pickNum(rec, 'edge_prob', 'edgeProb');
  const modelProb = pickNum(rec, 'model_prob', 'modelProb');

  if (!['primary', 'watch'].includes(tier)) return false;
  if (!isMainMarket(market) && !isPropMarket(market)) return false;
  if (ev == null || ev < config.minEvThreshold) return false;
  if (edge == null || edge <= 0) return false;
  if (modelProb == null || modelProb <= 0) return false;
  return true;
}

function isUnderTotalPick(rec) {
  const pick = rec.pick || '';
  return rec.market === 'totals' && (pick.startsWith('小') || /^under/i.test(pick));
}

function isSpreadPlus15Pick(rec) {
  return rec.market === 'spreads' && /\+1\.5\b/.test(rec.pick || '');
}

function totalsAllowed(rec) {
  if (rec.market !== 'totals') return true;
  if (isUnderTotalPick(rec)) return false;
  const dq = pickNum(rec, 'data_quality', 'dataQuality') ?? 0;
  return rec.league === 'MLB' && dq >= (config.flatBetMinDataQuality ?? 0.65);
}

function minEdgeForMarket(market) {
  if (market === 'totals') return config.flatBetMinEdgePctTotals ?? 4;
  if (isPropMarket(market)) return config.flatBetMinEdgePctProps ?? 4;
  return config.flatBetMinEdgePct ?? 2.5;
}

export function qualifiesFlatBet(rec, options = {}) {
  if (!passesBaseGates(rec)) return false;

  const market = rec.market;
  const tier = rec.tier;
  const pickRank = options.pickRank ?? pickNum(rec, 'pick_rank', 'pickRank') ?? 1;
  const odds = pickNum(rec, 'odds_decimal', 'oddsDecimal');
  const modelProb = pickNum(rec, 'model_prob', 'modelProb');
  const edge = pickNum(rec, 'edge_prob', 'edgeProb');

  if (config.flatBetPrimaryOnly) {
    if (pickRank === 1 && tier !== 'primary') return false;
    if (pickRank > 1 && tier === 'watch' && edge < minEdgeForMarket(market)) return false;
  }
  if (odds == null || odds < config.flatBetMinOdds) return false;
  if (modelProb < config.flatBetMinProb) return false;
  if (edge < minEdgeForMarket(market)) return false;

  if (market === 'totals') return totalsAllowed(rec);
  if (isPropMarket(market)) return config.enablePlayerProps;

  if (isSpreadPlus15Pick(rec) && modelProb < (config.parlaySlateSpreadPlus15MinProb ?? 0.58)) {
    return false;
  }

  return market === 'h2h' || market === 'spreads';
}

export function qualifiesParlayAnchor(rec) {
  if (!passesBaseGates(rec)) return false;

  const odds = pickNum(rec, 'odds_decimal', 'oddsDecimal');
  const modelProb = pickNum(rec, 'model_prob', 'modelProb');
  const market = rec.market;

  if (odds == null) return false;
  if (odds < config.parlayAnchorMinOdds || odds > config.parlayAnchorMaxOdds) return false;
  if (modelProb < config.parlayAnchorMinProb) return false;
  if (isUnderTotalPick(rec)) return false;
  if (isSpreadPlus15Pick(rec) && modelProb < (config.parlaySlateSpreadPlus15MinProb ?? 0.58)) {
    return false;
  }

  if (market === 'totals') {
    return totalsAllowed(rec) && modelProb >= (config.parlayAnchorMinProb + 0.02);
  }

  return market === 'h2h' || market === 'spreads';
}

export function assignBetStrategies(picks, context = {}) {
  const pool = (picks || []).filter((p) => p.tier);
  return pool.map((p) => ({
    ...p,
    bet_strategy: classifyBetStrategy(p, context),
  }));
}

export function classifyBetStrategy(rec, context = {}) {
  const pickRank = pickNum(rec, 'pick_rank', 'pickRank') ?? 99;
  const maxFlat = config.maxFlatBetsPerGame ?? 2;

  if (pickRank <= maxFlat && qualifiesFlatBet(rec, { pickRank })) {
    return 'flat_bet';
  }
  if (qualifiesParlayAnchor(rec)) return 'parlay_anchor';
  return null;
}

export function enrichWithBetStrategy(rec, context = {}) {
  const betStrategy = rec.bet_strategy || classifyBetStrategy(rec, context);
  return { ...rec, bet_strategy: betStrategy };
}

export const BET_STRATEGY_LABELS = {
  flat_bet: '均注精選',
  parlay_anchor: '串關錨腿',
};
