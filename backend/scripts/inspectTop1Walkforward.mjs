import db from '../src/db/database.js';
import {
  buildMlbHistoricalFeatureRows,
  fitMlbBaseline,
  predictMlbBaseline,
} from '../src/services/MlbHistoricalBaseline.js';
import {
  bestFairH2h,
  selectResearchDirection,
} from '../src/services/MlbResearchRanker.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const featureRows = buildMlbHistoricalFeatureRows({});
const featureById = new Map(featureRows.map((row) => [row.gameId, row]));
const days = Math.max(14, Number(process.argv[2] || 60));
const since = new Date();
since.setUTCDate(since.getUTCDate() - days);
const games = db.prepare(`
  SELECT id, commence_time, home_team, away_team, home_score, away_score
  FROM games
  WHERE league = 'MLB'
    AND completed = 1
    AND home_score IS NOT NULL
    AND away_score IS NOT NULL
    AND NOT (home_score = 0 AND away_score = 0)
    AND datetime(commence_time) >= datetime(?)
  ORDER BY datetime(commence_time)
`).all(since.toISOString());

function day(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong' }).format(new Date(iso));
}

const byDay = new Map();
for (const game of games) {
  if (!featureById.has(game.id)) continue;
  const pitOdds = resolvePitOdds(game.id, game.commence_time);
  if (!pitOdds.ok) continue;
  const market = bestFairH2h(pitOdds.bookmakers, game.home_team, game.away_team);
  if (!market) continue;
  const key = day(game.commence_time);
  if (!byDay.has(key)) byDay.set(key, []);
  byDay.get(key).push({ game, market, feature: featureById.get(game.id) });
}

const samples = [];
for (const [d, dayGames] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const first = Date.parse(dayGames[0].game.commence_time);
  const train = featureRows.filter((row) => Date.parse(row.commenceTime) < first);
  if (train.length < 120) continue;
  const { model } = fitMlbBaseline(train, { holdout: false, epochs: 500 });
  const dirs = dayGames.map(({ game, market, feature }) => {
    const homeProb = predictMlbBaseline(model, feature.features.vector);
    const direction = selectResearchDirection({
      homeTeam: game.home_team,
      awayTeam: game.away_team,
      homeModelProb: homeProb,
      awayModelProb: 1 - homeProb,
      market,
    });
    const homeWon = Number(game.home_score) > Number(game.away_score);
    const won = direction.pick === game.home_team ? homeWon : !homeWon;
    return {
      day: d,
      match: `${game.away_team} @ ${game.home_team}`,
      pick: direction.pick,
      odds: Number(direction.oddsDecimal.toFixed(2)),
      edge: Number(direction.edge.toFixed(3)),
      model: Number(direction.modelProb.toFixed(3)),
      market: Number(direction.marketProb.toFixed(3)),
      score: `${game.away_score}-${game.home_score}`,
      result: won ? 'W' : 'L',
      pnl: Number((won ? direction.oddsDecimal - 1 : -1).toFixed(2)),
    };
  }).sort((a, b) => b.edge - a.edge);
  samples.push(dirs[0]);
}

console.log(JSON.stringify(samples.slice(-12), null, 2));
console.log('n', samples.length);
console.log('avgOdds', (samples.reduce((sum, row) => sum + row.odds, 0) / samples.length).toFixed(2));
console.log('hitRate', (samples.filter((row) => row.result === 'W').length / samples.length).toFixed(3));
console.log('roi', (samples.reduce((sum, row) => sum + row.pnl, 0) / samples.length).toFixed(3));
