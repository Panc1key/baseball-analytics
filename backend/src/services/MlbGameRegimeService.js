/**
 * MLB 賽事型態（Game Regime）。
 *
 * Phase 1：賽後標籤 + 賽前分離度驗證。
 * Phase 2：soft 調整 dispersion／不對稱得分機會。
 *
 * 產品哲學（崩盤）：
 * - 崩盤只需識別「會崩」，不必估準 15 分還是 100 分。
 * - 驗收以崩盤識別、非崩盤場比分、勝方方向為主；
 *   不以崩盤場總分 MAE 當過關條件。
 */

import { resolveMlbParkFactor } from '../data/parkFactors.js';

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseInningsPitched(raw) {
  if (raw == null || raw === '') return null;
  const text = String(raw);
  const n = Number(
    text.replace(/(\d+)\.1$/, '$1.333').replace(/(\d+)\.2$/, '$1.666')
  );
  return Number.isFinite(n) ? n : null;
}

function mean(arr) {
  const vals = arr.filter((v) => Number.isFinite(v));
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[idx];
}

export const MLB_GAME_REGIME_VERSION = 'mlb-game-regime-v1';
export const MLB_GAME_REGIMES = Object.freeze(['duel', 'normal', 'blowup']);

/**
 * 從單邊 boxscore 抽出先發／牛棚投球線。
 */
export function extractSidePitchingLine(boxscore, side) {
  const team = boxscore?.teams?.[side];
  if (!team) return null;
  const pitcherIds = Array.isArray(team.pitchers) ? team.pitchers : [];
  const lines = pitcherIds.map((id) => {
    const player = team.players?.[`ID${id}`];
    const pitching = player?.stats?.pitching || {};
    const position = player?.position?.abbreviation || null;
    return {
      id,
      name: player?.person?.fullName || String(id),
      position,
      ip: parseInningsPitched(pitching.inningsPitched),
      er: finite(pitching.earnedRuns, 0),
      r: finite(pitching.runs, 0),
      h: finite(pitching.hits, 0),
      bb: finite(pitching.baseOnBalls, 0),
      k: finite(pitching.strikeOuts, 0),
      pitches: finite(pitching.numberOfPitches, 0),
      note: pitching.note || null,
    };
  });
  const starter = lines[0] || null;
  const bullpen = lines.slice(1);
  const bullpenER = bullpen.reduce((s, p) => s + (p.er || 0), 0);
  const bullpenR = bullpen.reduce((s, p) => s + (p.r || 0), 0);
  const bullpenIP = bullpen.reduce((s, p) => s + (p.ip || 0), 0);
  const likelyPositionPlayerPitching = bullpen.some((p) =>
    p.position && !['P', 'TWP'].includes(String(p.position).toUpperCase())
  );
  return {
    teamName: team.team?.name || side,
    starter,
    bullpen,
    bullpenCount: bullpen.length,
    bullpenER,
    bullpenR,
    bullpenIP: Number(bullpenIP.toFixed(3)),
    pitcherCount: lines.length,
    likelyPositionPlayerPitching,
  };
}

function starterCollapsed(starter) {
  if (!starter) return false;
  const ip = starter.ip;
  const er = starter.er ?? 0;
  const r = starter.r ?? 0;
  if (er >= 7 || r >= 8) return true;
  if (ip != null && ip < 4 && (er >= 5 || r >= 5)) return true;
  if (ip != null && ip < 3 && (er >= 3 || r >= 4)) return true;
  return false;
}

function bullpenCollapsed(sideLine) {
  if (!sideLine) return false;
  if (sideLine.likelyPositionPlayerPitching) return true;
  if (sideLine.bullpenER >= 6 && sideLine.bullpenCount >= 3) return true;
  if (sideLine.bullpenER >= 8) return true;
  return false;
}

/**
 * 賽後真相標籤（優先用 boxscore）。
 * Blowup 優先於 Duel，避免高分場被誤標。
 */
export function labelGameRegimeFromBoxscore(boxscore, {
  homeScore = null,
  awayScore = null,
} = {}) {
  const home = extractSidePitchingLine(boxscore, 'home');
  const away = extractSidePitchingLine(boxscore, 'away');
  const homeRuns = finite(homeScore, finite(boxscore?.teams?.home?.teamStats?.batting?.runs));
  const awayRuns = finite(awayScore, finite(boxscore?.teams?.away?.teamStats?.batting?.runs));
  if (homeRuns == null || awayRuns == null || !home || !away) {
    return {
      regime: null,
      reason: 'boxscore_or_score_missing',
      totalRuns: null,
      details: { home, away },
    };
  }
  const totalRuns = homeRuns + awayRuns;
  const homeStarterBad = starterCollapsed(home.starter);
  const awayStarterBad = starterCollapsed(away.starter);
  const homeBullpenBad = bullpenCollapsed(home);
  const awayBullpenBad = bullpenCollapsed(away);
  const pitchingCollapse =
    homeStarterBad || awayStarterBad || homeBullpenBad || awayBullpenBad;

  if (totalRuns >= 14 || pitchingCollapse) {
    return {
      regime: 'blowup',
      reason: totalRuns >= 14
        ? (pitchingCollapse ? 'high_total_and_pitching_collapse' : 'high_total')
        : 'pitching_collapse',
      totalRuns,
      details: {
        homeRuns,
        awayRuns,
        homeStarterBad,
        awayStarterBad,
        homeBullpenBad,
        awayBullpenBad,
        home,
        away,
      },
    };
  }

  const homeStarter = home.starter;
  const awayStarter = away.starter;
  const bothStartersDeep =
    homeStarter?.ip != null &&
    awayStarter?.ip != null &&
    homeStarter.ip >= 5 &&
    awayStarter.ip >= 5;
  const bothStartersTight =
    (homeStarter?.er ?? 99) <= 2 &&
    (awayStarter?.er ?? 99) <= 2;
  if (totalRuns <= 5 && bothStartersDeep && bothStartersTight) {
    return {
      regime: 'duel',
      reason: 'low_total_quality_starters',
      totalRuns,
      details: {
        homeRuns,
        awayRuns,
        homeStarterBad,
        awayStarterBad,
        homeBullpenBad,
        awayBullpenBad,
        home,
        away,
      },
    };
  }

  return {
    regime: 'normal',
    reason: 'default',
    totalRuns,
    details: {
      homeRuns,
      awayRuns,
      homeStarterBad,
      awayStarterBad,
      homeBullpenBad,
      awayBullpenBad,
      home,
      away,
    },
  };
}

