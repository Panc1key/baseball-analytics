/**
 * 方向準度消融（算得準）：對齊 v4.5/v46 訓練協議
 * - 基線：庫內正式 v4.5
 * - 對照重訓：base_v45 特徵
 * - +側向勝率特徵
 * - 事後：強主場客 μ 收縮、與市場機率混合
 *
 * 主指標：方向命中、Brier、強主μ選客率、MAE（Locked B $ 僅附錄）
 *
 * 用法: node scripts/auditMlbDirectionAccuracyAblation.mjs
 * 產物: tmp-direction-accuracy-ablation.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import { getCachedMlbGameWeather } from '../src/services/MlbGameWeatherService.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  buildMlbExpectedRunsSideFeatures,
  fitMlbExpectedRunsModel,
  predictMlbExpectedRunsMean,
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
  calibrateMlbScoreMarkets,
  MLB_V45_SELECTED_FEATURE_KEYS,
  MLB_EXPECTED_RUNS_FEATURE_KEYS,
  MLB_MONEYLINE_RULE_PROFILES,
  scoreMlbMoneylineDailyRank,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';

const STAKE = 50;
const STRONG = 0.65;
const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;

function finite(v, f = 0.5) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}
function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function enrichSideVector(base, features, side) {
  const homeWinPct = finite(features?.home?.homeWinPct, 0.5);
  const awayWinPct = finite(features?.away?.awayWinPct, 0.5);
  const homeSeason = finite(features?.home?.seasonWinPct, 0.5);
  const awaySeason = finite(features?.away?.seasonWinPct, 0.5);
  return {
    ...base,
    offenseRoleWinPct: side === 'home' ? homeWinPct : awayWinPct,
    opponentRoleWinPct: side === 'home' ? awayWinPct : homeWinPct,
    offenseSeasonWinPct: side === 'home' ? homeSeason : awaySeason,
    seasonWinPctDiffForOffense:
      side === 'home' ? homeSeason - awaySeason : awaySeason - homeSeason,
    venueHomeWinPct: homeWinPct,
    venueHomeWinPctGap: homeWinPct - 0.5,
  };
}

function loadGameRows(fromIso, toIsoExclusive = null) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam,
              g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND datetime(f.commence_time) >= datetime(?)
         ${toIsoExclusive ? 'AND datetime(f.commence_time) < datetime(?)' : ''}
       ORDER BY datetime(f.commence_time), f.game_id`
    )
    .all(
      ...(toIsoExclusive
        ? [MLB_BASELINE_FEATURE_VERSION, fromIso, toIsoExclusive]
        : [MLB_BASELINE_FEATURE_VERSION, fromIso])
    );

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
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    features.gameId = row.gameId;
    features.commenceTime = row.commenceTime;
    features.homeTeam = row.homeTeam;
    features.awayTeam = row.awayTeam;
    features.parkFactor = resolveMlbParkFactor({
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    features.weather = getCachedMlbGameWeather({
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    const homeVec = enrichSideVector(
      buildMlbExpectedRunsSideFeatures(features, 'home'),
      features,
      'home'
    );
    const awayVec = enrichSideVector(
      buildMlbExpectedRunsSideFeatures(features, 'away'),
      features,
      'away'
    );
    if (!MLB_EXPECTED_RUNS_FEATURE_KEYS.every((k) => Number.isFinite(homeVec[k]))) continue;
    if (!MLB_EXPECTED_RUNS_FEATURE_KEYS.every((k) => Number.isFinite(awayVec[k]))) continue;
    out.push({
      gameId: row.gameId,
      commenceTime: row.commenceTime,
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

function examplesFrom(rows) {
  return rows.flatMap((r) => [
    {
      gameId: r.gameId,
      commenceTime: r.commenceTime,
      side: 'home',
      targetRuns: r.homeScore,
      vector: r.homeVector,
    },
    {
      gameId: r.gameId,
      commenceTime: r.commenceTime,
      side: 'away',
      targetRuns: r.awayScore,
      vector: r.awayVector,
    },
  ]);
}

function fitTemp(rows, predictFn) {
  const points = [];
  for (const row of rows) {
    if (row.homeScore === row.awayScore) continue;
    const pred = predictFn(row, 1);
    points.push({
      p: pred.markets.homeWinProbability,
      y: row.homeScore > row.awayScore ? 1 : 0,
    });
  }
  if (points.length < 50) return 1;
  let bestT = 1;
  let best = Infinity;
  for (let t = 0.7; t <= 1.4 + 1e-9; t += 0.05) {
    let brier = 0;
    for (const pt of points) {
      const logit = Math.log(Math.max(1e-6, pt.p) / Math.max(1e-6, 1 - pt.p));
      const cal = 1 / (1 + Math.exp(-logit / t));
      brier += (cal - pt.y) ** 2;
    }
    brier /= points.length;
    if (brier < best) {
      best = brier;
      bestT = t;
    }
  }
  return Number(bestT.toFixed(3));
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
    out.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao, fairHome: null });
  }
  return out;
}

function fairHomeProb(homeOdds, awayOdds) {
  const ih = 1 / homeOdds;
  const ia = 1 / awayOdds;
  return ih / (ih + ia);
}

/** posthoc params fitted on validation */
function fitStrongHomeAwayShrink(valRows, rawPredict) {
  // awayMu' = awayMu - k * max(0, hwp - 0.55)
  // choose k to max direction hit on val (grid)
  let bestK = 0;
  let bestHit = -1;
  for (let k = 0; k <= 2.0 + 1e-9; k += 0.1) {
    let n = 0;
    let hit = 0;
    for (const row of valRows) {
      if (row.homeScore === row.awayScore) continue;
      const raw = rawPredict(row);
      let ph = raw.homeExpectedRuns;
      let pa = raw.awayExpectedRuns;
      const hwp = row.homeWinPct;
      if (hwp != null && hwp >= 0.55) {
        pa = Math.max(0.5, pa - k * (hwp - 0.55));
      }
      n += 1;
      if ((ph >= pa) === row.homeScore > row.awayScore) hit += 1;
    }
    const rate = n ? hit / n : 0;
    if (rate > bestHit + 1e-9) {
      bestHit = rate;
      bestK = k;
    }
  }
  return { k: Number(bestK.toFixed(2)), valDirectionHit: Number(bestHit.toFixed(4)) };
}

