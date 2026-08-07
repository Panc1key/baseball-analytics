/**
 * β 重訓實驗：把主場強度寫進特徵（不 persist、不改鎖定 B 常數）
 *
 * 對照：
 * - prod：現用 v4.5
 * - retrain_v45：同特徵重訓（控制組）
 * - +venueHomeWinPct
 * - +offenseRoleWinPct + opponentRoleWinPct
 * - +三者全加
 *
 * 訓練：2025-05～09（近似正式切分的 development 窗）
 * 外測鎖定 B：2024 / 2025 / 2026 窗
 *
 * 用法：node scripts/auditMlbRetrainHomeWinPctFeature.mjs
 * 產物：tmp-b-retrain-home-winpct-feature.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  buildMlbExpectedRunsSideFeatures,
  fitMlbExpectedRunsModel,
  predictMlbExpectedRunsMean,
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
  calibrateMlbScoreMarkets,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
  MLB_EXPECTED_RUNS_FEATURE_KEYS,
} from '../src/services/MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const STAKE = 50;
const STRONG = 0.65;

const EVAL_WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function finite(v, fallback = 0.5) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function books(g, c, h, a) {
  const pit = resolvePitOdds(g, c);
  if (!pit?.bookmakers?.length) return [];
  const out = [];
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const home =
      m.outcomes.find((o) => o.name === h) ||
      m.outcomes.find((o) => String(o.name).includes(String(h).split(' ').pop()));
    const away =
      m.outcomes.find((o) => o.name === a) ||
      m.outcomes.find((o) => String(o.name).includes(String(a).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const ho = +home.price;
    const ao = +away.price;
    if (!Number.isFinite(ho) || !Number.isFinite(ao)) continue;
    out.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao });
  }
  return out;
}

function summarize(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0 };
  let hits = 0;
  let unit = 0;
  let odds = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
  };
}

function applyDrop(sorted) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
  if (
    slots.length >= 2 &&
    slots[1].pickOdds >= DROP_R2_MIN &&
    slots[1].pickOdds < DROP_R2_MAX
  ) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}

function enrichVector(baseVector, features, side) {
  const homeWinPct = finite(features?.home?.homeWinPct, 0.5);
  const awayWinPct = finite(features?.away?.awayWinPct, 0.5);
  const homeSeason = finite(features?.home?.seasonWinPct, 0.5);
  const awaySeason = finite(features?.away?.seasonWinPct, 0.5);
  return {
    ...baseVector,
    venueHomeWinPct: homeWinPct,
    venueHomeWinPctGap: homeWinPct - 0.5,
    offenseRoleWinPct: side === 'home' ? homeWinPct : awayWinPct,
    opponentRoleWinPct: side === 'home' ? awayWinPct : homeWinPct,
    seasonWinPctDiffForOffense:
      side === 'home' ? homeSeason - awaySeason : awaySeason - homeSeason,
  };
}

function loadGameRows(from, to) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, from, to);

  const out = [];
  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const hs = +row.homeScore;
    const as = +row.awayScore;
    if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) continue;
    const homeVec = enrichVector(
      buildMlbExpectedRunsSideFeatures(features, 'home'),
      features,
      'home'
    );
    const awayVec = enrichVector(
      buildMlbExpectedRunsSideFeatures(features, 'away'),
      features,
      'away'
    );
    if (!MLB_EXPECTED_RUNS_FEATURE_KEYS.every((k) => Number.isFinite(homeVec[k]))) continue;
    if (!MLB_EXPECTED_RUNS_FEATURE_KEYS.every((k) => Number.isFinite(awayVec[k]))) continue;

    out.push({
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      day: hk(row.commenceTime),
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      homeScore: hs,
      awayScore: as,
      features,
      homeVector: homeVec,
      awayVector: awayVec,
      homeWinPct: finite(features?.home?.homeWinPct, null),
    });
  }
  return out;
}

function examplesFromRows(rows) {
  return rows.flatMap((row) => [
    {
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      side: 'home',
      targetRuns: row.homeScore,
      vector: row.homeVector,
    },
    {
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      side: 'away',
      targetRuns: row.awayScore,
      vector: row.awayVector,
    },
  ]);
}

function fitTemperature(rows, model) {
  // 簡化：掃描 temperature，最小化主隊勝 Brier
  const points = [];
  for (const row of rows) {
    const pred = predictGame(model, row, 1);
    points.push({
      p: pred.markets.homeWinProbability,
      y: row.homeScore > row.awayScore ? 1 : 0,
    });
  }
  if (points.length < 50) return 1;
  let bestT = 1;
  let bestBrier = Infinity;
  for (let t = 0.7; t <= 1.4; t += 0.05) {
    let brier = 0;
    for (const pt of points) {
      const logit = Math.log(Math.max(1e-6, pt.p) / Math.max(1e-6, 1 - pt.p));
      const cal = 1 / (1 + Math.exp(-logit / t));
      brier += (cal - pt.y) ** 2;
    }
    brier /= points.length;
    if (brier < bestBrier) {
      bestBrier = brier;
      bestT = t;
    }
  }
  return Number(bestT.toFixed(3));
}

function predictGame(model, row, temperature = null) {
  const homeMean = predictMlbExpectedRunsMean(model, row.homeVector);
  const awayMean = predictMlbExpectedRunsMean(model, row.awayVector);
  const distribution = buildMlbScoreDistribution({
    homeMean,
    awayMean,
    homeDispersion: model.dispersion,
    awayDispersion: model.dispersion,
  });
  const rawMarkets = deriveMlbScoreMarkets(distribution, { totalLine: 8.5 });
  const temp = temperature ?? model.moneylineTemperature ?? 1;
  const markets = calibrateMlbScoreMarkets(rawMarkets, temp);
  return {
    homeExpectedRuns: homeMean,
    awayExpectedRuns: awayMean,
    markets,
  };
}

function attachBooksAndGates(rows) {
  const out = [];
  for (const row of rows) {
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) continue;
    const pitchers = row.features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    const sig = buildPregameRegimeSignals(row.features);
    out.push({
      ...row,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      homeEarly: +sig.homeEarlyExitsLast3 || 0,
      awayEarly: +sig.awayEarlyExitsLast3 || 0,
    });
  }
  return out;
}

function selectLockedB(rows, model) {
  const byDay = new Map();
  for (const row of rows) {
    const pred = predictGame(model, row);
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    const modelProb = pickHome
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? row.homeOdds : row.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    const pickEarly = pickHome ? row.homeEarly : row.awayEarly;
    const oppEarly = pickHome ? row.awayEarly : row.homeEarly;
    if (pickEarly > oppEarly) continue;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue) continue;
    if (margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (pickOdds < B.minimumPickOdds || pickOdds > B.maximumPickOdds) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    if (!byDay.has(row.day)) byDay.set(row.day, []);
    byDay.get(row.day).push({
      day: row.day,
      window: row.window,
      pickHome,
      pickOdds,
      modelProb,
      ev,
      margin,
      bScore,
      homeWinPct: row.homeWinPct,
      hit: pickHome ? row.homeScore > row.awayScore : row.awayScore > row.homeScore,
    });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    applyDrop(arr).forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

function toxicStats(bets) {
  const toxicR1 = bets.filter(
    (b) => b.rank === 1 && !b.pickHome && (b.homeWinPct ?? 0) >= STRONG
  );
  const hiEv = toxicR1.filter((b) => b.ev >= 0.1);
  return {
    toxicRank1: summarize(toxicR1),
    toxicRank1N: toxicR1.length,
    toxicRank1HighEvN: hiEv.length,
    toxicRank1HighEv: summarize(hiEv),
  };
}

/** 方向／校準（不看 EV 選注）：μ 誰大誰贏 + 強主場偏客切片 */
function directionMetrics(rows, model) {
  let n = 0;
  let dirHit = 0;
  let maeHome = 0;
  let maeAway = 0;
  let brier = 0;
  let strongN = 0;
  let strongAwayPick = 0;
  let strongAwayPickHomeActual = 0;
  let strongAwayPickHit = 0;
  for (const row of rows) {
    const pred = predictGame(model, row);
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const homeWins = row.homeScore > row.awayScore;
    const pickHome = ph >= pa;
    n += 1;
    if (pickHome === homeWins) dirHit += 1;
    maeHome += Math.abs(ph - row.homeScore);
    maeAway += Math.abs(pa - row.awayScore);
    const pHome = +pred.markets.homeWinProbability;
    brier += (pHome - (homeWins ? 1 : 0)) ** 2;
    const hwp = row.homeWinPct;
    if (hwp != null && hwp >= STRONG) {
      strongN += 1;
      if (!pickHome) {
        strongAwayPick += 1;
        if (homeWins) strongAwayPickHomeActual += 1;
        if (!homeWins) strongAwayPickHit += 1;
      }
    }
  }
  if (!n) {
    return {
      games: 0,
      directionHitRate: null,
      maeHome: null,
      maeAway: null,
      moneylineBrier: null,
      strongHome: null,
    };
  }
  return {
    games: n,
    directionHitRate: Number((dirHit / n).toFixed(4)),
    maeHome: Number((maeHome / n).toFixed(4)),
    maeAway: Number((maeAway / n).toFixed(4)),
    moneylineBrier: Number((brier / n).toFixed(5)),
    strongHome: {
      games: strongN,
      muPicksAway: strongAwayPick,
      muPicksAwayRate: strongN
        ? Number((strongAwayPick / strongN).toFixed(4))
        : null,
      whenMuPicksAwayHomeActualWinRate: strongAwayPick
        ? Number((strongAwayPickHomeActual / strongAwayPick).toFixed(4))
        : null,
      whenMuPicksAwayAwayHitRate: strongAwayPick
        ? Number((strongAwayPickHit / strongAwayPick).toFixed(4))
        : null,
    },
  };
}