/** 僅比分的弱標籤（無 boxscore 時對照用）。 */
export function labelGameRegimeFromScores(homeScore, awayScore) {
  const homeRuns = finite(homeScore);
  const awayRuns = finite(awayScore);
  if (homeRuns == null || awayRuns == null) {
    return { regime: null, reason: 'score_missing', totalRuns: null };
  }
  const totalRuns = homeRuns + awayRuns;
  if (totalRuns >= 14) {
    return { regime: 'blowup', reason: 'score_only_high_total', totalRuns };
  }
  if (totalRuns <= 5) {
    return { regime: 'duel', reason: 'score_only_low_total', totalRuns };
  }
  return { regime: 'normal', reason: 'score_only_mid_total', totalRuns };
}

function expectedStarterInnings(pitcher, recent) {
  const seasonIp = finite(pitcher?.inningsPitched);
  const seasonStarts = finite(pitcher?.gamesStarted);
  const seasonExp = seasonStarts > 0 ? seasonIp / seasonStarts : null;
  const recentStarts = finite(recent?.startsObserved);
  const recentIp = finite(recent?.recent3Innings);
  const recentExp = recentStarts > 0 ? recentIp / recentStarts : null;
  return finite(recentExp, finite(seasonExp));
}

/**
 * 近 3 場先發波動：優先用逐場計數；舊 feature row 無欄位時用聚合代理。
 * 提早退場：IP < 4；爆分：ER>=5 或短局高失分。
 */
export function resolvePitcherStartVolatility(recent) {
  if (!recent || typeof recent !== 'object') {
    return {
      earlyExitsLast3: 0,
      blowupStartsLast3: 0,
      minIpLast3: null,
      maxErLast3: null,
      source: 'missing',
    };
  }
  const hasExplicit =
    recent.earlyExitsLast3 != null ||
    recent.blowupStartsLast3 != null ||
    recent.minIpLast3 != null ||
    recent.maxErLast3 != null;
  if (hasExplicit) {
    return {
      earlyExitsLast3: Math.max(0, Math.floor(finite(recent.earlyExitsLast3, 0))),
      blowupStartsLast3: Math.max(0, Math.floor(finite(recent.blowupStartsLast3, 0))),
      minIpLast3: finite(recent.minIpLast3),
      maxErLast3: finite(recent.maxErLast3),
      source: 'explicit',
    };
  }

  const starts = Math.max(0, Math.floor(finite(recent.startsObserved, 0)));
  const ip = finite(recent.recent3Innings);
  const era = finite(recent.recent3Era);
  if (!starts || ip == null) {
    return {
      earlyExitsLast3: 0,
      blowupStartsLast3: 0,
      minIpLast3: null,
      maxErLast3: null,
      source: 'proxy_empty',
    };
  }
  const avgIp = ip / starts;
  let earlyExitsLast3 = 0;
  if (avgIp < 3.5) earlyExitsLast3 = Math.min(starts, 2);
  else if (avgIp < 4.2) earlyExitsLast3 = 1;

  // 代理爆分要更嚴，避免「雙邊 ERA 略差」就變 high_total
  let blowupStartsLast3 = 0;
  if (era != null && era >= 7.5 && avgIp <= 4.5) blowupStartsLast3 = Math.min(starts, 2);
  else if (era != null && era >= 7 && avgIp <= 4) blowupStartsLast3 = 1;
  else if (era != null && era >= 6.5 && avgIp < 3.8) blowupStartsLast3 = 1;

  return {
    earlyExitsLast3,
    blowupStartsLast3,
    minIpLast3: Number(avgIp.toFixed(3)),
    maxErLast3: null,
    source: 'proxy',
  };
}

/**
 * 從賽前 feature row 抽出波動／型態候選訊號。
 */
