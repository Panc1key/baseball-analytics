/**
 * 動態建議投注額 — 以基準均注為單位，依 EV / 優勢 / 序位調整
 */

import { config } from '../config.js';

function pickNum(rec, ...keys) {
  for (const k of keys) {
    const v = rec[k];
    if (v != null && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}

/**
 * 投注倍率（相對基準均注 1.0）
 */
export function computeStakeMultiplier(rec) {
  const ev = pickNum(rec, 'ev') ?? 0;
  const edge = pickNum(rec, 'edge_prob', 'edgeProb') ?? 0;
  const odds = pickNum(rec, 'odds_decimal', 'oddsDecimal') ?? 1.8;
  const pickRank = pickNum(rec, 'pick_rank', 'pickRank') ?? 1;
  const dataQuality = pickNum(rec, 'data_quality', 'dataQuality') ?? 0.5;
  const betStrategy = rec.bet_strategy || rec.betStrategy;

  const minEvPct = (config.minEvThreshold ?? 0.03) * 100;
  const evPct = ev * 100;

  const evFactor = 0.85 + Math.min(1.0, Math.max(0, (evPct - minEvPct) * 0.12));
  const edgeFactor = 0.9 + Math.min(0.3, Math.max(0, edge * 0.028));
  const rankFactor = pickRank === 1 ? 1 : pickRank === 2 ? 0.7 : pickRank === 3 ? 0.5 : 0.4;
  const dqFactor = 0.82 + Math.min(0.18, dataQuality * 0.2);

  let oddsFactor = 1;
  if (odds >= 2.6) oddsFactor = 0.88;
  else if (odds >= 2.1) oddsFactor = 0.95;
  else if (odds < config.parlayAnchorMaxOdds) oddsFactor = 0.92;

  let mult = evFactor * edgeFactor * rankFactor * dqFactor * oddsFactor;

  if (betStrategy === 'parlay_anchor') {
    mult *= config.parlayAnchorStakeRatio ?? 0.35;
  }

  const minM = config.stakeMinMultiplier ?? 0.3;
  const maxM = config.stakeMaxMultiplier ?? 2;
  return Math.max(minM, Math.min(maxM, mult));
}

/** 建議投注額（元） */
export function computeSuggestedStake(rec) {
  const base = config.baseStakeUnit ?? 10;
  const mult = computeStakeMultiplier(rec);
  const raw = base * mult;
  const step = config.stakeRoundStep ?? 1;
  const rounded = Math.round(raw / step) * step;
  const minStake = config.stakeMinAmount ?? Math.round(base * (config.stakeMinMultiplier ?? 0.3));
  const maxStake = config.stakeMaxAmount ?? Math.round(base * (config.stakeMaxMultiplier ?? 2));
  return Math.max(minStake, Math.min(maxStake, rounded));
}

export function enrichWithSuggestedStake(rec) {
  const stakeMultiplier = computeStakeMultiplier(rec);
  const suggestedStake = computeSuggestedStake(rec);
  return {
    ...rec,
    stakeMultiplier: Math.round(stakeMultiplier * 100) / 100,
    suggestedStake,
    suggested_stake: suggestedStake,
  };
}

export function getStakeSizingMeta() {
  return {
    baseUnit: config.baseStakeUnit ?? 10,
    currency: config.stakeCurrencyLabel ?? '元',
    minMultiplier: config.stakeMinMultiplier ?? 0.3,
    maxMultiplier: config.stakeMaxMultiplier ?? 2,
    minAmount: config.stakeMinAmount ?? 3,
    maxAmount: config.stakeMaxAmount ?? 20,
    description: '基準均注 × EV/優勢/序位倍率，高 EV 多投、次推縮倉',
  };
}