function evalModel(label, model, evalSets, prodBaselineByWindow) {
  const byWindow = {};
  const all = [];
  const allRows = [];
  for (const set of evalSets) {
    const bets = selectLockedB(set.rows, model);
    all.push(...bets.map((b) => ({ ...b, window: set.key })));
    allRows.push(...set.rows);
    const s = summarize(bets);
    const prod = prodBaselineByWindow[set.key];
    byWindow[set.key] = {
      ...s,
      deltaUsdVsProd: prod ? s.usd50 - prod.usd50 : null,
      ...toxicStats(bets),
      direction: directionMetrics(set.rows, model),
    };
  }
  const overall = summarize(all);
  let winNonNeg = 0;
  for (const w of EVAL_WINDOWS) {
    const d = byWindow[w.key]?.deltaUsdVsProd;
    if (d != null && d >= 0) winNonNeg += 1;
  }
  return {
    label,
    featureKeys: model.featureKeys,
    weightsHome: {
      isHome: model.weights?.isHome ?? null,
      venueHomeWinPct: model.weights?.venueHomeWinPct ?? null,
      venueHomeWinPctGap: model.weights?.venueHomeWinPctGap ?? null,
      offenseRoleWinPct: model.weights?.offenseRoleWinPct ?? null,
      opponentRoleWinPct: model.weights?.opponentRoleWinPct ?? null,
    },
    overall,
    byWindow,
    windowsNonNegVsProd: winNonNeg,
    toxicAll: toxicStats(all),
    directionAll: directionMetrics(allRows, model),
  };
}