export function buildPregameRegimeSignals(features) {
  const homeP = features?.pitchers?.home || null;
  const awayP = features?.pitchers?.away || null;
  const homeR = features?.pitchers?.homeRecent || null;
  const awayR = features?.pitchers?.awayRecent || null;
  const homeBp = features?.bullpen?.home || null;
  const awayBp = features?.bullpen?.away || null;

  const homeSeasonEra = finite(homeP?.era);
  const awaySeasonEra = finite(awayP?.era);
  const homeRecentEra = finite(homeR?.recent3Era, homeSeasonEra);
  const awayRecentEra = finite(awayR?.recent3Era, awaySeasonEra);
  const homeEraGap = homeRecentEra != null && homeSeasonEra != null
    ? homeRecentEra - homeSeasonEra
    : null;
  const awayEraGap = awayRecentEra != null && awaySeasonEra != null
    ? awayRecentEra - awaySeasonEra
    : null;
  const homeExpIp = expectedStarterInnings(homeP, homeR);
  const awayExpIp = expectedStarterInnings(awayP, awayR);
  const homeBullpenPitches = finite(homeBp?.pitchesLast3);
  const awayBullpenPitches = finite(awayBp?.pitchesLast3);
  const homeOffenseRpg = finite(features?.home?.recentRunsPerGame);
  const awayOffenseRpg = finite(features?.away?.recentRunsPerGame);
  const homeVol = resolvePitcherStartVolatility(homeR);
  const awayVol = resolvePitcherStartVolatility(awayR);
  const parkFactor = resolveMlbParkFactor({
    venueName: features?.venueName || features?.venue?.name,
    homeTeam: features?.homeTeam || features?.home?.teamName,
  });

  const maxRecentEra = Math.max(homeRecentEra ?? 0, awayRecentEra ?? 0);
  const maxEraGap = Math.max(homeEraGap ?? 0, awayEraGap ?? 0);
  const minExpIp = Math.min(
    homeExpIp ?? 9,
    awayExpIp ?? 9
  );
  const maxBullpenPitches = Math.max(
    homeBullpenPitches ?? 0,
    awayBullpenPitches ?? 0
  );
  const avgRecentEra = mean([homeRecentEra, awayRecentEra]);
  const avgExpIp = mean([homeExpIp, awayExpIp]);
  const avgBullpenPitches = mean([homeBullpenPitches, awayBullpenPitches]);

  // 不對稱：強打線打近期失控先發 → 對面得分機會上升風險
  const homePitchingBlowupRisk =
    (awayOffenseRpg != null && homeRecentEra != null && awayOffenseRpg >= 5 && homeRecentEra >= 5.2 ? 1 : 0) +
    (homeEraGap != null && homeEraGap >= 1.5 ? 1 : 0) +
    (homeExpIp != null && homeExpIp <= 4.5 ? 1 : 0) +
    (homeBullpenPitches != null && homeBullpenPitches >= 220 ? 1 : 0) +
    (homeVol.earlyExitsLast3 >= 1 ? 1 : 0) +
    (homeVol.blowupStartsLast3 >= 1 ? 1 : 0);
  const awayPitchingBlowupRisk =
    (homeOffenseRpg != null && awayRecentEra != null && homeOffenseRpg >= 5 && awayRecentEra >= 5.2 ? 1 : 0) +
    (awayEraGap != null && awayEraGap >= 1.5 ? 1 : 0) +
    (awayExpIp != null && awayExpIp <= 4.5 ? 1 : 0) +
    (awayBullpenPitches != null && awayBullpenPitches >= 220 ? 1 : 0) +
    (awayVol.earlyExitsLast3 >= 1 ? 1 : 0) +
    (awayVol.blowupStartsLast3 >= 1 ? 1 : 0);

  return {
    homeRecentEra,
    awayRecentEra,
    homeSeasonEra,
    awaySeasonEra,
    homeEraGap,
    awayEraGap,
    homeExpIp,
    awayExpIp,
    homeBullpenPitches,
    awayBullpenPitches,
    homeOffenseRpg,
    awayOffenseRpg,
    homeEarlyExitsLast3: homeVol.earlyExitsLast3,
    awayEarlyExitsLast3: awayVol.earlyExitsLast3,
    homeBlowupStartsLast3: homeVol.blowupStartsLast3,
    awayBlowupStartsLast3: awayVol.blowupStartsLast3,
    homeMinIpLast3: homeVol.minIpLast3,
    awayMinIpLast3: awayVol.minIpLast3,
    parkFactor,
    volatilitySource: homeVol.source === 'explicit' || awayVol.source === 'explicit'
      ? 'explicit_or_mixed'
      : homeVol.source,
    maxRecentEra,
    maxEraGap,
    minExpIp,
    maxBullpenPitches,
    avgRecentEra,
    avgExpIp,
    avgBullpenPitches,
    homePitchingBlowupRisk,
    awayPitchingBlowupRisk,
    eitherPitchingBlowupRisk: Math.max(homePitchingBlowupRisk, awayPitchingBlowupRisk),
    bothPitchingStable:
      (homeRecentEra != null && homeRecentEra <= 3.8 ? 1 : 0) +
      (awayRecentEra != null && awayRecentEra <= 3.8 ? 1 : 0) +
      (homeExpIp != null && homeExpIp >= 5.5 ? 1 : 0) +
      (awayExpIp != null && awayExpIp >= 5.5 ? 1 : 0),
  };
}

/**
 * 賽前型態打分 v2.1（提高 duel／high_total precision）。
 *
 * - duel：雙邊都緊且深局，且近 3 場無提早退場／爆分
 * - one_sided：單邊不穩 → 分差風險，禁止自動押大
 * - high_total：雙邊波動確認（雙邊爆分／雙提早退場／雙熱+牛棚），門檻更高
 */
