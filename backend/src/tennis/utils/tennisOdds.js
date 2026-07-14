import { calcEV, decimalToImpliedProb, decimalToNetOdds, removeVig } from '../../utils/odds.js';

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

/** 預期局數淨勝 vs 讓局盤 */
export function estimateTennisCoverProb(expectedGameMargin, spreadPoint, scale = 4.5) {
  const edge = expectedGameMargin + spreadPoint;
  return Math.max(0.05, Math.min(0.92, 1 / (1 + Math.exp(-edge / scale))));
}

export function probGamesOver(projectedGames, line, scale = 3.5) {
  const diff = projectedGames - line;
  return 1 / (1 + Math.exp(-diff / scale));
}

export function extractTennisMarkets(bookmakers) {
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
