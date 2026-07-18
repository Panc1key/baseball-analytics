/**
 * NPB/KBO 得分期望模型（初盤）
 * RPG/RAPG → λ，再用 Elo 差調整；NPB 另用 baseball-data OPS/WHIP 調 λ
 */

import {
  applyEloToLambdas,
  eloHomeWinProb,
  eloToStrength,
  getTeamElo,
  ELO_DEFAULT,
} from './BaseballElo.js';
import { offenseFormMultiplier, staffWhipMultiplier } from './TeamRollingStats.js';
import { config } from '../config.js';

const NPB_LEAGUE_TEAM_RPG = 3.9;
const KBO_LEAGUE_TEAM_RPG = 4.5;

function sideRpg(teamStats, seasonGames, kind) {
  const minG = config.rollingFormMinGames ?? 8;
  const g30 = Number(teamStats?.games_30) || 0;
  const rolling = kind === 'off' ? teamStats?.rpg_30 : teamStats?.rapg_30;
  if (g30 >= minG && rolling != null && Number.isFinite(Number(rolling))) {
    return { value: Number(rolling), source: `近${teamStats.rolling_window_days || 30}日` };
  }
  const season =
    kind === 'off'
      ? Number(teamStats?.runs_scored || 0) / Math.max(1, seasonGames)
      : Number(teamStats?.runs_allowed || 0) / Math.max(1, seasonGames);
  return { value: season, source: '賽季' };
}

export function projectSideRuns({ offenseRpg, oppDefenseRpg, leagueRpg, homeBoost = 0 }) {
  const off = Math.max(0.5, Number(offenseRpg) || leagueRpg);
  const def = Math.max(0.5, Number(oppDefenseRpg) || leagueRpg);
  const base = leagueRpg * (off / leagueRpg) * (def / leagueRpg);
  return Math.max(1.5, Math.min(8.5, base + homeBoost));
}

/**
 * @returns {{
 *   homeRuns, awayRuns, modelTotal, leagueRpg, factors,
 *   homeElo, awayElo, eloHomeWinProb, homeStrength, awayStrength
 * }}
 */
export function projectNpbFamilyRuns({
  league,
  homeTeam,
  awayTeam,
  homeTeamStats,
  awayTeamStats,
  homeGames,
  awayGames,
  homeStrength: ratingHome,
  awayStrength: ratingAway,
  eloOverride = null,
}) {
  const leagueRpg = league === 'KBO' ? KBO_LEAGUE_TEAM_RPG : NPB_LEAGUE_TEAM_RPG;
  const homeOff = sideRpg(homeTeamStats, homeGames, 'off');
  const awayOff = sideRpg(awayTeamStats, awayGames, 'off');
  const homeDef = sideRpg(homeTeamStats, homeGames, 'def');
  const awayDef = sideRpg(awayTeamStats, awayGames, 'def');

  let homeRuns = projectSideRuns({
    offenseRpg: homeOff.value,
    oppDefenseRpg: awayDef.value,
    leagueRpg,
    homeBoost: 0.1,
  });
  let awayRuns = projectSideRuns({
    offenseRpg: awayOff.value,
    oppDefenseRpg: homeDef.value,
    leagueRpg,
    homeBoost: 0,
  });

  const homeElo =
    homeTeam != null
      ? getTeamElo(league, homeTeam, eloOverride)
      : ELO_DEFAULT + ((ratingHome ?? 0.5) - 0.5) * 800;
  const awayElo =
    awayTeam != null
      ? getTeamElo(league, awayTeam, eloOverride)
      : ELO_DEFAULT + ((ratingAway ?? 0.5) - 0.5) * 800;

  const eloAdj = applyEloToLambdas(homeRuns, awayRuns, homeElo, awayElo);
  homeRuns = eloAdj.homeRuns;
  awayRuns = eloAdj.awayRuns;

  const factors = [
    `${league} 得失分λ 主${homeRuns.toFixed(2)}+客${awayRuns.toFixed(2)}=${(homeRuns + awayRuns).toFixed(2)}` +
      `（主進${homeOff.value.toFixed(2)}/${homeOff.source}·失${homeDef.value.toFixed(2)}` +
      ` 客進${awayOff.value.toFixed(2)}/${awayOff.source}·失${awayDef.value.toFixed(2)}）`,
    `${league} Elo 主${homeElo.toFixed(0)} / 客${awayElo.toFixed(0)}` +
      ` · Elo主勝${(eloHomeWinProb(homeElo, awayElo) * 100).toFixed(1)}%` +
      (eloAdj.shrink > 0.01 ? ` · 總分壓縮${(eloAdj.shrink * 100).toFixed(1)}%` : ''),
  ];

  // NPB/KBO：隊級 OPS / 對手投手群 WHIP（賽季累積寫在 ops_30/whip_30）
  const useNpbForm = league === 'NPB' && config.enableNpbBaseballDataForm !== false;
  const useKboForm = league === 'KBO' && config.enableKboOfficialForm !== false;
  if (useNpbForm || useKboForm) {
    const leagueOps = useKboForm
      ? config.kboRollingLeagueOps ?? 0.745
      : config.npbRollingLeagueOps ?? 0.67;
    const leagueWhip = useKboForm
      ? config.kboRollingLeagueWhip ?? 1.46
      : config.npbRollingLeagueWhip ?? 1.22;
    const homeOpsMul = offenseFormMultiplier(homeTeamStats?.ops_30, leagueOps);
    const awayOpsMul = offenseFormMultiplier(awayTeamStats?.ops_30, leagueOps);
    const homeFaceWhip = staffWhipMultiplier(awayTeamStats?.whip_30, leagueWhip);
    const awayFaceWhip = staffWhipMultiplier(homeTeamStats?.whip_30, leagueWhip);
    if (
      homeOpsMul !== 1 ||
      awayOpsMul !== 1 ||
      homeFaceWhip !== 1 ||
      awayFaceWhip !== 1
    ) {
      homeRuns *= homeOpsMul * homeFaceWhip;
      awayRuns *= awayOpsMul * awayFaceWhip;
      const src = useKboForm ? 'KBO 官網' : 'NPB baseball-data';
      factors.push(
        `${src} 形態` +
          ` 主OPS ${homeTeamStats?.ops_30?.toFixed?.(3) ?? '-'}×${homeOpsMul.toFixed(2)}` +
          ` 客OPS ${awayTeamStats?.ops_30?.toFixed?.(3) ?? '-'}×${awayOpsMul.toFixed(2)}` +
          ` · 對WHIP×${homeFaceWhip.toFixed(2)}/${awayFaceWhip.toFixed(2)}`
      );
    }
  }

  const modelTotal = homeRuns + awayRuns;
  const homeStrength = eloToStrength(homeElo);
  const awayStrength = eloToStrength(awayElo);
  const winP = eloHomeWinProb(homeElo, awayElo);

  return {
    homeRuns,
    awayRuns,
    modelTotal,
    leagueRpg,
    factors,
    homeElo,
    awayElo,
    eloHomeWinProb: winP,
    homeStrength,
    awayStrength,
  };
}
