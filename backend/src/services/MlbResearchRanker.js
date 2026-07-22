/**
 * MLB 研究方向排序與紙上驗證。
 *
 * 正式推薦已停用。本模組只做：
 * 1. 獨立模型概率 vs 去水市場 → 錯價（edge）
 * 2. 每日 Top1 / Top3 研究方向排序
 * 3. Walk-forward 紙上結算（命中、ROI、相對市場）
 */
import db from '../db/database.js';
import { decimalToImpliedProb, removeVig } from '../utils/odds.js';
import {
  buildMlbHistoricalFeatureRows,
  fitMlbBaseline,
  predictMlbBaseline,
  MLB_BASELINE_FEATURE_VERSION,
} from './MlbHistoricalBaseline.js';
import { resolvePitOdds } from './PitOddsService.js';

const RESEARCH_STRATEGY = 'mlb-research-rank-v1';

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 與真相管線相同：同一 bookmaker 雙邊 h2h 去水。 */
export function bestFairH2h(bookmakers, homeTeam, awayTeam) {
  let selected = null;
  for (const book of bookmakers || []) {
    const market = (book.markets || []).find((item) => item.key === 'h2h');
    if (!market?.outcomes?.length) continue;
    const home = market.outcomes.find((item) => item.name === homeTeam);
    const away = market.outcomes.find((item) => item.name === awayTeam);
    if (!home?.price || !away?.price) continue;
    const fair = removeVig(decimalToImpliedProb(home.price), decimalToImpliedProb(away.price));
    const vig = decimalToImpliedProb(home.price) + decimalToImpliedProb(away.price);
    const candidate = {
      bookmaker: book.title || book.key || 'unknown',
      homeOdds: Number(home.price),
      awayOdds: Number(away.price),
      homeProb: fair.fairA,
      awayProb: fair.fairB,
      vig,
    };
    if (!selected || candidate.vig < selected.vig) selected = candidate;
  }
  return selected;
}

/**
 * 模型概率與市場比較後，選出正 edge 最大的一方。
 * 不可用「模型 > 50%」當選邊規則。
 */
export function selectResearchDirection({
  homeTeam,
  awayTeam,
  homeModelProb,
  awayModelProb,
  market,
}) {
  if (!market || !Number.isFinite(homeModelProb) || !Number.isFinite(awayModelProb)) return null;
  const homeEdge = homeModelProb - market.homeProb;
  const awayEdge = awayModelProb - market.awayProb;
  if (![homeEdge, awayEdge].every(Number.isFinite)) return null;
  const pickHome = homeEdge >= awayEdge;
  const modelProb = pickHome ? homeModelProb : awayModelProb;
  const marketProb = pickHome ? market.homeProb : market.awayProb;
  const odds = pickHome ? market.homeOdds : market.awayOdds;
  const edge = pickHome ? homeEdge : awayEdge;
  const ev = modelProb * odds - 1;
  return {
    pick: pickHome ? homeTeam : awayTeam,
    side: pickHome ? 'home' : 'away',
    modelProb,
    marketProb,
    oddsDecimal: odds,
    edge,
    ev,
    bookmaker: market.bookmaker,
  };
}

function localDateKey(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function settleDirection(direction, game) {
  if (!direction?.pick) return null;
  const homeScore = Number(game.home_score);
  const awayScore = Number(game.away_score);
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore) || homeScore === awayScore) {
    return 'void';
  }
  const homeWon = homeScore > awayScore;
  const won = direction.pick === game.home_team ? homeWon : !homeWon;
  return won ? 'win' : 'loss';
}

