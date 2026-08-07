/**
 * 獨贏偏差 +「低賠強主」勝率診斷
 * 產物：tmp-ml-bias-strong-home-odds.json
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
  MLB_FROZEN_B_SHADOW_SPEC,
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
function summarize(bets) {
  if (!bets.length) {
    return {
      bets: 0,
      hitRate: null,
      avgOdds: null,
      beHr: null,
      roi: null,
      usd50: 0,
      edgeVsBePp: null,
    };
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
  const beHr = 1 / avgOdds;
  const hitRate = hits / n;
  return {
    bets: n,
    hitRate: Number(hitRate.toFixed(4)),
    avgOdds: Number(avgOdds.toFixed(3)),
    beHr: Number(beHr.toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * 50),
    edgeVsBePp: Number(((hitRate - beHr) * 100).toFixed(2)),
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

const model = getLatestMlbExpectedRunsValidation()?.model;
if (!model) {
  console.error('no model');
  process.exit(1);
}

const allBets = [];
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
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    const day = hk(row.commenceTime);
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day).push({
      window: w.key,
      day,
      pickHome,
      pickOdds,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      homeWinPct,
      ev,
      margin,
      modelProb,
      muHome: ph,
      muAway: pa,
      hit: pickHome ? hs > as : as > hs,
      homeWon: hs > as,
      rankScore: bScore,
      strongHome: homeWinPct >= 0.62,
      lowOdds: pickOdds < 1.85,
    });
  }

  for (const [, cands] of dayMap) {
    const sorted = [...cands].sort((a, b) => b.rankScore - a.rankScore);
    const slots = applyDrop(sorted);
    slots.forEach((b, i) => {
      allBets.push({ ...b, rank: i + 1 });
    });
  }
}

function band(odds) {
  if (odds < 1.7) return '1.40-1.70';
  if (odds < 1.85) return '1.70-1.85';
  if (odds < 2.0) return '1.85-2.00';
  if (odds < 2.15) return '2.00-2.15';
  return '2.15-2.30';
}

const bySide = {
  home: summarize(allBets.filter((b) => b.pickHome)),
  away: summarize(allBets.filter((b) => !b.pickHome)),
};
const byOddsBand = {};
for (const b of allBets) {
  const k = band(b.pickOdds);
  if (!byOddsBand[k]) byOddsBand[k] = [];
  byOddsBand[k].push(b);
}
const oddsBands = Object.fromEntries(
  Object.entries(byOddsBand).map(([k, v]) => [k, summarize(v)])
);

const strongHomePicks = allBets.filter((b) => b.pickHome && b.homeWinPct >= 0.62);
const strongHomeLowOdds = strongHomePicks.filter((b) => b.pickOdds < 1.85);
const strongHomeAllOdds = summarize(strongHomePicks);
const strongHomeLow = summarize(strongHomeLowOdds);

// 模擬：官方池 vs 把「毒客」改成加入低賠強主（flip）vs skip
const toxic = allBets.filter(
  (b) => !b.pickHome && b.homeWinPct >= 0.62 && b.ev >= 0.1
);
const official = summarize(allBets);
const skipToxic = summarize(
  allBets.filter((b) => !(!b.pickHome && b.homeWinPct >= 0.62 && b.ev >= 0.1))
);
const flipToxic = allBets.map((b) => {
  if (!b.pickHome && b.homeWinPct >= 0.62 && b.ev >= 0.1) {
    return {
      ...b,
      pickHome: true,
      pickOdds: b.homeOdds,
      hit: b.homeWon,
      lowOdds: b.homeOdds < 1.85,
    };
  }
  return b;
});
const flipSum = summarize(flipToxic);
const flipAddedHomes = summarize(
  flipToxic.filter((b, i) => {
    const o = allBets[i];
    return !o.pickHome && o.homeWinPct >= 0.62 && o.ev >= 0.1;
  })
);

// 偏差來源：μ 方向 vs 市場 vs 實際
const awayPicks = allBets.filter((b) => !b.pickHome);
const muSaysAwayButHomeWins = awayPicks.filter((b) => b.homeWon);
const strongAwayPicks = awayPicks.filter((b) => b.homeWinPct >= 0.62);

const live = db
  .prepare(
    `SELECT b.pick, b.odds_decimal, b.result, b.profit_units, g.home_team, g.away_team, g.home_score, g.away_score
     FROM mlb_paper_bets b JOIN games g ON g.id = b.game_id
     WHERE b.market = 'h2h' AND b.result IN ('win','loss')`
  )
  .all();
const liveSum = (() => {
  const bets = live.map((r) => ({
    hit: r.result === 'win',
    pickOdds: Number(r.odds_decimal),
  }));
  return summarize(bets);
})();

const report = {
  experimentId: 'ml-bias-strong-home-odds-2026-08-07',
  lockedBLedger: {
    overall: official,
    bySide,
    oddsBands,
    strongHomePicksNatural: {
      all: strongHomeAllOdds,
      lowOddsBelow185: strongHomeLow,
      note: '系統自然選到的強主（非 flip 硬加）',
    },
  },
  toxicSlice: {
    n: toxic.length,
    asAway: summarize(toxic),
    ifFlipToHome: flipAddedHomes,
    note: '毒客：客選+hwp≥0.62+EV≥10%',
  },
  policyCompare: {
    official,
    skipToxicAway: skipToxic,
    flipToStrongHome: flipSum,
    deltaHrSkip: skipToxic.hitRate != null && official.hitRate != null
      ? Number(((skipToxic.hitRate - official.hitRate) * 100).toFixed(2))
      : null,
    deltaHrFlip: flipSum.hitRate != null && official.hitRate != null
      ? Number(((flipSum.hitRate - official.hitRate) * 100).toFixed(2))
      : null,
    whyFlipHrCanFeelWorse:
      '翻主後均賠下降 → 打平所需勝率(beHr)上升；若勝率沒跟上，ROI/體感會變差，即使命中數差不多。',
  },
  biasDecomposition: {
    awayShare: Number((awayPicks.length / allBets.length).toFixed(3)),
    awayHitRate: summarize(awayPicks).hitRate,
    awayBeHr: summarize(awayPicks).beHr,
    homeHitRate: bySide.home.hitRate,
    homeBeHr: bySide.home.beHr,
    strongHomeAwayPicks: summarize(strongAwayPicks),
    awayPicksWhereHomeActuallyWon: {
      n: muSaysAwayButHomeWins.length,
      shareOfAway: awayPicks.length
        ? Number((muSaysAwayButHomeWins.length / awayPicks.length).toFixed(3))
        : null,
    },
    structural:
      '選注偏愛高 EV → 多落在客隊高賠；μ 不含 homeWinPct；低賠強主自然進池少，硬加進來要打更高勝率才打平。',
  },
  livePaper: liveSum,
  answers: {
    whyBiasLarge: [
      '日推獨贏以客隊高賠為主（高 EV），均賠約 2.0+，打平約需 48–50% 勝率',
      '強主場 μ 仍可能推客，homeWinPct 不在得分特徵裡',
      '活體樣本短 + 毒客切片拖累，體感偏差遠大於長窗回測',
    ],
    whyAddLowOddsStrongHomeCanLowerFeltWinrate: [
      '低賠強主打平勝率更高（賠 1.70 約需 59%；賠 2.05 約需 49%）',
      '若 flip 只把「最毒的客」換成主，整帳勝率可能微升，但 2026 小窗曾降',
      'skip（不下）比 flip（加入低賠強主）更穩：不稀釋、不要求更高打平勝率',
    ],
  },
};

fs.writeFileSync(
  new URL('../tmp-ml-bias-strong-home-odds.json', import.meta.url),
  JSON.stringify(report, null, 2)
);
console.log(JSON.stringify(report.lockedBLedger, null, 2));
console.log(JSON.stringify(report.toxicSlice, null, 2));
console.log(JSON.stringify(report.policyCompare, null, 2));
console.log(JSON.stringify(report.biasDecomposition, null, 2));
console.log('live', liveSum);