export function scoreGameRegimeFromPregame(signals) {
  const reasons = [];
  const homeTight = signals.homeRecentEra != null && signals.homeRecentEra <= 3.8;
  const awayTight = signals.awayRecentEra != null && signals.awayRecentEra <= 3.8;
  const homeHot = signals.homeRecentEra != null && signals.homeRecentEra >= 5.2;
  const awayHot = signals.awayRecentEra != null && signals.awayRecentEra >= 5.2;
  const homeOk = signals.homeRecentEra != null && signals.homeRecentEra < 5.2;
  const awayOk = signals.awayRecentEra != null && signals.awayRecentEra < 5.2;
  const homeDeep = signals.homeExpIp != null && signals.homeExpIp >= 5.5;
  const awayDeep = signals.awayExpIp != null && signals.awayExpIp >= 5.5;
  const homeRisk = Number(signals.homePitchingBlowupRisk) || 0;
  const awayRisk = Number(signals.awayPitchingBlowupRisk) || 0;
  const homeEarly = Number(signals.homeEarlyExitsLast3) || 0;
  const awayEarly = Number(signals.awayEarlyExitsLast3) || 0;
  const homeBlowups = Number(signals.homeBlowupStartsLast3) || 0;
  const awayBlowups = Number(signals.awayBlowupStartsLast3) || 0;
  const eitherRecentVolatile =
    homeEarly >= 1 || awayEarly >= 1 || homeBlowups >= 1 || awayBlowups >= 1;
  const bothBullpenFresh =
    signals.homeBullpenPitches != null &&
    signals.awayBullpenPitches != null &&
    signals.homeBullpenPitches <= 170 &&
    signals.awayBullpenPitches <= 170;
  const bothBullpenOverloaded =
    signals.homeBullpenPitches != null &&
    signals.awayBullpenPitches != null &&
    signals.homeBullpenPitches >= 210 &&
    signals.awayBullpenPitches >= 210;
  const bothOffenseQuiet =
    signals.homeOffenseRpg != null &&
    signals.awayOffenseRpg != null &&
    signals.homeOffenseRpg <= 4.3 &&
    signals.awayOffenseRpg <= 4.3;
  const bothOffenseLoud =
    signals.homeOffenseRpg != null &&
    signals.awayOffenseRpg != null &&
    signals.homeOffenseRpg >= 5.0 &&
    signals.awayOffenseRpg >= 5.0;
  const eitherOffenseLoud =
    (signals.homeOffenseRpg != null && signals.homeOffenseRpg >= 5.2) ||
    (signals.awayOffenseRpg != null && signals.awayOffenseRpg >= 5.2);
  const parkFactor = Number(signals.parkFactor);
  const hitterPark = Number.isFinite(parkFactor) && parkFactor >= 1.05;
  const pitcherPark = Number.isFinite(parkFactor) && parkFactor <= 0.96;

  // --- duel：雙緊+雙深，且無近況波動；打者公園否決 ---
  let duelScore = 0;
  if (eitherRecentVolatile) {
    reasons.push('recent_start_volatility_vetoes_duel');
  } else if (hitterPark) {
    reasons.push('hitter_park_vetoes_duel');
  } else if (homeTight && awayTight && homeDeep && awayDeep) {
    duelScore += 5;
    reasons.push('both_tight_and_deep');
    if (bothBullpenFresh) {
      duelScore += 1;
      reasons.push('bullpens_fresh');
    }
    if (bothOffenseQuiet) {
      duelScore += 1;
      reasons.push('both_offenses_quiet');
    }
    if (pitcherPark) {
      duelScore += 1;
      reasons.push('pitcher_park_supports_duel');
    }
    if (eitherOffenseLoud || bothOffenseLoud) {
      duelScore = Math.max(0, duelScore - 3);
      reasons.push('loud_offense_undercuts_duel');
    }
  } else if (homeTight && awayTight) {
    duelScore += 2;
    reasons.push('both_starters_tight_but_not_deep');
  } else if (homeTight || awayTight) {
    duelScore += 1;
    reasons.push(homeTight ? 'only_home_starter_tight' : 'only_away_starter_tight');
  }
  if (
    duelScore > 0 &&
    (
      (signals.homeBullpenPitches != null && signals.homeBullpenPitches >= 230) ||
      (signals.awayBullpenPitches != null && signals.awayBullpenPitches >= 230)
    )
  ) {
    duelScore = Math.max(0, duelScore - 2);
    reasons.push('bullpen_load_undercuts_duel');
  }

  // --- one_sided：恰好一邊熱／高風險／波動 ---
  let oneSidedScore = 0;
  const homeUnstable =
    homeHot || homeRisk >= 2 || homeEarly >= 1 || homeBlowups >= 1;
  const awayUnstable =
    awayHot || awayRisk >= 2 || awayEarly >= 1 || awayBlowups >= 1;
  if (homeUnstable && !awayUnstable && awayOk) {
    oneSidedScore += 4;
    reasons.push('home_pitching_unstable_away_ok');
  } else if (awayUnstable && !homeUnstable && homeOk) {
    oneSidedScore += 4;
    reasons.push('away_pitching_unstable_home_ok');
  } else if ((homeTight && awayHot) || (awayTight && homeHot)) {
    oneSidedScore += 5;
    reasons.push('stable_vs_hot_starter_mismatch');
  } else if ((homeRisk >= 2 && awayRisk <= 1) || (awayRisk >= 2 && homeRisk <= 1)) {
    oneSidedScore += 3;
    reasons.push('asymmetric_pitching_risk');
  }

  // --- high_total：要雙邊波動確認；單純雙熱／代理爆分不夠 ---
  let highTotalScore = 0;
  if (homeBlowups >= 1 && awayBlowups >= 1) {
    highTotalScore += 3;
    reasons.push('both_sides_recent_blowup_starts');
    if (bothBullpenOverloaded || bothOffenseLoud || (homeEarly >= 1 && awayEarly >= 1)) {
      highTotalScore += 4;
      reasons.push('both_blowups_confirmed');
    }
  } else if (homeEarly >= 1 && awayEarly >= 1 && homeHot && awayHot) {
    highTotalScore += 3;
    reasons.push('both_early_exits_and_both_hot');
    if (bothBullpenOverloaded || bothOffenseLoud) {
      highTotalScore += 3;
      reasons.push('both_early_hot_confirmed');
    }
  }
  if (homeHot && awayHot) {
    highTotalScore += 1;
    reasons.push('both_starters_hot_weak');
  }
  if (homeHot && awayHot && (bothBullpenOverloaded || bothOffenseLoud)) {
    highTotalScore += 7;
    reasons.push('both_hot_confirmed_by_offense_or_bullpen_load');
  } else if (bothBullpenOverloaded && homeUnstable && awayUnstable) {
    highTotalScore += 2;
    reasons.push('both_bullpens_overloaded_and_both_unstable');
  }
  if (hitterPark && homeUnstable && awayUnstable) {
    highTotalScore += 2;
    reasons.push('hitter_park_with_both_unstable');
  }
  if (pitcherPark) {
    highTotalScore = Math.max(0, highTotalScore - 2);
    reasons.push('pitcher_park_undercuts_high_total');
  }
  if (homeRisk >= 3 && awayRisk >= 3 && homeHot && awayHot) {
    highTotalScore += 1;
    reasons.push('both_sides_elevated_pitching_risk');
  }

  // 衝突處理：雙邊都緊且無波動時，壓低 one_sided
  if (homeTight && awayTight && !eitherRecentVolatile) {
    oneSidedScore = Math.min(oneSidedScore, 2);
  }
  // 只有一邊熱／波動時，不要算成 high_total
  if ((homeUnstable && !awayUnstable) || (awayUnstable && !homeUnstable)) {
    highTotalScore = Math.min(highTotalScore, 2);
  }

  const scores = {
    duel: duelScore,
    one_sided: oneSidedScore,
    high_total: highTotalScore,
  };
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topKey, topScore] = ranked[0];
  const secondScore = ranked[1][1];

  // duel／high_total：提高門檻換 precision，但 duel 不再用極嚴的 7
  // （7 只剩約 0.5% 場次，產品上等於幾乎不喊）
  let predicted = 'normal';
  const threshold = topKey === 'high_total' ? 8 : topKey === 'duel' ? 5 : 4;
  if (topScore >= threshold && topScore >= secondScore + 2) {
    predicted = topKey;
  } else if (
    topKey === 'one_sided' &&
    topScore >= 4 &&
    secondScore >= 4 &&
    Math.abs(topScore - secondScore) <= 1
  ) {
    predicted = 'unclear';
    reasons.push('conflicting_regime_signals');
  } else if (topKey === 'one_sided' && topScore >= 5) {
    predicted = topKey;
  } else if (topScore >= threshold + 1) {
    predicted = topKey;
  }

  const blowupScore = highTotalScore;
  return {
    duelScore,
    oneSidedScore,
    highTotalScore,
    blowupScore,
    predicted,
    reasons,
    scores,
  };
}

/**
 * 舊三分類兼容（給仍讀 duel/blowup/normal 的報表）。
 */
