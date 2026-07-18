/**
 * 大小盤（Totals）模型
 * 核心：市場主盤線為錨點 + 球隊進攻/失分 + 球場 + 先發投手
 * 僅在模型與市場方向一致且達門檻時推薦
 */

import { config } from '../config.js';
import { resolveNpbTeamStrength } from './NpbStrength.js';
import { projectNpbFamilyRuns } from './NpbScoreModel.js';
import {
  offenseFormMultiplier,
  staffWhipMultiplier,
} from './TeamRollingStats.js';
import {
  decimalToImpliedProb,
  decimalToNetOdds,
  removeVig,
  calibrateModelProb,
  calcEVWithPush,
} from '../utils/odds.js';
import { getParkFactor } from '../data/parkFactors.js';
import {
  poissonTotalDistribution,
  poissonTotalOverProb,
} from '../models/GameScoreModel.js';
import { getDixonColesRho } from '../models/DixonColes.js';

const MLB_LEAGUE_RUNS_PER_GAME = 8.8;
const MLB_TEAM_RUNS_AVG = MLB_LEAGUE_RUNS_PER_GAME / 2;

/**
 * 先發投手質量指數（越高越差，類似足球後防漏洞）
 * 棒球不對稱：一側投手差 → 大分機率顯著上升；小球需兩側都穩
 */
export function pitcherQualityIndex(pitcherStats) {
  if (!pitcherStats) {
    return { index: 0, tier: 'unknown', weak: false, solid: false, elite: false, era: null, whip: null };
  }
  const era = pitcherStats.era ?? 4.5;
  const whip = pitcherStats.whip ?? 1.3;
  const index = (era - 4.5) * 0.55 + (whip - 1.3) * 2.2;

  let tier = 'avg';
  if (index > 0.85 || era >= 5.2 || whip >= 1.48) tier = 'weak';
  else if (index > 0.35 || era >= 4.8) tier = 'below_avg';
  else if (index < -0.35 && era <= 3.6 && whip <= 1.12) tier = 'elite';
  else if (index < 0.15 && era <= 4.0) tier = 'solid';

  return {
    index,
    tier,
    weak: tier === 'weak' || tier === 'below_avg',
    solid: tier === 'solid' || tier === 'elite',
    elite: tier === 'elite',
    era,
    whip,
  };
}

/** 大小球場景：大分觸發 vs 小球可行（不對稱） */
export function analyzePitchingTotalsContext({
  homePitcherStats,
  awayPitcherStats,
  homeMlb,
  awayMlb,
  parkFactor = 1,
}) {
  const homeP = pitcherQualityIndex(homePitcherStats);
  const awayP = pitcherQualityIndex(awayPitcherStats);
  const homeOff = homeMlb ? runsPerGame(homeMlb) : MLB_TEAM_RUNS_AVG;
  const awayOff = awayMlb ? runsPerGame(awayMlb) : MLB_TEAM_RUNS_AVG;
  const avgOffense = (homeOff + awayOff) / 2;
  const combinedPitcherBad = homeP.index + awayP.index;

  // 大分：任一侧投手偏弱即可拉高（不必三振，上垒就有机会）
  const overTrigger =
    homeP.weak ||
    awayP.weak ||
    combinedPitcherBad > 0.55;

  const weakPitcherCount = (homeP.tier === 'weak' ? 1 : 0) + (awayP.tier === 'weak' ? 1 : 0);

  // 小球：両投手都稳 + 进攻不猛 + 球场不偏打
  const underViable =
    !homeP.weak &&
    !awayP.weak &&
    homeP.index < 0.3 &&
    awayP.index < 0.3 &&
    parkFactor <= (config.totalsMaxUnderParkFactor ?? 1.03) &&
    avgOffense <= MLB_TEAM_RUNS_AVG + (config.totalsMaxUnderOffenseRpg ?? 0.3);

  const factors = [];
  if (homeP.tier !== 'unknown') {
    factors.push(
      `主先發 ${homeP.tier}（ERA ${homeP.era?.toFixed(2) ?? '?'} WHIP ${homeP.whip?.toFixed(2) ?? '?'}）`
    );
  }
  if (awayP.tier !== 'unknown') {
    factors.push(
      `客先發 ${awayP.tier}（ERA ${awayP.era?.toFixed(2) ?? '?'} WHIP ${awayP.whip?.toFixed(2) ?? '?'}）`
    );
  }
  if (overTrigger) factors.push('投手漏洞 → 大分風險↑（單側差投即可）');
  if (underViable) factors.push('雙先發穩定 + 進攻一般 → 小球可行');
  else if (homeP.tier !== 'unknown') factors.push('小球條件不足（需雙投手穩 + 低進攻）');

  return {
    homePitcher: homeP,
    awayPitcher: awayP,
    overTrigger,
    weakPitcherCount,
    underViable,
    avgOffense,
    combinedPitcherBad,
    factors,
  };
}

