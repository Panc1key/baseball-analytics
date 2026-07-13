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
 * @returns {{ homeBoost, awayBoost, factors }}
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

/** 是否為高水冷門獨贏候選 */
export function isContrarianDogPick(candidate, analysis) {
  if (candidate.market !== 'h2h') return false;
  const odds = candidate.oddsDecimal ?? candidate.odds?.price ?? 0;
  if (odds < (config.flatBetMinOdds ?? 1.8)) return false;

  const pick = candidate.pick;
  const homeProb = analysis?.homeWinProb ?? 0.5;
  const isHomePick = pick === analysis?.homeTeam;
  const modelFavorsPick =
    (isHomePick && homeProb >= 0.5) || (!isHomePick && homeProb < 0.5);

  const impliedFav = homeProb >= 0.5;
  const pickingDog =
    (isHomePick && !impliedFav && homeProb > 0.42) ||
    (!isHomePick && impliedFav && homeProb < 0.58);

  return modelFavorsPick && pickingDog && (candidate.edgeProb ?? 0) >= 2;
}

function marketTypeKey(market) {
  if (market === 'h2h' || market === 'spreads' || market === 'totals') return market;
  if (market?.startsWith('batter_') || market?.startsWith('pitcher_')) return 'props';
  return 'other';
}

/**
 * 跨盤口「可執行優勢分」— 數值越高越適合均注主推
 * 整合：評分、EV、盤口類型、冷門動量、球員盤趨勢
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

  // 大小盤需更強訊號才搶主推（不排除，但提高門檻）
  if (mtype === 'totals') {
    if (edge < (config.flatBetMinEdgePctTotals ?? 4)) return -1;
    bonus -= 3;
  }

  if (mtype === 'props') {
    if (edge < (config.flatBetMinEdgePctProps ?? 4)) return -1;
    bonus += 5;
  }

  // 高賠率區間加分（符合均注策略）
  if (odds >= 1.9) bonus += 4;
  else if (odds >= 1.8) bonus += 2;

  const base = candidate.score ?? 0;
  const actionable = base + bonus + evPct * 0.45;

  return {
    score: Math.round(actionable * 10) / 10,
    signals,
    bonus,
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
