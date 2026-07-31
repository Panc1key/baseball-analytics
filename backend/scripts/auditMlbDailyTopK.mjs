/**
 * MLB only：近 N 天，每天最多 3 / 5 注的方向勝率。
 * 候選＝當日所有完賽 MLB（有 feature + 預測）；
 * 排序＝|預期得分差| 降序（分差愈大愈先下）；
 * 命中＝預測得分較高邊 = 實際勝方。
 * 另算：有 PIT 獨贏時，用 EV 排序的對照。
 *
 * 用法: node scripts/auditMlbDailyTopK.mjs [months]
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
    AND g.away_score IS NOT NULL
    AND date(f.commence_time) >= date(?)
  ORDER BY f.commence_time
`).all(MLB_BASELINE_FEATURE_VERSION, sinceIso);

function hkDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function bestMl(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'h2h');
    if (!market?.outcomes?.length) continue;
    const home =
      market.outcomes.find((o) => o.name === homeTeam) ||
      market.outcomes.find((o) => String(o.name).includes(String(homeTeam).split(' ').pop()));
    const away =
      market.outcomes.find((o) => o.name === awayTeam) ||
      market.outcomes.find((o) => String(o.name).includes(String(awayTeam).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const vig = 1 / home.price + 1 / away.price;
    if (!best || vig < best.vig) {
      const fair = removeVig(
        decimalToImpliedProb(home.price),
        decimalToImpliedProb(away.price)
      );
      best = {
        homeOdds: Number(home.price),
        awayOdds: Number(away.price),
        fairHome: fair.fairA,
        vig,
      };
    }
  }
  return best;
}

const games = [];
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

  const predHomeWin = predHome >= predAway;
  const actualHomeWin = homeScore > awayScore;
  const hit = predHomeWin === actualHomeWin;
  const margin = Math.abs(predHome - predAway);
  const ml = bestMl(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);

  let pickOdds = null;
  let fairPick = null;
  let ev = null;
  if (ml) {
    pickOdds = predHomeWin ? ml.homeOdds : ml.awayOdds;
    fairPick = predHomeWin ? ml.fairHome : 1 - ml.fairHome;
    const modelProb = predHomeWin
      ? Number(pred.markets?.homeWinProbability)
      : Number(pred.markets?.awayWinProbability);
    if (Number.isFinite(modelProb) && Number.isFinite(pickOdds)) {
      ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    }
  }

  games.push({
    day: hkDate(row.commenceTime),
    commenceTime: row.commenceTime,
    matchup: `${row.awayTeam} @ ${row.homeTeam}`,
    margin,
    predHomeWin,
    hit,
    pickOdds,
    fairPick,
    ev,
    hasOdds: Boolean(ml),
  });
}

function summarize(list, label) {
  const n = list.length;
  const hits = list.filter((g) => g.hit).length;
  const withOdds = list.filter((g) => g.hasOdds && Number.isFinite(g.pickOdds));
  let unitPnl = 0;
  for (const g of withOdds) {
    if (g.hit) unitPnl += g.pickOdds - 1;
    else unitPnl -= 1;
  }
  const byDay = new Map();
  for (const g of list) byDay.set(g.day, (byDay.get(g.day) || 0) + 1);
  const dayCounts = [...byDay.values()];
  return {
    label,
    bets: n,
    daysWithBets: byDay.size,
    avgBetsPerActiveDay: byDay.size ? Number((n / byDay.size).toFixed(2)) : 0,
    hits,
    hitRate: n ? Number((hits / n).toFixed(4)) : null,
    withOddsN: withOdds.length,
    unitPnlOnOdds: Number(unitPnl.toFixed(2)),
    roiOnOdds: withOdds.length ? Number((unitPnl / withOdds.length).toFixed(4)) : null,
    daysFull: dayCounts.filter((c) => c >= (label.includes('top5') ? 5 : label.includes('top3') ? 3 : 0)).length,
  };
}

function takeTopK(all, k, rankFn) {
  const byDay = new Map();
  for (const g of all) {
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const selected = [];
  const fill = { full: 0, partial: 0 };
  for (const day of [...byDay.keys()].sort()) {
    const ranked = [...byDay.get(day)].sort(rankFn);
    const slice = ranked.slice(0, k);
    selected.push(...slice);
    if (slice.length >= k) fill.full += 1;
    else fill.partial += 1;
  }
  return { selected, fill, activeDays: byDay.size };
}

const byMargin = (a, b) => b.margin - a.margin || (b.ev ?? -999) - (a.ev ?? -999);
const byEv = (a, b) => (b.ev ?? -999) - (a.ev ?? -999) || b.margin - a.margin;

const allDays = new Set(games.map((g) => g.day));
const gamesPerDay = [...allDays].map((day) => games.filter((g) => g.day === day).length);
const slate = {
  days: allDays.size,
  avgMlbGamesPerDay: gamesPerDay.length
    ? Number((games.length / gamesPerDay.length).toFixed(2))
    : 0,
  medianMlbGamesPerDay: [...gamesPerDay].sort((a, b) => a - b)[
    Math.floor(gamesPerDay.length / 2)
  ],
};

const m3 = takeTopK(games, 3, byMargin);
const m5 = takeTopK(games, 5, byMargin);
const e3 = takeTopK(
  games.filter((g) => g.hasOdds),
  3,
  byEv
);
const e5 = takeTopK(
  games.filter((g) => g.hasOdds),
  5,
  byEv
);

// 對照：只做分差>=1.5（少出場）
const ge15 = games.filter((g) => g.margin >= 1.5);

const out = {
  ok: true,
  league: 'MLB',
  modelVersion: validation.modelVersion,
  windowMonths: months,
  since: sinceIso,
  slate,
  allGamesDirection: summarize(games, 'all_mlb_direction'),
  byPredMargin: {
    top3: { ...summarize(m3.selected, 'top3_by_pred_margin'), fill: m3.fill, activeDays: m3.activeDays },
    top5: { ...summarize(m5.selected, 'top5_by_pred_margin'), fill: m5.fill, activeDays: m5.activeDays },
  },
  byEvWhenOdds: {
    top3: { ...summarize(e3.selected, 'top3_by_ev'), fill: e3.fill, activeDays: e3.activeDays },
    top5: { ...summarize(e5.selected, 'top5_by_ev'), fill: e5.fill, activeDays: e5.activeDays },
  },
  referenceMarginGe15: summarize(ge15, 'only_margin_ge_1_5'),
  importantCorrection: [
    '先前回測 87注/60% 是 NPB+KBO 均注精選，不是 MLB',
    '本報告只含 MLB',
  ],
  note: [
    'topK：每天按規則取前 K 場；MLB 日程足夠時可湊滿 3/5',
    '命中＝方向（預期得分較高邊）；unitPnl 僅在有獨贏賠率時計算',
    '非正式投注建議',
  ],
};

fs.writeFileSync('tmp-mlb-daily-topk.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