/** 從戰績計算場均得分/失分 */
export function runsPerGame(mlbTeam) {
  if (!mlbTeam) return MLB_TEAM_RUNS_AVG;
  const gp = (mlbTeam.wins || 0) + (mlbTeam.losses || 0);
  if (!gp) return MLB_TEAM_RUNS_AVG;
  return (mlbTeam.runsScored || 0) / gp;
}

export function runsAllowedPerGame(mlbTeam) {
  if (!mlbTeam) return MLB_TEAM_RUNS_AVG;
  const gp = (mlbTeam.wins || 0) + (mlbTeam.losses || 0);
  if (!gp) return MLB_TEAM_RUNS_AVG;
  return (mlbTeam.runsAllowed || 0) / gp;
}

/** 先發投手對對手得分的影響（弱投非線性放大） */
function pitcherRunSuppression(pitcherStats) {
  if (!pitcherStats) return 0;
  const q = pitcherQualityIndex(pitcherStats);
  if (q.tier === 'weak') {
    return 0.45 + Math.max(0, q.index) * 0.5;
  }
  if (q.tier === 'below_avg') {
    return 0.22 + Math.max(0, q.index) * 0.35;
  }
  if (q.elite) {
    return -0.35 + q.index * 0.25;
  }
  return q.index * 0.35;
}

/**
 * 單隊預期得分
 * 進攻 vs 對手投手/守備，再乘球場與主場
 */
export function projectTeamRuns({
  offenseRpg,
  oppRunsAllowedRpg,
  oppPitcherStats = null,
  parkFactor = 1,
  isHome = false,
}) {
  const base = (offenseRpg + oppRunsAllowedRpg) / 2;
  let runs = base * parkFactor;
  if (isHome) runs *= 1.02;
  runs += pitcherRunSuppression(oppPitcherStats);
  return Math.max(2.2, Math.min(7.5, runs));
}

/** 從賠率提取市場共識大小盤 */
export function extractMarketTotals(bookmakers) {
  const byLine = new Map();

  for (const book of bookmakers || []) {
    const market = book.markets?.find((m) => m.key === 'totals');
    if (!market?.outcomes?.length) continue;

    const over = market.outcomes.find((o) => o.name === 'Over');
    const under = market.outcomes.find((o) => o.name === 'Under');
    if (!over?.point || !over.price || !under?.price) continue;

    const line = over.point;
    if (!byLine.has(line)) {
      byLine.set(line, { line, books: 0, overPrices: [], underPrices: [] });
    }
    const row = byLine.get(line);
    row.books += 1;
    row.overPrices.push(over.price);
    row.underPrices.push(under.price);
  }

  if (!byLine.size) return null;

  let best = null;
  for (const row of byLine.values()) {
    const avgOver = row.overPrices.reduce((a, b) => a + b, 0) / row.overPrices.length;
    const avgUnder = row.underPrices.reduce((a, b) => a + b, 0) / row.underPrices.length;
    const fair = removeVig(decimalToImpliedProb(avgOver), decimalToImpliedProb(avgUnder));
    const candidate = {
      line: row.line,
      books: row.books,
      overImplied: decimalToImpliedProb(avgOver),
      underImplied: decimalToImpliedProb(avgUnder),
      fairOverProb: fair.fairA,
      fairUnderProb: fair.fairB,
      avgOverPrice: avgOver,
      avgUnderPrice: avgUnder,
    };
    if (!best || row.books > best.books || (row.books === best.books && row.line > best.line)) {
      best = candidate;
    }
  }

  return best;
}