export function toLegacyRegimeLabel(predicted) {
  if (predicted === 'duel') return 'duel';
  if (predicted === 'high_total') return 'blowup';
  if (predicted === 'one_sided') return 'blowup';
  if (predicted === 'unclear') return 'normal';
  return 'normal';
}

export const MLB_GAME_REGIME_DETECTION_VERSION = 'mlb-regime-detection-v2';
export const MLB_GAME_REGIMES_V2 = Object.freeze([
  'duel',
  'one_sided',
  'high_total',
  'normal',
]);

/**
 * 賽後真相標籤 v2（對齊產品四類，不再把單邊崩併進 blowup）。
 *
 * - duel：低總分 + 雙先發深且緊
 * - one_sided：恰好一邊投球崩／大分差／高分但單邊灌分
 * - high_total：雙邊投球崩，或高總分且雙邊都有得分
 * - normal：其餘
 */
export function labelGameRegimeV2FromBoxscore(boxscore, {
  homeScore = null,
  awayScore = null,
} = {}) {
  const legacy = labelGameRegimeFromBoxscore(boxscore, { homeScore, awayScore });
  if (!legacy.regime) {
    return {
      ...legacy,
      taxonomy: 'v2',
      margin: null,
    };
  }

  const homeRuns = legacy.details?.homeRuns;
  const awayRuns = legacy.details?.awayRuns;
  const totalRuns = legacy.totalRuns;
  const margin = Math.abs(homeRuns - awayRuns);
  const homeCollapsed = Boolean(
    legacy.details?.homeStarterBad || legacy.details?.homeBullpenBad
  );
  const awayCollapsed = Boolean(
    legacy.details?.awayStarterBad || legacy.details?.awayBullpenBad
  );
  const minRuns = Math.min(homeRuns, awayRuns);

  const base = {
    taxonomy: 'v2',
    totalRuns,
    margin,
    details: {
      ...legacy.details,
      homeCollapsed,
      awayCollapsed,
    },
  };

  if (legacy.regime === 'duel') {
    return { ...base, regime: 'duel', reason: legacy.reason };
  }

  if (homeCollapsed !== awayCollapsed) {
    return {
      ...base,
      regime: 'one_sided',
      reason: homeCollapsed ? 'home_pitching_collapse' : 'away_pitching_collapse',
    };
  }

  if (homeCollapsed && awayCollapsed) {
    return {
      ...base,
      regime: 'high_total',
      reason: 'both_sides_pitching_collapse',
    };
  }

  if (totalRuns >= 14 && minRuns >= 4) {
    return {
      ...base,
      regime: 'high_total',
      reason: 'high_total_both_sides_scoring',
    };
  }

  if (totalRuns >= 14) {
    return {
      ...base,
      regime: 'one_sided',
      reason: 'lopsided_high_total',
    };
  }

  if (margin >= 6) {
    return {
      ...base,
      regime: 'one_sided',
      reason: 'large_margin',
    };
  }

  return {
    ...base,
    regime: 'normal',
    reason: legacy.reason === 'default' ? 'default' : `legacy_${legacy.reason}`,
  };
}

/** 僅比分的弱標籤 v2（無 boxscore 時對照用）。 */
export function labelGameRegimeV2FromScores(homeScore, awayScore) {
  const homeRuns = finite(homeScore);
  const awayRuns = finite(awayScore);
  if (homeRuns == null || awayRuns == null) {
    return {
      regime: null,
      reason: 'score_missing',
      totalRuns: null,
      margin: null,
      taxonomy: 'v2',
    };
  }
  const totalRuns = homeRuns + awayRuns;
  const margin = Math.abs(homeRuns - awayRuns);
  const minRuns = Math.min(homeRuns, awayRuns);
  if (totalRuns <= 5) {
    return {
      regime: 'duel',
      reason: 'score_only_low_total',
      totalRuns,
      margin,
      taxonomy: 'v2',
    };
  }
  if (totalRuns >= 14 && minRuns >= 4) {
    return {
      regime: 'high_total',
      reason: 'score_only_high_total_both_sides',
      totalRuns,
      margin,
      taxonomy: 'v2',
    };
  }
  if (totalRuns >= 14 || margin >= 6) {
    return {
      regime: 'one_sided',
      reason: totalRuns >= 14 ? 'score_only_lopsided_high_total' : 'score_only_large_margin',
      totalRuns,
      margin,
      taxonomy: 'v2',
    };
  }
  return {
    regime: 'normal',
    reason: 'score_only_mid_total',
    totalRuns,
    margin,
    taxonomy: 'v2',
  };
}

function confusionMatrixV2(rows) {
  const matrix = Object.fromEntries(
    MLB_GAME_REGIMES_V2.map((trueLabel) => [
      trueLabel,
      Object.fromEntries(MLB_GAME_REGIMES_V2.map((pred) => [pred, 0])),
    ])
  );
  for (const row of rows) {
    const trueRegime = row.trueRegime;
    const predicted = normalizePredictedRegimeV2(row.predicted);
    if (!matrix[trueRegime] || matrix[trueRegime][predicted] == null) continue;
    matrix[trueRegime][predicted] += 1;
  }
  return matrix;
}

function normalizePredictedRegimeV2(predicted) {
  if (predicted === 'duel') return 'duel';
  if (predicted === 'one_sided') return 'one_sided';
  if (predicted === 'high_total') return 'high_total';
  // unclear／舊 blowup 等：不計入 actionable 精準度分子時，歸 normal
  return 'normal';
}

function classMetricsV2(matrix, label) {
  const tp = matrix[label][label];
  const fp = MLB_GAME_REGIMES_V2
    .filter((k) => k !== label)
    .reduce((s, k) => s + matrix[k][label], 0);
  const fn = MLB_GAME_REGIMES_V2
    .filter((k) => k !== label)
    .reduce((s, k) => s + matrix[label][k], 0);
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  return {
    support: tp + fn,
    predicted: tp + fp,
    precision: precision == null ? null : Number(precision.toFixed(4)),
    recall: recall == null ? null : Number(recall.toFixed(4)),
  };
}

/**
 * Detection 主 KPI：賽前預測 vs 賽後 v2 真相。
 * 不以大小球 lean 命中率過關。
 *
 * rows: { trueRegime, predicted, totalRuns, margin, duelScore, oneSidedScore, highTotalScore, ... }
 */
