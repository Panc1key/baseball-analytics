/**
 * 輸出近 3 個月：大小球路由 lean 猜錯的樣本（研究用）。
 */
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  attachMlbRegimeMarketPlan,
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';

const model = getLatestMlbExpectedRunsValidation()?.model;
if (!model) throw new Error('model_missing');

const since = '2026-04-24';
const rows = db.prepare(`
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
    AND date(f.commence_time) >= date(?)
  ORDER BY f.commence_time DESC
`).all(MLB_BASELINE_FEATURE_VERSION, since);

function bestTotalsLine(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return { line: 8.5, source: 'default_8.5' };
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'totals');
    if (!market) continue;
    for (const over of market.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = market.outcomes.find((o) =>
        o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!under?.price || !over.price) continue;
      const vig = 1 / over.price + 1 / under.price;
      if (!best || vig < best.vig) {
        best = {
          line: Number(over.point),
          source: 'pit',
          overOdds: Number(over.price),
          underOdds: Number(under.price),
          fairOver: removeVig(
            decimalToImpliedProb(over.price),
            decimalToImpliedProb(under.price)
          ).fairA,
        };
      }
    }
  }
  return best || { line: 8.5, source: 'default_8.5' };
}

const misses = [];
for (const row of rows) {
  let features;
  try {
    features = JSON.parse(row.featuresJson);
  } catch {
    continue;
  }
  const homeScore = Number(row.homeScore);
  const awayScore = Number(row.awayScore);
  const actualTotal = homeScore + awayScore;
  const market = bestTotalsLine(row.gameId, row.commenceTime);
  const line = market.line;
  if (actualTotal === line) continue;

  const base = predictMlbGameRuns(model, features, { totalLine: line });
  const routed = attachMlbRegimeMarketPlan(base, features, { totalLine: line });
  const plan = routed.marketPlan;
  if (plan.primaryMarket !== 'totals' || !plan.totalsLean) continue;

  const actualSide = actualTotal > line ? 'over' : 'under';
  if (plan.totalsLean === actualSide) continue;

  const homeP = features.pitchers?.homeRecent || {};
  const awayP = features.pitchers?.awayRecent || {};
  const homeBp = features.bullpen?.home || {};
  const awayBp = features.bullpen?.away || {};

  misses.push({
    date: String(row.commenceTime).slice(0, 10),
    matchup: `${row.awayTeam} @ ${row.homeTeam}`,
    score: `${awayScore}-${homeScore}`,
    actualTotal,
    line,
    lineSource: market.source,
    regime: plan.regimePredicted,
    reason: plan.reason,
    lean: plan.totalsLean,
    actualSide,
    expectedTotal: Number(base.expectedTotal.toFixed(2)),
    modelVsLine: base.expectedTotal > line ? 'model_over' : 'model_under',
    duelScore: plan.duelScore,
    blowupScore: plan.blowupScore,
    homeRecentEra: homeP.recent3Era ?? null,
    awayRecentEra: awayP.recent3Era ?? null,
    homeBullpenPitches3: homeBp.pitchesLast3 ?? null,
    awayBullpenPitches3: awayBp.pitchesLast3 ?? null,
    likelyCause:
      plan.totalsLean === 'under' && actualSide === 'over'
        ? '判成投手戰／偏小，但實際爆分或中高分'
        : plan.totalsLean === 'over' && actualSide === 'under'
          ? '判成崩盤／偏大，但實際變低分或投手戰'
          : '其他',
  });
  if (misses.length >= 10) break;
}

console.log(JSON.stringify({
  ok: true,
  title: '近3個月：大小球路由 lean 猜錯的 10 場',
  note: '方向對≠lean準；這些是「該看大小球」後，大小傾向仍判反的場',
  samples: misses,
}, null, 2));