/** 大球機率由已含投手影響的 lambda 直接決定，避免再次加權同一先發資訊。 */
export function probTotalOverWithContext(homeRuns, awayRuns, line, totalsContext) {
  return poissonTotalOverProb(homeRuns, awayRuns, line);
}

/** 小球概率與大球使用同一分布；投手/進攻條件只作推薦門控，不再修改概率。 */
export function probTotalUnderWithContext(
  homeRuns,
  awayRuns,
  line,
  totalsContext,
  modelTotal,
  marketLine,
  rho = 0
) {
  return poissonTotalDistribution(homeRuns, awayRuns, line, undefined, rho).underProb;
}

/** 大於盤口線機率（logistic 備用，非 MLB Poisson 時） */
export function probOverAtLine(projectedTotal, line, steepness = 2.0) {
  const diff = projectedTotal - (line + 0.5);
  return 1 / (1 + Math.exp(-diff / steepness));
}

export function resolveTotalsMarketBlend(league, hasMlbCore, hasPitchers, hasMarket, hasNpbStrength = false) {
  if (!hasMarket) return 0;
  if (league === 'MLB') {
    if (hasMlbCore && hasPitchers) return config.totalsMarketBlendMlbFull ?? 0.6;
    if (hasMlbCore) return config.totalsMarketBlendMlb ?? 0.65;
    return config.totalsMarketBlendMlbLite ?? 0.7;
  }
  if ((league === 'NPB' || league === 'KBO') && hasNpbStrength) {
    return config.totalsMarketBlendNpbFull ?? 0.5;
  }
  return config.totalsMarketBlendOther ?? 0.75;
}

/**
 * 計算大小盤核心預估
 */
