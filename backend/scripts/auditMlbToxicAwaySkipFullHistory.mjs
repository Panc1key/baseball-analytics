/**
 * 全歷史鎖定 B：強主毒客 skip 大樣本（非昨日個案）
 * 產物：tmp-toxic-away-skip-full-history.json
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
    return { bets: 0, wins: 0, losses: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0 };
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
  return {
    bets: n,
    wins: hits,
    losses: n - hits,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}
function isToxic(b, hwpMin, evMin) {
  return !b.pickHome && b.homeWinPct >= hwpMin && b.ev >= evMin;
}

const model = getLatestMlbExpectedRunsValidation()?.model;
if (!model) {
  console.error('no model');
  process.exit(1);
}

const allBets = [];
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

    let pred = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    pred = applyFormalLockedBResidual(model, pred, features, { totalLine: 8.5 });
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < 1.4 || pickOdds > (B.maximumPickOdds ?? 2.5)) continue;
    const sig = buildPregameRegimeSignals(features);
    if (
      (pickHome ? sig.homeEarlyExitsLast3 : sig.awayEarlyExitsLast3) >
      (pickHome ? sig.awayEarlyExitsLast3 : sig.homeEarlyExitsLast3)
    ) {
      continue;
    }
    modelProb = applyFormalToxicAwayShrink(modelProb, pickOdds, {
      pickHome,
      homeWinPct,
    });
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue) continue;
    if (margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (pickOdds < B.minimumPickOdds || pickOdds > B.maximumPickOdds) continue;
    const rankScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    const day = `${w.key}:${hk(row.commenceTime)}`;
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day).push({
      window: w.key,
      day,
      pickHome,
      pickOdds,
      homeOdds: best.homeOdds,
      homeWinPct,
      ev,
      margin,
      modelProb,
      rankScore,
      hit: pickHome ? hs > as : as > hs,
      homeWon: hs > as,
    });
  }
  for (const [, cands] of dayMap) {
    const sorted = [...cands].sort((a, b) => b.rankScore - a.rankScore);
    applyDrop(sorted).forEach((b, i) => allBets.push({ ...b, rank: i + 1 }));
  }
}

const official = summarize(allBets);

function evalSkip(hwpMin, evMin) {
  const toxic = allBets.filter((b) => isToxic(b, hwpMin, evMin));
  const kept = allBets.filter((b) => !isToxic(b, hwpMin, evMin));
  const toxicSum = summarize(toxic);
  const keptSum = summarize(kept);
  return {
    rule: `skip away if hwp>=${hwpMin} & EV>=${evMin}`,
    toxicSlice: toxicSum,
    ledgerAfterSkip: keptSum,
    deltaHrPp:
      keptSum.hitRate != null && official.hitRate != null
        ? Number(((keptSum.hitRate - official.hitRate) * 100).toFixed(2))
        : null,
    deltaUsd: keptSum.usd50 - official.usd50,
    byYear: Object.fromEntries(
      WINDOWS.map((w) => {
        const o = summarize(allBets.filter((b) => b.window === w.key));
        const k = summarize(
          allBets.filter((b) => b.window === w.key && !isToxic(b, hwpMin, evMin))
        );
        const t = summarize(
          allBets.filter((b) => b.window === w.key && isToxic(b, hwpMin, evMin))
        );
        return [
          w.key,
          {
            official: o,
            afterSkip: k,
            toxic: t,
            deltaHrPp:
              k.hitRate != null && o.hitRate != null
                ? Number(((k.hitRate - o.hitRate) * 100).toFixed(2))
                : null,
            deltaUsd: k.usd50 - o.usd50,
          },
        ];
      })
    ),
  };
}

const rules = [
  evalSkip(0.62, 0.1),
  evalSkip(0.65, 0.1),
  evalSkip(0.62, 0.05),
  evalSkip(0.6, 0.1),
];

const report = {
  experimentId: 'toxic-away-skip-full-history-2026-08-07',
  note: '全歷史鎖定 B 日 Top（非昨日幾場）；與 replay 個案分開看',
  sample: {
    windows: WINDOWS,
    officialLedger: official,
  },
  rules,
  primary: rules[0],
  plainSpeak: (() => {
    const r = rules[0];
    return `全樣本獨贏 ${official.bets} 注、勝率 ${(official.hitRate * 100).toFixed(1)}%、$${official.usd50}。毒客切片（hwp≥0.62 EV≥10%）${r.toxicSlice.bets} 注、勝率 ${((r.toxicSlice.hitRate || 0) * 100).toFixed(1)}%、$${r.toxicSlice.usd50}。Skip 後剩餘 ${r.ledgerAfterSkip.bets} 注、勝率 ${((r.ledgerAfterSkip.hitRate || 0) * 100).toFixed(1)}%（Δ${r.deltaHrPp}pp）、$${r.ledgerAfterSkip.usd50}（Δ$${r.deltaUsd}）。昨日個案可以和這個大帳方向不一致。`;
  })(),
};

fs.writeFileSync(
  new URL('../tmp-toxic-away-skip-full-history.json', import.meta.url),
  JSON.stringify(report, null, 2)
);
console.log(report.plainSpeak);
console.log(JSON.stringify({ official, primary: rules[0] }, null, 2));
for (const r of rules) {
  console.log(
    r.rule,
    'toxic',
    r.toxicSlice,
    'kept',
    r.ledgerAfterSkip,
    'dHr',
    r.deltaHrPp,
    'dUsd',
    r.deltaUsd
  );
}
