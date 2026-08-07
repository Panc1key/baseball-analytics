/**
 * 勝率現實檢驗：鎖定 B vs 無腦高賠 vs 無腦熱門 vs 只看 μ
 * 產物：tmp-ml-vs-naive-baselines.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
} from '../src/services/MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import {
  applyFormalLockedBResidual,
  applyFormalToxicAwayShrink,
} from '../src/services/MlbFrozenBShadow.js';

const B = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: 2,
};
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
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
function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, hitRate: null, avgOdds: null, beHr: null, roi: null, usd50: 0 };
  }
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
  const avgOdds = odds / n;
  const hr = hits / n;
  return {
    bets: n,
    hitRate: Number(hr.toFixed(4)),
    avgOdds: Number(avgOdds.toFixed(3)),
    beHr: Number((1 / avgOdds).toFixed(4)),
    edgeVsBePp: Number(((hr - 1 / avgOdds) * 100).toFixed(2)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}

const model = getLatestMlbExpectedRunsValidation()?.model;
if (!model) {
  console.error('no model');
  process.exit(1);
}

const lockedB = [];
const sameSlateNaive = {
  alwaysHigherOdds: [],
  alwaysFavorite: [], // lower odds
  alwaysHome: [],
  alwaysMuSide: [], // same as locked direction before filters? use μ on same games as lockedB
};

for (const w of WINDOWS) {
  console.log('load', w.key);
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

  const dayMap = new Map();
  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const hs = +row.hs;
    const as = +row.ascore;
    if (hs === as) continue;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    const homeWinPct = Number(features?.home?.homeWinPct);
    if (!Number.isFinite(homeWinPct)) continue;
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) continue;
    // 與鎖定 B 同賠率帶，否則無腦高賠會選 3.0+ 不可比
    if (best.homeOdds > 2.3 && best.awayOdds > 2.3) continue;

    let pred = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    pred = applyFormalLockedBResidual(model, pred, features, { totalLine: 8.5 });
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHomeMu = ph >= pa;
    let modelProb = pickHomeMu
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOddsMu = pickHomeMu ? best.homeOdds : best.awayOdds;
    if (pickOddsMu < 1.4 || pickOddsMu > 2.3) continue;

    const sig = buildPregameRegimeSignals(features);
    if (
      (pickHomeMu ? sig.homeEarlyExitsLast3 : sig.awayEarlyExitsLast3) >
      (pickHomeMu ? sig.awayEarlyExitsLast3 : sig.homeEarlyExitsLast3)
    ) {
      continue;
    }
    modelProb = applyFormalToxicAwayShrink(modelProb, pickOddsMu, {
      pickHome: pickHomeMu,
      homeWinPct,
    });
    const ev = modelProb * (pickOddsMu - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue) continue;
    if (margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (pickOddsMu < B.minimumPickOdds || pickOddsMu > B.maximumPickOdds) continue;
    const rankScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );

    const day = `${w.key}:${hk(row.commenceTime)}`;
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day).push({
      rankScore,
      pickHomeMu,
      pickOddsMu,
      modelProb,
      ev,
      margin,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      homeWon: hs > as,
      hitMu: pickHomeMu ? hs > as : as > hs,
    });
  }

  for (const [, cands] of dayMap) {
    const sorted = [...cands].sort((a, b) => b.rankScore - a.rankScore);
    const slots = applyDrop(sorted);
    slots.forEach((g, i) => {
      const lockedHit = g.hitMu;
      lockedB.push({
        rank: i + 1,
        pickOdds: g.pickOddsMu,
        hit: lockedHit,
        pickHome: g.pickHomeMu,
      });

      // 同一場：無腦高賠 / 熱門 / 主隊
      const higherIsHome = g.homeOdds >= g.awayOdds;
      const favIsHome = g.homeOdds <= g.awayOdds;
      sameSlateNaive.alwaysHigherOdds.push({
        pickOdds: higherIsHome ? g.homeOdds : g.awayOdds,
        hit: higherIsHome ? g.homeWon : !g.homeWon,
      });
      sameSlateNaive.alwaysFavorite.push({
        pickOdds: favIsHome ? g.homeOdds : g.awayOdds,
        hit: favIsHome ? g.homeWon : !g.homeWon,
      });
      sameSlateNaive.alwaysHome.push({
        pickOdds: g.homeOdds,
        hit: g.homeWon,
      });
      sameSlateNaive.alwaysMuSide.push({
        pickOdds: g.pickOddsMu,
        hit: g.hitMu,
      });
    });
  }
}

// 另：若日排改為「勝率優先」——同池按 modelProb 取 Top，不要 EV
// 重跑太貴；用 lockedB 近似不夠。改在上面同一 dayMap 存不足。
// 簡化：報告 locked vs naive on same games.

const report = {
  experimentId: 'ml-vs-naive-baselines-2026-08-07',
  note: '同一批鎖定 B 入選場次上，對照無腦策略（可比；不是全聯盟無腦高賠）',
  lockedB: summarize(lockedB),
  onSameGames: {
    alwaysHigherOdds: summarize(sameSlateNaive.alwaysHigherOdds),
    alwaysFavorite: summarize(sameSlateNaive.alwaysFavorite),
    alwaysHome: summarize(sameSlateNaive.alwaysHome),
    alwaysMuSide: summarize(sameSlateNaive.alwaysMuSide),
  },
  reading: {
    beAt207: '均賠≈2.07 → 打平約需 48.3% 勝率',
    hr55Means: '55% 只比打平多約 7pp，edge 薄；活體 43% 已低於打平',
    vsBlindDog:
      '若系統勝率≈無腦高賠，就幾乎沒有「預測力」，只是在吃高賠波動',
  },
};

const L = report.lockedB;
const D = report.onSameGames.alwaysHigherOdds;
const F = report.onSameGames.alwaysFavorite;
report.verdict = {
  betterThanBlindDog:
    L.hitRate != null && D.hitRate != null && L.hitRate > D.hitRate + 0.02,
  betterThanFavorite:
    L.hitRate != null && F.hitRate != null && L.hitRate > F.hitRate,
  plainSpeak: `鎖定B勝率 ${(L.hitRate * 100).toFixed(1)}% / 無腦高賠 ${(D.hitRate * 100).toFixed(1)}% / 無腦熱門 ${(F.hitRate * 100).toFixed(1)}% / 無腦主隊 ${(report.onSameGames.alwaysHome.hitRate * 100).toFixed(1)}%。相對打平 edge：B ${L.edgeVsBePp}pp、高賠 ${D.edgeVsBePp}pp、熱門 ${F.edgeVsBePp}pp。`,
};

fs.writeFileSync(
  new URL('../tmp-ml-vs-naive-baselines.json', import.meta.url),
  JSON.stringify(report, null, 2)
);
console.log(report.verdict.plainSpeak);
console.log(JSON.stringify(report.lockedB, null, 2));
console.log(JSON.stringify(report.onSameGames, null, 2));