function fitMarketBlend(valRows, rawPredict) {
  // p' = (1-w)*p + w*p_mkt ; pick w minimizing brier on val
  let bestW = 0;
  let bestB = Infinity;
  for (let w = 0; w <= 0.6 + 1e-9; w += 0.05) {
    let n = 0;
    let brier = 0;
    for (const row of valRows) {
      if (row.homeScore === row.awayScore) continue;
      const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
      if (bs.length < 1) continue;
      bs.sort((a, b) => a.vig - b.vig);
      const pMkt = fairHomeProb(bs[0].homeOdds, bs[0].awayOdds);
      const raw = rawPredict(row);
      const p = (1 - w) * raw.markets.homeWinProbability + w * pMkt;
      const y = row.homeScore > row.awayScore ? 1 : 0;
      brier += (p - y) ** 2;
      n += 1;
    }
    if (!n) continue;
    brier /= n;
    if (brier < bestB) {
      bestB = brier;
      bestW = w;
    }
  }
  return { w: Number(bestW.toFixed(2)), valBrier: Number(bestB.toFixed(5)) };
}

function makePredict(model, posthoc = null) {
  return (row, temperatureOverride = null) => {
    let ph = predictMlbExpectedRunsMean(model, row.homeVector);
    let pa = predictMlbExpectedRunsMean(model, row.awayVector);
    if (posthoc?.strongShrinkK) {
      const hwp = row.homeWinPct;
      if (hwp != null && hwp >= 0.55) {
        pa = Math.max(0.5, pa - posthoc.strongShrinkK * (hwp - 0.55));
      }
    }
    const dist = buildMlbScoreDistribution({
      homeMean: ph,
      awayMean: pa,
      homeDispersion: model.dispersion,
      awayDispersion: model.dispersion,
    });
    let markets = deriveMlbScoreMarkets(dist, { totalLine: 8.5 });
    const temp = temperatureOverride ?? model.moneylineTemperature ?? 1;
    markets = calibrateMlbScoreMarkets(markets, temp);
    if (posthoc?.marketBlendW > 0) {
      const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
      if (bs.length) {
        bs.sort((a, b) => a.vig - b.vig);
        const pMkt = fairHomeProb(bs[0].homeOdds, bs[0].awayOdds);
        const w = posthoc.marketBlendW;
        const pHome = (1 - w) * markets.homeWinProbability + w * pMkt;
        markets = {
          ...markets,
          homeWinProbability: pHome,
          awayWinProbability: 1 - pHome,
        };
      }
    }
    return { homeExpectedRuns: ph, awayExpectedRuns: pa, markets };
  };
}

