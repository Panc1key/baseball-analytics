import { config } from '../config.js';
import {
  decimalToImpliedProb,
  calibrateModelProb,
  calcEV,
  calcEVWithPush,
  decimalToNetOdds,
} from '../utils/odds.js';
import { applyReliabilityCalibration } from './ProbabilityCalibration.js';

/** 各盤口水位帶（僅作軟性排序，不作硬門檻） */
export const MARKET_BANDS = {
  h2h: { min: 1.75, max: 3.5, sweetMin: 1.8, sweetMax: 2.8 },
  spreads: { min: 1.75, max: 2.6, sweetMin: 1.8, sweetMax: 2.35 },
  totals: { min: 1.75, max: 2.3, sweetMin: 1.8, sweetMax: 2.15 },
  props: { min: 1.75, max: 3.0, sweetMin: 1.8, sweetMax: 2.5 },
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
    if (analysis.homeRuns != null && analysis.awayRuns != null) q += 0.1;
    if (analysis.factors?.some((f) => f.includes('主場球場'))) q += 0.05;
  } else if (league === 'NPB' || league === 'KBO') {
    if (
      analysis.hasTeamStrength ||
      analysis.factors?.some((f) => f.includes('Elo') || f.includes('Yahoo'))
    ) {
      q += 0.4;
    } else q = Math.min(q, 0.3);
    if (analysis.marketHomeProb != null) q += 0.15;
    if (analysis.factors?.some((f) => f.includes('泊松') || f.includes('得失分'))) q += 0.1;
  } else if (analysis.factors?.length >= 2) {
    q += 0.35;
  }
  if (analysis.dataQuality != null) q = Math.max(q, analysis.dataQuality);
  return Math.min(1, q);
}

/**
 * 決策導向打分：以 EV + 校準勝率為主，水位帶僅軟排序
 * tier 由 EV/勝率門檻決定，不再靠 hitRateBonus 魔術加分
 */
export function scorePick({
  modelProb,
  impliedProb,
  marketProb = null,
  oddsDecimal,
  marketType,
  dataQuality,
  structuralOk = true,
  ev = null,
}) {
  const fairReference = marketProb ?? impliedProb;
  const edgeProb = (modelProb - fairReference) * 100;
  const offeredEdgeProb = (modelProb - impliedProb) * 100;

  const netOdds = decimalToNetOdds(oddsDecimal);
  const computedEv =
    ev != null && Number.isFinite(ev)
      ? ev
      : calcEV(modelProb, netOdds);

  // EV 主導（0.03 → 24，0.10 → 50 封頂）
  const evScore = Math.min(50, Math.max(0, computedEv * 800));
  // 校準勝率：達主推門檻給滿分段，否則線性
  const primaryMin = config.prematchPrimaryMinProb ?? 0.58;
  const probScore =
    modelProb >= primaryMin
      ? 25
      : Math.max(0, ((modelProb - 0.5) / Math.max(0.01, primaryMin - 0.5)) * 18);
  const dataScore = (dataQuality ?? 0.5) * 15;
  const band = MARKET_BANDS[marketType] || MARKET_BANDS.props;
  const oddsScore = oddsBandFit(oddsDecimal, band) * 10;
  const structScore = structuralOk ? 10 : 0;
  const score = evScore + probScore + dataScore + oddsScore + structScore;

  const minEv = config.minEvThreshold ?? 0.03;
  let tier = null;
  if (structuralOk && computedEv >= minEv && modelProb >= primaryMin) {
    tier = 'primary';
  } else if (
    structuralOk &&
    computedEv >= minEv &&
    modelProb >= Math.min(0.55, primaryMin - 0.03)
  ) {
    tier = 'watch';
  } else if (score >= config.recommendPrimaryScore) {
    tier = 'primary';
  } else if (score >= config.recommendWatchScore) {
    tier = 'watch';
  }

  return {
    score: Math.round(score * 10) / 10,
    tier,
    edgeProb: Math.round(edgeProb * 10) / 10,
    offeredEdgeProb: Math.round(offeredEdgeProb * 10) / 10,
    dataQuality: Math.round((dataQuality ?? 0) * 100) / 100,
  };
}

export function enrichCandidate(candidate, analysis, league, marketType) {
  const impliedProb = decimalToImpliedProb(candidate.oddsDecimal ?? candidate.odds?.price);
  const oddsDecimal = candidate.oddsDecimal ?? candidate.odds?.price;
  const rawModelProb = candidate.rawModelProb ?? candidate.modelProb;
  const maxEdge =
    marketType === 'spreads'
      ? (config.spreadsMaxModelEdgePct ?? config.maxModelEdgePct)
      : config.maxModelEdgePct;
  const probabilityCalibrated = candidate.probabilityCalibrated === true;
  let modelProb = probabilityCalibrated
    ? candidate.modelProb
    : calibrateModelProb(rawModelProb, impliedProb, maxEdge);

  // 可靠度分箱校準（若有歷史表）
  modelProb = applyReliabilityCalibration(modelProb, league, marketType);
  // 最終 trust-region 必須在所有校準之後套用；不能因上游已市場混合而繞過。
  const fairReference = candidate.marketProb ?? impliedProb;
  const preCapProb = modelProb;
  modelProb = calibrateModelProb(modelProb, fairReference, maxEdge);
  const finalEdgeCapped = Math.abs(modelProb - preCapProb) > 1e-9;

  const pushProb = candidate.pushProb ?? 0;
  const ev =
    pushProb > 0
      ? calcEVWithPush(
          modelProb * (1 - pushProb),
          pushProb,
          decimalToNetOdds(oddsDecimal)
        )
      : calcEV(modelProb, decimalToNetOdds(oddsDecimal));
  const dataQuality = calcDataQuality(analysis, league);
  const scored = scorePick({
    modelProb,
    impliedProb,
    marketProb: candidate.marketProb,
    oddsDecimal,
    marketType,
    dataQuality,
    structuralOk: candidate.structuralOk !== false,
    ev,
  });

  return {
    ...candidate,
    rawModelProb,
    marketProb: candidate.marketProb ?? impliedProb,
    calibratedProb: modelProb,
    preCapProb,
    finalEdgeCapped,
    probabilityCalibrated: true,
    calibrationCount: (candidate.calibrationCount ?? 0) + (probabilityCalibrated ? 0 : 1),
    modelProb,
    ev,
    impliedProb,
    oddsDecimal,
    ...scored,
  };
}
