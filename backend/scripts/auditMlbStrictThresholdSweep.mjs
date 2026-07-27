/**
 * MLB 嚴格選場參數掃描（預期得分模型）：
 * 門檻 = 模型勝率 × 預期分差 ×（可選 EV）× 每日 TopK
 * 排序 = 勝率 → 分差 → EV（與研究方向一致）
 * 特徵列為歷史 PIT feature rows；賠率用 resolvePitOdds。
 *
 * 用法: node scripts/auditMlbStrictThresholdSweep.mjs [months]
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
const minBets = Number(process.env.SWEEP_MIN_BETS || 40);
const breakeven085 = 1 / (1 + 0.85); // ~0.5405
const breakeven076 = 1 / (1 + 0.76); // ~0.5682

const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) throw new Error('model_missing');

const since = new Date();
since.setUTCMonth(since.getUTCMonth() - months);
const sinceIso = since.toISOString().slice(0, 10);

const rows = db
  .prepare(
    `
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
`
  )
  .all(MLB_BASELINE_FEATURE_VERSION, sinceIso);

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
  const modelProb = predHomeWin
    ? Number(pred.markets?.homeWinProbability)
    : Number(pred.markets?.awayWinProbability);
  if (!Number.isFinite(modelProb)) continue;

  const hit = predHomeWin === homeScore > awayScore;
  const margin = Math.abs(predHome - predAway);
  const ml = bestMl(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);

  let pickOdds = null;
  let ev = null;
  if (ml) {
    pickOdds = predHomeWin ? ml.homeOdds : ml.awayOdds;
    if (Number.isFinite(pickOdds)) {
      ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    }
  }

  games.push({
    day: hkDate(row.commenceTime),
    margin,
    modelProb,
    hit,
    pickOdds,
    ev,
    hasOdds: Number.isFinite(pickOdds),
  });
}

const WIN_PROBS = [0.5, 0.52, 0.54, 0.55, 0.57, 0.58, 0.6, 0.62];
const MARGINS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const EVS = [null, 0, 0.03]; // null = 不要求有賠率／不濾 EV
const TOP_KS = [3, 5, 99]; // 99 = 當日通過門檻全下（不湊數、不截斷）

function rankFn(a, b) {
  return (
    b.modelProb - a.modelProb ||
    b.margin - a.margin ||
    (b.ev ?? -999) - (a.ev ?? -999)
  );
}

function evaluate(candidates, topK) {
  const byDay = new Map();
  for (const g of candidates) {
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const selected = [];
  for (const day of [...byDay.keys()].sort()) {
    const ranked = [...byDay.get(day)].sort(rankFn);
    selected.push(...ranked.slice(0, topK));
  }
  const n = selected.length;
  const hits = selected.filter((g) => g.hit).length;
  const withOdds = selected.filter((g) => g.hasOdds);
  let unitPnl = 0;
  let oddsSum = 0;
  for (const g of withOdds) {
    oddsSum += g.pickOdds;
    unitPnl += g.hit ? g.pickOdds - 1 : -1;
  }
  const hitRate = n ? hits / n : null;
  const avgOdds = withOdds.length ? oddsSum / withOdds.length : null;
  const breakevenAtAvgOdds =
    avgOdds != null && avgOdds > 1 ? 1 / (1 + (avgOdds - 1)) : null;
  return {
    bets: n,
    daysWithBets: byDay.size,
    hits,
    hitRate: hitRate == null ? null : Number(hitRate.toFixed(4)),
    withOddsN: withOdds.length,
    avgOdds: avgOdds == null ? null : Number(avgOdds.toFixed(3)),
    breakevenAtAvgOdds:
      breakevenAtAvgOdds == null ? null : Number(breakevenAtAvgOdds.toFixed(4)),
    clearsOwnAvgOdds:
      hitRate != null &&
      breakevenAtAvgOdds != null &&
      hitRate >= breakevenAtAvgOdds,
    unitPnl: Number(unitPnl.toFixed(2)),
    roi: withOdds.length ? Number((unitPnl / withOdds.length).toFixed(4)) : null,
    clears085: hitRate != null && hitRate >= breakeven085,
    clears076: hitRate != null && hitRate >= breakeven076,
  };
}

const grid = [];
for (const minWinProb of WIN_PROBS) {
  for (const minMargin of MARGINS) {
    for (const minEv of EVS) {
      for (const topK of TOP_KS) {
        const candidates = games.filter((g) => {
          if (g.modelProb < minWinProb) return false;
          if (g.margin < minMargin) return false;
          if (minEv != null) {
            if (!g.hasOdds) return false;
            if (g.ev < minEv) return false;
          }
          return true;
        });
        const stats = evaluate(candidates, topK);
        grid.push({
          minWinProb,
          minMargin,
          minEv,
          topK: topK === 99 ? 'all_pass' : topK,
          ...stats,
        });
      }
    }
  }
}

const viable = grid
  .filter((r) => r.bets >= minBets && r.clears085)
  .sort(
    (a, b) =>
      b.hitRate - a.hitRate ||
      b.bets - a.bets ||
      (b.roi ?? -999) - (a.roi ?? -999)
  );

const viable076 = grid
  .filter((r) => r.bets >= minBets && r.clears076)
  .sort((a, b) => b.hitRate - a.hitRate || b.bets - a.bets);

const baseline = grid.find(
  (r) =>
    r.minWinProb === 0.55 &&
    r.minMargin === 1 &&
    r.minEv == null &&
    r.topK === 'all_pass'
);
const legacyBaseline = grid.find(
  (r) =>
    r.minWinProb === 0.55 &&
    r.minMargin === 0.5 &&
    r.minEv === 0.03 &&
    r.topK === 'all_pass'
);

const topByHit = [...grid]
  .filter((r) => r.bets >= minBets)
  .sort((a, b) => b.hitRate - a.hitRate || b.bets - a.bets)
  .slice(0, 15);

const topByRoi = [...grid]
  .filter((r) => r.bets >= minBets && r.withOddsN >= minBets)
  .sort((a, b) => (b.roi ?? -999) - (a.roi ?? -999) || b.hitRate - a.hitRate)
  .slice(0, 10);

const clearsOwn = grid
  .filter((r) => r.bets >= minBets && r.clearsOwnAvgOdds)
  .sort(
    (a, b) =>
      b.hitRate - a.hitRate ||
      b.bets - a.bets ||
      (b.roi ?? -999) - (a.roi ?? -999)
  );

const recommended =
  clearsOwn.find(
    (r) =>
      r.minMargin >= 1 &&
      r.minEv == null &&
      (r.topK === 3 || r.topK === 5)
  ) ||
  clearsOwn.find((r) => r.topK === 3 || r.topK === 5) ||
  clearsOwn[0] ||
  viable.find((r) => r.topK === 3 || r.topK === 5) ||
  viable[0] ||
  null;

const marginLadder = [0.5, 0.75, 1, 1.25, 1.5, 2].map((minMargin) => {
  const row = grid.find(
    (r) =>
      r.minWinProb === 0.55 &&
      r.minMargin === minMargin &&
      r.minEv == null &&
      r.topK === 'all_pass'
  );
  return row || { minMargin, missing: true };
});

const out = {
  ok: true,
  modelVersion: validation.modelVersion,
  windowMonths: months,
  since: sinceIso,
  universeN: games.length,
  universeHitRate: games.length
    ? Number((games.filter((g) => g.hit).length / games.length).toFixed(4))
    : null,
  breakeven: {
    winPlus085: Number(breakeven085.toFixed(4)),
    winPlus076: Number(breakeven076.toFixed(4)),
  },
  sweep: {
    minBets,
    winProbs: WIN_PROBS,
    margins: MARGINS,
    evs: EVS,
    topKs: TOP_KS.map((k) => (k === 99 ? 'all_pass' : k)),
    gridSize: grid.length,
  },
  currentStrictRulesReplay: baseline || null,
  legacyStrictRulesReplay: legacyBaseline || null,
  marginLadder_p55_noEv_allPass: marginLadder,
  clearsOwnAvgOdds_minBets: clearsOwn.slice(0, 15),
  clears085_minBets: viable.slice(0, 20),
  clears076_minBets: viable076.slice(0, 15),
  topByHitRate_minBets: topByHit,
  topByRoi_minBets: topByRoi,
  recommended,
  verdict: (() => {
    if (!clearsOwn.length && !viable.length) {
      return 'no_param_clears_breakeven_with_enough_bets';
    }
    if (clearsOwn.length) {
      return 'found_params_clear_own_avg_odds_breakeven';
    }
    if (viable076.length) {
      return 'clears_generic_076_but_not_own_short_odds';
    }
    return 'clears_generic_085_but_not_own_short_odds';
  })(),
  note: [
    '候選方向＝預期得分較高邊；排序＝模型勝率→分差→EV',
    'topK=all_pass：當日通過門檻全下，不足不湊',
    'topK=3/5：通過門檻後再截每日前 K',
    'minEv=null：不要求 PIT 獨贏；minEv=0/0.03：必須有賠率且 EV≥門檻',
    'clearsOwnAvgOdds：相對該組平均獨贏價的真實損益平衡，比固定 54.1%/56.8% 更準',
    '非正式投注建議；近窗過線仍需 walk-forward 複驗',
  ],
};

fs.writeFileSync('tmp-mlb-strict-threshold-sweep.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