function directionReport(rows, predictFn) {
  let n = 0;
  let dirHit = 0;
  let maeH = 0;
  let maeA = 0;
  let brier = 0;
  let strongN = 0;
  let strongAway = 0;
  let strongAwayHomeAct = 0;
  let tieSkip = 0;
  for (const row of rows) {
    if (row.homeScore === row.awayScore) {
      tieSkip += 1;
      continue;
    }
    const pred = predictFn(row);
    const homeWins = row.homeScore > row.awayScore;
    const pickHome = pred.homeExpectedRuns >= pred.awayExpectedRuns;
    n += 1;
    if (pickHome === homeWins) dirHit += 1;
    maeH += Math.abs(pred.homeExpectedRuns - row.homeScore);
    maeA += Math.abs(pred.awayExpectedRuns - row.awayScore);
    brier += (pred.markets.homeWinProbability - (homeWins ? 1 : 0)) ** 2;
    const hwp = row.homeWinPct;
    if (hwp != null && hwp >= STRONG) {
      strongN += 1;
      if (!pickHome) {
        strongAway += 1;
        if (homeWins) strongAwayHomeAct += 1;
      }
    }
  }
  return {
    games: n,
    tiesSkipped: tieSkip,
    directionHitRate: n ? Number((dirHit / n).toFixed(4)) : null,
    moneylineBrier: n ? Number((brier / n).toFixed(5)) : null,
    maeHome: n ? Number((maeH / n).toFixed(4)) : null,
    maeAway: n ? Number((maeA / n).toFixed(4)) : null,
    strongHome: {
      games: strongN,
      muPicksAway: strongAway,
      muPicksAwayRate: strongN ? Number((strongAway / strongN).toFixed(4)) : null,
      whenAwayHomeActual: strongAway
        ? Number((strongAwayHomeAct / strongAway).toFixed(4))
        : null,
    },
  };
}

function lockedB(rows, predictFn) {
  const byDay = new Map();
  for (const row of rows) {
    if (row.homeScore === row.awayScore) continue;
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
    const pred = predictFn(row);
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    const modelProb = pickHome
      ? pred.markets.homeWinProbability
      : pred.markets.awayWinProbability;
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    const sig = buildPregameRegimeSignals(row.features);
    const pickEarly = pickHome
      ? +sig.homeEarlyExitsLast3 || 0
      : +sig.awayEarlyExitsLast3 || 0;
    const oppEarly = pickHome
      ? +sig.awayEarlyExitsLast3 || 0
      : +sig.homeEarlyExitsLast3 || 0;
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
    const day = hk(row.commenceTime);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({
      pickOdds,
      bScore,
      margin,
      hit: pickHome ? row.homeScore > row.awayScore : row.awayScore > row.homeScore,
    });
  }
  const bets = [];
  for (const day of [...byDay.keys()].sort()) {
    let slots = [...byDay.get(day)]
      .sort((a, b) => b.bScore - a.bScore || b.margin - a.margin)
      .slice(0, 3);
    if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
    if (
      slots.length >= 2 &&
      slots[1].pickOdds >= 1.85 &&
      slots[1].pickOdds < 1.95
    ) {
      slots = [slots[0], ...slots.slice(2)];
    }
    bets.push(...slots);
  }
  let w = 0;
  let u = 0;
  for (const b of bets) {
    if (b.hit) {
      w += 1;
      u += b.pickOdds - 1;
    } else u -= 1;
  }
  return {
    bets: bets.length,
    hitRate: bets.length ? Number((w / bets.length).toFixed(4)) : null,
    usd50: Math.round(u * STAKE),
  };
}

