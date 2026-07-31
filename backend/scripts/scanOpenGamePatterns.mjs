/**
 * 開放式規律掃描：不預設「型態路由／大小球」框架。
 * 只看比賽結果與現有特徵，找任何站得住的結構。
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';

const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) throw new Error('model_missing');

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
  ORDER BY f.commence_time
`).all(MLB_BASELINE_FEATURE_VERSION);

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mean(arr) {
  const xs = arr.filter((x) => Number.isFinite(x));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function rate(hits, n) {
  return n ? Number((hits / n).toFixed(4)) : null;
}

function bestMoneyline(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m) continue;
    const home = m.outcomes?.find((o) => o.name === pit.home_team || o.name === 'Home');
    const away = m.outcomes?.find((o) => o.name === pit.away_team || o.name === 'Away');
    // fallback: match by team names on game
    const outcomes = m.outcomes || [];
    let homeO = outcomes.find((o) => String(o.name).includes('Home')) || null;
    let awayO = outcomes.find((o) => String(o.name).includes('Away')) || null;
    if (!homeO || !awayO) {
      // try exact team from features later; use first two
      if (outcomes.length >= 2) {
        // Prefer matching later; store raw
        homeO = outcomes[0];
        awayO = outcomes[1];
      }
    }
    if (!home?.price && !homeO?.price) continue;
    const hp = Number(home?.price ?? homeO.price);
    const ap = Number(away?.price ?? awayO.price);
    if (!Number.isFinite(hp) || !Number.isFinite(ap)) continue;
    const vig = 1 / hp + 1 / ap;
    if (!best || vig < best.vig) {
      const fair = removeVig(decimalToImpliedProb(hp), decimalToImpliedProb(ap));
      best = {
        homeOdds: hp,
        awayOdds: ap,
        vig,
        fairHome: fair.fairA,
        homeName: home?.name || homeO?.name,
        awayName: away?.name || awayO?.name,
      };
    }
  }
  return best;
}

function bestTotals(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'totals');
    if (!market) continue;
    for (const over of market.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = market.outcomes.find(
        (o) => o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!under?.price || !over.price) continue;
      const vig = 1 / over.price + 1 / under.price;
      if (!best || vig < best.vig) {
        best = { line: Number(over.point), overOdds: Number(over.price), underOdds: Number(under.price), vig };
      }
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
  const total = homeScore + awayScore;
  const margin = homeScore - awayScore;
  const absMargin = Math.abs(margin);
  const pred = predictMlbGameRuns(model, features, { totalLine: 8.5 });
  const park = resolveMlbParkFactor({
    venueName: features.venueName,
    homeTeam: row.homeTeam,
  });
  const homeRecentEra = finite(features?.pitchers?.homeRecent?.recent3Era ?? features?.pitchers?.home?.era);
  const awayRecentEra = finite(features?.pitchers?.awayRecent?.recent3Era ?? features?.pitchers?.away?.era);
  const homeRpg = finite(features?.home?.recentRunsPerGame);
  const awayRpg = finite(features?.away?.recentRunsPerGame);
  const homeBp = finite(features?.bullpen?.home?.pitchesLast3);
  const awayBp = finite(features?.bullpen?.away?.pitchesLast3);
  const hour = (() => {
    try {
      return new Date(row.commenceTime).getUTCHours();
    } catch {
      return null;
    }
  })();
  const dow = (() => {
    try {
      return new Date(row.commenceTime).getUTCDay();
    } catch {
      return null;
    }
  })();
  const year = String(row.commenceTime).slice(0, 4);
  const month = String(row.commenceTime).slice(0, 7);

  games.push({
    gameId: row.gameId,
    commenceTime: row.commenceTime,
    year,
    month,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    homeScore,
    awayScore,
    total,
    margin,
    absMargin,
    homeWin: homeScore > awayScore,
    predHome: pred.homeExpectedRuns,
    predAway: pred.awayExpectedRuns,
    predTotal: pred.expectedTotal,
    predHomeWin: pred.homeExpectedRuns >= pred.awayExpectedRuns,
    park,
    homeRecentEra,
    awayRecentEra,
    avgEra: mean([homeRecentEra, awayRecentEra]),
    eraGap: homeRecentEra != null && awayRecentEra != null
      ? Math.abs(homeRecentEra - awayRecentEra)
      : null,
    homeRpg,
    awayRpg,
    avgRpg: mean([homeRpg, awayRpg]),
    homeBp,
    awayBp,
    maxBp: mean([homeBp, awayBp]) == null ? null : Math.max(homeBp ?? 0, awayBp ?? 0),
    hour,
    dow,
  });
}

// --- 基礎分佈 ---
const totals = games.map((g) => g.total).sort((a, b) => a - b);
const margins = games.map((g) => g.absMargin).sort((a, b) => a - b);
function pct(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}

const distribution = {
  n: games.length,
  homeWinRate: rate(games.filter((g) => g.homeWin).length, games.length),
  meanTotal: Number(mean(games.map((g) => g.total)).toFixed(3)),
  medianTotal: pct(totals, 0.5),
  p10Total: pct(totals, 0.1),
  p90Total: pct(totals, 0.9),
  meanAbsMargin: Number(mean(games.map((g) => g.absMargin)).toFixed(3)),
  medianAbsMargin: pct(margins, 0.5),
  blowoutAbsMarginGe6: rate(games.filter((g) => g.absMargin >= 6).length, games.length),
  lowTotalLe5: rate(games.filter((g) => g.total <= 5).length, games.length),
  highTotalGe14: rate(games.filter((g) => g.total >= 14).length, games.length),
  oneSidedScore: rate(
    games.filter((g) => Math.min(g.homeScore, g.awayScore) <= 2 && g.absMargin >= 5).length,
    games.length
  ),
};

// --- 模型方向 ---
const decided = games.filter((g) => g.homeScore !== g.awayScore);
const modelDirHits = decided.filter((g) => g.predHomeWin === g.homeWin).length;
const modelDirection = {
  n: decided.length,
  hitRate: rate(modelDirHits, decided.length),
  whenPredHome: (() => {
    const s = decided.filter((g) => g.predHomeWin);
    return { n: s.length, hitRate: rate(s.filter((g) => g.homeWin).length, s.length) };
  })(),
  whenPredAway: (() => {
    const s = decided.filter((g) => !g.predHomeWin);
    return { n: s.length, hitRate: rate(s.filter((g) => !g.homeWin).length, s.length) };
  })(),
};

// 簡單基準：永遠主隊、永遠較低 ERA、永遠較高 RPG
function baseline(name, pickHomeFn) {
  let n = 0;
  let hits = 0;
  for (const g of decided) {
    const pick = pickHomeFn(g);
    if (pick == null) continue;
    n += 1;
    if (pick === g.homeWin) hits += 1;
  }
  return { name, n, hitRate: rate(hits, n) };
}

const baselines = [
  baseline('always_home', () => true),
  baseline('lower_recent_era', (g) => {
    if (g.homeRecentEra == null || g.awayRecentEra == null) return null;
    if (g.homeRecentEra === g.awayRecentEra) return null;
    return g.homeRecentEra < g.awayRecentEra; // 主隊 ERA 更好 → 挑主
  }),
  baseline('higher_offense_rpg', (g) => {
    if (g.homeRpg == null || g.awayRpg == null) return null;
    if (g.homeRpg === g.awayRpg) return null;
    return g.homeRpg > g.awayRpg;
  }),
  baseline('model_v45', (g) => g.predHomeWin),
];

// --- 切片：模型何時比較準／比較不準 ---
function slice(name, pred) {
  const s = decided.filter(pred);
  const hits = s.filter((g) => g.predHomeWin === g.homeWin).length;
  return {
    name,
    n: s.length,
    hitRate: rate(hits, s.length),
    meanAbsMargin: Number(mean(s.map((g) => g.absMargin))?.toFixed(3)),
    meanTotal: Number(mean(s.map((g) => g.total))?.toFixed(3)),
  };
}

const slices = [
  slice('pred_margin_ge_1.5', (g) => Math.abs(g.predHome - g.predAway) >= 1.5),
  slice('pred_margin_lt_0.5', (g) => Math.abs(g.predHome - g.predAway) < 0.5),
  slice('pred_margin_0.5_to_1.5', (g) => {
    const m = Math.abs(g.predHome - g.predAway);
    return m >= 0.5 && m < 1.5;
  }),
  slice('hitter_park_ge_1.05', (g) => g.park >= 1.05),
  slice('pitcher_park_le_0.96', (g) => g.park <= 0.96),
  slice('avg_era_le_3.5', (g) => g.avgEra != null && g.avgEra <= 3.5),
  slice('avg_era_ge_5.0', (g) => g.avgEra != null && g.avgEra >= 5.0),
  slice('era_gap_ge_2', (g) => g.eraGap != null && g.eraGap >= 2),
  slice('era_gap_lt_1', (g) => g.eraGap != null && g.eraGap < 1),
  slice('max_bullpen_ge_220', (g) => g.maxBp != null && g.maxBp >= 220),
  slice('weekend_sat_sun', (g) => g.dow === 0 || g.dow === 6),
  slice('weekday', (g) => g.dow >= 1 && g.dow <= 5),
  slice('year_2024', (g) => g.year === '2024'),
  slice('year_2025', (g) => g.year === '2025'),
  slice('year_2026', (g) => g.year === '2026'),
].sort((a, b) => (b.hitRate ?? 0) - (a.hitRate ?? 0));

// --- 總分 vs 預測：高估／低估 ---
const totalErr = games.map((g) => g.predTotal - g.total);
const bias = {
  meanPredMinusActual: Number(mean(totalErr).toFixed(3)),
  overPredictShare: rate(games.filter((g) => g.predTotal > g.total).length, games.length),
  mae: Number(mean(games.map((g) => Math.abs(g.predTotal - g.total))).toFixed(3)),
};

// 盤口對照（有 PIT 才算）
let mlMarket = { n: 0, favoriteHits: 0, modelAgreesFavorite: 0, modelAgreeHits: 0, modelDisagreeHits: 0, modelDisagreeN: 0 };
let totalsMarket = { n: 0, overHits: 0, underHits: 0, pushes: 0, modelOverHits: 0, modelOverN: 0 };

for (const g of games) {
  const ml = bestMoneyline(g.gameId, g.commenceTime);
  if (ml?.fairHome != null && g.homeScore !== g.awayScore) {
    // map odds names to home/away by team string match
    let fairHome = ml.fairHome;
    const homeName = String(ml.homeName || '');
    if (homeName && !homeName.includes(g.homeTeam.split(' ').pop()) && homeName.includes(g.awayTeam.split(' ').pop())) {
      fairHome = 1 - ml.fairHome;
    }
    const favHome = fairHome >= 0.5;
    const favHit = favHome === g.homeWin;
    mlMarket.n += 1;
    if (favHit) mlMarket.favoriteHits += 1;
    const modelFav = g.predHomeWin;
    if (modelFav === favHome) {
      mlMarket.modelAgreesFavorite += 1;
      if (modelFav === g.homeWin) mlMarket.modelAgreeHits += 1;
    } else {
      mlMarket.modelDisagreeN += 1;
      if (modelFav === g.homeWin) mlMarket.modelDisagreeHits += 1;
    }
  }

  const tot = bestTotals(g.gameId, g.commenceTime);
  if (tot?.line != null) {
    if (g.total === tot.line) {
      totalsMarket.pushes += 1;
    } else {
      totalsMarket.n += 1;
      if (g.total > tot.line) totalsMarket.overHits += 1;
      else totalsMarket.underHits += 1;
      const modelOver = g.predTotal > tot.line;
      if (modelOver) {
        totalsMarket.modelOverN += 1;
        if (g.total > tot.line) totalsMarket.modelOverHits += 1;
      } else {
        // model under
        totalsMarket.modelOverN += 0;
        // track under separately via complement later
      }
    }
  }
}

// redo totals model lean cleanly
let totLean = { overN: 0, overHits: 0, underN: 0, underHits: 0, linePush: 0 };
for (const g of games) {
  const tot = bestTotals(g.gameId, g.commenceTime);
  if (!tot?.line) continue;
  if (g.total === tot.line) {
    totLean.linePush += 1;
    continue;
  }
  if (g.predTotal > tot.line) {
    totLean.overN += 1;
    if (g.total > tot.line) totLean.overHits += 1;
  } else if (g.predTotal < tot.line) {
    totLean.underN += 1;
    if (g.total < tot.line) totLean.underHits += 1;
  }
}

// --- 最穩的「非模型」現象 ---
const phenomena = [];

// 1) 主場優勢
phenomena.push({
  id: 'home_advantage',
  title: '主場勝率略高於五成',
  detail: `全樣本主隊勝率 ${(distribution.homeWinRate * 100).toFixed(1)}%`,
  strength: '弱但穩定',
});

// 2) 大分差並不少見
phenomena.push({
  id: 'blowout_common',
  title: '分差≥6 的場次並不少',
  detail: `約 ${(distribution.blowoutAbsMarginGe6 * 100).toFixed(1)}% 場次分差至少 6 分；中位分差 ${distribution.medianAbsMargin}`,
  strength: '結構事實',
});

// 3) 低分／高分尾部
phenomena.push({
  id: 'total_tails',
  title: '總分兩尾存在但不多',
  detail: `≤5 分約 ${(distribution.lowTotalLe5 * 100).toFixed(1)}%；≥14 分約 ${(distribution.highTotalGe14 * 100).toFixed(1)}%；中位總分 ${distribution.medianTotal}`,
  strength: '結構事實',
});

// 4) 模型總分偏差
phenomena.push({
  id: 'total_bias',
  title: '預期總分相對實際的偏差',
  detail: `平均(預測-實際)=${bias.meanPredMinusActual}；高估場次佔 ${(bias.overPredictShare * 100).toFixed(1)}%；MAE=${bias.mae}`,
  strength: bias.mae > 3 ? '明顯有誤差但未必有方向邊' : '中等',
});

// 5) 市場熱門
if (mlMarket.n > 50) {
  phenomena.push({
    id: 'market_favorite',
    title: '盤口熱門勝率',
    detail: `n=${mlMarket.n}，熱門命中 ${(rate(mlMarket.favoriteHits, mlMarket.n) * 100).toFixed(1)}%；模型同意熱門時 ${(rate(mlMarket.modelAgreeHits, mlMarket.modelAgreesFavorite) * 100).toFixed(1)}%，不同意時 ${(rate(mlMarket.modelDisagreeHits, mlMarket.modelDisagreeN) * 100).toFixed(1)}%`,
    strength: '關鍵對照',
  });
}

// 找切片裡最好／最差
const usableSlices = slices.filter((s) => s.n >= 80);
const bestSlice = usableSlices[0];
const worstSlice = usableSlices[usableSlices.length - 1];
if (bestSlice) {
  phenomena.push({
    id: 'best_slice',
    title: `模型相對較準的切片：${bestSlice.name}`,
    detail: `n=${bestSlice.n}，方向命中 ${(bestSlice.hitRate * 100).toFixed(1)}%`,
    strength: bestSlice.hitRate >= 0.56 ? '值得注意' : '仍弱',
  });
}
if (worstSlice) {
  phenomena.push({
    id: 'worst_slice',
    title: `模型相對較差的切片：${worstSlice.name}`,
    detail: `n=${worstSlice.n}，方向命中 ${(worstSlice.hitRate * 100).toFixed(1)}%`,
    strength: '避開區',
  });
}

const out = {
  ok: true,
  generatedAt: new Date().toISOString(),
  modelVersion: validation.modelVersion,
  distribution,
  modelDirection,
  baselines,
  bias,
  slices: usableSlices,
  market: {
    moneyline: {
      n: mlMarket.n,
      favoriteHitRate: rate(mlMarket.favoriteHits, mlMarket.n),
      agreeFavoriteN: mlMarket.modelAgreesFavorite,
      agreeHitRate: rate(mlMarket.modelAgreeHits, mlMarket.modelAgreesFavorite),
      disagreeN: mlMarket.modelDisagreeN,
      disagreeHitRate: rate(mlMarket.modelDisagreeHits, mlMarket.modelDisagreeN),
    },
    totalsLean: {
      over: { n: totLean.overN, hitRate: rate(totLean.overHits, totLean.overN) },
      under: { n: totLean.underN, hitRate: rate(totLean.underHits, totLean.underN) },
      pushes: totLean.linePush,
    },
  },
  phenomena,
  honestTake: [
    '若各切片都在 50–56%，代表沒有強規律可翻轉成穩定優勢',
    '若熱門本身就 ~54–58%，模型 54% 可能只是在追市場／主場弱訊號',
    '真正可做的規律應明顯高於熱門基準，且樣本夠大',
  ],
};

fs.writeFileSync('tmp-open-pattern-scan.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