export function computeTotalsProjection({
  league,
  homeMlb = null,
  awayMlb = null,
  homePitcherStats = null,
  awayPitcherStats = null,
  venueName = null,
  bookmakers = [],
  homeTeamStats = null,
  awayTeamStats = null,
  eloOverride = null,
}) {
  const parkFactor = league === 'MLB' ? getParkFactor(venueName) : 1.0;
  const market = extractMarketTotals(bookmakers);
  const marketLine = market?.line ?? null;
  const marketOverProb = market?.fairOverProb ?? null;

  let modelTotal = MLB_LEAGUE_RUNS_PER_GAME;
  let homeRuns = null;
  let awayRuns = null;
  const factors = [];
  const hasMlbCore = Boolean(homeMlb && awayMlb);
  const hasPitchers = Boolean(homePitcherStats && awayPitcherStats);
  const homeGames = (homeTeamStats?.wins || 0) + (homeTeamStats?.losses || 0);
  const awayGames = (awayTeamStats?.wins || 0) + (awayTeamStats?.losses || 0);
  const { hasStrength: hasNpbStrength } = resolveNpbTeamStrength(
    homeTeamStats,
    awayTeamStats,
    league
  );

  if (league === 'MLB' && hasMlbCore) {
    const homeOff = runsPerGame(homeMlb);
    const awayOff = runsPerGame(awayMlb);
    const homeRa = runsAllowedPerGame(homeMlb);
    const awayRa = runsAllowedPerGame(awayMlb);

    homeRuns = projectTeamRuns({
      offenseRpg: homeOff,
      oppRunsAllowedRpg: awayRa,
      oppPitcherStats: awayPitcherStats,
      parkFactor,
      isHome: true,
    });
    awayRuns = projectTeamRuns({
      offenseRpg: awayOff,
      oppRunsAllowedRpg: homeRa,
      oppPitcherStats: homePitcherStats,
      parkFactor,
      isHome: false,
    });

    // 近窗完賽形態（OBP/SLG→OPS、對手投手群 WHIP）— 類似足球近期 xG
    const leagueOps = config.mlbRollingLeagueOps ?? 0.72;
    const leagueWhip = config.mlbRollingLeagueWhip ?? 1.28;
    const minG = config.rollingFormMinGames ?? 8;
    const homeFormOk = (homeTeamStats?.games_30 || 0) >= minG;
    const awayFormOk = (awayTeamStats?.games_30 || 0) >= minG;
    if (homeFormOk || awayFormOk) {
      const homeOpsMul = homeFormOk
        ? offenseFormMultiplier(homeTeamStats?.ops_30, leagueOps)
        : 1;
      const awayOpsMul = awayFormOk
        ? offenseFormMultiplier(awayTeamStats?.ops_30, leagueOps)
        : 1;
      const homeFaceWhip = awayFormOk
        ? staffWhipMultiplier(awayTeamStats?.whip_30, leagueWhip)
        : 1;
      const awayFaceWhip = homeFormOk
        ? staffWhipMultiplier(homeTeamStats?.whip_30, leagueWhip)
        : 1;
      // 近窗 RPG 與賽季 RPG 混合（60% 近窗）
      if (homeFormOk && homeTeamStats?.rpg_30 != null) {
        homeRuns =
          homeRuns * 0.4 +
          projectTeamRuns({
            offenseRpg: homeTeamStats.rpg_30,
            oppRunsAllowedRpg:
              awayFormOk && awayTeamStats?.rapg_30 != null ? awayTeamStats.rapg_30 : awayRa,
            oppPitcherStats: awayPitcherStats,
            parkFactor,
            isHome: true,
          }) *
            0.6;
      }
      if (awayFormOk && awayTeamStats?.rpg_30 != null) {
        awayRuns =
          awayRuns * 0.4 +
          projectTeamRuns({
            offenseRpg: awayTeamStats.rpg_30,
            oppRunsAllowedRpg:
              homeFormOk && homeTeamStats?.rapg_30 != null ? homeTeamStats.rapg_30 : homeRa,
            oppPitcherStats: homePitcherStats,
            parkFactor,
            isHome: false,
          }) *
            0.6;
      }
      homeRuns *= homeOpsMul * homeFaceWhip;
      awayRuns *= awayOpsMul * awayFaceWhip;
      factors.push(
        `近${homeTeamStats?.rolling_window_days || awayTeamStats?.rolling_window_days || 30}日形態` +
          ` 主OPS ${homeTeamStats?.ops_30?.toFixed?.(3) ?? '-'}×${homeOpsMul.toFixed(2)}` +
          ` 客OPS ${awayTeamStats?.ops_30?.toFixed?.(3) ?? '-'}×${awayOpsMul.toFixed(2)}` +
          ` · 對WHIP×${homeFaceWhip.toFixed(2)}/${awayFaceWhip.toFixed(2)}`
      );
    }

    modelTotal = homeRuns + awayRuns;

    factors.push(
      `模型得分 主${homeRuns.toFixed(1)}+客${awayRuns.toFixed(1)}=${modelTotal.toFixed(1)}` +
        `（主場進攻${homeOff.toFixed(2)} 客進攻${awayOff.toFixed(2)}）`
    );
    if (parkFactor !== 1) factors.push(`球場係數 ${venueName || '未知'} ×${parkFactor.toFixed(2)}`);
  } else if (league === 'MLB' && (homePitcherStats || awayPitcherStats)) {
    const homeEra = homePitcherStats?.era ?? 4.5;
    const awayEra = awayPitcherStats?.era ?? 4.5;
    const avgEra = (homeEra + awayEra) / 2;
    // ERA 高於聯盟均值 → 總分偏高；強投 → 總分偏低
    modelTotal = MLB_LEAGUE_RUNS_PER_GAME + (avgEra - 4.5) * 0.35;
    factors.push(`僅先發 ERA 估算總分 ${modelTotal.toFixed(1)}`);
  } else if (hasNpbStrength) {
    const projected = projectNpbFamilyRuns({
      league,
      homeTeam: homeTeamStats.team_name,
      awayTeam: awayTeamStats.team_name,
      homeTeamStats,
      awayTeamStats,
      homeGames,
      awayGames,
      homeStrength: homeTeamStats.rating,
      awayStrength: awayTeamStats.rating,
      eloOverride,
    });
    homeRuns = projected.homeRuns;
    awayRuns = projected.awayRuns;
    modelTotal = projected.modelTotal;
    factors.push(...projected.factors);
  } else {
    modelTotal = { MLB: 8.8, NPB: 8.0, KBO: 9.0 }[league] ?? 8.5;
    factors.push(`聯盟均值總分 ${modelTotal.toFixed(1)}`);
  }

  const marketWeight = resolveTotalsMarketBlend(
    league,
    hasMlbCore,
    hasPitchers,
    marketLine != null,
    hasNpbStrength
  );
  let finalTotal = modelTotal;

  if (marketLine != null) {
    finalTotal = modelTotal * (1 - marketWeight) + marketLine * marketWeight;
    factors.push(
      `市場主盤 ${marketLine} · Over公平${((marketOverProb ?? 0.5) * 100).toFixed(1)}% · 混合${(marketWeight * 100).toFixed(0)}%`
    );
    factors.push(`最終預估總分 ${finalTotal.toFixed(1)}（模型${modelTotal.toFixed(1)}）`);
  }

  // 大小盤概率與畫面顯示的 finalTotal 必須使用同一組 lambda。
  // 只調整總量，保留主客原始得分比例。
  let probabilityHomeRuns = homeRuns;
  let probabilityAwayRuns = awayRuns;
  if (homeRuns != null && awayRuns != null) {
    const pureTotal = homeRuns + awayRuns;
    const scale = pureTotal > 0 ? finalTotal / pureTotal : 1;
    probabilityHomeRuns = homeRuns * scale;
    probabilityAwayRuns = awayRuns * scale;
  }

  const modelMarketGap = marketLine != null ? Math.abs(modelTotal - marketLine) : 0;
  const marketFavorsOver = marketOverProb != null ? marketOverProb >= 0.5 : finalTotal > (marketLine ?? finalTotal);

  let totalsContext = null;
  if (league === 'MLB' && hasPitchers) {
    totalsContext = analyzePitchingTotalsContext({
      homePitcherStats,
      awayPitcherStats,
      homeMlb,
      awayMlb,
      parkFactor,
    });
    factors.push(...totalsContext.factors);
  }

  return {
    league,
    modelTotal,
    finalTotal,
    homeRuns,
    awayRuns,
    probabilityHomeRuns,
    probabilityAwayRuns,
    marketLine,
    marketOverProb,
    marketUnderProb: marketOverProb != null ? 1 - marketOverProb : null,
    marketWeight,
    modelMarketGap,
    marketFavorsOver,
    parkFactor,
    totalsContext,
    factors,
    hasMlbCore,
    hasPitchers,
    hasNpbStrength,
    dataQuality: hasMlbCore && hasPitchers ? 0.85 : hasMlbCore ? 0.65 : hasNpbStrength ? 0.7 : 0.35,
  };
}