console.log('Loading rows…');
const development2025 = loadGameRows('2025-05-01T00:00:00Z', '2026-01-01T00:00:00Z');
const splitIndex = Math.floor(development2025.length * 0.7);
const trainRows = development2025.slice(0, splitIndex);
const valRows = development2025.slice(splitIndex);
const rows2024 = loadGameRows('2024-04-01T00:00:00Z', '2024-10-01T00:00:00Z');
const rows2026 = loadGameRows('2026-04-01T00:00:00Z', '2026-07-23T00:00:00Z');
const rows2025full = loadGameRows('2025-04-01T00:00:00Z', '2025-10-01T00:00:00Z');

console.log({
  train: trainRows.length,
  val: valRows.length,
  y2024: rows2024.length,
  y2025: rows2025full.length,
  y2026: rows2026.length,
});

const prodModel = getLatestMlbExpectedRunsValidation().model;
// prod model uses its own feature keys; vectors have extras ignored
const prodPredict = makePredict(prodModel);

const FEATURE_SETS = [
  { id: 'retrain_v45_control', keys: [...MLB_V45_SELECTED_FEATURE_KEYS] },
  {
    id: 'v45_plus_roleWinPct',
    keys: [
      ...MLB_V45_SELECTED_FEATURE_KEYS,
      'offenseRoleWinPct',
      'opponentRoleWinPct',
    ],
  },
  {
    id: 'v45_plus_seasonDiff',
    keys: [...MLB_V45_SELECTED_FEATURE_KEYS, 'seasonWinPctDiffForOffense'],
  },
  {
    id: 'v45_plus_role_and_season',
    keys: [
      ...MLB_V45_SELECTED_FEATURE_KEYS,
      'offenseRoleWinPct',
      'opponentRoleWinPct',
      'seasonWinPctDiffForOffense',
    ],
  },
];

const evalSets = [
  { key: 'val2025', rows: valRows },
  { key: '2024', rows: rows2024 },
  { key: '2025', rows: rows2025full },
  { key: '2026', rows: rows2026 },
];

function packageModel(label, model, posthoc, meta = {}) {
  const predict = makePredict(model, posthoc);
  const byWindow = {};
  for (const set of evalSets) {
    byWindow[set.key] = {
      direction: directionReport(set.rows, predict),
      lockedB: lockedB(set.rows, predict),
    };
  }
  return {
    label,
    meta,
    posthoc,
    weightsHint: {
      isHome: model.weights?.isHome ?? null,
      offenseRoleWinPct: model.weights?.offenseRoleWinPct ?? null,
      opponentRoleWinPct: model.weights?.opponentRoleWinPct ?? null,
      seasonWinPctDiffForOffense: model.weights?.seasonWinPctDiffForOffense ?? null,
    },
    byWindow,
  };
}

const results = [];
results.push(
  packageModel('prod_v45', prodModel, null, { note: '庫內正式模型' })
);

for (const spec of FEATURE_SETS) {
  console.log('Fitting', spec.id);
  const model = fitMlbExpectedRunsModel(examplesFrom(trainRows), {
    featureKeys: spec.keys,
  });
  const rawPredict = makePredict(model, null);
  const temp = fitTemp(valRows, rawPredict);
  model.moneylineTemperature = temp;

  results.push(
    packageModel(spec.id, model, null, { temperature: temp })
  );

  // posthoc on this model
  const shrink = fitStrongHomeAwayShrink(valRows, (row) => rawPredict(row));
  const blend = fitMarketBlend(valRows, (row) => {
    // use temp-calibrated markets
    return makePredict(model, null)(row);
  });
  console.log('  posthoc', shrink, blend);

  results.push(
    packageModel(
      `${spec.id}+strongShrink`,
      model,
      { strongShrinkK: shrink.k, marketBlendW: 0 },
      { temperature: temp, shrink }
    )
  );
  results.push(
    packageModel(
      `${spec.id}+mktBlend`,
      model,
      { strongShrinkK: 0, marketBlendW: blend.w },
      { temperature: temp, blend }
    )
  );
  results.push(
    packageModel(
      `${spec.id}+shrink+blend`,
      model,
      { strongShrinkK: shrink.k, marketBlendW: blend.w },
      { temperature: temp, shrink, blend }
    )
  );
}

