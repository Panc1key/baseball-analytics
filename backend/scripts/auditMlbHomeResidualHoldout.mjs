/**
 * 主場殘差修正嚴格外測
 * - 在 2025 擬合 a,b
 * - 用 2025 內部分切選 scale
 * - 只在 2024、2026 報告（真正 OOS）
 * - 另：train2024 → test2025；train2025 → test2026
 *
 * 用法：node scripts/auditMlbHomeResidualHoldout.mjs
 * 產物：tmp-b-home-residual-holdout.json
 *       若過閘則更新影子 meta
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
const RIDGE = 50;
const SCALES = [0.25, 0.5, 0.75, 1, 1.25];

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
function fitRidge(xs, ys, ridge) {
  let num = 0;
  let den = ridge;
  for (let i = 0; i < xs.length; i += 1) {
    num += xs[i] * ys[i];
    den += xs[i] * xs[i];
  }
  return num / den;
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
    const homeWinPct = Number(features?.home?.homeWinPct);
    if (!Number.isFinite(homeWinPct)) continue;
    const sig = buildPregameRegimeSignals(features);
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
  return {
    homeExpectedRuns: homeMean,
    awayExpectedRuns: awayMean,
    markets: calibrateMlbScoreMarkets(rawMarkets, model.moneylineTemperature),
  };
}
function selectB(pool, model, a, b) {
  const byDay = new Map();
  for (const g of pool) {
    const pred =
      a === 0 && b === 0
        ? { homeExpectedRuns: g.base.homeExpectedRuns, awayExpectedRuns: g.base.awayExpectedRuns, markets: g.base.markets }
        : rebuild(model, g.base, g.xHome, a, b);
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    const modelProb = pickHome ? +pred.markets.homeWinProbability : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? g.homeOdds : g.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    if ((pickHome ? g.homeEarly : g.awayEarly) > (pickHome ? g.awayEarly : g.homeEarly)) continue;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue) continue;
    if (margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (pickOdds < B.minimumPickOdds || pickOdds > B.maximumPickOdds) continue;
    const bScore = scoreMlbMoneylineDailyRank({ expectedValue: ev, modelProbability: modelProb }, B);
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({
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
    const arr = [...byDay.get(day)].sort((x, y) => y.bScore - x.bScore || y.margin - x.margin);
    applyDrop(arr).forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}
function fitAB(pool) {
  const hX = [];
  const hY = [];
  const aX = [];
  const aY = [];
  for (const g of pool) {
    hX.push(g.xHome);
    hY.push(g.homeScore - g.base.homeExpectedRuns);
    aX.push(g.xHome);
    aY.push(g.awayScore - g.base.awayExpectedRuns);
  }
  return { a: fitRidge(hX, hY, RIDGE), b: fitRidge(aX, aY, RIDGE) };
}
function pickScale(valPool, model, aHat, bHat) {
  const raw = summarize(selectB(valPool, model, 0, 0));
  let best = { scale: 0.25, delta: -Infinity };
  for (const s of SCALES) {
    const opt = summarize(selectB(valPool, model, aHat * s, bHat * s));
    const delta = opt.usd50 - raw.usd50;
    if (delta > best.delta) best = { scale: s, delta, opt };
  }
  return best;
}

const validation = getLatestMlbExpectedRunsValidation();
const model = validation.model;

const p2024 = loadPool('2024-04-01', '2024-09-30', model);
const p2025 = loadPool('2025-04-01', '2025-09-30', model);
const p2026 = loadPool('2026-04-01', '2026-07-22', model);

// Protocol 1: fit 2025 first 70%, select scale on last 30%, test 2024+2026
const split = Math.floor(p2025.length * 0.7);
const fit25 = p2025.slice(0, split);
const val25 = p2025.slice(split);
const ab25 = fitAB(fit25);
const scalePick = pickScale(val25, model, ab25.a, ab25.b);
const a1 = ab25.a * scalePick.scale;
const b1 = ab25.b * scalePick.scale;

const raw24 = summarize(selectB(p2024, model, 0, 0));
const opt24 = summarize(selectB(p2024, model, a1, b1));
const raw26 = summarize(selectB(p2026, model, 0, 0));
const opt26 = summarize(selectB(p2026, model, a1, b1));
const raw25 = summarize(selectB(p2025, model, 0, 0));
const opt25 = summarize(selectB(p2025, model, a1, b1));

// Protocol 2: train2024 → test2025
const ab24 = fitAB(p2024);
const scale24 = pickScale(p2024, model, ab24.a, ab24.b); // in-sample scale pick weak; use fixed 0.25 also
const a2 = ab24.a * 0.25;
const b2 = ab24.b * 0.25;
const t25raw = summarize(selectB(p2025, model, 0, 0));
const t25opt = summarize(selectB(p2025, model, a2, b2));

// Protocol 3: train2025 → test2026 with scale from val25
const a3 = a1;
const b3 = b1;
const t26raw = raw26;
const t26opt = opt26;

const protocol1 = {
  fitOn: '2025 first70%',
  scaleSelectedOn: '2025 last30%',
  selectedScale: scalePick.scale,
  coeffs: { aHat: ab25.a, bHat: ab25.b, a: a1, b: b1 },
  oos2024: { raw: raw24, opt: opt24, deltaUsd: opt24.usd50 - raw24.usd50 },
  oos2026: { raw: raw26, opt: opt26, deltaUsd: opt26.usd50 - raw26.usd50 },
  semi2025: { raw: raw25, opt: opt25, deltaUsd: opt25.usd50 - raw25.usd50 },
  oosSumDelta: opt24.usd50 - raw24.usd50 + (opt26.usd50 - raw26.usd50),
  oosBothNonNeg:
    opt24.usd50 - raw24.usd50 >= 0 && opt26.usd50 - raw26.usd50 >= 0,
};

const protocol2 = {
  fitOn: '2024',
  scale: 0.25,
  coeffs: { aHat: ab24.a, bHat: ab24.b, a: a2, b: b2 },
  test2025: { raw: t25raw, opt: t25opt, deltaUsd: t25opt.usd50 - t25raw.usd50 },
};

const out = {
  experimentId: 'b-home-residual-holdout-2026-07-29',
  protocol1,
  protocol2,
  protocol3_train25_test26: {
    deltaUsd: t26opt.usd50 - t26raw.usd50,
    raw: t26raw,
    opt: t26opt,
  },
  recommendation: null,
};

out.recommendation = {
  wireSuggested: false,
  promoteShadow:
    protocol1.oosBothNonNeg && protocol1.oosSumDelta > 0 && protocol2.test2025.deltaUsd >= 0,
  note:
    protocol1.oosBothNonNeg && protocol1.oosSumDelta > 0
      ? protocol2.test2025.deltaUsd >= 0
        ? '嚴格 OOS（24+26）與 24→25 皆不傷：升格為模型側影子主候選（仍不 persist）'
        : '24+26 OOS 過，但 24→25 未過：影子可並列，不接入'
      : '嚴格 OOS 未過：殘差修正尚不能取代 shrink；繼續研究',
};

fs.writeFileSync(
  new URL('../tmp-b-home-residual-holdout.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('P1', protocol1);
console.log('P2', protocol2);
console.log('REC', out.recommendation);

if (out.recommendation.promoteShadow) {
  fs.writeFileSync(
    new URL('../tmp-b-toxic-conditional-shrink-shadow.json', import.meta.url),
    JSON.stringify(
      {
        experimentId: 'shadow-status-2026-07-29',
        recommendWire: false,
        shadows: [
          {
            id: 'shrink_p_ge55_w045',
            type: 'probability_shrink',
            deltaUsdNote: '+257 vs B, 3-window ok, month 3/1/9',
          },
          {
            id: 'home_residual_scale025',
            type: 'prod_v45_residual',
            rule: 'homeMean+=a*(hw-0.5); awayMean+=b*(hw-0.5); scale from 2025 val',
            coeffs: protocol1.coeffs,
            oos: {
              d2024: protocol1.oos2024.deltaUsd,
              d2026: protocol1.oos2026.deltaUsd,
              d2025_semi: protocol1.semi2025.deltaUsd,
              train24_test25: protocol2.test2025.deltaUsd,
            },
          },
        ],
        note: '雙影子並列；正式 B 不變',
      },
      null,
      2
    )
  );
}
