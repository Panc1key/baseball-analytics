/**
 * 籃球獨贏 / 淨勝分：效率×節奏框架（KenPom / 籃球分析教科書路線）
 * Margin ~ Normal；P(home win) = Φ(margin/σ)
 */
import { basketballConfig, BASKETBALL_LEAGUE_AVG_TOTAL } from '../config.js';
import { extractFairH2h2 } from '../utils/basketballOdds.js';
import { normalCdf, marginFromWinProb } from './BasketballNormal.js';

const LEAGUE_PACE = {
  NBA: 100,
  WNBA: 94,
  NBA_SUMMER: 102,
  DEFAULT: 100,
};

const LEAGUE_OFF_RTG = {
  NBA: 112,
  WNBA: 102,
  NBA_SUMMER: 108,
  DEFAULT: 110,
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function blend(obs, games, prior) {
  if (!games || games <= 0) return prior;
  const w = games >= 10 ? 0.85 : games >= 5 ? 0.65 : 0.4;
  return obs * w + prior * (1 - w);
}

/**
 * 由得分資料推估節奏與效率（無官方 pace 時的標準近似）
 * pace ≈ possessions；offRtg = pts / poss * 100
 */
export function estimateTeamEfficiency(profile, league) {
  const avgTotal = BASKETBALL_LEAGUE_AVG_TOTAL[league] ?? BASKETBALL_LEAGUE_AVG_TOTAL.DEFAULT;
  const half = avgTotal / 2;
  const pacePrior = LEAGUE_PACE[league] ?? LEAGUE_PACE.DEFAULT;
  const ortgPrior = LEAGUE_OFF_RTG[league] ?? LEAGUE_OFF_RTG.DEFAULT;

  const ppg = blend(profile?.ppg ?? half, profile?.gamesPlayed ?? 0, half);
  const oppg = blend(profile?.oppg ?? half, profile?.gamesPlayed ?? 0, half);

  // 以聯盟節奏先驗反推 possessions；慢/快隊用得分相對尺度輕調
  const pace = clamp(pacePrior * (ppg / half), pacePrior * 0.9, pacePrior * 1.1);
  const offRtg = clamp((ppg / pace) * 100, ortgPrior * 0.85, ortgPrior * 1.15);
  const defRtg = clamp((oppg / pace) * 100, ortgPrior * 0.85, ortgPrior * 1.15);

  return { ppg, oppg, pace, offRtg, defRtg };
}

/**
 * 標準得分投影：
 * expectedPace = (paceH+paceA)/2
 * homePts ≈ pace/100 * (homeOff + awayDef) / 2   （對稱平均攻對防）
 * + 主場分數優勢
 */
export function projectBasketballScore({ league, homeProfile, awayProfile }) {
  const factors = [];
  const home = estimateTeamEfficiency(homeProfile, league);
  const away = estimateTeamEfficiency(awayProfile, league);
  const leagueRtg = LEAGUE_OFF_RTG[league] ?? LEAGUE_OFF_RTG.DEFAULT;

  const expectedPace = (home.pace + away.pace) / 2;
  // 每百回合期望得分（對位）
  const homePtsPer100 = (home.offRtg + away.defRtg) / 2;
  const awayPtsPer100 = (away.offRtg + home.defRtg) / 2;

  const homeCourtPts = basketballConfig.homeCourtPoints ?? 3.0;
  let homeExpected = (expectedPace / 100) * homePtsPer100 + homeCourtPts / 2;
  let awayExpected = (expectedPace / 100) * awayPtsPer100 - homeCourtPts / 2;

  // 向聯盟平均總分輕微收縮，防樣本極值
  const priorTotal = BASKETBALL_LEAGUE_AVG_TOTAL[league] ?? BASKETBALL_LEAGUE_AVG_TOTAL.DEFAULT;
  const rawTotal = homeExpected + awayExpected;
  const shrink = 0.15;
  const scaled = rawTotal * (1 - shrink) + priorTotal * shrink;
  const scale = scaled / (rawTotal || 1);
  homeExpected *= scale;
  awayExpected *= scale;

  const expectedMargin = homeExpected - awayExpected;
  const modelTotal = homeExpected + awayExpected;

  factors.push(
    `節奏 ${expectedPace.toFixed(1)} · 效率 主${homePtsPer100.toFixed(1)}/客${awayPtsPer100.toFixed(1)}（聯盟 ${leagueRtg}）`
  );
  factors.push(
    `投影 ${homeExpected.toFixed(1)}-${awayExpected.toFixed(1)} · 淨勝 ${expectedMargin >= 0 ? '+' : ''}${expectedMargin.toFixed(1)} · 總分 ${modelTotal.toFixed(1)}`
  );
  factors.push(`主場優勢 +${homeCourtPts.toFixed(1)} 分`);

  return {
    homeExpected,
    awayExpected,
    expectedMargin,
    modelTotal,
    expectedPace,
    homeEff: home,
    awayEff: away,
    factors,
  };
}

export function computeBasketballH2h({
  homeTeam,
  awayTeam,
  bookmakers,
  homeProfile = null,
  awayProfile = null,
  league = 'NBA',
  scoreProjection = null,
}) {
  const factors = [];
  if (homeProfile?.formSummary) factors.push(`${homeTeam} ${homeProfile.formSummary}`);
  if (awayProfile?.formSummary) factors.push(`${awayTeam} ${awayProfile.formSummary}`);

  const proj =
    scoreProjection ||
    projectBasketballScore({ league, homeProfile, awayProfile });
  factors.push(...proj.factors);

  const sigma = basketballConfig.marginSigma ?? 11.5;
  let expectedMargin = proj.expectedMargin;
  const rawHome = 1 - normalCdf(0, expectedMargin, sigma);

  const market = extractFairH2h2(bookmakers, homeTeam, awayTeam);
  const hasIntel = Boolean(homeProfile?.hasIntel || awayProfile?.hasIntel);
  const marketWeight = !market
    ? 0
    : hasIntel
      ? basketballConfig.marketBlendFull
      : basketballConfig.marketBlendLite;

  // 市場混合做在「淨勝分」上，獨贏/讓分共用同一 μ（避免只混勝率導致讓分脫節）
  // 保持總分不變，只平移主客得分差
  let projBlended;
  if (market && marketWeight > 0) {
    const marketMargin = marginFromWinProb(market.homeProb, sigma);
    expectedMargin = expectedMargin * (1 - marketWeight) + marketMargin * marketWeight;
    const total = proj.modelTotal;
    const homeExpected = (total + expectedMargin) / 2;
    const awayExpected = (total - expectedMargin) / 2;
    factors.push(
      `模型淨勝 ${proj.expectedMargin.toFixed(1)} · 市場隱含 ${marketMargin.toFixed(1)} · 混合μ ${(marketWeight * 100).toFixed(0)}% → ${expectedMargin.toFixed(1)}`
    );
    projBlended = {
      ...proj,
      expectedMargin,
      homeExpected,
      awayExpected,
      modelTotal: total,
    };
  } else {
    projBlended = { ...proj, expectedMargin };
  }

  let modelHome = 1 - normalCdf(0, expectedMargin, sigma);
  factors.push(
    `N(μ=${expectedMargin.toFixed(1)},σ=${sigma}) 主勝 ${(modelHome * 100).toFixed(0)}%（原模型 ${(rawHome * 100).toFixed(0)}%）`
  );

  modelHome = clamp(modelHome, 0.08, 0.92);
  const modelAway = 1 - modelHome;
  const confidence = Math.abs(modelHome - 0.5) * 1.8;

  return {
    homeWinProb: modelHome,
    awayWinProb: modelAway,
    expectedMargin,
    confidence: Math.max(0, Math.min(1, confidence)),
    factors,
    market,
    scoreProjection: projBlended,
    components: {
      marketWeight,
      hasIntel,
      marginSigma: sigma,
      homeExpected: projBlended.homeExpected,
      awayExpected: projBlended.awayExpected,
      rawMargin: proj.expectedMargin,
    },
  };
}
