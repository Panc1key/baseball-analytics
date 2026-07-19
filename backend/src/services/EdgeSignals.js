/**
 * 動態優勢訊號 — 用於跨盤口比較，選出「本場最佳」而非固定獨贏/讓分
 */

import { parseL10Rate } from './H2hModel.js';
import { config } from '../config.js';

/** 近 10 場 vs 季賽勝率差（正 = 近況火熱） */
export function teamMomentum(mlbTeam) {
  if (!mlbTeam) return 0;
  const season = mlbTeam.winPct ?? 0.5;
  const l10 = parseL10Rate(mlbTeam.last10) ?? season;
  return l10 - season;
}

/**
 * 冷門高水訊號：市場低估近況火熱的一方
 */
export function computeMomentumShifts(homeMlb, awayMlb, threshold = 0.06) {
  const factors = [];
  let homeBoost = 0;
  let awayBoost = 0;

  const homeMom = teamMomentum(homeMlb);
  const awayMom = teamMomentum(awayMlb);

  if (homeMom >= threshold) {
    homeBoost = Math.min(0.045, homeMom * 0.4);
    factors.push(`主隊近況熱 L10 高於季賽 ${(homeMom * 100).toFixed(0)}%`);
  }
  if (awayMom >= threshold) {
    awayBoost = Math.min(0.045, awayMom * 0.4);
    factors.push(`客隊近況熱 L10 高於季賽 ${(awayMom * 100).toFixed(0)}%`);
  }

  return { homeBoost, awayBoost, factors };
}

/** 市場看弱、但模型由可解釋基本面判斷不弱。 */
export function assessContrarianProfile(candidate, analysis = {}) {
  const team =
    candidate.market === 'spreads'
      ? candidate.odds?.name || candidate.spread?.name
      : candidate.pick;
  const homeTeam = analysis.homeTeam || analysis.home_team;
  const awayTeam = analysis.awayTeam || analysis.away_team;
  const isHome = team === homeTeam;
  const isAway = team === awayTeam;
  if (!team || (!isHome && !isAway)) {
    return { marketDog: false, qualified: false, supports: [] };
  }

  const modelProb = isHome
    ? Number(analysis.homeWinProb ?? 0.5)
    : Number(analysis.awayWinProb ?? 0.5);
  const marketProb = isHome
    ? Number(analysis.marketHomeProb ?? 0.5)
    : Number(analysis.marketAwayProb ?? (1 - Number(analysis.marketHomeProb ?? 0.5)));
  const line = Number(candidate.line);
  const marketDog =
    (candidate.market === 'spreads' && Number.isFinite(line) && line > 0) ||
    (candidate.market === 'h2h' && marketProb < 0.5);

  const supports = [];
  if (isHome) supports.push('主場');

  const pitcherEdge = Number(analysis.pitcherEdge ?? 0);
  const pickPitcherEdge = isHome ? pitcherEdge : -pitcherEdge;
  if (pickPitcherEdge >= 0.005) supports.push('先發投手');

  const homeMomentum = teamMomentum(analysis.homeMlb);
  const awayMomentum = teamMomentum(analysis.awayMlb);
  const momentumEdge = isHome
    ? homeMomentum - awayMomentum
    : awayMomentum - homeMomentum;
  if (momentumEdge >= 0.04) supports.push('近期狀態');

  const homeRuns = Number(analysis.scoringHomeRuns ?? analysis.homeRuns);
  const awayRuns = Number(analysis.scoringAwayRuns ?? analysis.awayRuns);
  if (Number.isFinite(homeRuns) && Number.isFinite(awayRuns)) {
    const expectedMargin = isHome ? homeRuns - awayRuns : awayRuns - homeRuns;
    if (expectedMargin >= 0) supports.push('得分模型不落後');
  }

  const dataQuality = Number(candidate.dataQuality ?? analysis.dataQuality ?? 0);
  const qualified =
    marketDog &&
    modelProb >= (config.contrarianMinWinProb ?? 0.48) &&
    dataQuality >= (config.contrarianMinDataQuality ?? 0.8) &&
    supports.length >= (config.contrarianMinSupportSignals ?? 2);

  return {
    team,
    marketDog,
    qualified,
    modelProb,
    marketProb,
    supportCount: supports.length,
    supports,
  };
}

/** 是否為有基本面支持的高水冷門候選。 */
export function isContrarianDogPick(candidate, analysis) {
  return assessContrarianProfile(candidate, analysis).qualified;
}

