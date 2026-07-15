import { footballConfig } from './config.js';
import { calcEVWithPush, decimalToNetOdds } from '../utils/odds.js';
import { estimateSoccerCoverProb } from './utils/footballOdds.js';
import { buildTotalCandidates } from './models/FootballTotalsModel.js';
import { buildCornerCandidates } from './models/FootballCornersModel.js';
import { enrichFootballCandidate } from './FootballPickScorer.js';
import { pickFootballPropCandidates } from './FootballPlayerAnalyzer.js';

/** 寫進推薦「分析」欄，讓前端不用翻矩陣也能看方向 */
export function formatThreeWayDirection(game, analysis) {
  const h = analysis.homeWinProb ?? 0;
  const d = analysis.drawProb ?? 0;
  const a = analysis.awayWinProb ?? 0;
  const homeDc = h + d;
  const awayDc = a + d;
  const parts = [
    `三向 主${(h * 100).toFixed(0)}% 和${(d * 100).toFixed(0)}% 客${(a * 100).toFixed(0)}%`,
    `雙選(主+和)${(homeDc * 100).toFixed(0)}%/(客+和)${(awayDc * 100).toFixed(0)}%`,
  ];
  if (awayDc > h + 0.05 && h >= a) {
    parts.push(`方向：${game.away_team}不敗優於${game.home_team}獨贏`);
  } else if (homeDc > a + 0.05 && a >= h) {
    parts.push(`方向：${game.home_team}不敗優於${game.away_team}獨贏`);
  }
  return parts.join(' · ');
}

/**
 * 三向膠著 / 雙選更強 → 不推獨贏（避免界面只出現「法國勝」卻看不到西班牙不敗）
 */
export function evaluateH2hDirectionGate(game, analysis) {
  const h = analysis.homeWinProb ?? 0;
  const d = analysis.drawProb ?? 0;
  const a = analysis.awayWinProb ?? 0;
  const ranked = [
    { side: 'home', name: game.home_team, prob: h },
    { side: 'draw', name: 'Draw', label: '和局', prob: d },
    { side: 'away', name: game.away_team, prob: a },
  ].sort((x, y) => y.prob - x.prob);

  const top = ranked[0];
  const second = ranked[1];
  const minFav = footballConfig.h2hMinFavoriteProb ?? 0.45;
  const minGap = footballConfig.h2hMinProbGap ?? 0.06;

  if (top.prob < minFav) {
    return {
      allow: false,
      favorite: top,
      reason: `三向最高僅 ${(top.prob * 100).toFixed(0)}% < ${(minFav * 100).toFixed(0)}%，膠著不推獨贏`,
    };
  }
  if (top.prob - second.prob < minGap) {
    return {
      allow: false,
      favorite: top,
      reason: `領先第二向僅 ${((top.prob - second.prob) * 100).toFixed(1)}pt，方向不明不推獨贏`,
    };
  }

  if (footballConfig.h2hSkipIfDoubleChanceStronger !== false) {
    if (top.side === 'home' && d + a > h + 0.05) {
      return {
        allow: false,
        favorite: top,
        reason: `和+客 ${( ((d + a) * 100).toFixed(0) )}% > 主勝，禁推主勝獨贏（應看客受讓/雙選）`,
      };
    }
    if (top.side === 'away' && d + h > a + 0.05) {
      return {
        allow: false,
        favorite: top,
        reason: `和+主 ${(((d + h) * 100).toFixed(0))}% > 客勝，禁推客勝獨贏（應看主受讓/雙選）`,
      };
    }
  }

  return { allow: true, favorite: top, reason: null };
}

function pickH2hCandidates(game, markets, analysis) {
  const gate = evaluateH2hDirectionGate(game, analysis);
  if (!gate.allow) return null;

  const options = [];
  const outcomes = [
    { name: game.home_team, prob: analysis.homeWinProb },
    { name: 'Draw', prob: analysis.drawProb, label: '和局' },
    { name: game.away_team, prob: analysis.awayWinProb },
  ];

  const favSide = gate.favorite.side === 'draw' ? 'Draw' : gate.favorite.name;

  for (const out of outcomes) {
    const odds = markets.h2h[out.name];
    if (!odds?.price) continue;

    const pickSide = out.label ? 'Draw' : out.name;
    if (pickSide !== favSide) continue;

    const enriched = enrichFootballCandidate(
      {
        market: 'h2h',
        marketGroup: 'main',
        pick: out.label || out.name,
        line: null,
        odds,
        oddsDecimal: odds.price,
        modelProb: out.prob,
        confidence: analysis.confidence,
        structuralOk: true,
        directionNote: formatThreeWayDirection(game, analysis),
      },
      analysis,
      game.league,
      'h2h'
    );

    if (enriched.ev < footballConfig.minEvThreshold) continue;
    if (enriched.edgeProb < footballConfig.h2hMinEdgePct) continue;
    if (analysis.confidence < footballConfig.minConfidence) continue;
    if (!enriched.tier) continue;

    options.push(enriched);
  }

  options.sort((a, b) => b.score - a.score || b.ev - a.ev);
  return options[0] || null;
}

