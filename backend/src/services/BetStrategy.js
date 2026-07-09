/**
 * 雙軌投注策略分類
 * - flat_bet：均注精選（高賠 + 正 EV，避開低水臭水）
 * - parlay_anchor：串關錨腿（低水 + 高勝率，用於組串抬命中）
 */

import { config } from '../config.js';

const MAIN_MARKETS = new Set(['h2h', 'spreads', 'totals']);

export function isMainMarket(market) {
  return MAIN_MARKETS.has(market);
}

function pickNum(rec, ...keys) {
  for (const k of keys) {
    const v = rec[k];
    if (v != null && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}

/** 均注 / 錨腿共用基礎門檻 */
function passesBaseGates(rec) {
  const tier = rec.tier;
  const market = rec.market;
  const ev = pickNum(rec, 'ev');
  const edge = pickNum(rec, 'edge_prob', 'edgeProb');
  const modelProb = pickNum(rec, 'model_prob', 'modelProb');

  if (!['primary', 'watch'].includes(tier)) return false;
  if (!isMainMarket(market)) return false;
  if (ev == null || ev < config.minEvThreshold) return false;
  if (edge == null || edge <= 0) return false;
  if (modelProb == null || modelProb <= 0) return false;
  return true;
}

/** 大小盤均注/錨腿：僅 MLB 且數據完整度足夠 */
function totalsAllowed(rec) {
  const market = rec.market;
  if (market !== 'totals') return true;
  const league = rec.league;
  const dq = pickNum(rec, 'data_quality', 'dataQuality') ?? 0;
  return league === 'MLB' && dq >= (config.flatBetMinDataQuality ?? 0.65);
}

/**
 * 均注精選：賠率 ≥ 門檻、用高賠實現 EV
 */
export function qualifiesFlatBet(rec) {
  if (!passesBaseGates(rec)) return false;
  if (!totalsAllowed(rec)) return false;

  const odds = pickNum(rec, 'odds_decimal', 'oddsDecimal');
  const modelProb = pickNum(rec, 'model_prob', 'modelProb');

  if (odds == null || odds < config.flatBetMinOdds) return false;
  if (modelProb < config.flatBetMinProb) return false;

  return true;
}

/**
 * 串關錨腿：低水區間 + 高模型勝率（獨贏/讓分優先）
 */
export function qualifiesParlayAnchor(rec) {
  if (!passesBaseGates(rec)) return false;

  const odds = pickNum(rec, 'odds_decimal', 'oddsDecimal');
  const modelProb = pickNum(rec, 'model_prob', 'modelProb');
  const market = rec.market;

  if (odds == null) return false;
  if (odds < config.parlayAnchorMinOdds || odds > config.parlayAnchorMaxOdds) return false;
  if (modelProb < config.parlayAnchorMinProb) return false;

  // 錨腿以獨贏/讓分為主；大小僅 MLB 高完整度
  if (market === 'totals') {
    return totalsAllowed(rec) && modelProb >= (config.parlayAnchorMinProb + 0.02);
  }

  return market === 'h2h' || market === 'spreads';
}

/** 分類：flat_bet 優先於 parlay_anchor（賠率區間互斥） */
export function classifyBetStrategy(rec) {
  if (qualifiesFlatBet(rec)) return 'flat_bet';
  if (qualifiesParlayAnchor(rec)) return 'parlay_anchor';
  return null;
}

export function enrichWithBetStrategy(rec) {
  const betStrategy = rec.bet_strategy || classifyBetStrategy(rec);
  return { ...rec, bet_strategy: betStrategy };
}

export const BET_STRATEGY_LABELS = {
  flat_bet: '均注精選',
  parlay_anchor: '串關錨腿',
};