function summarizeSettled(rows) {
  const decided = rows.filter((row) => row.result === 'win' || row.result === 'loss');
  if (!decided.length) {
    return { n: 0, wins: 0, losses: 0, hitRate: null, roi: null, avgEdge: null, profitUnits: 0 };
  }
  let profit = 0;
  let edgeSum = 0;
  let wins = 0;
  for (const row of decided) {
    edgeSum += Number(row.edge || 0);
    if (row.result === 'win') {
      wins += 1;
      profit += Number(row.oddsDecimal) - 1;
    } else {
      profit -= 1;
    }
  }
  return {
    n: decided.length,
    wins,
    losses: decided.length - wins,
    hitRate: wins / decided.length,
    roi: profit / decided.length,
    avgEdge: edgeSum / decided.length,
    profitUnits: Math.round(profit * 100) / 100,
  };
}

function marketFavoriteDirection(game, market) {
  if (!market) return null;
  const pickHome = market.homeProb >= market.awayProb;
  return {
    pick: pickHome ? game.home_team : game.away_team,
    side: pickHome ? 'home' : 'away',
    modelProb: pickHome ? market.homeProb : market.awayProb,
    marketProb: pickHome ? market.homeProb : market.awayProb,
    oddsDecimal: pickHome ? market.homeOdds : market.awayOdds,
    edge: 0,
    ev: (pickHome ? market.homeProb : market.awayProb) * (pickHome ? market.homeOdds : market.awayOdds) - 1,
    bookmaker: market.bookmaker,
  };
}

/**
 * 依香港日曆日分組，按 edge 降序標註 dailyRank。
 * 正式推薦語意禁止出現；此處只產生研究排序。
 */
export function attachDailyResearchRanks(gameRows) {
  const byDay = new Map();
  for (const row of gameRows) {
    const key = localDateKey(row.commenceTime || row.commence_time);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(row);
  }

  const ranked = [];
  for (const [day, rows] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sortable = rows
      .map((row) => ({
        ...row,
        _sortEdge: Number(row.research?.edge ?? row.edge ?? Number.NEGATIVE_INFINITY),
      }))
      .sort((a, b) => b._sortEdge - a._sortEdge || String(a.gameId).localeCompare(String(b.gameId)));

    sortable.forEach((row, index) => {
      const { _sortEdge, ...rest } = row;
      ranked.push({
        ...rest,
        researchDay: day,
        dailyRank: Number.isFinite(_sortEdge) ? index + 1 : null,
        researchTier:
          !Number.isFinite(_sortEdge)
            ? 'unranked'
            : index === 0
              ? 'top1_observation'
              : index < 3
                ? 'top3_observation'
                : 'watchlist',
      });
    });
  }
  return ranked;
}

/**
 * Walk-forward：每一天只用該日前資料訓練，再對當日場次排 Top1/Top3。
 * 這是紙上驗證，不是正式推薦。
 */
