/**
 * 足球賠率工具（含三向獨贏去抽水）
 */
import { calcEV, decimalToImpliedProb, decimalToNetOdds } from '../../utils/odds.js';

export { calcEV, decimalToImpliedProb, decimalToNetOdds };

/** 三向市場去抽水 */
export function removeVig3(probHome, probDraw, probAway) {
  const total = probHome + probDraw + probAway;
  if (total <= 0) return { fairHome: 1 / 3, fairDraw: 1 / 3, fairAway: 1 / 3 };
  return {
    fairHome: probHome / total,
    fairDraw: probDraw / total,
    fairAway: probAway / total,
  };
}

/** 從莊家提取三向獨贏公平概率 */
export function extractFairH2h3(bookmakers, homeTeam, awayTeam) {
  const pinnacle = bookmakers?.find((b) => /pinnacle/i.test(b.title));
  const books = pinnacle ? [pinnacle] : bookmakers?.slice(0, 4) || [];

  for (const book of books) {
    const h2h = book.markets?.find((m) => m.key === 'h2h');
    if (!h2h?.outcomes?.length) continue;

    const home = h2h.outcomes.find((o) => o.name === homeTeam);
    const away = h2h.outcomes.find((o) => o.name === awayTeam);
    const draw = h2h.outcomes.find((o) => o.name === 'Draw' || o.name === '平');
    if (!home?.price || !away?.price) continue;

    const hp = decimalToImpliedProb(home.price);
    const ap = decimalToImpliedProb(away.price);
    const dp = draw?.price ? decimalToImpliedProb(draw.price) : 0;
    const fair = removeVig3(hp, dp, ap);

    return {
      homeProb: fair.fairHome,
      drawProb: fair.fairDraw,
      awayProb: fair.fairAway,
      bookmaker: book.title,
      prices: { home: home.price, draw: draw?.price, away: away.price },
    };
  }
  return null;
}

/** 亞洲讓球蓋盤機率（足球係數） */
export function estimateSoccerCoverProb(winProb, drawProb, spreadPoint) {
  const absLine = Math.abs(spreadPoint);
  if (spreadPoint < 0) {
    return Math.max(0.05, Math.min(0.92, winProb - drawProb * 0.35 - absLine * 0.14));
  }
  return Math.max(0.05, Math.min(0.92, winProb + drawProb * 0.4 + absLine * 0.11));
}

/** 大於盤口總進球線的機率（預估值直接對比盤口線，非 line+0.5） */
export function probGoalsOver(projectedGoals, line) {
  const diff = projectedGoals - line;
  return 1 / (1 + Math.exp(-diff / 0.42));
}

export function extractSoccerMarkets(bookmakers) {
  const result = { h2h: {}, spreads: {}, totals: {} };

  for (const book of bookmakers || []) {
    for (const market of book.markets || []) {
      const key = market.key;
      if (!['h2h', 'spreads', 'totals'].includes(key)) continue;

      for (const outcome of market.outcomes || []) {
        const id =
          key === 'totals'
            ? `${outcome.name}_${outcome.point}`
            : key === 'spreads'
              ? `${outcome.name}_${outcome.point}`
              : outcome.name;

        const existing = result[key][id];
        if (!existing || outcome.price > existing.price) {
          result[key][id] = {
            name: outcome.name,
            point: outcome.point ?? null,
            price: outcome.price,
            bookmaker: book.title,
          };
        }
      }
    }
  }
  return result;
}
