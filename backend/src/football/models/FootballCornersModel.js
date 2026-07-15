/**
 * 足球角球大小：主盤（1X2/進球大小）膠著時的備選市場
 * 期望角球 ≈ 聯盟基準 + 進球開放度調整，再與市場線混合
 */
import { footballConfig } from '../config.js';
import { calibrateModelProb, calcEV, decimalToImpliedProb, decimalToNetOdds } from '../../utils/odds.js';

const LEAGUE_AVG_CORNERS = {
  WC: 9.8,
  MLS: 10.4,
  LIGAMX: 10.2,
  KLEAGUE: 9.6,
  DEFAULT: 10.0,
};

export function extractCornerTotals(bookmakers) {
  const pinnacle = bookmakers?.find((b) => /pinnacle/i.test(b.title));
  const books = pinnacle ? [pinnacle, ...(bookmakers || [])] : bookmakers || [];
  const seen = new Set();

  for (const book of books) {
    if (!book?.title || seen.has(book.title)) continue;
    seen.add(book.title);
    const m =
      book.markets?.find((x) => x.key === 'alternate_totals_corners') ||
      book.markets?.find((x) => x.key === 'totals_corners');
    if (!m?.outcomes?.length) continue;

    const overs = m.outcomes.filter((o) => o.name === 'Over' && o.point != null);
    if (!overs.length) continue;

    // 主線：靠近 9.5 / 10.5
    const main = overs.reduce((best, o) => {
      const dist = Math.min(Math.abs(o.point - 9.5), Math.abs(o.point - 10.5));
      const bestDist = Math.min(Math.abs(best.point - 9.5), Math.abs(best.point - 10.5));
      return dist < bestDist ? o : best;
    });

    const under = m.outcomes.find((o) => o.name === 'Under' && o.point === main.point);
    if (!under?.price) continue;

    const overImp = decimalToImpliedProb(main.price);
    const underImp = decimalToImpliedProb(under.price);
    const sum = overImp + underImp;
    return {
      line: main.point,
      overPrice: main.price,
      underPrice: under.price,
      marketOverProb: sum > 0 ? overImp / sum : 0.5,
      bookmaker: book.title,
    };
  }
  return null;
}

/** 從 bookmakers 抽出所有角球大小線（取各線最高價） */
export function extractCornerTotalOutcomes(bookmakers) {
  const best = {};
  for (const book of bookmakers || []) {
    const m =
      book.markets?.find((x) => x.key === 'alternate_totals_corners') ||
      book.markets?.find((x) => x.key === 'totals_corners');
    if (!m) continue;
    for (const o of m.outcomes || []) {
      if (o.point == null || (o.name !== 'Over' && o.name !== 'Under')) continue;
      const id = `${o.name}_${o.point}`;
      if (!best[id] || o.price > best[id].price) {
        best[id] = {
          name: o.name,
          point: o.point,
          price: o.price,
          bookmaker: book.title,
        };
      }
    }
  }
  return best;
}

export function projectMatchCorners({
  league = 'DEFAULT',
  homeLambda = 1.3,
  awayLambda = 1.2,
  homeProfile = null,
  awayProfile = null,
  bookmakers = [],
}) {
  const factors = [];
  const avg = LEAGUE_AVG_CORNERS[league] ?? LEAGUE_AVG_CORNERS.DEFAULT;
  const goals = (homeLambda ?? 0) + (awayLambda ?? 0);
  // 進球期望偏高 → 攻勢來回多 → 角球略增
  let modelCorners = avg + (goals - 2.5) * 1.25;

  if (homeProfile?.tacticalStyle === 'attacking') modelCorners += 0.35;
  if (awayProfile?.tacticalStyle === 'attacking') modelCorners += 0.35;
  if (homeProfile?.tacticalStyle === 'defensive' && awayProfile?.tacticalStyle === 'defensive') {
    modelCorners -= 0.55;
  }

  modelCorners = Math.max(7.5, Math.min(14.5, modelCorners));
  const market = extractCornerTotals(bookmakers);
  let finalCorners = modelCorners;
  let dataQuality = 0.45;

  if (market) {
    const blend = footballConfig.cornersMarketBlend ?? 0.55;
    finalCorners = modelCorners * (1 - blend) + market.line * blend;
    factors.push(
      `角球模型 ${modelCorners.toFixed(1)} · 市場 ${market.line}（大${(market.marketOverProb * 100).toFixed(0)}%）· 混合 ${(blend * 100).toFixed(0)}%`
    );
    dataQuality = 0.65;
  } else {
    factors.push(`角球模型 ${modelCorners.toFixed(1)}（無市場線）`);
  }

  return {
    modelCorners,
    finalCorners,
    marketLine: market?.line ?? null,
    marketOverProb: market?.marketOverProb ?? null,
    modelMarketGap: market ? Math.abs(modelCorners - market.line) : null,
    dataQuality,
    factors,
    hasMarket: Boolean(market),
  };
}

function cornersOverProb(expected, line) {
  // logistic；σ≈1.15 角球
  const diff = expected - line;
  return 1 / (1 + Math.exp(-diff / 1.15));
}

export function buildCornerCandidates(bookmakers, projection) {
  const outcomes = extractCornerTotalOutcomes(bookmakers);
  const candidates = [];
  const expected = projection.finalCorners ?? projection.modelCorners;
  if (!expected || !Object.keys(outcomes).length) return candidates;

  for (const [, o] of Object.entries(outcomes)) {
    const isOver = o.name === 'Over';
    const line = o.point;
    // 只看靠近模型的線，避免極端交替線
    if (Math.abs(line - expected) > 2.25) continue;

    const rawOver = cornersOverProb(expected, line);
    const rawProb = isOver ? rawOver : 1 - rawOver;
    const impliedProb = decimalToImpliedProb(o.price);
    const modelProb = calibrateModelProb(rawProb, impliedProb, footballConfig.maxModelEdgePct ?? 0.1);
    const ev = calcEV(modelProb, decimalToNetOdds(o.price));
    const edgePct = (modelProb - impliedProb) * 100;

    // 方向須與模型一致
    const favorsOver = expected >= line + (footballConfig.cornersMinLineGap ?? 0.25);
    const favorsUnder = expected <= line - (footballConfig.cornersMinLineGap ?? 0.25);
    if (isOver && !favorsOver) continue;
    if (!isOver && !favorsUnder) continue;
    if (edgePct < (footballConfig.cornersMinEdgePct ?? 2.0)) continue;
    if (ev < (footballConfig.minEvThreshold ?? 0.03)) continue;

    candidates.push({
      market: 'corners_totals',
      marketGroup: 'corners',
      pick: isOver ? `角球大 ${line}` : `角球小 ${line}`,
      line,
      side: isOver ? 'over' : 'under',
      odds: o,
      oddsDecimal: o.price,
      bookmaker: o.bookmaker,
      modelProb,
      rawModelProb: rawProb,
      impliedProb,
      ev,
      edgePct,
      projectedCorners: expected,
      modelCorners: projection.modelCorners,
      structuralOk: true,
      probabilityCalibrated: true,
    });
  }

  candidates.sort((a, b) => b.ev - a.ev || b.edgePct - a.edgePct);
  return candidates;
}
