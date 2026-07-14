/**
 * 網球獨贏：選手近期勝率 Log5 + 市場混合（無真實主場）
 */
import { tennisConfig } from '../config.js';
import { extractFairH2h2 } from '../utils/tennisOdds.js';

export function log5WinProb(pA, pB) {
  const a = Math.max(0.05, Math.min(0.95, pA));
  const b = Math.max(0.05, Math.min(0.95, pB));
  const den = a + b - 2 * a * b;
  if (den <= 0) return 0.5;
  return (a - a * b) / den;
}

export function buildPlayerStrength(profile) {
  if (!profile) return 0.5;
  const form = profile.formRating ?? 0.5;
  const serve = profile.serveRating ?? 0.5;
  const base = form * 0.7 + serve * 0.3;
  return Math.max(0.12, Math.min(0.88, base));
}

export function computeTennisH2h({
  homeTeam,
  awayTeam,
  bookmakers,
  homeProfile = null,
  awayProfile = null,
}) {
  const factors = [];
  const homeStrength = buildPlayerStrength(homeProfile);
  const awayStrength = buildPlayerStrength(awayProfile);

  if (homeProfile?.formSummary) factors.push(`${homeTeam} ${homeProfile.formSummary}`);
  if (awayProfile?.formSummary) factors.push(`${awayTeam} ${awayProfile.formSummary}`);

  const pseudo = tennisConfig.homePseudoAdv ?? 0.01;
  const homeAdj = Math.min(0.9, homeStrength + pseudo);
  let modelHome = log5WinProb(homeAdj, awayStrength);

  const market = extractFairH2h2(bookmakers, homeTeam, awayTeam);
  const hasIntel = Boolean(homeProfile?.hasIntel || awayProfile?.hasIntel);
  const marketWeight = !market
    ? 0
    : hasIntel
      ? tennisConfig.marketBlendFull
      : tennisConfig.marketBlendLite;

  if (market) {
    modelHome = modelHome * (1 - marketWeight) + market.homeProb * marketWeight;
    factors.push(
      `市場 主${(market.homeProb * 100).toFixed(1)}% 客${(market.awayProb * 100).toFixed(1)}% · 混合 ${(marketWeight * 100).toFixed(0)}%`
    );
  }

  const modelAway = 1 - modelHome;
  /** 預期局數淨勝（BO3 尺度約 ±6） */
  const expectedGameMargin = (modelHome - 0.5) * 12;
  factors.push(`預期局差 ${expectedGameMargin >= 0 ? '+' : ''}${expectedGameMargin.toFixed(1)}`);

  return {
    homeWinProb: modelHome,
    awayWinProb: modelAway,
    expectedGameMargin,
    confidence: Math.max(0, Math.min(1, Math.abs(modelHome - 0.5) * 1.9)),
    factors,
    market,
    components: { homeStrength, awayStrength, marketWeight, hasIntel },
  };
}