function totalsLineBand(league) {
  if (league === 'NPB' || league === 'KBO') {
    return {
      min: config.npbTotalsLineMin ?? 6.5,
      max: config.npbTotalsLineMax ?? 13,
    };
  }
  if (league === 'MLB') {
    return {
      min: config.mlbTotalsLineMin ?? 5.5,
      max: config.mlbTotalsLineMax ?? 14,
    };
  }
  return null;
}

/** 是否應跳過該盤口線 */
export function shouldSkipTotalLine({
  projection,
  line,
  isOver,
  modelProb,
  impliedProb,
  marketProb = null,
  league = null,
}) {
  const edgePct = (modelProb - (marketProb ?? impliedProb)) * 100;
  const minEdge = config.totalsMinEdgePct ?? 2;
  const minContrarian = config.totalsMinContrarianEdgePct ?? 5;
  const minSignal = config.totalsMinModelMarketGap ?? 0.35;
  const maxGap = config.totalsMaxModelMarketGap ?? 1.2;

  const marketLine = projection.marketLine ?? line;
  const modelTotal = projection.modelTotal;
  const modelMarketGap = projection.modelMarketGap ?? Math.abs(modelTotal - marketLine);
  const leagueCode = league || projection.league || null;

  // 盤帶閘：排除滾球縮水線／非全場線（例：日職全場出現 3.5）
  const band = totalsLineBand(leagueCode);
  if (band && line != null && (line < band.min || line > band.max)) {
    return {
      skip: true,
      reason: `大小線 ${line} 超出初盤合理帶 ${band.min}-${band.max}（疑似滾球/非全場）`,
    };
  }

  // 模型與市場總分幾乎一致 → 無資訊優勢，不推
  if (modelMarketGap < minSignal) {
    return { skip: true, reason: `模型${modelTotal.toFixed(1)}≈市場${marketLine}，無優勢` };
  }

  const modelFavorsOver = projection.totalsContext?.overTrigger
    ? modelTotal > marketLine - 0.05
    : modelTotal > marketLine + 0.15;
  const modelFavorsUnder = modelTotal < marketLine - (config.totalsMinUnderGap ?? 0.5);

  if (isOver && !modelFavorsOver) {
    return { skip: true, reason: '模型未看好大分' };
  }
  if (!isOver) {
    // MLB：小球需投手穩定條件；NPB/KBO 有得失分模型即可
    if (!projection.totalsContext?.underViable && !projection.hasNpbStrength) {
      return { skip: true, reason: '小球需雙先發穩定且進攻/球場配合，條件不足' };
    }
    if (projection.totalsContext?.overTrigger) {
      return { skip: true, reason: '存在投手漏洞，禁止推小（弱投易出大分）' };
    }
    if (modelTotal >= marketLine) {
      return { skip: true, reason: '模型總分不低於盤口，禁止推小' };
    }
    if (!modelFavorsUnder) {
      return { skip: true, reason: `推小需模型低於市場至少 ${config.totalsMinUnderGap ?? 0.5} 分` };
    }
    if (edgePct < (config.totalsMinUnderEdgePct ?? 6)) {
      return { skip: true, reason: '小球需更高優勢門檻' };
    }
  }

  // 市場定低盤（強投手戰／滾球縮水）但模型偏高 → 禁止博大假 EV
  const softGap = config.totalsSoftLineOverGap ?? 1.5;
  if (isOver && Number.isFinite(modelTotal) && line <= modelTotal - softGap) {
    return {
      skip: true,
      reason: `市場線 ${line} 遠低於模型 ${modelTotal.toFixed(1)}，禁止博大（防滾球低線）`,
    };
  }
  if (isOver && marketLine <= modelTotal - 1.2 && edgePct < minContrarian) {
    return { skip: true, reason: '市場低盤線，模型不應博大' };
  }
  // 市場定高盤但模型偏低 → 不輕易博小
  if (!isOver && marketLine >= modelTotal + 1.2 && edgePct < minContrarian) {
    return { skip: true, reason: '市場高盤線，模型不應博小' };
  }

  if (isOver && projection.totalsContext?.overTrigger && edgePct < (config.totalsMinEdgePct ?? 2)) {
    return { skip: true, reason: '大分觸發但優勢仍不足' };
  }

  if (edgePct < minEdge) {
    return { skip: true, reason: `優勢不足 ${edgePct.toFixed(1)}%` };
  }

  if (modelMarketGap > maxGap && ((isOver && modelFavorsUnder) || (!isOver && modelFavorsOver))) {
    return { skip: true, reason: '模型與市場嚴重背離' };
  }

  if (projection.marketOverProb != null) {
    const marketDirOver = projection.marketOverProb >= 0.5;
    if (marketDirOver !== isOver && edgePct < minContrarian) {
      return { skip: true, reason: '逆市場且優勢不足' };
    }
  }

  return { skip: false };
}

