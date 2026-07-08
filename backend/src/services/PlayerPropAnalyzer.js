import { calcEV, decimalToNetOdds, probTotalOver } from '../utils/odds.js';
import { enrichCandidate } from './PickScorer.js';

/** MLB 球員盤口市場 key（The Odds API event-odds） */
export const MLB_PROP_MARKETS = [
  'pitcher_strikeouts',
  'pitcher_outs',
  'pitcher_hits_allowed',
  'batter_hits',
  'batter_total_bases',
  'batter_home_runs',
];

export const PROP_MARKET_LABELS = {
  pitcher_strikeouts: '投手三振',
  pitcher_outs: '投手出局',
  pitcher_hits_allowed: '投手被安打',
  batter_hits: '打者安打',
  batter_total_bases: '打者總壘打',
  batter_home_runs: '打者全壘打',
};

function logisticProb(diff, scale = 1.2) {
  return 1 / (1 + Math.exp(-diff / scale));
}

function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z]/g, '');
}

function nameMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** 從 event-odds 回應提取 props */
export function extractPlayerProps(bookmakers) {
  const result = {};

  for (const book of bookmakers || []) {
    for (const market of book.markets || []) {
      if (!MLB_PROP_MARKETS.includes(market.key)) continue;

      for (const outcome of market.outcomes || []) {
        const playerName = outcome.description || outcome.name;
        const isOu = outcome.name === 'Over' || outcome.name === 'Under';
        if (!isOu || outcome.point == null) continue;

        const side = outcome.name === 'Over' ? 'over' : 'under';
        const id = `${market.key}|${playerName}|${outcome.point}|${side}`;
        const existing = result[id];
        if (!existing || outcome.price > existing.price) {
          result[id] = {
            marketKey: market.key,
            playerName,
            point: outcome.point,
            side,
            price: outcome.price,
            bookmaker: book.title,
          };
        }
      }
    }
  }

  return result;
}

function estimatePitcherStrikeoutProb(pitcherStats, line) {
  if (!pitcherStats || line == null) return null;
  const ip = parseFloat(pitcherStats.inningsPitched) || 50;
  const k = parseFloat(pitcherStats.strikeOuts) || 0;
  const kPer9 = ip > 0 ? (k / ip) * 9 : 7;
  const expectedK = kPer9 * (5.5 / 9);
  return logisticProb(expectedK - (line + 0.5), 1.4);
}

function estimatePitcherOutsProb(pitcherStats, line) {
  if (!pitcherStats || line == null) return null;
  const ip = parseFloat(pitcherStats.inningsPitched) || 50;
  const avgOuts = Math.min(21, Math.max(12, (ip / Math.max(pitcherStats.gamesStarted || 10, 1)) * 3 * 0.85));
  return logisticProb(avgOuts - (line + 0.5), 2);
}

function estimateBatterHitsProb(line) {
  if (line == null) return null;
  const expectedHits = 0.95;
  return logisticProb(expectedHits - (line + 0.5), 0.35);
}

function estimateBatterTotalBasesProb(line) {
  if (line == null) return null;
  const expected = 1.45;
  return logisticProb(expected - (line + 0.5), 0.55);
}

function estimateBatterHrProb(line) {
  if (line == null) return null;
  const expected = 0.22;
  return logisticProb(expected - (line + 0.5), 0.12);
}

function estimatePitcherHitsAllowedProb(pitcherStats, line) {
  if (!pitcherStats || line == null) return null;
  const ip = parseFloat(pitcherStats.inningsPitched) || 50;
  const h = parseFloat(pitcherStats.hits) || ip * 0.9;
  const hPer9 = ip > 0 ? (h / ip) * 9 : 8.5;
  const expected = hPer9 * (5.5 / 9);
  return logisticProb(expected - (line + 0.5), 1.2);
}

function modelPropProb(marketKey, line, pitcherStats) {
  switch (marketKey) {
    case 'pitcher_strikeouts':
      return estimatePitcherStrikeoutProb(pitcherStats, line);
    case 'pitcher_outs':
      return estimatePitcherOutsProb(pitcherStats, line);
    case 'pitcher_hits_allowed':
      return estimatePitcherHitsAllowedProb(pitcherStats, line);
    case 'batter_hits':
      return estimateBatterHitsProb(line);
    case 'batter_total_bases':
      return estimateBatterTotalBasesProb(line);
    case 'batter_home_runs':
      return estimateBatterHrProb(line);
    default:
      return null;
  }
}

function formatPropPick(prop) {
  const label = PROP_MARKET_LABELS[prop.marketKey] || prop.marketKey;
  if (prop.side === 'over' || prop.side === 'under') {
    const cn = prop.side === 'over' ? '大' : '小';
    return `${prop.playerName} ${label} ${cn} ${prop.point}`;
  }
  return `${prop.playerName} ${label} ${prop.side}`;
}

/**
 * 分析球員盤口候選
 * @param {object} game
 * @param {object} propsMap extractPlayerProps 結果
 * @param {object} context { homePitcherStats, awayPitcherStats, homePitcherName, awayPitcherName }
 */
export function pickPropCandidates(game, propsMap, analysis, context = {}) {
  const results = [];
  const seen = new Set();

  for (const prop of Object.values(propsMap || {})) {
    const isOverUnder = prop.side === 'over' || prop.side === 'under';
    if (!isOverUnder || prop.point == null) continue;

    let pitcherStats = null;
    if (prop.marketKey.startsWith('pitcher_')) {
      const homeMatch = nameMatch(prop.playerName, context.homePitcherName);
      const awayMatch = nameMatch(prop.playerName, context.awayPitcherName);
      pitcherStats = homeMatch ? context.homePitcherStats : awayMatch ? context.awayPitcherStats : null;
      if (!pitcherStats) continue;
    }

    const overProb = modelPropProb(prop.marketKey, prop.point, pitcherStats);
    if (overProb == null) continue;

    const modelProb = prop.side === 'over' ? overProb : 1 - overProb;
    const ev = calcEV(modelProb, decimalToNetOdds(prop.price));
    const pick = formatPropPick(prop);
    const dedupeKey = `${prop.marketKey}|${pick}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const candidate = enrichCandidate(
      {
        market: prop.marketKey,
        marketGroup: 'props',
        pick,
        line: prop.point,
        odds: { price: prop.price, bookmaker: prop.bookmaker },
        oddsDecimal: prop.price,
        modelProb,
        ev,
        confidence: analysis.confidence,
        playerName: prop.playerName,
        structuralOk: true,
      },
      analysis,
      game.league,
      'props'
    );

    if (!candidate.tier) continue;

    results.push({
      ...candidate,
      reasoning: `${PROP_MARKET_LABELS[prop.marketKey] || prop.marketKey} | 模型 ${(modelProb * 100).toFixed(1)}% | 盤口 ${prop.point}`,
      bookmaker: prop.bookmaker,
    });
  }

  return results.sort((a, b) => b.score - a.score || b.modelProb - a.modelProb);
}

export { probTotalOver };