function marketTypeKey(market) {
  if (market === 'h2h' || market === 'spreads' || market === 'totals') return market;
  if (market?.startsWith('batter_') || market?.startsWith('pitcher_')) return 'props';
  return 'other';
}

/**
 * 跨盤口「可執行優勢分」— 數值越高越適合均注主推
 */
export function computeActionableScore(candidate, context = {}) {
  const market = candidate.market;
  const mtype = marketTypeKey(market);
  const edge = candidate.edgeProb ?? 0;
  const evPct = (candidate.ev ?? 0) * 100;
  const odds = candidate.oddsDecimal ?? candidate.odds?.price ?? 1;
  let bonus = 0;
  const signals = [];

  if (context.analysis?.matchupCore?.edges?.favoriteTrap) {
    bonus += 10;
    signals.push('熱門陷阱·EV在冷門');
  }

  if (isContrarianDogPick(candidate, context.analysis)) {
    bonus += Math.min(12, edge * 1.2);
    signals.push('冷門高水+模型看好');
  }

  if (context.momentumFavorsPick) {
    bonus += 8;
    signals.push('近況動量');
  } else if (candidate.market === 'h2h' && context.homeMlb && context.awayMlb) {
    const homeMom = teamMomentum(context.homeMlb);
    const awayMom = teamMomentum(context.awayMlb);
    const pick = candidate.pick;
    if (
      (pick === context.analysis?.homeTeam && homeMom >= 0.06) ||
      (pick === context.analysis?.awayTeam && awayMom >= 0.06)
    ) {
      bonus += 8;
      signals.push('近況動量');
    }
  }

  if (candidate.propTrendBonus) {
    bonus += candidate.propTrendBonus;
    signals.push('球員近期趨勢');
  }

  if (mtype === 'h2h') {
    if (context.preferTotals) {
      // 膠著／高分環境：獨贏大幅降權，讓大小能排到主推（洛磯案：只 -2 仍被獨贏佔均注）
      const park = Number(context.analysis?.parkFactor ?? context.parkFactor ?? 1);
      bonus -= park >= 1.1 ? 18 : 14;
      signals.push('對壘膠著·壓低獨贏權重');
    } else {
      bonus += 5;
    }
  }
  if (mtype === 'totals') {
    if (edge < (config.flatBetMinEdgePctTotals ?? 4)) return { score: -1, signals: [], bonus: 0 };
    if (context.preferTotals) {
      // 膠著時大小是更合理主選，對沖預設罰分
      bonus += config.totalsAmbiguousBoost ?? 6;
      signals.push('對壘膠著·優先大小');
    } else {
      bonus -= config.totalsPrimaryScorePenalty ?? 15;
      // 小球仍可進跨盤比較，但不輕易壓過清晰獨贏
      if (candidate.side === 'under') bonus -= 6;
    }
  }

  if (mtype === 'props') {
    if (edge < (config.flatBetMinEdgePctProps ?? 4)) return { score: -1, signals: [], bonus: 0 };
    bonus += 5;
  }

  if (odds >= 1.9) bonus += 4;
  else if (odds >= 1.8) bonus += 2;

  const base = candidate.score ?? 0;
  const evBonus = Math.min(
    config.actionableMaxEvBonus ?? 6,
    Math.max(0, evPct - (config.minEvThreshold ?? 0.03) * 100) * 0.35
  );
  if (candidate.finalEdgeCapped) signals.push('最終edge已限幅');
  const contrarianProfile = assessContrarianProfile(candidate, context.analysis);
  const actionable = base + bonus + evBonus;

  return {
    score: Math.round(actionable * 10) / 10,
    signals,
    bonus,
    evBonus: Math.round(evBonus * 10) / 10,
    contrarianProfile,
  };
}

export function pickBestActionableCandidate(candidates, context = {}) {
  if (!candidates?.length) return null;

  const ranked = candidates
    .map((c) => {
      const { score, signals, bonus } = computeActionableScore(c, context);
      return { candidate: c, actionableScore: score, signals, bonus };
    })
    .filter((r) => r.actionableScore >= 0)
    .sort(
      (a, b) =>
        b.actionableScore - a.actionableScore ||
        b.candidate.ev - a.candidate.ev ||
        b.candidate.modelProb - a.candidate.modelProb
    );

  if (!ranked.length) return null;

  const best = ranked[0];
  return {
    ...best.candidate,
    actionableScore: best.actionableScore,
    edgeSignals: best.signals,
    isPrimary: true,
  };
}