/**
 * 為所有可用大小盤線計算候選
 */
export function buildTotalCandidates(markets, projection, league) {
  const candidates = [];
  const usePoisson =
    projection.probabilityHomeRuns != null &&
    projection.probabilityAwayRuns != null &&
    (league === 'MLB' || projection.hasNpbStrength);

  for (const [, total] of Object.entries(markets.totals || {})) {
    const isOver = total.name === 'Over';
    const line = total.point;
    const rho = getDixonColesRho(league);
    const distribution = usePoisson
      ? poissonTotalDistribution(
          projection.probabilityHomeRuns,
          projection.probabilityAwayRuns,
          line,
          undefined,
          rho
        )
      : null;
    const pushProb = distribution?.pushProb ?? 0;
    const decisiveMass = Math.max(1e-9, 1 - pushProb);
    const rawProb = usePoisson
      ? isOver
        ? distribution.overProb / decisiveMass
        : distribution.underProb / decisiveMass
      : isOver
        ? probOverAtLine(projection.finalTotal, line)
        : 1 - probOverAtLine(projection.finalTotal, line);
    const maxEdge = isOver
      ? config.maxModelEdgePct
      : (config.totalsUnderMaxModelEdgePct ?? 0.05);
    const impliedProb = decimalToImpliedProb(total.price);
    const oppositeKey = `${isOver ? 'Under' : 'Over'}_${line}`;
    const opposite = markets.totals?.[oppositeKey];
    const marketProb = opposite?.price
      ? removeVig(
          impliedProb,
          decimalToImpliedProb(opposite.price)
        ).fairA
      : impliedProb;
    const modelProb = calibrateModelProb(rawProb, marketProb, maxEdge);
    const winProb = modelProb * (1 - pushProb);
    const ev = calcEVWithPush(winProb, pushProb, decimalToNetOdds(total.price));
    // 模型優勢以去水市場為基準；投注 EV 仍使用實際可下注賠率。
    const edgePct = (modelProb - marketProb) * 100;

    const gate = shouldSkipTotalLine({
      projection,
      line,
      isOver,
      modelProb,
      impliedProb,
      marketProb,
      league,
      offeredEdgePct: (modelProb - impliedProb) * 100,
    });

    candidates.push({
      market: 'totals',
      marketGroup: 'main',
      pick: isOver ? `大 ${line}` : `小 ${line}`,
      line,
      side: isOver ? 'over' : 'under',
      odds: total,
      oddsDecimal: total.price,
      modelProb,
      rawModelProb: rawProb,
      marketProb,
      impliedProb,
      pushProb,
      ev,
      edgePct,
      projectedTotal: projection.finalTotal,
      modelTotal: projection.modelTotal,
      marketLine: projection.marketLine,
      structuralOk: !gate.skip,
      skipReason: gate.reason,
      probabilityCalibrated: true,
    });
  }

  return candidates;
}
