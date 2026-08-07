/**
 * 提勝率影子：強主禁客（翻主/不下）+ 脆弱投手禁小
 * 目標：抬 hitRate；USD 作硬閘（不可明顯變差）
 * 產物：tmp-winrate-lift-shadow.json
 *
 * 用法: node scripts/auditMlbWinrateLiftShadow.mjs
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import { getCachedMlbGameWeather } from '../src/services/MlbGameWeatherService.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  scoreMlbMoneylineDailyRank,
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
  MLB_MONEYLINE_RULE_PROFILES,
} from '../src/services/MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import {
  MLB_TOTALS_SATELLITE_SPEC,
  MLB_TOTALS_SATELLITE_HYBRID_SPEC,
} from '../src/services/MlbTotalsSatellite.js';

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const BASE = MLB_TOTALS_SATELLITE_SPEC.rules;
const UNDER_GAP = Number(BASE.minAbsGap) || 0.6;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function booksH2h(g, c, h, a) {
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
function bestTotalsLine(gameId, commenceTime) {
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
      if (!over.price || !under?.price) continue;
      const overOdds = Number(over.price);
      const underOdds = Number(under.price);
      if (overOdds < BASE.pickOddsMin || underOdds < BASE.pickOddsMin) continue;
      if (overOdds > BASE.pickOddsMax || underOdds > BASE.pickOddsMax) continue;
      const vig = 1 / overOdds + 1 / underOdds;
      if (!best || vig < best.vig) {
        const fair = removeVig(
          decimalToImpliedProb(overOdds),
          decimalToImpliedProb(underOdds)
        );
        best = {
          line: Number(over.point),
          overOdds,
          underOdds,
          fairOver: fair.fairA,
          fairUnder: fair.fairB,
          vig,
        };
      }
    }
  }
  return best;
}
function summarize(bets) {
  const settled = bets.filter((b) => b.hit === true || b.hit === false);
  if (!settled.length) {
    return { bets: 0, hitRate: null, roi: null, usd50: 0, avgOdds: null };
  }
  let hits = 0;
  let unit = 0;
  let odds = 0;
  for (const b of settled) {
    odds += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = settled.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * 50),
    avgOdds: Number((odds / n).toFixed(3)),
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

const validation = getLatestMlbExpectedRunsValidation();
const pool = [];
for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);

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
    const pred = predictMlbGameRuns(validation.model, features, { totalLine: 8.5 });
    const ph = +pred.homeExpectedRuns;
    const pa = +pred.awayExpectedRuns;
    if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;
    const pickHome = ph >= pa;
    const modelProb = pickHome
      ? +pred.markets?.homeWinProbability
      : +pred.markets?.awayWinProbability;
    if (!Number.isFinite(modelProb)) continue;
    const bs = booksH2h(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome ? +sig.homeEarlyExitsLast3 || 0 : +sig.awayEarlyExitsLast3 || 0;
    const oppEarly = pickHome ? +sig.awayEarlyExitsLast3 || 0 : +sig.homeEarlyExitsLast3 || 0;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2 || pickEarly > oppEarly) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    pool.push({
      window: w.key,
      day: hk(row.commenceTime),
      gameId: row.gameId,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      pickHome,
      pickOdds,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      modelProb,
      ev,
      margin,
      bScore,
      homeWinPct: +features?.home?.homeWinPct || null,
      homeWon: hs > as,
      hit: pickHome ? hs > as : as > hs,
    });
  }
}

const byDay = new Map();
for (const g of pool) {
  if (
    g.ev < B.minimumExpectedValue ||
    g.margin < B.minimumExpectedRunMargin ||
    g.modelProb < B.minimumModelProbability ||
    g.pickOdds < B.minimumPickOdds ||
    g.pickOdds > B.maximumPickOdds
  ) {
    continue;
  }
  if (!byDay.has(g.day)) byDay.set(g.day, []);
  byDay.get(g.day).push(g);
}
const official = [];
for (const day of [...byDay.keys()].sort()) {
  const arr = [...byDay.get(day)].sort(
    (a, b) => b.bScore - a.bScore || b.margin - a.margin
  );
  applyDrop(arr).forEach((x, i) => official.push({ ...x, rank: i + 1 }));
}

const baseMl = summarize(official);

function isToxic(b, { strong, evCut, rank1Only, marketHomeFav }) {
  if (b.pickHome !== false) return false;
  if (rank1Only && b.rank !== 1) return false;
  if (evCut != null && b.ev < evCut) return false;
  if (marketHomeFav && !(b.homeOdds < b.awayOdds)) return false;
  if (strong != null && (b.homeWinPct ?? 0) < strong) return false;
  return true;
}

function applyMlPolicy(officialBets, cfg) {
  const toxic = officialBets.filter((b) => isToxic(b, cfg));
  if (cfg.action === 'skip') {
    const kept = officialBets.filter((b) => !isToxic(b, cfg));
    const s = summarize(kept);
    return {
      ...cfg,
      id: cfg.id,
      toxicN: toxic.length,
      toxicAwayHr: summarize(
        toxic.map((b) => ({ pickOdds: b.awayOdds, hit: !b.homeWon }))
      ).hitRate,
      ledger: s,
      deltaHrPp:
        s.hitRate != null && baseMl.hitRate != null
          ? Number(((s.hitRate - baseMl.hitRate) * 100).toFixed(2))
          : null,
      deltaUsd: s.usd50 - baseMl.usd50,
      catchesBrewersLike: toxic.some(
        (b) =>
          (b.homeWinPct ?? 0) >= 0.62 &&
          (b.homeWinPct ?? 0) < 0.65 &&
          b.ev >= 0.1
      ),
    };
  }
  // flip
  const flipped = officialBets.map((b) => {
    if (!isToxic(b, cfg)) return b;
    return { ...b, pickOdds: b.homeOdds, hit: b.homeWon };
  });
  const s = summarize(flipped);
  return {
    ...cfg,
    id: cfg.id,
    toxicN: toxic.length,
    toxicAwayHr: summarize(
      toxic.map((b) => ({ pickOdds: b.awayOdds, hit: !b.homeWon }))
    ).hitRate,
    toxicFlipHr: summarize(
      toxic.map((b) => ({ pickOdds: b.homeOdds, hit: b.homeWon }))
    ).hitRate,
    ledger: s,
    deltaHrPp:
      s.hitRate != null && baseMl.hitRate != null
        ? Number(((s.hitRate - baseMl.hitRate) * 100).toFixed(2))
        : null,
    deltaUsd: s.usd50 - baseMl.usd50,
    catchesBrewersLike: toxic.some(
      (b) =>
        (b.homeWinPct ?? 0) >= 0.62 &&
        (b.homeWinPct ?? 0) < 0.65 &&
        b.ev >= 0.1
    ),
  };
}

const mlCfgs = [];
for (const strong of [0.6, 0.62, 0.65]) {
  for (const evCut of [0.1, 0.05, null]) {
    for (const rank1Only of [true, false]) {
      for (const action of ['flip', 'skip']) {
        mlCfgs.push({
          id: `${action}_hwp${String(strong).replace('.', '')}_ev${evCut == null ? 'any' : Math.round(evCut * 100)}_r${rank1Only ? '1' : 'all'}`,
          action,
          strong,
          evCut,
          rank1Only,
          marketHomeFav: false,
        });
      }
    }
  }
}
// 市場主熱門 + EV（不靠 homeWinPct，蓋釀酒人類）
for (const evCut of [0.1, 0.05]) {
  for (const action of ['flip', 'skip']) {
    mlCfgs.push({
      id: `${action}_mktHomeFav_ev${Math.round(evCut * 100)}_r1`,
      action,
      strong: null,
      evCut,
      rank1Only: true,
      marketHomeFav: true,
    });
  }
}

const mlResults = mlCfgs.map((c) => applyMlPolicy(official, c));
mlResults.sort((a, b) => {
  // 優先：勝率升 + 美元不掉超過 200；再比 deltaHr、deltaUsd
  const aOk = (a.deltaUsd ?? -9999) >= -200 && (a.deltaHrPp ?? -99) > 0;
  const bOk = (b.deltaUsd ?? -9999) >= -200 && (b.deltaHrPp ?? -99) > 0;
  if (aOk !== bOk) return aOk ? -1 : 1;
  if ((b.deltaHrPp ?? -99) !== (a.deltaHrPp ?? -99)) {
    return (b.deltaHrPp ?? -99) - (a.deltaHrPp ?? -99);
  }
  return (b.deltaUsd ?? -9999) - (a.deltaUsd ?? -9999);
});

// —— totals under fragile skip ——
const underBets = [];
for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS hs, g.away_score AS ascore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);

  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    features.parkFactor = resolveMlbParkFactor({
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    const weather = getCachedMlbGameWeather(row.gameId);
    if (weather) features.weather = weather;
    let pred;
    try {
      pred = predictMlbGameRuns(validation.model, features);
    } catch {
      continue;
    }
    if (!pred || !Number.isFinite(pred.expectedTotal)) continue;
    const lineObj = bestTotalsLine(row.gameId, row.commenceTime);
    if (!lineObj) continue;
    const mu = Number(pred.expectedTotal);
    const gap = mu - lineObj.line;
    if (!(gap < 0) || Math.abs(gap) < UNDER_GAP) continue;
    if (lineObj.line > BASE.maxTotalLine) continue;
    const dist = buildMlbScoreDistribution({
      homeMean: Number(pred.homeExpectedRuns),
      awayMean: Number(pred.awayExpectedRuns),
      homeDispersion: Number(pred.dispersion ?? 3.5),
      awayDispersion: Number(pred.dispersion ?? 3.5),
    });
    const markets = deriveMlbScoreMarkets(dist, { totalLine: lineObj.line });
    const pushP = Number(markets.total?.pushProbability) || 0;
    const underRaw = Number(markets.total?.underProbability);
    if (!Number.isFinite(underRaw)) continue;
    const modelProb = underRaw / Math.max(1e-9, 1 - pushP);
    const pickOdds = lineObj.underOdds;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const edge = modelProb - lineObj.fairUnder;
    if (ev < BASE.minimumExpectedValue) continue;
    if (edge < BASE.minEdgeVsMarket) continue;
    if (modelProb < BASE.minimumModelProbability) continue;

    const homeR3 = Number(features?.pitchers?.homeRecent?.recent3Era);
    const awayR3 = Number(features?.pitchers?.awayRecent?.recent3Era);
    const r3s = [homeR3, awayR3].filter((x) => Number.isFinite(x));
    const maxR3 = r3s.length ? Math.max(...r3s) : null;
    const homeEra = Number(features?.pitchers?.home?.era);
    const awayEra = Number(features?.pitchers?.away?.era);
    const eras = [homeEra, awayEra].filter((x) => Number.isFinite(x));
    const maxEra = eras.length ? Math.max(...eras) : null;
    const homeBp = Number(features?.recentBoxscore?.home?.bullpen?.era);
    const awayBp = Number(features?.recentBoxscore?.away?.bullpen?.era);
    const bps = [homeBp, awayBp].filter((x) => Number.isFinite(x));
    const maxBp = bps.length ? Math.max(...bps) : null;

    const total = Number(row.hs) + Number(row.ascore);
    let result = 'push';
    if (total < lineObj.line) result = 'win';
    else if (total > lineObj.line) result = 'loss';
    if (result === 'push') continue;

    underBets.push({
      window: w.key,
      pickOdds,
      hit: result === 'win',
      maxR3,
      maxEra,
      maxBp,
      absGap: Math.abs(gap),
    });
  }
}

const baseTot = summarize(underBets);
const totPolicies = [
  {
    id: 'skip_r3era_ge60',
    test: (b) => (b.maxR3 ?? -1) >= 6,
  },
  {
    id: 'skip_r3era_ge55',
    test: (b) => (b.maxR3 ?? -1) >= 5.5,
  },
  {
    id: 'skip_starter_era_ge50',
    test: (b) => (b.maxEra ?? -1) >= 5,
  },
  {
    id: 'skip_bp_ge50',
    test: (b) => (b.maxBp ?? -1) >= 5,
  },
  {
    id: 'skip_r3era_ge60_or_era_ge50',
    test: (b) => (b.maxR3 ?? -1) >= 6 || (b.maxEra ?? -1) >= 5,
  },
  {
    id: 'skip_r3_ge55_and_gap_lt10',
    test: (b) => (b.maxR3 ?? -1) >= 5.5 && b.absGap < 1,
  },
].map((p) => {
  const dropped = underBets.filter(p.test);
  const kept = underBets.filter((b) => !p.test(b));
  const s = summarize(kept);
  const d = summarize(dropped);
  return {
    id: p.id,
    droppedN: dropped.length,
    droppedHr: d.hitRate,
    ledger: s,
    deltaHrPp:
      s.hitRate != null && baseTot.hitRate != null
        ? Number(((s.hitRate - baseTot.hitRate) * 100).toFixed(2))
        : null,
    deltaUsd: s.usd50 - baseTot.usd50,
  };
});
totPolicies.sort((a, b) => (b.deltaHrPp ?? -99) - (a.deltaHrPp ?? -99));

const hrLiftOk = mlResults.filter(
  (r) => (r.deltaHrPp ?? 0) >= 0.5 && (r.deltaUsd ?? -9999) >= 0 && r.catchesBrewersLike
);
const hrLiftAny = mlResults.filter(
  (r) => (r.deltaHrPp ?? 0) >= 0.5 && (r.deltaUsd ?? -9999) >= -100
);

const out = {
  experimentId: 'winrate-lift-shadow-2026-08-07',
  goal: '抬勝率；美元不惡化；盡量蓋住強主客隊（釀酒人類 hwp≈0.62）',
  moneyline: {
    baseline: baseMl,
    topByHitRate: mlResults.slice(0, 12).map((r) => ({
      id: r.id,
      toxicN: r.toxicN,
      ledgerHr: r.ledger.hitRate,
      deltaHrPp: r.deltaHrPp,
      deltaUsd: r.deltaUsd,
      usd50: r.ledger.usd50,
      catchesBrewersLike: r.catchesBrewersLike,
      toxicAwayHr: r.toxicAwayHr,
      toxicFlipHr: r.toxicFlipHr,
    })),
    recommendForWinrate: hrLiftOk[0] || hrLiftAny.find((r) => r.catchesBrewersLike) || null,
    noteBrewers:
      '正式 0.65 蓋不住 hwp=0.625；需 0.60/0.62 或市場主熱門規則',
  },
  totalsUnder: {
    baseline: baseTot,
    policies: totPolicies,
    recommend:
      totPolicies.find((p) => (p.deltaHrPp ?? 0) > 0 && (p.deltaUsd ?? -1) >= 0) ||
      totPolicies[0],
    noteMarlins:
      '禁小可抬剩餘池勝率或砍掉差切片；勿自動翻大（先前已證翻大更差）',
  },
};

fs.writeFileSync(
  new URL('../tmp-winrate-lift-shadow.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('ML baseline', baseMl);
console.log('ML top5', out.moneyline.topByHitRate.slice(0, 5));
console.log('ML recommend', out.moneyline.recommendForWinrate);
console.log('TOT baseline', baseTot);
console.log('TOT policies', totPolicies);
