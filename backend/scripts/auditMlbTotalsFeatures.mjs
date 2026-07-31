import db from '../src/db/database.js';
import {
  getLatestMlbExpectedRunsValidation,
  buildMlbExpectedRunsSideFeatures,
  predictMlbExpectedRunsMean,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';

function corr(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let c = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i += 1) {
    c += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  return c / Math.sqrt(Math.max(1e-12, vx * vy));
}

const row = db.prepare(`
  SELECT features_json
  FROM mlb_historical_feature_rows
  WHERE feature_version = 'mlb-foundation-pit-v1'
    AND commence_time >= '2025-08-16'
  LIMIT 1
`).get();
const sample = JSON.parse(row.features_json);
console.log('keys', Object.keys(sample));
console.log('home', Object.keys(sample.home || {}));
console.log('pitchers', Object.keys(sample.pitchers || {}));
console.log('recentBoxscore', Object.keys(sample.recentBoxscore || {}));
if (sample.recentBoxscore?.home) {
  console.log('recentBox home', Object.keys(sample.recentBoxscore.home));
}

const model = getLatestMlbExpectedRunsValidation().model;
const rows = db.prepare(`
  SELECT f.features_json AS featuresJson, g.home_score AS homeScore, g.away_score AS awayScore
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  WHERE f.feature_version = 'mlb-foundation-pit-v1'
    AND f.commence_time >= '2025-08-16'
    AND f.commence_time < '2026-01-01'
    AND g.home_score IS NOT NULL
`).all();

const series = {
  actualTotal: [],
  expectedTotal: [],
  homeRpg: [],
  awayRpg: [],
  homeRa: [],
  awayRa: [],
  combinedRpg: [],
  combinedRa: [],
  envProxy: [],
  homeObp: [],
  awayObp: [],
  homeStarterEra: [],
  awayStarterEra: [],
  actualHome: [],
  predHome: [],
  actualAway: [],
  predAway: [],
};

for (const row of rows) {
  const features = JSON.parse(row.featuresJson);
  const home = buildMlbExpectedRunsSideFeatures(features, 'home');
  const away = buildMlbExpectedRunsSideFeatures(features, 'away');
  const pred = predictMlbGameRuns(model, features);
  const total = Number(row.homeScore) + Number(row.awayScore);
  series.actualTotal.push(total);
  series.expectedTotal.push(pred.expectedTotal);
  series.homeRpg.push(home.offenseRecentRpg);
  series.awayRpg.push(away.offenseRecentRpg);
  series.homeRa.push(home.opponentRecentRaRpg);
  series.awayRa.push(away.opponentRecentRaRpg);
  series.combinedRpg.push(home.offenseRecentRpg + away.offenseRecentRpg);
  series.combinedRa.push(home.opponentRecentRaRpg + away.opponentRecentRaRpg);
  series.envProxy.push(
    home.offenseRecentRpg + away.offenseRecentRpg +
    home.opponentRecentRaRpg + away.opponentRecentRaRpg
  );
  series.homeObp.push(home.offenseObp);
  series.awayObp.push(away.offenseObp);
  series.homeStarterEra.push(home.opponentStarterEraContribution);
  series.awayStarterEra.push(away.opponentStarterEraContribution);
  series.actualHome.push(Number(row.homeScore));
  series.predHome.push(pred.homeExpectedRuns);
  series.actualAway.push(Number(row.awayScore));
  series.predAway.push(pred.awayExpectedRuns);
}

const report = {
  n: rows.length,
  corr: {
    expectedTotal: corr(series.expectedTotal, series.actualTotal),
    combinedRpg: corr(series.combinedRpg, series.actualTotal),
    combinedRa: corr(series.combinedRa, series.actualTotal),
    envProxy: corr(series.envProxy, series.actualTotal),
    homeRpg: corr(series.homeRpg, series.actualTotal),
    awayRpg: corr(series.awayRpg, series.actualTotal),
    homeObp: corr(series.homeObp, series.actualHome),
    awayObp: corr(series.awayObp, series.actualAway),
    predHome: corr(series.predHome, series.actualHome),
    predAway: corr(series.predAway, series.actualAway),
    homeStarterEraVsHomeRuns: corr(series.homeStarterEra, series.actualHome),
    awayStarterEraVsAwayRuns: corr(series.awayStarterEra, series.actualAway),
  },
};
console.log(JSON.stringify(report, null, 2));
