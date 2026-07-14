/**
 * 足球 / 籃球定價不變量檢查
 */
import {
  buildDixonColesGrid,
  outcomeFromGrid,
  asianHandicapFromGrid,
  totalFromGrid,
  splitAsianQuarterLine,
} from '../src/football/models/DixonColesScoreModel.js';
import { computeFootballH2h } from '../src/football/models/FootballH2hModel.js';
import {
  normalCdf,
  normalCoverProb,
  inverseNormalCdf,
  marginFromWinProb,
} from '../src/basketball/models/BasketballNormal.js';
import {
  projectBasketballScore,
  computeBasketballH2h,
} from '../src/basketball/models/BasketballH2hModel.js';
import {
  runFootballAnalysis,
  getFootballRecommendations,
} from '../src/football/FootballAnalysisEngine.js';
import {
  basketballFullRefresh,
  getBasketballRecommendations,
} from '../src/basketball/BasketballAnalysisEngine.js';

const errors = [];
function assert(cond, msg) {
  if (!cond) errors.push(msg);
}

const { grid, homeLambda, awayLambda } = buildDixonColesGrid(1.55, 1.15, -0.08);
let mass = 0;
for (const row of grid) for (const p of row) mass += p;
assert(Math.abs(mass - 1) < 1e-9, `DC mass ${mass}`);

const o = outcomeFromGrid(grid);
assert(Math.abs(o.homeWinProb + o.drawProb + o.awayWinProb - 1) < 1e-9, '1X2 sum');
assert(o.homeWinProb > o.awayWinProb, 'stronger attack should win more');

const ah05 = asianHandicapFromGrid(grid, true, -0.5);
assert(Math.abs(ah05.winProb + ah05.lossProb + ah05.pushProb - 1) < 1e-6, 'AH -0.5 sum');
assert(
  Math.abs(ah05.winProb - o.homeWinProb) < 0.02,
  `AH-0.5≈homeWin ${ah05.winProb} vs ${o.homeWinProb}`
);

const ah0 = asianHandicapFromGrid(grid, true, 0);
assert(ah0.pushProb > 0.15, `AH0 push ~draw got ${ah0.pushProb}`);

assert(JSON.stringify(splitAsianQuarterLine(-0.25)) === JSON.stringify([0, -0.5]), 'q -0.25');
assert(JSON.stringify(splitAsianQuarterLine(-0.75)) === JSON.stringify([-0.5, -1]), 'q -0.75');
assert(JSON.stringify(splitAsianQuarterLine(0.25)) === JSON.stringify([0, 0.5]), 'q +0.25');

const tot = totalFromGrid(grid, 2.5);
assert(Math.abs(tot.overProb + tot.underProb + tot.pushProb - 1) < 1e-9, 'totals sum');
assert(tot.pushProb < 1e-9, '2.5 no push');

const h2hNull = computeFootballH2h({
  homeTeam: 'A',
  awayTeam: 'B',
  bookmakers: [],
  league: 'MLS',
});
assert(h2hNull.scoreGrid?.length > 0, 'null profile grid');
assert(Number.isFinite(h2hNull.homeWinProb), 'homeWin finite');

const books = [
  {
    title: 'Pinnacle',
    markets: [
      {
        key: 'h2h',
        outcomes: [
          { name: 'HomeFC', price: 1.8 },
          { name: 'Draw', price: 3.5 },
          { name: 'AwayFC', price: 4.5 },
        ],
      },
    ],
  },
];
const blended = computeFootballH2h({
  homeTeam: 'HomeFC',
  awayTeam: 'AwayFC',
  bookmakers: books,
  league: 'MLS',
  homeProfile: {
    goalsPerGame: 1.8,
    goalsAgainstPerGame: 1.0,
    gamesPlayed: 8,
    hasIntel: true,
  },
  awayProfile: {
    goalsPerGame: 1.1,
    goalsAgainstPerGame: 1.4,
    gamesPlayed: 8,
    hasIntel: true,
  },
});
const o2 = outcomeFromGrid(blended.scoreGrid);
assert(
  Math.abs(o2.homeWinProb - blended.homeWinProb) < 1e-12,
  '1X2 must match grid after λ blend'
);

