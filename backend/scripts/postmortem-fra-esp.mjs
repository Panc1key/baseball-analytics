import db from '../src/db/database.js';
import { analyzeFootballMatchup } from '../src/football/FootballTeamAnalyzer.js';
import {
  outcomeFromGrid,
  totalFromGrid,
  asianHandicapFromGrid,
} from '../src/football/models/DixonColesScoreModel.js';

const games = db
  .prepare(
    `SELECT * FROM games
     WHERE league = 'WC'
       AND (
         (home_team LIKE '%France%' AND away_team LIKE '%Spain%')
         OR (home_team LIKE '%Spain%' AND away_team LIKE '%France%')
       )
     ORDER BY commence_time`
  )
  .all();

console.log(
  'games',
  games.map((g) => ({
    id: g.id.slice(0, 8),
    home: g.home_team,
    away: g.away_team,
    commence: g.commence_time,
    completed: g.completed,
    score: `${g.home_score}-${g.away_score}`,
  }))
);

const g =
  games.find((x) => /France/i.test(x.home_team) && /Spain/i.test(x.away_team)) ||
  games[0];
if (!g) {
  console.log('NO_GAME');
  process.exit(0);
}

const books = JSON.parse(g.raw_odds || '[]');
const a = await analyzeFootballMatchup('WC', g.home_team, g.away_team, books, g.commence_time);

const grid = a.scoreGrid;
const o = outcomeFromGrid(grid);

const scores = [];
for (let i = 0; i <= 4; i++) {
  for (let j = 0; j <= 4; j++) {
    const p = grid[i]?.[j] || 0;
    if (p > 0.008) scores.push({ score: `${i}-${j}`, p: +(p * 100).toFixed(2) });
  }
}
scores.sort((x, y) => y.p - x.p);

const exact02 = grid[0]?.[2] || 0; // home 0 away 2 = France 0 Spain 2
const franceWin = o.homeWinProb;
const draw = o.drawProb;
const spainWin = o.awayWinProb;

const over15 = totalFromGrid(grid, 1.5);
const over25 = totalFromGrid(grid, 2.5);

const ahHome0 = asianHandicapFromGrid(grid, true, 0);
const ahAwayM05 = asianHandicapFromGrid(grid, false, -0.5);
const ahSpainP05 = asianHandicapFromGrid(grid, false, 0.5);

// Brier: actual away win
const brier = (franceWin - 0) ** 2 + (draw - 0) ** 2 + (spainWin - 1) ** 2;
const marketBrier =
  a.marketHomeProb != null
    ? (a.marketHomeProb - 0) ** 2 + (a.marketDrawProb - 0) ** 2 + (a.marketAwayProb - 1) ** 2
    : null;

const recs = db
  .prepare(
    `SELECT market, pick, odds_decimal, model_prob, implied_prob, ev, tier
     FROM recommendations WHERE game_id = ?`
  )
  .all(g.id);

const report = {
  match: `${g.away_team} @ ${g.home_team}`,
  kickoff: g.commence_time,
  storedResult: `${g.home_score}-${g.away_score} (home-away)`,
  actual: 'France 0-2 Spain → 客勝',
  xG: {
    france: +a.homeLambda.toFixed(2),
    spain: +a.awayLambda.toFixed(2),
    total: +(a.homeLambda + a.awayLambda).toFixed(2),
  },
  model1x2: {
    France: +(franceWin * 100).toFixed(1),
    Draw: +(draw * 100).toFixed(1),
    Spain: +(spainWin * 100).toFixed(1),
  },
  market1x2:
    a.marketHomeProb != null
      ? {
          France: +(a.marketHomeProb * 100).toFixed(1),
          Draw: +(a.marketDrawProb * 100).toFixed(1),
          Spain: +(a.marketAwayProb * 100).toFixed(1),
        }
      : null,
  exact_0_2_pct: +(exact02 * 100).toFixed(2),
  topScorelines: scores.slice(0, 8),
  totalsModel: {
    P_over_1_5: +(over15.overProb * 100).toFixed(1),
    P_over_2_5: +(over25.overProb * 100).toFixed(1),
    P_under_2_5: +(over25.underProb * 100).toFixed(1),
    actualGoals: 2,
  },
  asian: {
    France_0: +(ahHome0.winProb * 100).toFixed(1),
    Spain_minus_0_5: +(ahAwayM05.winProb * 100).toFixed(1),
    Spain_plus_0_5: +(ahSpainP05.winProb * 100).toFixed(1),
  },
  brier: {
    model: +brier.toFixed(3),
    market: marketBrier != null ? +marketBrier.toFixed(3) : null,
    note: '越低越好；隨機三向約 0.67，完美 0',
  },
  intel: {
    homeIntel: !!a.homeProfile?.hasIntel,
    awayIntel: !!a.awayProfile?.hasIntel,
    homeLineup: a.homeProfile?.lineupNote || null,
    awayLineup: a.awayProfile?.lineupNote || null,
    homeForm: a.homeProfile?.formSummary || null,
    awayForm: a.awayProfile?.formSummary || null,
  },
  recommendationsAtTime: recs,
  factors: a.factors,
};

console.log(JSON.stringify(report, null, 2));