export function summarizeRegimeDetectionV2(rows) {
  const labeled = rows.filter((r) => MLB_GAME_REGIMES_V2.includes(r.trueRegime));
  const counts = Object.fromEntries(
    MLB_GAME_REGIMES_V2.map((k) => [k, labeled.filter((r) => r.trueRegime === k).length])
  );
  const matrix = confusionMatrixV2(labeled);
  const overallMeanTotal = mean(labeled.map((r) => r.totalRuns));
  const overallMeanMargin = mean(labeled.map((r) => r.margin));

  const outcomeByPredicted = {};
  for (const pred of [...MLB_GAME_REGIMES_V2, 'unclear']) {
    const subset = labeled.filter((r) => (r.predicted || 'normal') === pred);
    outcomeByPredicted[pred] = {
      n: subset.length,
      meanTotal: mean(subset.map((r) => r.totalRuns)),
      meanMargin: mean(subset.map((r) => r.margin)),
    };
    if (outcomeByPredicted[pred].meanTotal != null) {
      outcomeByPredicted[pred].meanTotal = Number(
        outcomeByPredicted[pred].meanTotal.toFixed(3)
      );
    }
    if (outcomeByPredicted[pred].meanMargin != null) {
      outcomeByPredicted[pred].meanMargin = Number(
        outcomeByPredicted[pred].meanMargin.toFixed(3)
      );
    }
  }

  const byClass = Object.fromEntries(
    MLB_GAME_REGIMES_V2.map((k) => [k, classMetricsV2(matrix, k)])
  );

  return {
    version: MLB_GAME_REGIME_DETECTION_VERSION,
    n: labeled.length,
    baseRates: Object.fromEntries(
      MLB_GAME_REGIMES_V2.map((k) => [
        k,
        labeled.length ? Number((counts[k] / labeled.length).toFixed(4)) : null,
      ])
    ),
    counts,
    meanTotalByTrueRegime: Object.fromEntries(
      MLB_GAME_REGIMES_V2.map((k) => [
        k,
        Number(
          mean(labeled.filter((r) => r.trueRegime === k).map((r) => r.totalRuns))?.toFixed(3)
        ),
      ])
    ),
    meanMarginByTrueRegime: Object.fromEntries(
      MLB_GAME_REGIMES_V2.map((k) => [
        k,
        Number(
          mean(labeled.filter((r) => r.trueRegime === k).map((r) => r.margin))?.toFixed(3)
        ),
      ])
    ),
    overallMeanTotal: overallMeanTotal == null
      ? null
      : Number(overallMeanTotal.toFixed(3)),
    overallMeanMargin: overallMeanMargin == null
      ? null
      : Number(overallMeanMargin.toFixed(3)),
    outcomeByPredicted,
    detection: {
      byClass,
      confusion: matrix,
      // predicted unclear 另計；歸入 normal 的 confusion 僅供對齊四類
      predictedUnclear: labeled.filter((r) => r.predicted === 'unclear').length,
    },
    lifts: {
      top20DuelScore: topQuantileLift(labeled, 'duelScore', 'duel', 0.8),
      top20OneSidedScore: topQuantileLift(labeled, 'oneSidedScore', 'one_sided', 0.8),
      top20HighTotalScore: topQuantileLift(
        labeled,
        'highTotalScore',
        'high_total',
        0.8
      ),
    },
    ignoredMetric: 'totals_lean_hit_rate_not_used_for_pass',
  };
}

/**
 * Detection 過關旗標（研究用）：看分離結構，不看 lean 命中。
 */
export function evaluateRegimeDetectionV2Pass(summary) {
  const duelPred = summary?.outcomeByPredicted?.duel;
  const highPred = summary?.outcomeByPredicted?.high_total;
  const onePred = summary?.outcomeByPredicted?.one_sided;
  const overallTotal = summary?.overallMeanTotal;
  const overallMargin = summary?.overallMeanMargin;
  const duelClass = summary?.detection?.byClass?.duel;
  const highClass = summary?.detection?.byClass?.high_total;
  const oneClass = summary?.detection?.byClass?.one_sided;
  const duelBase = summary?.baseRates?.duel ?? 0;
  const highBase = summary?.baseRates?.high_total ?? 0;
  const oneBase = summary?.baseRates?.one_sided ?? 0;

  const duelTotalSeparated =
    duelPred?.n > 0 &&
    Number.isFinite(duelPred.meanTotal) &&
    Number.isFinite(overallTotal) &&
    duelPred.meanTotal <= overallTotal - 1.0;
  const highTotalSeparated =
    highPred?.n > 0 &&
    Number.isFinite(highPred.meanTotal) &&
    Number.isFinite(overallTotal) &&
    highPred.meanTotal >= overallTotal + 1.5;
  const oneSidedMarginSeparated =
    onePred?.n > 0 &&
    Number.isFinite(onePred.meanMargin) &&
    Number.isFinite(overallMargin) &&
    onePred.meanMargin >= overallMargin * 1.1;

  const duelPrecisionLift =
    duelClass?.precision != null && duelBase > 0
      ? duelClass.precision / duelBase
      : null;
  const highPrecisionLift =
    highClass?.precision != null && highBase > 0
      ? highClass.precision / highBase
      : null;
  const onePrecisionLift =
    oneClass?.precision != null && oneBase > 0
      ? oneClass.precision / oneBase
      : null;

  const pass = {
    duelTotalSeparated,
    highTotalSeparated,
    oneSidedMarginSeparated,
    duelPrecisionLiftAtLeast1_3: duelPrecisionLift != null && duelPrecisionLift >= 1.3,
    highPrecisionLiftAtLeast1_3: highPrecisionLift != null && highPrecisionLift >= 1.3,
    onePrecisionLiftAtLeast1_2: onePrecisionLift != null && onePrecisionLift >= 1.2,
  };

  const detectionPromising =
    pass.duelTotalSeparated ||
    pass.highTotalSeparated ||
    pass.oneSidedMarginSeparated ||
    pass.duelPrecisionLiftAtLeast1_3 ||
    pass.highPrecisionLiftAtLeast1_3;

  return {
    ...pass,
    lifts: {
      duelPrecisionLift: duelPrecisionLift == null
        ? null
        : Number(duelPrecisionLift.toFixed(3)),
      highPrecisionLift: highPrecisionLift == null
        ? null
        : Number(highPrecisionLift.toFixed(3)),
      onePrecisionLift: onePrecisionLift == null
        ? null
        : Number(onePrecisionLift.toFixed(3)),
    },
    detectionPromising: Boolean(detectionPromising),
    ignoredMetric: 'totals_lean_hit_rate_not_used_for_pass',
    note: '過關看型態分離／precision lift；不以大小球 lean 命中率',
  };
}

