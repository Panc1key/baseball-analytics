import { config } from '../config.js';

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
  // 0 分且 0 場視為無得失分（Elo 重建常寫入空殼列）
  const homeRunVol =
    Number(homeStats?.runs_scored || 0) + Number(homeStats?.runs_allowed || 0);
  const awayRunVol =
    Number(awayStats?.runs_scored || 0) + Number(awayStats?.runs_allowed || 0);
  const hasRuns = homeRunVol > 0 && awayRunVol > 0;
  const need = config.npbMinGamesForStrength ?? 15;
  const hasStrength = minGames >= need && hasRuns;
  return { hasStrength, homeGames, awayGames, minGames, hasRuns, need };
}
