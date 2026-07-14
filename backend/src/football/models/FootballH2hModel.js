/**
 * 足球獨贏：期望進球（攻防對碰）→ Dixon–Coles 比分矩陣 → 1X2
 * 不再用「Log5 + 外掛和局率」硬凑三向
 */
import { footballConfig } from '../config.js';
import { extractFairH2h3 } from '../utils/footballOdds.js';
import {
  buildDixonColesGrid,
  outcomeFromGrid,
} from './DixonColesScoreModel.js';

const LEAGUE_AVG_GOALS = { WC: 2.72, EPL: 2.78, MLS: 2.85, LIGAMX: 2.65, KLEAGUE: 2.55, DEFAULT: 2.6 };

function clampGoals(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function blendRate(observed, games, prior) {
  if (!games || games <= 0) return prior;
  const w = games >= 6 ? 0.85 : games >= 3 ? 0.65 : 0.4;
  return clampGoals(observed * w + prior * (1 - w), 0.35, 3.2);
}

/**
 * 估計本場期望進球 λ（主）、μ（客）
 * 標準形式：攻 × 對方防 / 聯盟尺度
 */
export function projectExpectedGoals({
  league,
  homeProfile,
  awayProfile,
  neutralVenue = false,
  tacticalEdge = 0,
}) {
  const factors = [];
  const leagueAvg = LEAGUE_AVG_GOALS[league] ?? LEAGUE_AVG_GOALS.DEFAULT;
  const half = leagueAvg / 2;

  const homeAtt = blendRate(homeProfile?.goalsPerGame ?? half, homeProfile?.gamesPlayed ?? 0, half);
  const homeDef = blendRate(homeProfile?.goalsAgainstPerGame ?? half, homeProfile?.gamesPlayed ?? 0, half);
  const awayAtt = blendRate(awayProfile?.goalsPerGame ?? half, awayProfile?.gamesPlayed ?? 0, half);
  const awayDef = blendRate(awayProfile?.goalsAgainstPerGame ?? half, awayProfile?.gamesPlayed ?? 0, half);

  // 相對聯盟：攻擊倍率、防守倍率（越低越好）
  const homeAttR = homeAtt / half;
  const homeDefR = homeDef / half;
  const awayAttR = awayAtt / half;
  const awayDefR = awayDef / half;

  let homeLambda = half * homeAttR * awayDefR;
  let awayLambda = half * awayAttR * homeDefR;

  const homeAdv = neutralVenue
    ? footballConfig.homeAdvantageNeutral
    : footballConfig.homeAdvantageNormal;
  // 主場優勢落在進球期望（約 +0.15~0.25 球量級，由機率門檻換算近似）
  const homeGoalBoost = homeAdv * 3.2;
  homeLambda += homeGoalBoost;
  homeLambda += tacticalEdge * 1.5;
  awayLambda -= tacticalEdge * 0.6;

  if (homeProfile?.tacticalStyle === 'attacking' || awayProfile?.tacticalStyle === 'attacking') {
    homeLambda += 0.08;
    awayLambda += 0.08;
    factors.push('進攻型風格 +期望進球');
  }
  if (homeProfile?.tacticalStyle === 'defensive' && awayProfile?.tacticalStyle === 'defensive') {
    homeLambda -= 0.12;
    awayLambda -= 0.12;
    factors.push('雙方防守型 -期望進球');
  }

  homeLambda = clampGoals(homeLambda, 0.35, 4.2);
  awayLambda = clampGoals(awayLambda, 0.25, 4.0);

  factors.push(
    `xG 主${homeLambda.toFixed(2)} 客${awayLambda.toFixed(2)}（聯盟均 ${leagueAvg.toFixed(2)}）`
  );
  if (homeGoalBoost > 0.01) factors.push(`主場進球加成 +${homeGoalBoost.toFixed(2)}`);

  return {
    homeLambda,
    awayLambda,
    leagueAvg,
    factors,
    components: { homeAtt, homeDef, awayAtt, awayDef, homeAdv },
  };
}

/**
 * @returns 含 scoreGrid / lambdas 的完整獨贏結果，供亞盤與大小共用
 */
export function computeFootballH2h({
  homeTeam,
  awayTeam,
  bookmakers,
  homeProfile = null,
  awayProfile = null,
  neutralVenue = true,
  tacticalEdge = 0,
  league = 'DEFAULT',
}) {
  const factors = [];
  if (homeProfile?.formSummary) factors.push(`${homeTeam} ${homeProfile.formSummary}`);
  if (awayProfile?.formSummary) factors.push(`${awayTeam} ${awayProfile.formSummary}`);
  if (homeProfile?.lineupNote) factors.push(homeProfile.lineupNote);
  if (awayProfile?.lineupNote) factors.push(awayProfile.lineupNote);
  if (tacticalEdge !== 0) {
    factors.push(`戰術傾向差 ${(tacticalEdge * 100).toFixed(1)}%`);
  }

  const xg = projectExpectedGoals({
    league,
    homeProfile,
    awayProfile,
    neutralVenue,
    tacticalEdge,
  });
  factors.push(...xg.factors);

  const rho = Math.max(-0.13, Math.min(-0.01, footballConfig.dixonColesRho ?? -0.08));
  let homeLambda = xg.homeLambda;
  let awayLambda = xg.awayLambda;

  const market = extractFairH2h3(bookmakers, homeTeam, awayTeam);
  const hasIntel = Boolean(
    homeProfile?.hasIntel || awayProfile?.hasIntel || tacticalEdge !== 0
  );
  const marketWeight = !market
    ? 0
    : hasIntel
      ? footballConfig.marketBlendFull
      : footballConfig.marketBlendLite;

  /**
   * 市場校準做在 λ/μ 上，再重建矩陣 — 確保 1X2/亞盤/大小同源
   * 簡化：保持總進球，調整主客差以靠近市場主勝率
   */
  if (market && marketWeight > 0) {
    const { grid: probeGrid } = buildDixonColesGrid(homeLambda, awayLambda, rho);
    const probe = outcomeFromGrid(probeGrid);
    const modelGap = probe.homeWinProb - probe.awayWinProb;
    const marketGap = market.homeProb - market.awayProb;
    const targetGap = modelGap * (1 - marketWeight) + marketGap * marketWeight;
    // 進球差約 0.1 ≈ 勝率差 ~3–4pt；保守調整
    const delta = clampGoals((targetGap - modelGap) * 0.9, -0.45, 0.45);
    homeLambda = clampGoals(homeLambda + delta / 2, 0.35, 4.2);
    awayLambda = clampGoals(awayLambda - delta / 2, 0.25, 4.0);
    factors.push(
      `xG 市場校準 Δ=${delta >= 0 ? '+' : ''}${delta.toFixed(2)}（權重 ${(marketWeight * 100).toFixed(0)}%）→ λ ${homeLambda.toFixed(2)}/μ ${awayLambda.toFixed(2)}`
    );
  }

  const { grid } = buildDixonColesGrid(homeLambda, awayLambda, rho);
  const final = outcomeFromGrid(grid);
  factors.push(
    `DC矩陣 主${(final.homeWinProb * 100).toFixed(0)}% 和${(final.drawProb * 100).toFixed(0)}% 客${(final.awayWinProb * 100).toFixed(0)}%`
  );

  const maxFav = Math.max(final.homeWinProb, final.drawProb, final.awayWinProb);
  const confidence = (maxFav - 1 / 3) * 1.5;

  return {
    homeWinProb: final.homeWinProb,
    drawProb: final.drawProb,
    awayWinProb: final.awayWinProb,
    confidence: Math.max(0, Math.min(1, confidence)),
    factors,
    market,
    scoreGrid: grid,
    homeLambda,
    awayLambda,
    rawOutcome: final,
    components: { ...xg.components, marketWeight, hasIntel, rho },
  };
}