const EXTRA_SETS = [
  {
    id: 'retrain_v45_control',
    keys: [...MLB_EXPECTED_RUNS_FEATURE_KEYS],
  },
  {
    id: 'v45_plus_venueHomeWinPct',
    keys: [...MLB_EXPECTED_RUNS_FEATURE_KEYS, 'venueHomeWinPct'],
  },
  {
    id: 'v45_plus_venueHomeWinPctGap',
    keys: [...MLB_EXPECTED_RUNS_FEATURE_KEYS, 'venueHomeWinPctGap'],
  },
  {
    id: 'v45_plus_roleWinPct',
    keys: [
      ...MLB_EXPECTED_RUNS_FEATURE_KEYS,
      'offenseRoleWinPct',
      'opponentRoleWinPct',
    ],
  },
  {
    id: 'v45_plus_home_stack',
    keys: [
      ...MLB_EXPECTED_RUNS_FEATURE_KEYS,
      'venueHomeWinPct',
      'venueHomeWinPctGap',
      'offenseRoleWinPct',
      'opponentRoleWinPct',
    ],
  },
];

console.log('Loading rows…');
const trainRowsRaw = loadGameRows('2025-05-01', '2025-09-30');
const splitIdx = Math.floor(trainRowsRaw.length * 0.7);
const trainFit = trainRowsRaw.slice(0, splitIdx);
const trainVal = trainRowsRaw.slice(splitIdx);

const evalSets = EVAL_WINDOWS.map((w) => ({
  key: w.key,
  rows: attachBooksAndGates(
    loadGameRows(w.from, w.to).map((r) => ({ ...r, window: w.key }))
  ),
}));

const prodValidation = getLatestMlbExpectedRunsValidation();
const prodModel = prodValidation.model;

console.log('Evaluating production model locked B…');
const prodByWindow = {};
const prodAllBets = [];
for (const set of evalSets) {
  const bets = selectLockedB(set.rows, prodModel);
  prodByWindow[set.key] = summarize(bets);
  prodAllBets.push(...bets);
}
const prodOverall = summarize(prodAllBets);

const prodAllRows = evalSets.flatMap((s) => s.rows);
const results = [
  {
    label: 'prod_v45',
    featureKeys: prodModel.featureKeys,
    weightsHome: {
      isHome: prodModel.weights?.isHome ?? null,
      venueHomeWinPct: null,
    },
    overall: prodOverall,
    byWindow: Object.fromEntries(
      EVAL_WINDOWS.map((w) => {
        const set = evalSets.find((s) => s.key === w.key);
        const bets = selectLockedB(set.rows, prodModel);
        return [
          w.key,
          {
            ...prodByWindow[w.key],
            deltaUsdVsProd: 0,
            ...toxicStats(bets),
            direction: directionMetrics(set.rows, prodModel),
          },
        ];
      })
    ),
    windowsNonNegVsProd: 3,
    toxicAll: toxicStats(
      EVAL_WINDOWS.flatMap((w) =>
        selectLockedB(evalSets.find((s) => s.key === w.key).rows, prodModel).map((b) => ({
          ...b,
          window: w.key,
        }))
      )
    ),
    directionAll: directionMetrics(prodAllRows, prodModel),
  },
];

