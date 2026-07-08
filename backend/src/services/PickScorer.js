import { config } from '../config.js';
import { decimalToImpliedProb, calibrateModelProb, calcEV, decimalToNetOdds } from '../utils/odds.js';

/** 各盤口水位帶 */
export const MARKET_BANDS = {
  h2h: { min: 1.7, max: 3.5, sweetMin: 1.75, sweetMax: 2.8 },
  spreads: { min: 1.75, max: 2.6, sweetMin: 1.8, sweetMax: 2.3 },
  totals: { min: 1.85, max: 2.1, sweetMin: 1.88, sweetMax: 2.05 },
  props: { min: 1.7, max: 3.0, sweetMin: 1.75, sweetMax: 2.5 },
};

export function oddsBandFit(odds, band) {
  if (!band || odds < band.min || odds > band.max) return 0;
  if (odds >= band.sweetMin && odds <= band.sweetMax) return 1;
  if (odds < band.sweetMin) {
    return Math.max(0, (odds - band.min) / (band.sweetMin - band.min)) * 0.7;
  }
  return Math.max(0, (band.max - odds) / (band.max - band.sweetMax)) * 0.7;
}

export function calcDataQuality(analysis, league) {
  let q = 0.25;
  if (league === 'MLB') {
    if (analysis.homePitcherEra != null && analysis.awayPitcherEra != null) q += 0.25;
    if (analysis.marketHomeProb != null) q += 0.2;
    if (analysis.factors?.some((f) => f.includes('戰績'))) q += 0.15;
    if (analysis.factors?.some((f) => f.includes('傷兵'))) q += 0.1;
    if (analysis.factors?.some((f) => f.includes('主場球場'))) q += 0.05;
  } else if (analysis.factors?.length >= 2) {
    q += 0.35;
  }
  return Math.min(1, q);
}

export function scorePick({
  modelProb,
  impliedProb,
  oddsDecimal,
  marketType,
  dataQuality,
  structuralOk = true,
}) {
  const edgeProb = (modelProb - impliedProb) * 100;
  const edgeScore = Math.min(40, Math.max(0, edgeProb * 3.5));
  const dataScore = (dataQuality ?? 0.5) * 25;
  const band = MARKET_BANDS[marketType] || MARKET_BANDS.props;
  const oddsScore = oddsBandFit(oddsDecimal, band) * 20;
  const structScore = structuralOk ? 15 : 0;
  const score = edgeScore + dataScore + oddsScore + structScore;

  let tier = null;
  if (score >= config.recommendPrimaryScore) tier = 'primary';
  else if (score >= config.recommendWatchScore) tier = 'watch';

  return {
    score: Math.round(score * 10) / 10,
    tier,
    edgeProb: Math.round(edgeProb * 10) / 10,
    dataQuality: Math.round((dataQuality ?? 0) * 100) / 100,
  };
}

export function enrichCandidate(candidate, analysis, league, marketType) {
  const impliedProb = decimalToImpliedProb(candidate.oddsDecimal ?? candidate.odds?.price);
  const oddsDecimal = candidate.oddsDecimal ?? candidate.odds?.price;
  const rawModelProb = candidate.modelProb;
  const modelProb = calibrateModelProb(rawModelProb, impliedProb, config.maxModelEdgePct);
  const ev = calcEV(modelProb, decimalToNetOdds(oddsDecimal));
  const dataQuality = calcDataQuality(analysis, league);
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
