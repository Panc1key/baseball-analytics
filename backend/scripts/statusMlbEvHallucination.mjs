import {
  getLatestMlbExpectedRunsValidation,
  classifyMlbMoneylineCandidate,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import db from '../src/db/database.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';

const latest = getLatestMlbExpectedRunsValidation();
const model = latest.model;
const fallback = model.fallbackModel;
const covered = new Set(db.prepare(`
  SELECT DISTINCT game_id
  FROM mlb_probable_starter_snapshots
  WHERE status = 'complete'
    AND datetime(captured_at) < datetime(commence_time)
`).all().map((r) => r.game_id));

const rows = db.prepare(`
  SELECT f.game_id, f.commence_time, f.features_json, g.home_team, g.away_team, g.home_score, g.away_score
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  WHERE f.feature_version = 'mlb-foundation-pit-v1'
    AND g.completed = 1
    AND datetime(f.commence_time) >= datetime('2026-01-01')
`).all();

function marketH2h(row) {
  const pit = resolvePitOdds(row.game_id, row.commence_time);
  if (!pit.ok) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'h2h');
    if (!market) continue;
    const home = market.outcomes?.find((o) => o.name === row.home_team);
    const away = market.outcomes?.find((o) => o.name === row.away_team);
    if (!home?.price || !away?.price) continue;
    const fair = removeVig(decimalToImpliedProb(home.price), decimalToImpliedProb(away.price));
    const vig = 1 / home.price + 1 / away.price;
    if (!best || vig < best.vig) {
      best = {
        homeOdds: Number(home.price),
        awayOdds: Number(away.price),
        homeProb: fair.fairA,
        awayProb: fair.fairB ?? 1 - fair.fairA,
        vig,
      };
    }
  }
  return best;
}

const allPositive = [];
const strict = [];
const byEdge = [];

for (const row of rows) {
  const features = JSON.parse(row.features_json);
  features.homeTeam = row.home_team;
  features.awayTeam = row.away_team;
  features.gameId = row.game_id;
  features.commenceTime = row.commence_time;
  const active = covered.has(row.game_id) ? model : fallback;
  const modelStatus = covered.has(row.game_id) ? 'research_scored' : 'research_scored_fallback';
  const prediction = predictMlbGameRuns(active, features);
  const market = marketH2h(row);
  if (!market) continue;
  const homeWon = Number(row.home_score) > Number(row.away_score) ? 1 : 0;
  const homeEdge = prediction.markets.homeWinProbability - market.homeProb;
  const pickHome = homeEdge >= 0;
  const modelProbability = pickHome
    ? prediction.markets.homeWinProbability
    : prediction.markets.awayWinProbability;
  const odds = pickHome ? market.homeOdds : market.awayOdds;
  const won = pickHome ? homeWon === 1 : homeWon === 0;
  const ev = modelProbability * odds - 1;
  if (ev > 0) {
    allPositive.push({ won, odds, modelProbability, ev });
  }
  const candidate = classifyMlbMoneylineCandidate({
    prediction,
    market,
    modelStatus,
  });
  if (candidate.tier === 'recommendation') {
    strict.push({
      won: candidate.side === 'home' ? homeWon === 1 : homeWon === 0,
      odds: candidate.odds,
      modelProbability: candidate.modelProbability,
      expectedValue: candidate.expectedValue,
    });
  }
}

function summarize(bets) {
  if (!bets.length) return { samples: 0 };
  const wins = bets.filter((b) => b.won).length;
  const profit = bets.reduce((s, b) => s + (b.won ? b.odds - 1 : -1), 0);
  const roi = profit / bets.length;
  const probs = bets.map((b) => b.modelProbability);
  return {
    samples: bets.length,
    wins,
    winRate: wins / bets.length,
    averageOdds: bets.reduce((s, b) => s + b.odds, 0) / bets.length,
    averageModelProbability: probs.reduce((s, p) => s + p, 0) / probs.length,
    roi,
  };
}

console.log(JSON.stringify({
  modelVersion: latest.modelVersion,
  allPositiveEv: summarize(allPositive),
  strictRecommendation: summarize(strict),
  storedStrict: latest.summary?.routedFinalObserved?.strictMoneylineRecommendations?.all
    || latest.summary?.routedFinalObserved?.strictMoneylineRecommendations
    || null,
  storedPositive: latest.summary?.routedFinalObserved?.moneylineBetDiagnostics?.all
    || null,
}, null, 2));