for (const spec of EXTRA_SETS) {
  console.log('Fitting', spec.id, '…');
  const model = fitMlbExpectedRunsModel(examplesFromRows(trainFit), {
    featureKeys: spec.keys,
  });
  const temp = fitTemperature(trainVal, model);
  model.moneylineTemperature = temp;
  console.log('  temperature', temp, 'isHome', model.weights.isHome?.toFixed?.(6));
  results.push(evalModel(spec.id, model, evalSets, prodByWindow));
}

results.sort(
  (a, b) =>
    (b.windowsNonNegVsProd || 0) - (a.windowsNonNegVsProd || 0) ||
    (b.overall.usd50 || 0) - (a.overall.usd50 || 0)
);

const best = results.find((r) => r.label !== 'prod_v45') || null;
const bestPass = results.find(
  (r) =>
    r.label !== 'prod_v45' &&
    r.windowsNonNegVsProd === 3 &&
    (r.overall.usd50 || 0) > prodOverall.usd50
);

const out = {
  experimentId: 'b-retrain-home-winpct-feature-2026-07-29',
  plainLanguage:
    '重訓時加入主場勝率等特徵，看能不能從根上減少「強主場還選客」的假自信',
  train: {
    fit: { from: '2025-05-01', to: '2025-09-30', nGames: trainFit.length },
    val: { nGames: trainVal.length },
  },
  productionBaseline: {
    overall: prodOverall,
    byWindow: prodByWindow,
  },
  results,
  bestVsProd: best,
  bestPassingGates: bestPass,
  recommendation: {
    wireSuggested: false,
    persistModel: false,
    note: (() => {
      const prodDir = results.find((r) => r.label === 'prod_v45')?.directionAll;
      const bestDir = [...results]
        .filter((r) => r.label !== 'prod_v45')
        .sort(
          (a, b) =>
            (b.directionAll?.directionHitRate || 0) -
            (a.directionAll?.directionHitRate || 0)
        )[0];
      const dirLift =
        bestDir?.directionAll?.directionHitRate != null &&
        prodDir?.directionHitRate != null
          ? bestDir.directionAll.directionHitRate - prodDir.directionHitRate
          : null;
      if (bestPass && dirLift != null && dirLift >= 0.005) {
        return '主場特徵重訓：Locked B 三窗不傷且方向命中有升——可列下一版候選（仍不 persist）';
      }
      if (dirLift != null && dirLift >= 0.005) {
        return '方向命中有升但 Locked B USD 未穩過正式版——值得再調訓練窗，暫不升格';
      }
      return bestPass
        ? '重訓+主場特徵相對正式 v4.5 三窗不傷且總$更高：可列為下一版模型候選（仍不自動 persist）'
        : '主場特徵重訓尚未穩定勝過正式 v4.5；保留 shrink 影子，特徵方向需再調或拉長訓練窗';
    })(),
  },
};

fs.writeFileSync(
  new URL('../tmp-b-retrain-home-winpct-feature.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\nPROD', prodOverall, prodByWindow);
console.log('PROD direction', results[0].directionAll);
console.log('\nRESULTS:');
for (const r of results) {
  const d = r.directionAll;
  console.log(
    `${r.label.padEnd(28)} $=${r.overall.usd50} hr=${r.overall.hitRate} winVsProd=${r.windowsNonNegVsProd}/3 toxicR1=${r.toxicAll.toxicRank1N} hiEv=${r.toxicAll.toxicRank1HighEvN}`
  );
  console.log(
    `  24:${r.byWindow['2024']?.usd50}(Δ${r.byWindow['2024']?.deltaUsdVsProd}) 25:${r.byWindow['2025']?.usd50}(Δ${r.byWindow['2025']?.deltaUsdVsProd}) 26:${r.byWindow['2026']?.usd50}(Δ${r.byWindow['2026']?.deltaUsdVsProd})`
  );
  console.log(
    `  dirHit=${d?.directionHitRate} brier=${d?.moneylineBrier} strongAwayPickRate=${d?.strongHome?.muPicksAwayRate} whenAwayHomeActual=${d?.strongHome?.whenMuPicksAwayHomeActualWinRate}`
  );
  console.log('  weights', r.weightsHome);
}
console.log('\nREC', out.recommendation.note);