const prodDir2026 = results[0].byWindow['2026'].direction;
const ranked = results
  .filter((r) => r.label !== 'prod_v45')
  .map((r) => {
    const d26 = r.byWindow['2026'].direction;
    const d24 = r.byWindow['2024'].direction;
    const dProd24 = results[0].byWindow['2024'].direction;
    return {
      label: r.label,
      dir2026: d26.directionHitRate,
      deltaDir2026: Number(
        (d26.directionHitRate - prodDir2026.directionHitRate).toFixed(4)
      ),
      brier2026: d26.moneylineBrier,
      deltaBrier2026: Number(
        (d26.moneylineBrier - prodDir2026.moneylineBrier).toFixed(5)
      ),
      strongAwayRate2026: d26.strongHome.muPicksAwayRate,
      deltaStrongAway2026: Number(
        (
          (d26.strongHome.muPicksAwayRate ?? 0) -
          (prodDir2026.strongHome.muPicksAwayRate ?? 0)
        ).toFixed(4)
      ),
      dir2024: d24.directionHitRate,
      deltaDir2024: Number(
        (d24.directionHitRate - dProd24.directionHitRate).toFixed(4)
      ),
      maeAway2026: d26.maeAway,
      lockedB2026: r.byWindow['2026'].lockedB,
    };
  })
  .sort(
    (a, b) =>
      b.deltaDir2026 - a.deltaDir2026 ||
      a.deltaBrier2026 - b.deltaBrier2026 ||
      a.deltaStrongAway2026 - b.deltaStrongAway2026
  );

const best = ranked[0];
const pass = ranked.find(
  (r) =>
    r.deltaDir2026 >= 0.005 &&
    r.deltaBrier2026 <= 0 &&
    r.deltaStrongAway2026 <= 0 &&
    r.deltaDir2024 >= -0.002
);

const out = {
  experimentId: 'direction-accuracy-ablation-2026-08-07',
  plainLanguage: '對齊正式訓練窗，用側向勝率特徵／強主μ收縮／市場混合，看方向命中有無進步',
  split: {
    train: trainRows.length,
    val: valRows.length,
    protocol: '2025-05+ 70/30 then refit note: final models use train-only + val temp/posthoc',
  },
  productionBaseline: {
    byWindow: Object.fromEntries(
      evalSets.map((s) => [
        s.key,
        {
          direction: results[0].byWindow[s.key].direction,
          lockedB: results[0].byWindow[s.key].lockedB,
        },
      ])
    ),
  },
  ranked,
  results,
  recommendation: {
    wireSuggested: false,
    persistModel: false,
    best: best?.label || null,
    passGate: pass?.label || null,
    note: pass
      ? `${pass.label}：2026 方向升≥0.5pp、Brier 不差、強主選客下降、2024 不崩——可列研究候選，仍不 persist`
      : best
        ? `最佳 ${best.label}（2026 方向Δ ${best.deltaDir2026}）未過嚴閘；準度仍難靠這一層特徵／事後項打開`
        : '無候選',
  },
};

fs.writeFileSync(
  new URL('../tmp-direction-accuracy-ablation.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\nPROD 2026', results[0].byWindow['2026'].direction);
console.log('PROD 2024', results[0].byWindow['2024'].direction);
console.log('\nTOP:');
for (const r of ranked.slice(0, 8)) {
  console.log(
    `${r.label.padEnd(36)} dir26=${r.dir2026}(Δ${r.deltaDir2026}) brierΔ=${r.deltaBrier2026} strongAwayΔ=${r.deltaStrongAway2026} dir24Δ=${r.deltaDir2024} LB26$=${r.lockedB2026.usd50}`
  );
}
console.log('\nREC', out.recommendation.note);
