/**
 * 雙軌投注策略分類
 * - flat_bet：均注精選（同一場可多盤口，依序位與門檻）
 * - parlay_anchor：串關錨腿（低水 + 高勝率）
 */

import { config } from '../config.js';
import { resolveNpbTeamStrength } from './NpbStrength.js';

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
  const league = rec.league;
  const pickRank = options.pickRank ?? pickNum(rec, 'pick_rank', 'pickRank') ?? 1;
  const odds = pickNum(rec, 'odds_decimal', 'oddsDecimal');
  const modelProb = pickNum(rec, 'model_prob', 'modelProb');
  const edge = pickNum(rec, 'edge_prob', 'edgeProb');
  const dq = pickNum(rec, 'data_quality', 'dataQuality') ?? 0;
  const isNpbFamily = league === 'NPB' || league === 'KBO';

  // NPB/KBO 均注：勝率優先硬閘 — 無隊力 / 數據弱就不進「建議投注」
  if (isNpbFamily) {
    const hasStrength =
      rec.hasTeamStrength === true ||
      options.hasTeamStrength === true ||
      options.analysis?.hasTeamStrength === true;
    if (!hasStrength) return false;
    if (dq < (config.flatBetMinDataQualityNpb ?? 0.7)) return false;
    if (modelProb < (config.flatBetMinProbNpb ?? 0.6)) return false;
    if (edge < (config.flatBetMinEdgePctNpb ?? 3.5)) return false;
    // NPB 大小暫不進均注（無先發總分不穩）
    if (market === 'totals') return false;
  }

  if (config.flatBetPrimaryOnly) {
    if (pickRank === 1 && tier !== 'primary') return false;
    if (pickRank > 1 && tier === 'watch' && edge < minEdgeForMarket(market)) return false;
  }
  if (odds == null || odds < config.flatBetMinOdds) return false;
  if (!isNpbFamily && modelProb < config.flatBetMinProb) return false;
  if (!isNpbFamily && edge < minEdgeForMarket(market)) return false;

  if (market === 'totals') return totalsAllowed(rec);
  if (isPropMarket(market)) return config.enablePlayerProps;

  if (isSpreadPlus15Pick(rec)) {
    const minCover = config.flatBetPlus15MinCover ?? 0.62;
    if (modelProb < minCover) return false;
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
    hasTeamStrength: p.hasTeamStrength ?? context.analysis?.hasTeamStrength,
    dataQuality: p.dataQuality ?? context.analysis?.dataQuality ?? p.data_quality,
    bet_strategy: classifyBetStrategy(
      {
        ...p,
        hasTeamStrength: p.hasTeamStrength ?? context.analysis?.hasTeamStrength,
        dataQuality: p.dataQuality ?? context.analysis?.dataQuality,
        league: p.league ?? context.analysis?.league,
      },
      { ...context, hasTeamStrength: context.analysis?.hasTeamStrength }
    ),
  }));
}

export function classifyBetStrategy(rec, context = {}) {
  const pickRank = pickNum(rec, 'pick_rank', 'pickRank') ?? 99;
  const maxFlat = config.maxFlatBetsPerGame ?? 2;

  if (
    pickRank <= maxFlat &&
    qualifiesFlatBet(rec, {
      pickRank,
      hasTeamStrength: context.hasTeamStrength ?? rec.hasTeamStrength,
      analysis: context.analysis,
    })
  ) {
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