assert(Math.abs(normalCdf(0, 0, 1) - 0.5) < 1e-4, 'Φ(0)=0.5');
assert(Math.abs(inverseNormalCdf(0.5)) < 1e-4, 'Φ⁻¹(0.5)=0');
assert(Math.abs(inverseNormalCdf(0.8413) - 1) < 0.02, 'Φ⁻¹(~0.84)≈1');
const m = marginFromWinProb(0.64, 11.5);
assert(Math.abs(1 - normalCdf(0, m, 11.5) - 0.64) < 0.01, 'margin↔win roundtrip');

const cHalf = normalCoverProb(5, -3.5, 11.5);
assert(cHalf.pushProb === 0, 'half no push');
assert(Math.abs(cHalf.winProb + cHalf.lossProb - 1) < 1e-9, 'half sum');
const cInt = normalCoverProb(5, -3, 11.5);
assert(cInt.pushProb > 0.01, 'int has push');
assert(Math.abs(cInt.winProb + cInt.lossProb + cInt.pushProb - 1) < 1e-6, 'int sum');

const proj = projectBasketballScore({
  league: 'WNBA',
  homeProfile: { ppg: 88, oppg: 80, gamesPlayed: 12, hasIntel: true },
  awayProfile: { ppg: 79, oppg: 84, gamesPlayed: 12, hasIntel: true },
});
assert(proj.expectedMargin > 0, 'strong home margin+');
assert(proj.modelTotal > 140 && proj.modelTotal < 200, `total scale ${proj.modelTotal}`);

const bbBooks = [
  {
    title: 'Pinnacle',
    markets: [
      {
        key: 'h2h',
        outcomes: [
          { name: 'H', price: 1.7 },
          { name: 'A', price: 2.2 },
        ],
      },
    ],
  },
];
const bb = computeBasketballH2h({
  homeTeam: 'H',
  awayTeam: 'A',
  bookmakers: bbBooks,
  league: 'WNBA',
  homeProfile: { ppg: 88, oppg: 80, gamesPlayed: 12, hasIntel: true },
  awayProfile: { ppg: 79, oppg: 84, gamesPlayed: 12, hasIntel: true },
  scoreProjection: proj,
});
const winFromMargin = 1 - normalCdf(0, bb.expectedMargin, 11.5);
assert(
  Math.abs(winFromMargin - bb.homeWinProb) < 0.005,
  'BB win must derive from blended margin'
);

const fa = await runFootballAnalysis();
const ba = await basketballFullRefresh();
const frecs = getFootballRecommendations({ limit: 100 });
const brecs = getBasketballRecommendations({ limit: 100 });

let bad = 0;
for (const r of [...frecs, ...brecs]) {
  if (!Number.isFinite(r.model_prob) || r.model_prob <= 0 || r.model_prob >= 1) bad++;
  if (!Number.isFinite(r.ev)) bad++;
  if (!Number.isFinite(r.odds_decimal) || r.odds_decimal <= 1) bad++;
}
assert(bad === 0, `bad rec fields ${bad}`);

const sample = {
  football: frecs.slice(0, 3).map((r) => ({
    m: r.market,
    pick: r.pick,
    odds: r.odds_decimal,
    p: +Number(r.model_prob).toFixed(3),
    ev: +Number(r.ev).toFixed(3),
  })),
  basketball: brecs.slice(0, 3).map((r) => ({
    m: r.market,
    pick: r.pick,
    odds: r.odds_decimal,
    p: +Number(r.model_prob).toFixed(3),
    ev: +Number(r.ev).toFixed(3),
  })),
};

console.log(
  JSON.stringify(
    {
      ok: errors.length === 0,
      errors,
      dc: {
        λ: homeLambda,
        μ: awayLambda,
        ...o,
        ahNeg05: +ah05.winProb.toFixed(3),
        over25: +tot.overProb.toFixed(3),
      },
      bb: {
        margin: +bb.expectedMargin.toFixed(2),
        home: +bb.homeWinProb.toFixed(3),
        total: +proj.modelTotal.toFixed(1),
      },
      e2e: {
        football: fa,
        basketball: ba.analysis,
        frecs: frecs.length,
        brecs: brecs.length,
      },
      sample,
    },
    null,
    2
  )
);

if (errors.length) process.exit(1);
