/**
 * 新底座上：審計腳本曾用 pickOdds≤2.3 硬截，但 ev02_max230 上限是 2.5。
 * 比較 poolCap 2.3 vs 2.5，並單獨看 (2.3, 2.5] 尾段是否過閘。
 *   node scripts/auditMlbStackOddsUpperTail.mjs
 * 產物: tmp-stack-odds-upper-tail.json
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
import { resolveMlbGameType } from '../src/services/MlbLayeredArchitecture.js';
import { MLB_NORMAL_AWAY_MARKET_SHRINK_SPEC } from '../src/services/MlbNormalAwayMarketShrinkShadow.js';
import { MLB_TYPE_AWARE_RANK_SPEC } from '../src/services/MlbTypeAwareRankShadow.js';

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const W_MU = MLB_NORMAL_AWAY_MARKET_SHRINK_SPEC.shrinkWeight || 0.35;
const PEN = MLB_TYPE_AWARE_RANK_SPEC.normalAwayPenalty || 0.01;
const BOOST = MLB_TYPE_AWARE_RANK_SPEC.strongHomeAwayBoost || 0.02;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-08-07' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function books(g, c, h, a) {
  const pit = resolvePitOdds(g, c);
  if (!pit?.bookmakers?.length) return { books: [], totalsLine: null, homeOdds: null };
  const out = [];
  let bestTotals = null;
  let homeOdds = null;
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (m?.outcomes?.length) {
      const home =
        m.outcomes.find((o) => o.name === h) ||
        m.outcomes.find((o) => String(o.name).includes(String(h).split(' ').pop()));
      const away =
        m.outcomes.find((o) => o.name === a) ||
        m.outcomes.find((o) => String(o.name).includes(String(a).split(' ').pop()));
      if (home?.price && away?.price) {
        const ho = +home.price;
        const ao = +away.price;
        if (Number.isFinite(ho) && Number.isFinite(ao)) {
          out.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao });
          if (homeOdds == null || ho < homeOdds) homeOdds = ho;
        }
      }
    }
    const tot = book.markets?.find((x) => x.key === 'totals');
    if (!tot) continue;
    for (const over of tot.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = tot.outcomes.find(
        (o) => o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!over.price || !under?.price) continue;
      const oo = +over.price;
      const uo = +under.price;
      if (!Number.isFinite(oo) || !Number.isFinite(uo)) continue;
      const vig = 1 / oo + 1 / uo;
      if (!bestTotals || vig < bestTotals.vig) bestTotals = { line: Number(over.point), vig };
    }
  }
  return { books: out, totalsLine: bestTotals?.line ?? null, homeOdds };
}
function summarize(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, roi: null, usd50: 0 };
  let unit = 0;
  let hits = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * 50 * 100) / 100,
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
function selectEligible(pool, maxOdds = B.maximumPickOdds) {
  return pool.filter(
    (g) =>
      g.ev >= B.minimumExpectedValue &&
      g.margin >= B.minimumExpectedRunMargin &&
      g.modelProb >= B.minimumModelProbability &&
      g.pickOdds >= B.minimumPickOdds &&
      g.pickOdds <= maxOdds
  );
}
function stackScore(g) {
  let s = g.bScore;
  if (g.type === 'normal' && !g.pickHome) s -= PEN;
  if (g.type === 'strong_home' && !g.pickHome) s += BOOST;
  return s;
}
function selectDaily(eligible) {
  const map = new Map();
  for (const g of eligible) {
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const arr = [...map.get(day)].sort(
      (a, b) => stackScore(b) - stackScore(a) || b.margin - a.margin
    );
    out.push(...applyDrop(arr));
  }
  return out;
}
function yearOk(y) {
  return (
    (y?.['2024'] ?? -999) >= -80 &&
    (y?.['2025'] ?? -999) >= -80 &&
    (y?.['2026'] ?? -999) >= -80
  );
}

console.log('[odds-upper-tail] build…');
const validation = getLatestMlbExpectedRunsValidation();
const pool = [];
for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL
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
    const hs = +row.homeScore;
    const as = +row.awayScore;
    if (hs === as) continue;
    const pred = predictMlbGameRuns(validation.model, features, { totalLine: 8.5 });
    const ph = +pred.homeExpectedRuns;
    const pa = +pred.awayExpectedRuns;
    if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;
    const pickHome = ph >= pa;
    let p = pickHome
      ? +pred.markets?.homeWinProbability
      : +pred.markets?.awayWinProbability;
    if (!Number.isFinite(p)) continue;
    const pack = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (pack.books.length < 2) continue;
    pack.books.sort((a, b) => a.vig - b.vig);
    const best = pack.books[0];
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    // 放寬到 profile 上限，不再在 2.3 硬截
    if (pickOdds < 1.4 || pickOdds > 2.5) continue;
    const margin = Math.abs(ph - pa);
    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? +sig.homeEarlyExitsLast3 || 0
      : +sig.awayEarlyExitsLast3 || 0;
    const oppEarly = pickHome
      ? +sig.awayEarlyExitsLast3 || 0
      : +sig.homeEarlyExitsLast3 || 0;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2 || pickEarly > oppEarly) continue;
    const formal = resolveMlbGameType({
      features,
      totalsLine: pack.totalsLine,
      homeOdds: pack.homeOdds,
    });
    if (formal.type === 'normal' && !pickHome) {
      p = (1 - W_MU) * p + W_MU * (1 / pickOdds);
    }
    const ev = p * (pickOdds - 1) - (1 - p);
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: p },
      B
    );
    pool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      year: w.key,
      hit: pickHome === hs > as,
      pickHome,
      pickOdds,
      ev,
      margin,
      modelProb: p,
      bScore,
      type: formal.type,
      inTail: pickOdds > 2.3 && pickOdds <= 2.5,
    });
  }
}

const baseElig = selectEligible(pool, 2.3);
const basePicks = selectDaily(baseElig);
const baseline = summarize(basePicks);

const fullElig = selectEligible(pool, 2.5);
const fullPicks = selectDaily(fullElig);
const full = summarize(fullPicks);

const tailCand = pool.filter((g) => g.inTail);
const tailElig = selectEligible(tailCand, 2.5);
const tailOnly = summarize(selectDaily(tailElig));

const byYear = Object.fromEntries(
  ['2024', '2025', '2026'].map((y) => {
    const bY = summarize(basePicks.filter((x) => x.year === y));
    const kY = summarize(fullPicks.filter((x) => x.year === y));
    return [y, Number((kY.usd50 - bY.usd50).toFixed(2))];
  })
);
const dUsd = Number((full.usd50 - baseline.usd50).toFixed(2));
const dHrPp =
  full.hitRate != null && baseline.hitRate != null
    ? Number(((full.hitRate - baseline.hitRate) * 100).toFixed(2))
    : null;

const out = {
  experimentId: 'stack-odds-upper-tail-2026-08-08',
  note: '比較審計硬截 2.3 vs 正式上限 2.5（μ+price+minEv0.015）',
  pool: {
    n: pool.length,
    tailN: tailCand.length,
    tailEligN: tailElig.length,
  },
  baselineCap23: baseline,
  fullCap25: full,
  delta: {
    dUsd,
    dHrPp,
    byYear,
    nReplaced: basePicks.filter(
      (b) => !fullPicks.some((p) => p.gameId === b.gameId && p.pickHome === b.pickHome)
    ).length,
    gate: dUsd >= 50 && (dHrPp ?? -1) >= -0.2 && yearOk(byYear),
  },
  tailOnlyAsIfSelected: tailOnly,
  verdict:
    dUsd >= 50 && (dHrPp ?? -1) >= -0.2 && yearOk(byYear)
      ? 'TAIL_25_MAY_HELP_AUDITS'
      : dUsd > 0 && yearOk(byYear)
        ? 'TAIL_SMALL_POSITIVE'
        : 'TAIL_NO_PROMOTE',
};
fs.writeFileSync(
  new URL('../tmp-stack-odds-upper-tail.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
