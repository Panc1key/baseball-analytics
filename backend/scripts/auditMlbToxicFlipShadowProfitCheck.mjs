/**
 * 毒客 Rank1×EV≥10% → 改推主：歷史全帳 + 活體紙上窗對照
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
const STRONG = 0.65;
const EV_CUT = 0.1;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];
// 活體紙上大致從正式測試起
const LIVE_FROM = '2026-07-25';
const LIVE_TO = '2026-08-07';

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
function isToxic(b) {
  return (
    b.pickHome === false &&
    (b.homeWinPct ?? 0) >= STRONG &&
    b.rank === 1 &&
    b.ev >= EV_CUT
  );
}

function buildOfficial(from, to, windowKey = 'custom') {
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
      window: windowKey,
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
  return official;
}

function applyPolicies(official) {
  const toxic = official.filter(isToxic);
  const skip = official.filter((b) => !isToxic(b));
  const flip = official.map((b) => {
    if (!isToxic(b)) return b;
    return { ...b, pickHome: true, pickOdds: b.homeOdds, hit: b.homeWon, flipped: true };
  });
  return {
    toxicN: toxic.length,
    toxicAway: summarize(
      toxic.map((b) => ({ ...b, pickOdds: b.awayOdds, hit: !b.homeWon }))
    ),
    toxicFlipHome: summarize(
      toxic.map((b) => ({ ...b, pickOdds: b.homeOdds, hit: b.homeWon }))
    ),
    official: summarize(official),
    skip: summarize(skip),
    flip: summarize(flip),
    deltaSkip: summarize(skip).usd50 - summarize(official).usd50,
    deltaFlip: summarize(flip).usd50 - summarize(official).usd50,
  };
}

const histOfficial = [];
for (const w of WINDOWS) {
  histOfficial.push(...buildOfficial(w.from, w.to, w.key));
}
const hist = applyPolicies(histOfficial);

const liveOfficial = buildOfficial(LIVE_FROM, LIVE_TO, 'live_window');
const live = applyPolicies(liveOfficial);

// 真實紙上帳
const paper = db
  .prepare(
    `SELECT p.id, p.pick, p.odds_decimal, p.result, p.profit_units, p.model_prob,
            g.home_team, g.away_team, g.home_score, g.away_score, g.commence_time, g.id AS game_id
     FROM mlb_paper_bets p JOIN games g ON g.id = p.game_id
     WHERE p.result IN ('win','loss')
     ORDER BY g.commence_time`
  )
  .all();

function paperSum(rows) {
  if (!rows.length) return { bets: 0, hitRate: null, usd50: 0, roi: null };
  let hits = 0;
  let u = 0;
  for (const r of rows) {
    if (r.result === 'win') {
      hits += 1;
      u += Number(r.odds_decimal) - 1;
    } else u -= 1;
  }
  return {
    bets: rows.length,
    wins: hits,
    losses: rows.length - hits,
    hitRate: Number((hits / rows.length).toFixed(4)),
    roi: Number((u / rows.length).toFixed(4)),
    usd50: Math.round(u * 50),
  };
}

const out = {
  experimentId: 'toxic-flip-shadow-profit-check-2026-08-07',
  question: '毒客 Rank1×EV≥10% 改推主：賺還是虧？',
  historicalBacktest: {
    windows: WINDOWS,
    ...hist,
    byYear: Object.fromEntries(
      WINDOWS.map((w) => {
        const subset = histOfficial.filter((b) => b.window === w.key);
        return [w.key, applyPolicies(subset)];
      })
    ),
  },
  liveReplayWindow: {
    from: LIVE_FROM,
    to: LIVE_TO,
    note: '用同一套歷史特徵+選注回放近窗（不是 mlb_paper_bets 原文，但是同規則）',
    ...live,
  },
  actualPaperLedger: {
    all: paperSum(paper),
    note: '真實紙上結算；毒客翻主未必對得上 Rank1 定義（紙上已是最終成交單）',
  },
  verdict: null,
};

const flipUsd = hist.deltaFlip;
const skipUsd = hist.deltaSkip;
out.verdict = {
  historicalFlipProfitable: flipUsd > 0,
  historicalSkipProfitable: skipUsd > 0,
  historicalFlipDeltaUsd50: flipUsd,
  historicalSkipDeltaUsd50: skipUsd,
  liveFlipDeltaUsd50: live.deltaFlip,
  liveSkipDeltaUsd50: live.deltaSkip,
  plainSpeak:
    flipUsd > 0
      ? `歷史全帳：翻主影子相對正式多賺 $${flipUsd}（仍是回測，不是你體感的活體保證）`
      : `歷史全帳：翻主影子相對正式虧 $${Math.abs(flipUsd)}`,
  gapNote:
    '回測 55% 是長窗 PIT；活體紙上樣本 ~20 注在 43%。影子能改善帳，但不能 magically 把體感變成 55%。',
};

fs.writeFileSync(
  new URL('../tmp-toxic-flip-shadow-profit-check.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log(JSON.stringify({
  historical: {
    official: hist.official,
    skip: hist.skip,
    flip: hist.flip,
    toxicAway: hist.toxicAway,
    toxicFlipHome: hist.toxicFlipHome,
    deltaSkip: hist.deltaSkip,
    deltaFlip: hist.deltaFlip,
    toxicN: hist.toxicN,
  },
  byYear: Object.fromEntries(
    Object.entries(out.historicalBacktest.byYear).map(([y, v]) => [
      y,
      {
        official: v.official,
        flip: v.flip,
        deltaFlip: v.deltaFlip,
        deltaSkip: v.deltaSkip,
        toxicN: v.toxicN,
      },
    ])
  ),
  liveReplay: {
    official: live.official,
    skip: live.skip,
    flip: live.flip,
    toxicN: live.toxicN,
    toxicAway: live.toxicAway,
    toxicFlipHome: live.toxicFlipHome,
    deltaFlip: live.deltaFlip,
    deltaSkip: live.deltaSkip,
  },
  actualPaper: out.actualPaperLedger.all,
  verdict: out.verdict,
}, null, 2));