export function runMlbDailyTopWalkForward({
  days = 60,
  minTrainGames = 120,
  topN = 3,
} = {}) {
  const featureRows = buildMlbHistoricalFeatureRows({});
  const featureById = new Map(featureRows.map((row) => [row.gameId, row]));

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - Math.max(14, Number(days) || 60));
  const games = db.prepare(`
    SELECT id, commence_time, home_team, away_team, home_score, away_score, completed
    FROM games
    WHERE league = 'MLB'
      AND completed = 1
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND NOT (home_score = 0 AND away_score = 0)
      AND home_team NOT IN ('American League', 'National League')
      AND away_team NOT IN ('American League', 'National League')
      AND datetime(commence_time) >= datetime(?)
    ORDER BY datetime(commence_time) ASC, id ASC
  `).all(since.toISOString());

  const byDay = new Map();
  let skippedNoPitOdds = 0;
  for (const game of games) {
    if (!featureById.has(game.id)) continue;
    const pitOdds = resolvePitOdds(game.id, game.commence_time);
    if (!pitOdds.ok) {
      skippedNoPitOdds += 1;
      continue;
    }
    const market = bestFairH2h(pitOdds.bookmakers, game.home_team, game.away_team);
    if (!market) {
      skippedNoPitOdds += 1;
      continue;
    }
    const day = localDateKey(game.commence_time);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({
      game,
      market,
      feature: featureById.get(game.id),
      pitOdds: {
        snapshotId: pitOdds.snapshotId,
        capturedAt: pitOdds.capturedAt,
        source: pitOdds.source,
      },
    });
  }

  const top1 = [];
  const top3 = [];
  const allRanked = [];
  const marketTop1 = [];
  let daysUsed = 0;
  let skippedNoTrain = 0;

  for (const [day, dayGames] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const firstMs = Date.parse(dayGames[0].game.commence_time);
    const trainRows = featureRows.filter((row) => Date.parse(row.commenceTime) < firstMs);
    if (trainRows.length < minTrainGames) {
      skippedNoTrain += 1;
      continue;
    }

    let fitted;
    try {
      fitted = fitMlbBaseline(trainRows, {
        featureKeys: [
          'seasonWinPctDiff',
          'venueRecordDiff',
          'last10WinPctDiff',
          'recentRunsDiff',
          'recentRunsAllowedDiff',
        ],
        epochs: 500,
        holdout: false,
      });
    } catch {
      skippedNoTrain += 1;
      continue;
    }

    const model = fitted.model;
    const directions = dayGames.map(({ game, market, feature, pitOdds }) => {
      const homeModelProb = predictMlbBaseline(model, feature.features.vector);
      const direction = selectResearchDirection({
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        homeModelProb,
        awayModelProb: 1 - homeModelProb,
        market,
      });
      const favorite = marketFavoriteDirection(game, market);
      return {
        day,
        gameId: game.id,
        commenceTime: game.commence_time,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        research: direction,
        marketFavorite: favorite,
        result: settleDirection(direction, game),
        marketFavoriteResult: settleDirection(favorite, game),
        edge: direction?.edge ?? null,
        oddsDecimal: direction?.oddsDecimal ?? null,
        modelProb: direction?.modelProb ?? null,
        marketProb: direction?.marketProb ?? null,
        oddsSnapshot: pitOdds,
      };
    }).filter((row) => row.research);

    if (!directions.length) continue;
    daysUsed += 1;

    const ranked = [...directions].sort((a, b) => b.edge - a.edge);
    ranked.forEach((row, index) => {
      const item = {
        ...row,
        dailyRank: index + 1,
        researchTier: index === 0 ? 'top1_observation' : index < topN ? 'top3_observation' : 'watchlist',
      };
      allRanked.push(item);
      if (index === 0) top1.push(item);
      if (index < topN) top3.push(item);
    });

    const marketRanked = [...directions]
      .map((row) => ({
        ...row,
        edge: 0,
        oddsDecimal: row.marketFavorite?.oddsDecimal,
        pick: row.marketFavorite?.pick,
        result: row.marketFavoriteResult,
      }))
      .sort((a, b) => (b.marketFavorite?.marketProb || 0) - (a.marketFavorite?.marketProb || 0));
    if (marketRanked[0]) {
      marketTop1.push({
        ...marketRanked[0],
        dailyRank: 1,
        result: marketRanked[0].marketFavoriteResult,
        oddsDecimal: marketRanked[0].marketFavorite?.oddsDecimal,
        edge: 0,
      });
    }
  }

  return {
    mode: 'research_walk_forward_paper',
    strategyVersion: RESEARCH_STRATEGY,
    featureVersion: MLB_BASELINE_FEATURE_VERSION,
    warning: '此報告僅驗證研究方向排序，不構成正式推薦或盈利證明。',
    window: { days, minTrainGames, topN },
    coverage: {
      daysUsed,
      skippedNoTrain,
      skippedNoPitOdds,
      gamesRanked: allRanked.length,
    },
    summary: {
      top1: summarizeSettled(top1),
      top3: summarizeSettled(top3),
      allResearchDirections: summarizeSettled(allRanked),
      marketFavoriteTop1: summarizeSettled(marketTop1),
    },
    sampleDays: [...new Set(top1.map((row) => row.day))].slice(-10),
  };
}

export function getMlbResearchRankSummary({ days = 60 } = {}) {
  return runMlbDailyTopWalkForward({ days });
}
