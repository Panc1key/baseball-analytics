import { calcEV, decimalToImpliedProb, decimalToNetOdds, removeVig } from '../../utils/odds.js';
import { normalCoverProb } from '../models/BasketballNormal.js';

export { calcEV, decimalToImpliedProb, decimalToNetOdds };

export function extractFairH2h2(bookmakers, homeTeam, awayTeam) {
  const pinnacle = bookmakers?.find((b) => /pinnacle/i.test(b.title));
  const books = pinnacle ? [pinnacle] : bookmakers?.slice(0, 4) || [];

  for (const book of books) {
    const h2h = book.markets?.find((m) => m.key === 'h2h');
    if (!h2h?.outcomes?.length) continue;
    const home = h2h.outcomes.find((o) => o.name === homeTeam);
    const away = h2h.outcomes.find((o) => o.name === awayTeam);
    if (!home?.price || !away?.price) continue;
    const fair = removeVig(decimalToImpliedProb(home.price), decimalToImpliedProb(away.price));
    return {
      homeProb: fair.fairA,
      awayProb: fair.fairB,
      bookmaker: book.title,
      prices: { home: home.price, away: away.price },
    };
  }
  return null;
}

/** 常態淨勝分蓋盤（標準）；sd 預設 11.5 */
export function estimateBasketballCoverProb(expectedMargin, spreadPoint, sd = 11.5) {
  return normalCoverProb(expectedMargin, spreadPoint, sd);
}

export function extractBasketballMarkets(bookmakers) {
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
