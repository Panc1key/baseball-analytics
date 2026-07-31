/**
 * 驗證：預測分差門檻 × 方向命中（全樣本 vs 近 N 月）
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';

const months = Number(process.argv[2] || 3);
const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) throw new Error('model_missing');

const since = new Date();
since.setUTCMonth(since.getUTCMonth() - months);
const sinceIso = since.toISOString().slice(0, 10);

const allRows = db.prepare(`
  SELECT f.game_id AS gameId,
         f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
         g.home_team AS homeTeam,
         g.away_team AS awayTeam,
         g.home_score AS homeScore,
         g.away_score AS awayScore
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  WHERE f.feature_version = ?
    AND g.completed = 1
    AND g.home_score IS NOT NULL
    AND g.away_score IS NOT NULL
  ORDER BY f.commence_time
`).all(MLB_BASELINE_FEATURE_VERSION);

function bestFairHome(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'h2h');
    if (!market?.outcomes?.length) continue;
    const outcomes = market.outcomes;
    const home =
      outcomes.find((o) => o.name === homeTeam) ||
      outcomes.find((o) => String(o.name).includes(String(homeTeam).split(' ').pop()));
    const away =
      outcomes.find((o) => o.name === awayTeam) ||
      outcomes.find((o) => String(o.name).includes(String(awayTeam).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const vig = 1 / home.price + 1 / away.price;
    if (!best || vig < best.vig) {
      const fair = removeVig(
        decimalToImpliedProb(home.price),
        decimalToImpliedProb(away.price)
      );
      best = { fairHome: fair.fairA, homeOdds: home.price, awayOdds: away.price, vig };
    }
  }
  return best;
}

function analyze(rows, label) {
  const buckets = {
    all: { n: 0, hits: 0 },
    ge15: { n: 0, hits: 0 },
    mid: { n: 0, hits: 0 },
    lt05: { n: 0, hits: 0 },
    ge15AgreeMkt: { n: 0, hits: 0 },
    ge15DisagreeMkt: { n: 0, hits: 0 },
    ge15PredHome: { n: 0, hits: 0 },
    ge15PredAway: { n: 0, hits: 0 },
  };

  const examples = [];

  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const homeScore = Number(row.homeScore);
    const awayScore = Number(row.awayScore);
    if (homeScore === awayScore) continue;

    const pred = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const predHome = Number(pred.homeExpectedRuns);
    const predAway = Number(pred.awayExpectedRuns);
    if (!Number.isFinite(predHome) || !Number.isFinite(predAway)) continue;

    const margin = Math.abs(predHome - predAway);
    const predHomeWin = predHome >= predAway;
    const actualHomeWin = homeScore > awayScore;
    const hit = predHomeWin === actualHomeWin;

    buckets.all.n += 1;
    if (hit) buckets.all.hits += 1;

    let key = 'lt05';
    if (margin >= 1.5) key = 'ge15';
    else if (margin >= 0.5) key = 'mid';
    buckets[key].n += 1;
    if (hit) buckets[key].hits += 1;

    if (margin >= 1.5) {
      if (predHomeWin) {
        buckets.ge15PredHome.n += 1;
        if (hit) buckets.ge15PredHome.hits += 1;
      } else {
        buckets.ge15PredAway.n += 1;
        if (hit) buckets.ge15PredAway.hits += 1;
      }

      const mkt = bestFairHome(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
      if (mkt?.fairHome != null) {
        const favHome = mkt.fairHome >= 0.5;
        if (predHomeWin === favHome) {
          buckets.ge15AgreeMkt.n += 1;
          if (hit) buckets.ge15AgreeMkt.hits += 1;
        } else {
          buckets.ge15DisagreeMkt.n += 1;
          if (hit) buckets.ge15DisagreeMkt.hits += 1;
        }
      }

      if (examples.length < 15) {
        examples.push({
          date: String(row.commenceTime).slice(0, 10),
          matchup: `${row.awayTeam} @ ${row.homeTeam}`,
          pred: `${predAway.toFixed(2)}-${predHome.toFixed(2)}`,
          margin: Number(margin.toFixed(2)),
          pick: predHomeWin ? 'home' : 'away',
          actual: `${awayScore}-${homeScore}`,
          hit,
        });
      }
    }
  }

  function pack(b) {
    return {
      n: b.n,
      hits: b.hits,
      hitRate: b.n ? Number((b.hits / b.n).toFixed(4)) : null,
      share: buckets.all.n ? Number((b.n / buckets.all.n).toFixed(4)) : null,
    };
  }

  return {
    label,
    games: buckets.all.n,
    all: pack(buckets.all),
    predMarginGe15: pack(buckets.ge15),
    predMargin0_5to1_5: pack(buckets.mid),
    predMarginLt05: pack(buckets.lt05),
    ge15PredHome: pack(buckets.ge15PredHome),
    ge15PredAway: pack(buckets.ge15PredAway),
    ge15AgreeMarket: pack(buckets.ge15AgreeMkt),
    ge15DisagreeMarket: pack(buckets.ge15DisagreeMkt),
    examplesGe15: examples,
  };
}

const recentRows = allRows.filter((r) => String(r.commenceTime).slice(0, 10) >= sinceIso);
const out = {
  ok: true,
  modelVersion: validation.modelVersion,
  windowMonths: months,
  since: sinceIso,
  fullSample: analyze(allRows, 'full'),
  recent: analyze(recentRows, `last_${months}_months`),
  note: [
    '命中＝預測得分較高邊 = 實際勝方',
    'ge1.5 是研究口袋，不自動等於可下注；還要看樣本、是否逆盤、水位',
  ],
};

fs.writeFileSync('tmp-pred-margin-edge.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
