/**
 * NPB/KBO 隊力強度判定（單一真相來源）
 * 必須有足夠場次 + 得失分，才允許偏離市場較多 / 進均注
 */
export function resolveNpbTeamStrength(homeStats, awayStats, league) {
  if (league !== 'NPB' && league !== 'KBO') {
    return { hasStrength: false, homeGames: 0, awayGames: 0, minGames: 0 };
  }
  const homeGames = (homeStats?.wins || 0) + (homeStats?.losses || 0);
  const awayGames = (awayStats?.wins || 0) + (awayStats?.losses || 0);
  const minGames = Math.min(homeGames, awayGames);
  const hasRuns =
    homeStats?.runs_scored != null &&
    homeStats?.runs_allowed != null &&
    awayStats?.runs_scored != null &&
    awayStats?.runs_allowed != null;
  const hasStrength = minGames >= 20 && hasRuns;
  return { hasStrength, homeGames, awayGames, minGames, hasRuns };
}