/** 膠著場傾向推「不敗」側的受讓（如客 +0.5） */
function directionalSpreadBoost(game, analysis, spread) {
  const h = analysis.homeWinProb ?? 0;
  const d = analysis.drawProb ?? 0;
  const a = analysis.awayWinProb ?? 0;
  let boost = 0;

  // 主略熱但客不敗更強 → 偏好客隊正司
  if (h >= a && d + a > h + 0.05) {
    if (spread.name === game.away_team && spread.point > 0) boost += 8;
    if (spread.name === game.home_team && spread.point < 0) boost -= 6;
  }
  if (a >= h && d + h > a + 0.05) {
    if (spread.name === game.home_team && spread.point > 0) boost += 8;
    if (spread.name === game.away_team && spread.point < 0) boost -= 6;
  }
  return boost;
}

function pickSpreadCandidate(game, markets, analysis) {
  const raw = [];

  for (const [, spread] of Object.entries(markets.spreads || {})) {
    const isHome = spread.name === game.home_team;
    const cover = estimateSoccerCoverProb(
      isHome ? analysis.homeWinProb : analysis.awayWinProb,
      analysis.drawProb,
      spread.point,
      analysis.scoreGrid,
      isHome
    );
    const coverProb = cover.winProb ?? cover;
    const pushProb = cover.pushProb ?? 0;
    const ev = calcEVWithPush(coverProb, pushProb, decimalToNetOdds(spread.price));

    raw.push({
      spread,
      pick: `${spread.name} ${spread.point > 0 ? '+' : ''}${spread.point}`,
      line: spread.point,
      oddsDecimal: spread.price,
      modelProb: coverProb,
      pushProb,
      ev,
      odds: spread,
      directionBoost: directionalSpreadBoost(game, analysis, spread),
    });
  }

  if (!raw.length) return null;

  const scored = raw
    .map((g) => {
      const enriched = enrichFootballCandidate(
        {
          market: 'spreads',
          marketGroup: 'main',
          pick: g.pick,
          line: g.line,
          odds: g.odds,
          oddsDecimal: g.oddsDecimal,
          modelProb: g.modelProb,
          pushProb: g.pushProb,
          ev: g.ev,
          confidence: analysis.confidence,
          structuralOk: g.ev >= footballConfig.minEvThreshold,
          directionNote: formatThreeWayDirection(game, analysis),
        },
        analysis,
        game.league,
        'spreads'
      );
      return {
        ...enriched,
        score: (enriched.score ?? 0) + (g.directionBoost || 0),
      };
    })
    .filter((g) => g.tier);

  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

function pickTotalCandidate(game, markets, analysis) {
  const projection = analysis.totalsProjection;
  if (!projection) return null;
  const raw = buildTotalCandidates(markets, projection).filter((c) => c.structuralOk);

  const scored = raw
    .map((o) =>
      enrichFootballCandidate(
        { ...o, confidence: analysis.confidence },
        analysis,
        game.league,
        'totals'
      )
    )
    .filter((o) => o.tier && o.ev >= footballConfig.minEvThreshold);

  scored.sort((a, b) => b.score - a.score || b.ev - a.ev);
  return scored[0] || null;
}

/** 角球大小：主盤膠著時的備選 */
function pickCornerCandidate(game, bookmakers, analysis) {
  if (!footballConfig.enableCorners) return null;
  const projection = analysis.cornersProjection;
  if (!projection?.hasMarket && !projection?.modelCorners) return null;

  const raw = buildCornerCandidates(bookmakers, projection);
  const scored = raw
    .map((o) =>
      enrichFootballCandidate(
        {
          ...o,
          confidence: analysis.confidence,
          directionNote: formatThreeWayDirection(game, analysis),
        },
        analysis,
        game.league,
        'corners_totals'
      )
    )
    .filter((o) => o.tier && o.ev >= footballConfig.minEvThreshold);

  scored.sort((a, b) => b.score - a.score || b.ev - a.ev);
  return scored[0] || null;
}

/**
 * 主盤（獨贏/讓球/進球大小）是否「不好買」→ 應抬升角球備選
 */
function mainMarketsWeak(game, analysis, h2h, spread, total) {
  const gate = evaluateH2hDirectionGate(game, analysis);
  const mainCount = [h2h, spread, total].filter(Boolean).length;
  if (mainCount === 0) return true;
  if (!gate.allow && !spread && !total) return true;
  // 三向膠著：最高向 < 45% 且無讓球/大小 → 角球優先
  const maxP = Math.max(analysis.homeWinProb ?? 0, analysis.drawProb ?? 0, analysis.awayWinProb ?? 0);
  if (maxP < 0.45 && !total && !spread) return true;
  return false;
}

export async function pickFootballGameRecommendations(game, markets, analysis, baseReasoning, propsContext = {}) {
  const results = [];
  const usedMarkets = new Set();
  const bookmakers = propsContext.bookmakers || [];

  const h2h = pickH2hCandidates(game, markets, analysis);
  const spread = pickSpreadCandidate(game, markets, analysis);
  const total = pickTotalCandidate(game, markets, analysis);
  const corner = pickCornerCandidate(game, bookmakers, analysis);

  const mainWeak = mainMarketsWeak(game, analysis, h2h, spread, total);
  const mainCandidates = [h2h, spread, total].filter(Boolean);

  // 主盤膠著 → 角球可升主推；否則角球作次推備選
  let ordered = [];
  if (mainWeak && corner) {
    ordered.push({ ...corner, isPrimary: true, fallbackReason: '主盤膠著，改推角球' });
    for (const c of mainCandidates) ordered.push({ ...c, isPrimary: false });
  } else {
    const primary = mainCandidates.sort((a, b) => b.score - a.score)[0];
    if (primary) ordered.push({ ...primary, isPrimary: true });
    for (const c of mainCandidates) {
      if (c && c !== primary) ordered.push({ ...c, isPrimary: false });
    }
    if (corner) ordered.push({ ...corner, isPrimary: false, fallbackReason: '角球備選' });
  }

  for (const pick of ordered) {
    if (usedMarkets.has(pick.market)) continue;
    const direction = pick.directionNote || formatThreeWayDirection(game, analysis);
    const gate = evaluateH2hDirectionGate(game, analysis);
    const reasoningParts = [direction];
    if (pick.fallbackReason) reasoningParts.push(pick.fallbackReason);
    if (!gate.allow && pick.market !== 'h2h') {
      reasoningParts.push(gate.reason);
    }
    if (baseReasoning) reasoningParts.push(baseReasoning);
    if (pick.market === 'h2h') reasoningParts.push('獨贏');
    else if (pick.market === 'spreads') reasoningParts.push(`讓球 ${pick.line}`);
    else if (pick.market === 'totals') {
      reasoningParts.push(
        `模型 ${pick.modelTotal?.toFixed(1) ?? pick.projectedTotal?.toFixed(1) ?? '?'} 球 · 盤口 ${pick.line}`
      );
    } else if (pick.market === 'corners_totals') {
      reasoningParts.push(
        `角球模型 ${pick.projectedCorners?.toFixed(1) ?? pick.modelCorners?.toFixed(1) ?? '?'} · 盤口 ${pick.line}`
      );
    }

    results.push({
      ...pick,
      reasoning: reasoningParts.join(' | '),
      bookmaker: pick.odds?.bookmaker || pick.bookmaker,
    });
    usedMarkets.add(pick.market);
  }

  if (footballConfig.enablePlayerProps && propsContext.propsMap) {
    const props = await pickFootballPropCandidates(
      game,
      propsContext.propsMap,
      analysis,
      propsContext
    );
    for (const p of props) {
      if (usedMarkets.has(`${p.market}|${p.pick}`)) continue;
      results.push({
        ...p,
        isPrimary: false,
        reasoning: `${baseReasoning} | 球員盤`,
        bookmaker: p.bookmaker,
      });
      usedMarkets.add(`${p.market}|${p.pick}`);
    }
  }

  return results
    .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0) || b.score - a.score)
    .slice(0, footballConfig.maxPicksPerGame);
}
