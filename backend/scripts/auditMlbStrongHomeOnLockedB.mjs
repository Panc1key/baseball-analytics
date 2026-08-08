/**
 * 强主影子 vs Locked B 独赢
 *
 * 规则：市场主胜赔率够短 + 主队先发不太崩 → strongHome
 * 影子动作：若选的是客胜且强主成立 → 不下（不翻主）
 *
 *   node scripts/auditMlbStrongHomeOnLockedB.mjs
 * 产物: tmp-strong-home-on-locked-b.json
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
  detectStrongHome,
  MLB_GAME_SHAPE_SHADOW_SPEC,
} from '../src/services/MlbGameShapeShadow.js';

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
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
    usd50: Math.round(unit * 50 * 100) / 100,
  };
}

function build(from, to, yearKey) {
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
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    pool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      year: yearKey,
      hit: pickHome === hs > as,
      pickHome,
      pickOdds,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      ev,
      margin,
      modelProb,
      bScore,
      features,
      matchup: `${row.awayTeam} @ ${row.homeTeam}`,
    });
  }
  return pool;
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

function tagStrong(picks, maxHomeOdds, maxHomeEraWorseThanAway = 0.4) {
  const spec = {
    ...MLB_GAME_SHAPE_SHADOW_SPEC,
    strongHome: {
      ...MLB_GAME_SHAPE_SHADOW_SPEC.strongHome,
      maxHomeOdds,
      maxHomeEraWorseThanAway,
    },
  };
  return picks.map((g) => {
    const sh = detectStrongHome(g.features, {
      homeOdds: g.homeOdds,
      spec,
    });
    return {
      ...g,
      strongHome: sh.matched,
      strongReason: sh.reason,
    };
  });
}

console.log('[strong-home-locked-b] build…');
const pool = WINDOWS.flatMap((w) => build(w.from, w.to, w.key));
const locked = selectB(pool);
console.log(' locked B picks', locked.length);

const base = summarize(locked);
const grid = [];
for (const maxOdds of [1.55, 1.65, 1.75, 1.85]) {
  for (const eraWorse of [0.2, 0.4, 0.6]) {
    const tagged = tagStrong(locked, maxOdds, eraWorse);
    const toxic = tagged.filter((g) => !g.pickHome && g.strongHome);
    const kept = tagged.filter((g) => !(!g.pickHome && g.strongHome));
    const k = summarize(kept);
    const t = summarize(toxic);
    grid.push({
      id: `banAway_odds${maxOdds}_eraW${eraWorse}`,
      maxHomeOdds: maxOdds,
      maxHomeEraWorseThanAway: eraWorse,
      strongHomeN: tagged.filter((g) => g.strongHome).length,
      toxicAwayN: toxic.length,
      kept: k,
      toxicAway: t,
      dHrPp:
        k.hitRate != null && base.hitRate != null
          ? Number(((k.hitRate - base.hitRate) * 100).toFixed(2))
          : null,
      dRoiPp:
        k.roi != null && base.roi != null
          ? Number(((k.roi - base.roi) * 100).toFixed(2))
          : null,
      dUsd: Number((k.usd50 - base.usd50).toFixed(2)),
      byYearDeltaUsd: Object.fromEntries(
        ['2024', '2025', '2026'].map((y) => {
          const bY = summarize(locked.filter((x) => x.year === y));
          const kY = summarize(kept.filter((x) => x.year === y));
          return [y, Number((kY.usd50 - bY.usd50).toFixed(2))];
        })
      ),
    });
  }
}

grid.sort((a, b) => (b.dUsd ?? -9999) - (a.dUsd ?? -9999));

const defaultTagged = tagStrong(
  locked,
  MLB_GAME_SHAPE_SHADOW_SPEC.strongHome.maxHomeOdds,
  MLB_GAME_SHAPE_SHADOW_SPEC.strongHome.maxHomeEraWorseThanAway
);
const defaultToxic = defaultTagged.filter((g) => !g.pickHome && g.strongHome);
const defaultKept = defaultTagged.filter((g) => !(!g.pickHome && g.strongHome));

const out = {
  experimentId: 'strong-home-on-locked-b-2026-08-08',
  plain:
    '强主=主胜赔率够短+先发不太崩；影子动作=禁「强主局还去推客胜」，不自动翻主。',
  specDefault: MLB_GAME_SHAPE_SHADOW_SPEC.strongHome,
  baselineLockedB: base,
  baselineSplit: {
    homePicks: summarize(locked.filter((g) => g.pickHome)),
    awayPicks: summarize(locked.filter((g) => !g.pickHome)),
  },
  defaultRule: {
    ...grid.find(
      (g) =>
        g.maxHomeOdds === MLB_GAME_SHAPE_SHADOW_SPEC.strongHome.maxHomeOdds &&
        g.maxHomeEraWorseThanAway ===
          MLB_GAME_SHAPE_SHADOW_SPEC.strongHome.maxHomeEraWorseThanAway
    ),
    sampleToxic: defaultToxic.slice(0, 12).map((g) => ({
      year: g.year,
      matchup: g.matchup,
      pick: 'away',
      odds: g.pickOdds,
      homeOdds: g.homeOdds,
      hit: g.hit,
      reason: g.strongReason,
    })),
  },
  topByUsd: grid.slice(0, 8),
  recommend:
    grid.find(
      (g) =>
        (g.dUsd ?? -1) > 0 &&
        (g.dHrPp ?? -1) >= 0 &&
        g.toxicAwayN >= 8 &&
        (g.byYearDeltaUsd?.['2025'] ?? -999) >= -100
    ) || grid[0],
};

fs.writeFileSync(
  new URL('../tmp-strong-home-on-locked-b.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      baseline: out.baselineLockedB,
      split: out.baselineSplit,
      defaultRule: {
        id: out.defaultRule?.id,
        toxicAwayN: out.defaultRule?.toxicAwayN,
        toxicHr: out.defaultRule?.toxicAway?.hitRate,
        dHrPp: out.defaultRule?.dHrPp,
        dRoiPp: out.defaultRule?.dRoiPp,
        dUsd: out.defaultRule?.dUsd,
        byYear: out.defaultRule?.byYearDeltaUsd,
      },
      recommend: {
        id: out.recommend?.id,
        toxicAwayN: out.recommend?.toxicAwayN,
        dHrPp: out.recommend?.dHrPp,
        dUsd: out.recommend?.dUsd,
        byYear: out.recommend?.byYearDeltaUsd,
        toxicHr: out.recommend?.toxicAway?.hitRate,
      },
    },
    null,
    2
  )
);
console.log('wrote tmp-strong-home-on-locked-b.json');
