import { tennisConfig } from './config.js';
import { calcEV, decimalToImpliedProb, decimalToNetOdds, calibrateModelProb } from '../utils/odds.js';

const MARKET_BANDS = {
  h2h: { min: 1.25, max: 8.0, sweetMin: 1.55, sweetMax: 3.2 },
  spreads: { min: 1.5, max: 2.35, sweetMin: 1.7, sweetMax: 2.15 },
  totals: { min: 1.55, max: 2.3, sweetMin: 1.7, sweetMax: 2.1 },
};

function oddsBandFit(odds, band) {
  if (!band || odds < band.min || odds > band.max) return 0;
  if (odds >= band.sweetMin && odds <= band.sweetMax) return 1;
  if (odds < band.sweetMin) {
    return Math.max(0, (odds - band.min) / (band.sweetMin - band.min)) * 0.7;
  }
  return Math.max(0, (band.max - odds) / (band.max - band.sweetMax)) * 0.7;
}

export function calcTennisDataQuality(analysis) {
  let q = 0.25;
  if (analysis.homeProfile?.hasIntel || analysis.awayProfile?.hasIntel) q += 0.3;
  if (analysis.marketHomeProb != null) q += 0.25;
  if (analysis.factors?.length >= 3) q += 0.1;
  return Math.min(1, q);
}

function scorePick({ modelProb, impliedProb, oddsDecimal, marketType, dataQuality, structuralOk }) {
  const edgeProb = (modelProb - impliedProb) * 100;
  const edgeScore = Math.min(40, Math.max(0, edgeProb * 3.2));
  const dataScore = (dataQuality ?? 0.5) * 25;
  const band = MARKET_BANDS[marketType] || MARKET_BANDS.h2h;
  const oddsScore = oddsBandFit(oddsDecimal, band) * 20;
  const structScore = structuralOk ? 15 : 0;
  const score = edgeScore + dataScore + oddsScore + structScore;

  let tier = null;
  if (score >= tennisConfig.recommendPrimaryScore) tier = 'primary';
  else if (score >= tennisConfig.recommendWatchScore) tier = 'watch';

  return {
    score: Math.round(score * 10) / 10,
    tier,
    edgeProb: Math.round(edgeProb * 10) / 10,
    dataQuality: Math.round((dataQuality ?? 0) * 100) / 100,
  };
}

export function enrichTennisCandidate(candidate, analysis, _league, marketType) {
  const impliedProb = decimalToImpliedProb(candidate.oddsDecimal ?? candidate.odds?.price);
  const oddsDecimal = candidate.oddsDecimal ?? candidate.odds?.price;
  const rawModelProb = candidate.modelProb;
  const modelProb = calibrateModelProb(rawModelProb, impliedProb, tennisConfig.maxModelEdgePct);
  const ev = calcEV(modelProb, decimalToNetOdds(oddsDecimal));
  const dataQuality = calcTennisDataQuality(analysis);
  const scored = scorePick({
    modelProb,
    impliedProb,
    oddsDecimal,
    marketType,
    dataQuality,
    structuralOk: candidate.structuralOk !== false,
  });

  return {
    ...candidate,
    rawModelProb,
    modelProb,
    ev,
    impliedProb,
    oddsDecimal,
    ...scored,
  };
}

export function classifyTennisBetStrategy(rec) {
  const odds = rec.odds_decimal ?? rec.oddsDecimal;
  const prob = rec.model_prob ?? rec.modelProb;
  const ev = rec.ev;

  if (
    odds >= tennisConfig.flatBetMinOdds &&
    prob >= tennisConfig.flatBetMinProb &&
    ev >= tennisConfig.minEvThreshold
  ) {
    return 'flat_bet';
  }
  if (
    odds >= tennisConfig.parlayAnchorMinOdds &&
    odds <= tennisConfig.parlayAnchorMaxOdds &&
    prob >= tennisConfig.parlayAnchorMinProb
  ) {
    return 'parlay_anchor';
  }
  return 'watch';
}
