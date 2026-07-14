/**
 * 足球獨贏模型（三向：主勝 / 和 / 客勝）
 * 因子：近期戰績、進失球、陣容傷病、教練戰術傾向、市場校準
 */
import { footballConfig } from '../config.js';
import { extractFairH2h3 } from '../utils/footballOdds.js';

export function log5WinProb(pA, pB) {
  const a = Math.max(0.05, Math.min(0.95, pA));
  const b = Math.max(0.05, Math.min(0.95, pB));
  const den = a + b - 2 * a * b;
  if (den <= 0) return 0.5;
  return (a - a * b) / den;
}

export function buildTeamStrength(teamProfile) {
  if (!teamProfile) return 0.5;

  const form = teamProfile.formRating ?? 0.5;
  const attack = teamProfile.attackRating ?? 0.5;
  const defense = teamProfile.defenseRating ?? 0.5;
  const lineupPenalty = teamProfile.lineupPenalty ?? 0;

  const base = form * 0.4 + attack * 0.3 + defense * 0.3 - lineupPenalty;
  return Math.max(0.08, Math.min(0.92, base));
}

/** 依兩隊實力差估算和局概率 */
export function estimateDrawProb(homeStrength, awayStrength, baseDraw = footballConfig.baseDrawRate) {
  const gap = Math.abs(homeStrength - awayStrength);
  const drawBoost = gap < 0.06 ? 1.15 : gap > 0.2 ? 0.85 : 1;
  return Math.max(0.12, Math.min(0.38, baseDraw * drawBoost));
}

export function normalize3Way(home, draw, away) {
  const total = home + draw + away;
  if (total <= 0) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  return { home: home / total, draw: draw / total, away: away / total };
}

export function blendWithMarket3(model, market, weight) {
  if (!market || weight <= 0) return model;
  const w = Math.max(0, Math.min(0.65, weight));
  return normalize3Way(
    model.home * (1 - w) + market.homeProb * w,
    model.draw * (1 - w) + market.drawProb * w,
    model.away * (1 - w) + market.awayProb * w
  );
}

export function resolveMarketBlend(hasIntel, hasMarket) {
  if (!hasMarket) return 0;
  if (hasIntel) return footballConfig.marketBlendFull;
  return footballConfig.marketBlendLite;
}

/**
 * @param {object} params
 * @returns {{ homeWinProb, drawProb, awayWinProb, confidence, factors, market }}
 */
export function computeFootballH2h({
  homeTeam,
  awayTeam,
  bookmakers,
  homeProfile = null,
  awayProfile = null,
  neutralVenue = true,
  tacticalEdge = 0,
}) {
  const factors = [];
  const homeStrength = buildTeamStrength(homeProfile);
  const awayStrength = buildTeamStrength(awayProfile);

  if (homeProfile?.formSummary) factors.push(`${homeTeam} ${homeProfile.formSummary}`);
  if (awayProfile?.formSummary) factors.push(`${awayTeam} ${awayProfile.formSummary}`);
  if (homeProfile?.lineupNote) factors.push(homeProfile.lineupNote);
  if (awayProfile?.lineupNote) factors.push(awayProfile.lineupNote);
  if (homeProfile?.coachNote) factors.push(homeProfile.coachNote);
  if (awayProfile?.coachNote) factors.push(awayProfile.coachNote);
  if (tacticalEdge !== 0) {
    factors.push(`戰術傾向差 ${(tacticalEdge * 100).toFixed(1)}%（進攻壓制）`);
  }

  const homeAdv = neutralVenue
    ? footballConfig.homeAdvantageNeutral
    : footballConfig.homeAdvantageNormal;
  const homeWithField = Math.min(0.95, homeStrength + homeAdv + tacticalEdge);
  const awayAdjusted = Math.max(0.05, awayStrength - tacticalEdge * 0.5);

  let modelHome = log5WinProb(homeWithField, awayAdjusted);
  let modelDraw = estimateDrawProb(homeWithField, awayAdjusted);
  let modelAway = 1 - modelHome - modelDraw;

  if (modelAway < 0.05) {
    modelAway = 0.05;
    const rest = 0.95;
    const ratio = modelHome / (modelHome + modelDraw || 1);
    modelHome = rest * ratio;
    modelDraw = rest * (1 - ratio);
  }

  const model = normalize3Way(modelHome, modelDraw, modelAway);
  const market = extractFairH2h3(bookmakers, homeTeam, awayTeam);
  const hasIntel = Boolean(
    homeProfile?.hasIntel || awayProfile?.hasIntel || tacticalEdge !== 0
  );
  const marketWeight = resolveMarketBlend(hasIntel, Boolean(market));

  let final = model;
  if (market) {
    final = blendWithMarket3(model, market, marketWeight);
    factors.push(
      `市場 主${(market.homeProb * 100).toFixed(1)}% 和${(market.drawProb * 100).toFixed(1)}% 客${(market.awayProb * 100).toFixed(1)}% · 混合 ${(marketWeight * 100).toFixed(0)}%`
    );
  }

  const maxFav = Math.max(final.home, final.draw, final.away);
  const confidence = (maxFav - 1 / 3) * 1.5;

  return {
    homeWinProb: final.home,
    drawProb: final.draw,
    awayWinProb: final.away,
    confidence: Math.max(0, Math.min(1, confidence)),
    factors,
    market,
    components: { homeStrength, awayStrength, homeWithField, marketWeight, hasIntel },
  };
}
