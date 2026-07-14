import { calcEV, decimalToImpliedProb, decimalToNetOdds } from '../utils/odds.js';
import { calibrateModelProb } from '../utils/odds.js';
import { footballConfig, SOCCER_PROP_LABELS } from './config.js';
import { enrichFootballCandidate } from './FootballPickScorer.js';
import { fetchPlayerSeasonStats, findPlayerStats } from './FootballStatsService.js';

export function extractSoccerPlayerProps(bookmakers) {
  const result = {};

  for (const book of bookmakers || []) {
    for (const market of book.markets || []) {
      if (!market.key?.startsWith('player_')) continue;

      for (const outcome of market.outcomes || []) {
        const isYesNo = outcome.name === 'Yes' || outcome.name === 'No';
        const isOu = outcome.name === 'Over' || outcome.name === 'Under';

        if (isYesNo) {
          if (outcome.name !== 'Yes') continue;
          const playerName = outcome.description || outcome.name;
          const id = `${market.key}|${playerName}|yes`;
          const existing = result[id];
          if (!existing || outcome.price > existing.price) {
            result[id] = {
              marketKey: market.key,
              playerName,
              side: 'yes',
              point: null,
              price: outcome.price,
              bookmaker: book.title,
            };
          }
        } else if (isOu && outcome.point != null) {
          const playerName = outcome.description || outcome.name;
          const side = outcome.name === 'Over' ? 'over' : 'under';
          const id = `${market.key}|${playerName}|${outcome.point}|${side}`;
          const existing = result[id];
          if (!existing || outcome.price > existing.price) {
            result[id] = {
              marketKey: market.key,
              playerName,
              side,
              point: outcome.point,
              price: outcome.price,
              bookmaker: book.title,
            };
          }
        }
      }
    }
  }

  return result;
}

function estimateAnytimeGoalProb(stats) {
  if (!stats) return null;
  const apps = Math.max(stats.appearances, 1);
  const goalsPer90 = (stats.goals / Math.max(stats.minutes, 90)) * 90;
  const rate = Math.min(0.85, goalsPer90 * 0.55 + (stats.shotsOn / apps) * 0.04);
  return Math.max(0.05, Math.min(0.75, rate));
}

function estimateShotsOnTargetProb(stats, line) {
  if (!stats || line == null) return null;
  const apps = Math.max(stats.appearances, 1);
  const perGame = stats.shotsOn / apps;
  const diff = perGame - (line + 0.5);
  return 1 / (1 + Math.exp(-diff / 0.35));
}

function estimateAssistsProb(stats, line) {
  if (!stats || line == null) return null;
  const apps = Math.max(stats.appearances, 1);
  const perGame = stats.assists / apps;
  const diff = perGame - (line + 0.5);
  return 1 / (1 + Math.exp(-diff / 0.25));
}

function estimateCardProb(stats) {
  if (!stats) return null;
  const apps = Math.max(stats.appearances, 1);
  return Math.max(0.08, Math.min(0.55, (stats.cards / apps) * 0.9));
}

async function modelPropProb(prop, propsContext) {
  const { homeTeamId, awayTeamId, leagueCode, playerStatsCache } = propsContext;
  let stats = playerStatsCache?.[prop.playerName];

  if (!stats && leagueCode) {
    const homePlayers = homeTeamId ? await fetchPlayerSeasonStats(homeTeamId, leagueCode) : [];
    const awayPlayers = awayTeamId ? await fetchPlayerSeasonStats(awayTeamId, leagueCode) : [];
    stats =
      findPlayerStats(homePlayers, prop.playerName) ||
      findPlayerStats(awayPlayers, prop.playerName);
    if (playerStatsCache && stats) playerStatsCache[prop.playerName] = stats;
  }

  switch (prop.marketKey) {
    case 'player_goal_scorer_anytime':
    case 'player_first_goal_scorer':
      return prop.marketKey === 'player_first_goal_scorer'
        ? (estimateAnytimeGoalProb(stats) ?? 0.12) * 0.35
        : estimateAnytimeGoalProb(stats);
    case 'player_shots_on_target':
      return prop.side === 'over'
        ? estimateShotsOnTargetProb(stats, prop.point)
        : stats
          ? 1 - estimateShotsOnTargetProb(stats, prop.point)
          : null;
    case 'player_shots':
      return prop.side === 'over'
        ? estimateShotsOnTargetProb(stats, prop.point)
          ? estimateShotsOnTargetProb(stats, prop.point) * 1.15
          : null
        : null;
    case 'player_assists':
      return prop.side === 'over'
        ? estimateAssistsProb(stats, prop.point)
        : stats
          ? 1 - estimateAssistsProb(stats, prop.point)
          : null;
    case 'player_to_receive_card':
      return estimateCardProb(stats);
    default:
      return null;
  }
}

export async function pickFootballPropCandidates(game, propsMap, analysis, propsContext = {}) {
  if (!propsMap || !Object.keys(propsMap).length) return [];

  const playerStatsCache = {};
  const ctx = {
    ...propsContext,
    leagueCode: game.league,
    homeTeamId: analysis.homeProfile?.teamId,
    awayTeamId: analysis.awayProfile?.teamId,
    playerStatsCache,
  };

  const candidates = [];

  for (const prop of Object.values(propsMap)) {
    let modelProb = await modelPropProb(prop, ctx);
    if (modelProb == null) continue;

    const implied = decimalToImpliedProb(prop.price);
    modelProb = calibrateModelProb(modelProb, implied, footballConfig.maxModelEdgePct);
    const ev = calcEV(modelProb, decimalToNetOdds(prop.price));
    if (ev < footballConfig.minEvThreshold) continue;

    const label = SOCCER_PROP_LABELS[prop.marketKey] || prop.marketKey;
    const pick =
      prop.side === 'yes'
        ? `${prop.playerName} ${label}`
        : `${prop.playerName} ${label} ${prop.side === 'over' ? '大' : '小'} ${prop.point}`;

    candidates.push(
      enrichFootballCandidate(
        {
          market: prop.marketKey,
          marketGroup: 'props',
          pick,
          line: prop.point,
          oddsDecimal: prop.price,
          modelProb,
          ev,
          confidence: analysis.confidence,
          structuralOk: true,
          bookmaker: prop.bookmaker,
          playerName: prop.playerName,
        },
        analysis,
        game.league,
        'props'
      )
    );
  }

  return candidates
    .filter((c) => c.tier)
    .sort((a, b) => b.score - a.score || b.ev - a.ev)
    .slice(0, 3);
}
