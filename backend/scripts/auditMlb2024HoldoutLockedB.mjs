/**
 * 2024 holdout：鎖定 B ± 禁強主場客勝（不改常數）
 * 產物：tmp-2024-holdout-locked-b.json
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

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const FROM = '2024-03-28';
const TO = '2024-09-30';

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
  if (!bets.length) {
    return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0 };
  }
  let unit = 0;
  let odds = 0;
  let hits = 0;
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
    usd50: Math.round(unit * 50),
  };
}

function build(from, to) {
  const validation = getLatestMlbExpectedRunsValidation();
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
  const pool = [];
  let skipOdds = 0;
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
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) {
      skipOdds += 1;
      continue;
    }
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? +sig.homeEarlyExitsLast3 || 0
      : +sig.awayEarlyExitsLast3 || 0;
    const oppEarly = pickHome
      ? +sig.awayEarlyExitsLast3 || 0
      : +sig.homeEarlyExitsLast3 || 0;
    const pitchers = features?.pitchers || {};
    const homeId = pitchers.homeIdentity?.id ?? pitchers.home?.id ?? null;
    const awayId = pitchers.awayIdentity?.id ?? pitchers.away?.id ?? null;
    const hasBothPitcherIds = homeId != null && awayId != null;
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2 || pickEarly > oppEarly) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    pool.push({
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      hit: pickHome === hs > as,
      pickHome,
      pickOdds,
      ev,
      margin,
      modelProb,
      bScore,
      homeWinPct: +features?.home?.homeWinPct || null,
      hasBothPitcherIds,
    });
  }
  return { pool, skipOdds, featureRows: rows.length };
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

function selectB(pool) {
  const map = new Map();
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
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const arr = [...map.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    out.push(...applyDrop(arr));
  }
  return out;
}

console.log('Building 2024…');
const { pool, skipOdds, featureRows } = build(FROM, TO);
const withId = pool.filter((g) => g.hasBothPitcherIds);
const picksStrict = selectB(withId); // 完整鎖定 B（要雙先發 ID）
const picksDiag = selectB(pool); // 診斷：放寬 ID 閘，只驗賠率+模型路徑
const filterAway = (arr) =>
  arr.filter((g) => !(g.pickHome === false && (g.homeWinPct ?? 0) >= 0.65));
const filteredStrict = filterAway(picksStrict);
const filteredDiag = filterAway(picksDiag);
const byMonth = (arr) => {
  const m = new Map();
  for (const g of arr) {
    if (!m.has(g.month)) m.set(g.month, []);
    m.get(g.month).push(g);
  }
  return [...m.keys()].sort().map((k) => ({ month: k, ...summarize(m.get(k)) }));
};

const out = {
  experimentId: '2024-holdout-locked-b-2026-07-29',
  window: { FROM, TO },
  coverage: {
    featureRows,
    poolNoIdGate: pool.length,
    poolWithBothPitcherIds: withId.length,
    skipOddsFewBooks: skipOdds,
    note: '2024 特徵列多半缺 pitcher identity；完整鎖定 B 需雙 ID，故 strict 可能為 0',
  },
  strictLockedB_requirePitcherIds: {
    lockedB: summarize(picksStrict),
    plusNoAwayVsStrongHome65: summarize(filteredStrict),
  },
  diagnostic_relaxPitcherIdGate: {
    warning: '非正式；僅驗證 2024 賠率回補後的模型+選注路徑',
    lockedB: summarize(picksDiag),
    plusNoAwayVsStrongHome65: summarize(filteredDiag),
    deltaUsd50:
      summarize(filteredDiag).usd50 - summarize(picksDiag).usd50,
    deltaHitRatePp:
      summarize(filteredDiag).hitRate != null && summarize(picksDiag).hitRate != null
        ? Number(
            (
              (summarize(filteredDiag).hitRate - summarize(picksDiag).hitRate) *
              100
            ).toFixed(2)
          )
        : null,
  },
  monthlyDiagnosticLockedB: byMonth(picksDiag),
  referenceInSample: {
    window: '2025-04~09 + 2026-04~07',
    lockedB: { bets: 358, hitRate: 0.5642, usd50: 2682 },
    withFilter: { bets: 320, hitRate: 0.5813, usd50: 2875 },
  },
};

fs.writeFileSync(
  new URL('../tmp-2024-holdout-locked-b.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