export const MLB_GAME_REGIME_PHASE2_VERSION = 'mlb-game-regime-phase2-v1';

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * 連續強度：給 Phase 2 soft 調整用。
 */
export function softRegimeStrengths(scored) {
  const predicted = scored?.predicted || 'normal';
  const duelStrength = predicted === 'duel'
    ? clamp01(((scored?.duelScore ?? 0) - 3) / 5)
    : clamp01(((scored?.duelScore ?? 0) - 5) / 6) * 0.4;
  const highTotalStrength = predicted === 'high_total'
    ? clamp01(((scored?.highTotalScore ?? scored?.blowupScore ?? 0) - 3) / 5)
    : 0;
  const oneSidedStrength = predicted === 'one_sided'
    ? clamp01(((scored?.oneSidedScore ?? 0) - 3) / 5)
    : 0;
  // 舊 blowupStrength：僅高分風險；單邊崩不再當「放大總分方差去追大」
  const blowupStrength = highTotalStrength;

  let dominant = 'normal';
  if (predicted === 'duel') dominant = 'duel';
  else if (predicted === 'high_total') dominant = 'blowup';
  else if (predicted === 'one_sided') dominant = 'one_sided';
  else if (predicted === 'unclear') dominant = 'unclear';

  return {
    duelStrength: Number(duelStrength.toFixed(4)),
    blowupStrength: Number(blowupStrength.toFixed(4)),
    highTotalStrength: Number(highTotalStrength.toFixed(4)),
    oneSidedStrength: Number(oneSidedStrength.toFixed(4)),
    dominant,
  };
}

/**
 * Phase 2 soft 調整。
 *
 * - duel：縮小方差，總分略往下收（投手戰）
 * - blowup：大幅放大方差；對失控投手的對面只做小幅得分機會上修
 *   （識別崩盤＋方向，不追精確爆分）
 */
export function applySoftRegimeAdjustment({
  homeMean,
  awayMean,
  baseDispersion = 8,
  signals,
  scored,
} = {}) {
  const strengths = softRegimeStrengths(scored || scoreGameRegimeFromPregame(signals || {}));
  let home = Number(homeMean);
  let away = Number(awayMean);
  let homeDispersion = Number(baseDispersion);
  let awayDispersion = Number(baseDispersion);
  const notes = [];

  if (!Number.isFinite(home) || !Number.isFinite(away)) {
    return {
      homeMean,
      awayMean,
      homeDispersion: baseDispersion,
      awayDispersion: baseDispersion,
      strengths,
      notes: ['invalid_means'],
      scorePursuitOnBlowup: false,
    };
  }

  if (strengths.dominant === 'duel' || strengths.duelStrength >= 0.45) {
    const d = strengths.duelStrength;
    const shrink = 1 - 0.5 * d;
    homeDispersion *= shrink;
    awayDispersion *= shrink;
    notes.push('duel_compress_dispersion_only');
  }

  if (strengths.dominant === 'one_sided' || strengths.oneSidedStrength >= 0.4) {
    const s = Math.max(strengths.oneSidedStrength, 0.4);
    const homeRisk = Number(signals?.homePitchingBlowupRisk) || 0;
    const awayRisk = Number(signals?.awayPitchingBlowupRisk) || 0;
    // 單邊崩：只放大「可能被打爆那邊對面」的方差，不追總分大
    if (homeRisk >= awayRisk) {
      awayDispersion *= 1 + 0.7 * s;
      notes.push('one_sided_away_scoring_variance_up');
    } else {
      homeDispersion *= 1 + 0.7 * s;
      notes.push('one_sided_home_scoring_variance_up');
    }
  }

  if (strengths.dominant === 'blowup' || strengths.blowupStrength >= 0.4) {
    const b = strengths.blowupStrength;
    homeDispersion *= 1 + 1.25 * b;
    awayDispersion *= 1 + 1.25 * b;
    notes.push('high_total_widen_both_dispersion');
  }

  return {
    homeMean: Number(home.toFixed(4)),
    awayMean: Number(away.toFixed(4)),
    homeDispersion: Number(Math.max(2, homeDispersion).toFixed(4)),
    awayDispersion: Number(Math.max(2, awayDispersion).toFixed(4)),
    strengths,
    notes,
    scorePursuitOnBlowup: false,
  };
}

/**
 * Phase 2 驗收：崩盤識別優先；比分只看非崩盤場。
 */
export function evaluateRegimePhase2Pass({
  baseline,
  adjusted,
} = {}) {
  const blowupLiftImproved =
    (adjusted?.blowupDetection?.lift ?? 0) > (baseline?.blowupDetection?.lift ?? 0) + 0.02;
  const blowupPrecisionOk = (adjusted?.blowupDetection?.precision ?? 0) >= 0.28;
  const directionImproved =
    (adjusted?.directionHitRate ?? 0) >= (baseline?.directionHitRate ?? 0) - 0.003 &&
    (adjusted?.directionHitRateNonBlowup ?? 0) >=
      (baseline?.directionHitRateNonBlowup ?? 0) - 0.003;
  const nonBlowupMaeNotWorse =
    (adjusted?.sideMaeNonBlowup ?? Infinity) <=
    (baseline?.sideMaeNonBlowup ?? Infinity) + 0.02;
  const blowupRecallImproved =
    (adjusted?.blowupDetection?.recall ?? 0) >=
    (baseline?.blowupDetection?.recall ?? 0) + 0.01;
  const promising =
    (blowupLiftImproved || blowupPrecisionOk || blowupRecallImproved) &&
    directionImproved &&
    nonBlowupMaeNotWorse;

  return {
    blowupLiftImproved,
    blowupPrecisionOk,
    blowupRecallImproved,
    directionImproved,
    nonBlowupMaeNotWorse,
    phase2Promising: Boolean(promising),
    ignoredMetric: 'blowup_total_mae_not_used_for_pass',
    note: '崩盤場不追求精確得分；過關看識別／方向／非崩盤 MAE',
  };
}

