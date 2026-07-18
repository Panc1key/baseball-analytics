/**
 * 盤口選擇偏好：對壘膠著 / 雙強進攻時，優先大小而非硬推獨贏
 * （類比：兩隊難分胜負時不硬選勝負，改看大球/小球）
 */

import { config } from '../config.js';

function leagueExpectedRpg(league) {
  if (league === 'NPB' || league === 'KBO') return 8.0;
  return 8.8;
}

/**
 * @param {object} analysis
 * @param {{ league?: string }} game
 * @param {{ homeWinProb?: number } | null} live
 */
export function assessMarketPreference(analysis, game = {}, live = null) {
  const home =
    live?.homeWinProb != null
      ? Number(live.homeWinProb)
      : Number(analysis?.homeWinProb ?? 0.5);
  const away = 1 - home;
  const fav = Math.max(home, away);
  const gap = Math.abs(home - away);

  const maxGap = config.h2hAmbiguousMaxGap ?? 0.1; // 55/45
  const maxFav = config.h2hAmbiguousMaxFav ?? 0.58;
  const leagueRpg = leagueExpectedRpg(game.league);
  const homeRuns = analysis?.scoringHomeRuns ?? analysis?.homeRuns;
  const awayRuns = analysis?.scoringAwayRuns ?? analysis?.awayRuns;
  // 滾球優先用條件更新後的預期總分（與剩餘 λ SSOT 一致）
  const projected =
    live?.expectedFinalTotal != null
      ? Number(live.expectedFinalTotal)
      : homeRuns != null && awayRuns != null
        ? Number(homeRuns) + Number(awayRuns)
        : null;

  const bothStrongOffense =
    homeRuns != null &&
    awayRuns != null &&
    Number(homeRuns) >= leagueRpg / 2 + 0.2 &&
    Number(awayRuns) >= leagueRpg / 2 + 0.2;

  const highScoringEnv = projected != null && projected >= leagueRpg + 0.6;
  const coinFlip = gap < maxGap;
  const softFavorite = fav < maxFav;

  // 膠著：分不出明確熱門；或雙攻強且沒有壓倒性勝負
  const ambiguous =
    coinFlip || softFavorite || (bothStrongOffense && fav < 0.62);

  const preferTotals =
    ambiguous || (highScoringEnv && softFavorite) || (bothStrongOffense && softFavorite);

  const reasons = [];
  if (coinFlip || softFavorite) {
    reasons.push(`獨贏膠著（模型 ${(fav * 100).toFixed(0)}% / 差距 ${(gap * 100).toFixed(0)}%）`);
  }
  if (bothStrongOffense) reasons.push('雙隊進攻偏強，勝負波動大');
  if (highScoringEnv) reasons.push(`預估總分偏高（${projected?.toFixed(1)}）`);
  if (preferTotals) reasons.push('優先大小盤');

  return {
    ambiguous,
    preferTotals,
    bothStrongOffense,
    highScoringEnv,
    fav,
    gap,
    projectedTotal: projected,
    reason: reasons.join(' · ') || null,
  };
}

