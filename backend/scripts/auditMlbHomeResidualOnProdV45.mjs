/**
 * 在正式 v4.5 上做主場殘差修正（不重訓整模）
 *
 * 對 2025 train：
 *   homeMean' = homeMean + a * (homeWinPct - 0.5)
 *   awayMean' = awayMean + b * (homeWinPct - 0.5)
 * 用嶺回歸擬合 a,b（對實際得分殘差）
 *
 * 再掃強度縮放 s∈{0.5,1,1.5,2}：a'=s*a, b'=s*b
 * 評估鎖定 B 三窗 vs 正式模型
 *
 * 用法：node scripts/auditMlbHomeResidualOnProdV45.mjs
 * 產物：tmp-b-home-residual-on-prod-v45.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
  calibrateMlbScoreMarkets,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
} from '../src/services/MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const STAKE = 50;
const STRONG = 0.65;
const RIDGE = 50;

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

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

function loadPool(from, to, model) {
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
    if (hs === as) continue;
    const base = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) continue;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    const sig = buildPregameRegimeSignals(features);
    const homeWinPct = Number(features?.home?.homeWinPct);
    if (!Number.isFinite(homeWinPct)) continue;
    out.push({
      day: hk(row.commenceTime),
      homeWon: hs > as,
      homeScore: hs,
      awayScore: as,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      homeWinPct,
      xHome: homeWinPct - 0.5,
      base,
      homeEarly: +sig.homeEarlyExitsLast3 || 0,
      awayEarly: +sig.awayEarlyExitsLast3 || 0,
    });
  }
  return out;
}

function fitRidge(xs, ys, ridge) {
  // 1D: a = sum(x*y) / (sum(x^2)+ridge)
  let num = 0;
  let den = ridge;
  for (let i = 0; i < xs.length; i += 1) {
    num += xs[i] * ys[i];
    den += xs[i] * xs[i];
  }
  return num / den;
}

function rebuild(model, base, x, a, b) {
  const homeMean = Math.max(1.5, base.homeExpectedRuns + a * x);
  const awayMean = Math.max(1.5, base.awayExpectedRuns + b * x);
  const distribution = buildMlbScoreDistribution({
    homeMean,
    awayMean,
    homeDispersion: model.dispersion,
    awayDispersion: model.dispersion,
  });
  const rawMarkets = deriveMlbScoreMarkets(distribution, { totalLine: 8.5 });
  const markets = calibrateMlbScoreMarkets(rawMarkets, model.moneylineTemperature);
  return { homeExpectedRuns: homeMean, awayExpectedRuns: awayMean, markets };
}

function selectB(pool, model, a, b) {
  const byDay = new Map();
  for (const g of pool) {
    const pred =
      a === 0 && b === 0
        ? {
            homeExpectedRuns: g.base.homeExpectedRuns,
            awayExpectedRuns: g.base.awayExpectedRuns,
            markets: g.base.markets,
          }
        : rebuild(model, g.base, g.xHome, a, b);
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    const modelProb = pickHome
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? g.homeOdds : g.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    const pickEarly = pickHome ? g.homeEarly : g.awayEarly;
    const oppEarly = pickHome ? g.awayEarly : g.homeEarly;
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
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({
      day: g.day,
      pickHome,
      pickOdds,
      modelProb,
      ev,
      margin,
      bScore,
      homeWinPct: g.homeWinPct,
      hit: pickHome ? g.homeWon : !g.homeWon,
    });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (x, y) => y.bScore - x.bScore || y.margin - x.margin
    );
    applyDrop(arr).forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

function toxic(bets) {
  const t = bets.filter(
    (b) => b.rank === 1 && !b.pickHome && (b.homeWinPct ?? 0) >= STRONG
  );
  const hi = t.filter((b) => b.ev >= 0.1);
  return { n: t.length, hiEvN: hi.length, sum: summarize(t), hiSum: summarize(hi) };
}

const validation = getLatestMlbExpectedRunsValidation();
const model = validation.model;

console.log('Load train 2025…');
const train = loadPool('2025-05-01', '2025-09-30', model);
const homeXs = [];
const homeYs = [];
const awayXs = [];
const awayYs = [];
for (const g of train) {
  homeXs.push(g.xHome);
  homeYs.push(g.homeScore - g.base.homeExpectedRuns);
  awayXs.push(g.xHome);
  awayYs.push(g.awayScore - g.base.awayExpectedRuns);
}
const aHat = fitRidge(homeXs, homeYs, RIDGE);
const bHat = fitRidge(awayXs, awayYs, RIDGE);
console.log('Fitted residual coeffs a(home)=', aHat, 'b(away)=', bHat);
// Expect a>0 (strong home scores more at home), b<0 (visitors score less)

console.log('Load eval windows…');
const evalPools = {};
for (const w of WINDOWS) {
  evalPools[w.key] = loadPool(w.from, w.to, model);
}

const scales = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const trials = [];
for (const s of scales) {
  const a = aHat * s;
  const b = bHat * s;
  const byWindow = {};
  const all = [];
  for (const w of WINDOWS) {
    const bets = selectB(evalPools[w.key], model, a, b);
    byWindow[w.key] = { ...summarize(bets), toxic: toxic(bets) };
    all.push(...bets);
  }
  const rawByWindow = {};
  for (const w of WINDOWS) {
    rawByWindow[w.key] = summarize(selectB(evalPools[w.key], model, 0, 0));
  }
  let winNonNeg = 0;
  for (const w of WINDOWS) {
    byWindow[w.key].deltaUsd = byWindow[w.key].usd50 - rawByWindow[w.key].usd50;
    if (byWindow[w.key].deltaUsd >= 0) winNonNeg += 1;
  }
  const overall = summarize(all);
  const rawAll = summarize(
    WINDOWS.flatMap((w) => selectB(evalPools[w.key], model, 0, 0))
  );
  trials.push({
    scale: s,
    a,
    b,
    overall,
    deltaUsd: overall.usd50 - rawAll.usd50,
    byWindow,
    windowsNonNeg: winNonNeg,
    toxicAll: toxic(all),
    passGates: winNonNeg === 3 && overall.usd50 > rawAll.usd50,
  });
}

trials.sort(
  (x, y) =>
    Number(y.passGates) - Number(x.passGates) ||
    y.windowsNonNeg - x.windowsNonNeg ||
    y.deltaUsd - x.deltaUsd
);

const bestPass = trials.find((t) => t.passGates && t.scale > 0) || null;
const out = {
  experimentId: 'b-home-residual-on-prod-v45-2026-07-29',
  plainLanguage:
    '不重訓整模；只在正式 v4.5 上學習「主場勝率偏高時主隊多得分、客隊少得分」的修正',
  fitted: { aHat, bHat, ridge: RIDGE, trainN: train.length },
  interpretation: {
    aHatSign: aHat >= 0 ? '強主場→主隊得分上修（方向正確）' : '方向異常',
    bHatSign: bHat <= 0 ? '強主場→客隊得分下修（方向正確）' : '方向異常',
  },
  trials,
  bestPassing: bestPass,
  recommendation: {
    wireSuggested: false,
    note: bestPass
      ? '殘差主場修正過三窗閘：可作影子／下一版重訓先驗'
      : '殘差方向可能對，但縮放後仍未穩定三窗勝出；維持 shrink 影子，整模重訓需沿用正式訓練協定',
  },
};

fs.writeFileSync(
  new URL('../tmp-b-home-residual-on-prod-v45.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\nTRIALS:');
for (const t of trials) {
  console.log(
    `s=${t.scale} a=${t.a.toFixed(3)} b=${t.b.toFixed(3)} Δ$=${t.deltaUsd} win=${t.windowsNonNeg}/3 toxicR1=${t.toxicAll.n} hiEv=${t.toxicAll.hiEvN} pass=${t.passGates}`
  );
  console.log(
    `  24:${t.byWindow['2024'].deltaUsd} 25:${t.byWindow['2025'].deltaUsd} 26:${t.byWindow['2026'].deltaUsd}`
  );
}
console.log('\nBEST', bestPass);
console.log('REC', out.recommendation.note);