export function resolveOfficialGamePk(gameId) {
  const text = String(gameId || '');
  if (text.startsWith('mlb-official-')) {
    const pk = Number(text.slice('mlb-official-'.length));
    return Number.isFinite(pk) ? pk : null;
  }
  return null;
}

function confusionMatrix(rows) {
  const matrix = {
    duel: { duel: 0, normal: 0, blowup: 0 },
    normal: { duel: 0, normal: 0, blowup: 0 },
    blowup: { duel: 0, normal: 0, blowup: 0 },
  };
  for (const row of rows) {
    if (!row.trueRegime || !row.predicted) continue;
    matrix[row.trueRegime][row.predicted] += 1;
  }
  return matrix;
}

function classMetrics(matrix, label) {
  const tp = matrix[label][label];
  const fp = MLB_GAME_REGIMES
    .filter((k) => k !== label)
    .reduce((s, k) => s + matrix[k][label], 0);
  const fn = MLB_GAME_REGIMES
    .filter((k) => k !== label)
    .reduce((s, k) => s + matrix[label][k], 0);
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  return {
    support: tp + fn,
    precision: precision == null ? null : Number(precision.toFixed(4)),
    recall: recall == null ? null : Number(recall.toFixed(4)),
  };
}

function topQuantileLift(rows, scoreKey, trueLabel, q = 0.8) {
  const scored = rows
    .map((row) => ({ score: row[scoreKey], trueRegime: row.trueRegime }))
    .filter((row) => Number.isFinite(row.score) && row.trueRegime);
  if (!scored.length) return null;
  const sortedScores = scored.map((r) => r.score).sort((a, b) => a - b);
  const threshold = quantile(sortedScores, q);
  const top = scored.filter((r) => r.score >= threshold);
  const baseRate = scored.filter((r) => r.trueRegime === trueLabel).length / scored.length;
  const hitRate = top.length
    ? top.filter((r) => r.trueRegime === trueLabel).length / top.length
    : null;
  return {
    threshold: Number(threshold.toFixed(4)),
    topN: top.length,
    baseRate: Number(baseRate.toFixed(4)),
    topHitRate: hitRate == null ? null : Number(hitRate.toFixed(4)),
    lift: hitRate == null || baseRate === 0
      ? null
      : Number((hitRate / baseRate).toFixed(3)),
  };
}

function featureMeansByRegime(rows, featureKeys) {
  const out = {};
  for (const regime of MLB_GAME_REGIMES) {
    const subset = rows.filter((r) => r.trueRegime === regime);
    out[regime] = { n: subset.length };
    for (const key of featureKeys) {
      out[regime][key] = mean(subset.map((r) => r[key]));
      if (out[regime][key] != null) {
        out[regime][key] = Number(out[regime][key].toFixed(4));
      }
    }
  }
  return out;
}

/**
 * Phase 1 分離度摘要。
 * rows: { trueRegime, predicted, duelScore, blowupScore, totalRuns, ...features }
 */
export function summarizeRegimeSeparation(rows) {
  const labeled = rows.filter((r) => MLB_GAME_REGIMES.includes(r.trueRegime));
  const counts = Object.fromEntries(
    MLB_GAME_REGIMES.map((k) => [k, labeled.filter((r) => r.trueRegime === k).length])
  );
  const matrix = confusionMatrix(labeled);
  const featureKeys = [
    'avgRecentEra',
    'maxRecentEra',
    'maxEraGap',
    'avgExpIp',
    'minExpIp',
    'avgBullpenPitches',
    'maxBullpenPitches',
    'eitherPitchingBlowupRisk',
    'bothPitchingStable',
    'duelScore',
    'blowupScore',
    'totalRuns',
  ];
  return {
    version: MLB_GAME_REGIME_VERSION,
    n: labeled.length,
    baseRates: Object.fromEntries(
      MLB_GAME_REGIMES.map((k) => [
        k,
        labeled.length ? Number((counts[k] / labeled.length).toFixed(4)) : null,
      ])
    ),
    counts,
    meanTotalByTrueRegime: Object.fromEntries(
      MLB_GAME_REGIMES.map((k) => [
        k,
        Number(mean(labeled.filter((r) => r.trueRegime === k).map((r) => r.totalRuns))?.toFixed(3)),
      ])
    ),
    meanTotalByPredicted: Object.fromEntries(
      MLB_GAME_REGIMES.map((k) => [
        k,
        Number(mean(labeled.filter((r) => r.predicted === k).map((r) => r.totalRuns))?.toFixed(3)),
      ])
    ),
    featureMeansByTrueRegime: featureMeansByRegime(labeled, featureKeys),
    ruleClassifier: {
      accuracy: labeled.length
        ? Number((
          labeled.filter((r) => r.predicted === r.trueRegime).length / labeled.length
        ).toFixed(4))
        : null,
      byClass: Object.fromEntries(
        MLB_GAME_REGIMES.map((k) => [k, classMetrics(matrix, k)])
      ),
      confusion: matrix,
    },
    lifts: {
      top20BlowupScore: topQuantileLift(labeled, 'blowupScore', 'blowup', 0.8),
      top20DuelScore: topQuantileLift(labeled, 'duelScore', 'duel', 0.8),
    },
    passCriteria: {
      blowupLiftAtLeast1_3: null,
      duelLiftAtLeast1_3: null,
      predictedTotalsOrdered: null,
    },
  };
}

export function evaluateRegimePassCriteria(summary) {
  const blowupLift = summary?.lifts?.top20BlowupScore?.lift;
  const duelLift = summary?.lifts?.top20DuelScore?.lift;
  const totals = summary?.meanTotalByPredicted || {};
  const ordered =
    Number.isFinite(totals.duel) &&
    Number.isFinite(totals.normal) &&
    Number.isFinite(totals.blowup) &&
    totals.duel < totals.normal &&
    totals.normal < totals.blowup;
  const pass = {
    blowupLiftAtLeast1_3: blowupLift != null && blowupLift >= 1.3,
    duelLiftAtLeast1_3: duelLift != null && duelLift >= 1.3,
    predictedTotalsOrdered: ordered,
  };
  return {
    ...pass,
    phase1Promising: pass.blowupLiftAtLeast1_3 || pass.duelLiftAtLeast1_3 || pass.predictedTotalsOrdered,
  };
}
