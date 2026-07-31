/**
 * TopK 3/4/5 × 單場+$同日串 組合影子
 * 口徑：單場 @$50 + 同日 Top1×Top2 @$10（可選再加 3 串 @$10）
 * 產物：tmp-topk-parlay-package.json
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
const DROP_R3_T = Number(B.dropThirdIfMarginBelow) || 0.5;
const DROP_R2_MAX = Number(B.dropSecondIfOddsBelow) || 1.95;
const DROP_R2_MIN = Number(B.dropSecondIfOddsMin) || 1.85;

const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-28' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function books(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return [];
  const out = [];
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const home =
      m.outcomes.find((o) => o.name === homeTeam) ||
      m.outcomes.find((o) => String(o.name).includes(String(homeTeam).split(' ').pop()));
    const away =
      m.outcomes.find((o) => o.name === awayTeam) ||
      m.outcomes.find((o) => String(o.name).includes(String(awayTeam).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const ho = Number(home.price);
    const ao = Number(away.price);
    if (!Number.isFinite(ho) || !Number.isFinite(ao)) continue;
    out.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao });
  }
  return out;
}

function build(from, to) {
  const validation = getLatestMlbExpectedRunsValidation();
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ?
         AND g.completed = 1
         AND g.home_score IS NOT NULL
         AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?)
         AND date(f.commence_time) <= date(?)
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
    const hs = Number(row.homeScore);
    const as = Number(row.awayScore);
    if (hs === as) continue;

    const pred = predictMlbGameRuns(validation.model, features, { totalLine: 8.5 });
    const ph = Number(pred.homeExpectedRuns);
    const pa = Number(pred.awayExpectedRuns);
    if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;
    const pickHome = ph >= pa;
    const modelProb = pickHome
      ? Number(pred.markets?.homeWinProbability)
      : Number(pred.markets?.awayWinProbability);
    if (!Number.isFinite(modelProb)) continue;

    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) continue;

    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (
      !Number.isFinite(pickOdds) ||
      pickOdds < B.minimumPickOdds ||
      pickOdds > B.maximumPickOdds
    ) {
      continue;
    }

    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (
      ev < B.minimumExpectedValue ||
      margin < B.minimumExpectedRunMargin ||
      modelProb < B.minimumModelProbability
    ) {
      continue;
    }

    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }

    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? Number(sig.homeEarlyExitsLast3) || 0
      : Number(sig.awayEarlyExitsLast3) || 0;
    const oppEarly = pickHome
      ? Number(sig.awayEarlyExitsLast3) || 0
      : Number(sig.homeEarlyExitsLast3) || 0;
    const pickEarlyExitsHigher = pickEarly > oppEarly;
    if (B.requirePickEarlyExitsNotHigher && pickEarlyExitsHigher) continue;

    const score = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb, pickEarlyExitsHigher },
      B
    );

    pool.push({
      day: hk(row.commenceTime),
      window: from.startsWith('2025') ? '2025' : '2026',
      hit: pickHome === hs > as,
      pickOdds,
      margin,
      score,
    });
  }
  return pool;
}

function selectDays(pool, topK) {
  const byDay = new Map();
  for (const g of pool) {
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const days = [];
  for (const day of [...byDay.keys()].sort()) {
    let slots = [...byDay.get(day)]
      .sort((a, b) => b.score - a.score || b.margin - a.margin)
      .slice(0, topK);
    if (slots.length >= 3 && slots[2].margin < DROP_R3_T) {
      slots = [...slots.slice(0, 2), ...slots.slice(3)];
    }
    if (
      slots.length >= 2 &&
      slots[1].pickOdds >= DROP_R2_MIN &&
      slots[1].pickOdds < DROP_R2_MAX
    ) {
      slots = [slots[0], ...slots.slice(2)];
    }
    if (!slots.length) continue;
    days.push({ day, window: slots[0].window, legs: slots });
  }
  return days;
}

function sumSingles(days) {
  let n = 0;
  let hits = 0;
  let unit = 0;
  for (const d of days) {
    for (const b of d.legs) {
      n += 1;
      if (b.hit) {
        hits += 1;
        unit += b.pickOdds - 1;
      } else unit -= 1;
    }
  }
  return {
    n,
    hr: n ? Number((hits / n).toFixed(4)) : null,
    unit: Number(unit.toFixed(2)),
    usd50: Math.round(unit * 50),
  };
}

function sumParlay(days, nLegs) {
  let n = 0;
  let hits = 0;
  let unit = 0;
  let oddsSum = 0;
  for (const d of days) {
    if (d.legs.length < nLegs) continue;
    const L = d.legs.slice(0, nLegs);
    const o = L.reduce((a, x) => a * x.pickOdds, 1);
    const hit = L.every((x) => x.hit);
    n += 1;
    oddsSum += o;
    if (hit) {
      hits += 1;
      unit += o - 1;
    } else unit -= 1;
  }
  return {
    n,
    hr: n ? Number((hits / n).toFixed(4)) : null,
    avgOdds: n ? Number((oddsSum / n).toFixed(2)) : null,
    unit: Number(unit.toFixed(2)),
    usd10: Math.round(unit * 10),
    usd25: Math.round(unit * 25),
  };
}

function packageFor(days) {
  const singles = sumSingles(days);
  const p2 = sumParlay(days, 2);
  const p3 = sumParlay(days, 3);
  return {
    singles,
    p2,
    p3,
    pkg: {
      singles50_plus_2leg10: singles.usd50 + p2.usd10,
      singles50_plus_2leg10_plus_3leg10: singles.usd50 + p2.usd10 + p3.usd10,
    },
  };
}

console.log('[topk-parlay] building…');
const pools = {};
for (const w of WINDOWS) {
  pools[w.key] = build(w.from, w.to);
  console.log(`  ${w.key}: ${pools[w.key].length}`);
}
const combined = [...pools['2025'], ...pools['2026']];

const variants = {};
for (const topK of [3, 4, 5]) {
  const days = selectDays(combined, topK);
  const merged = packageFor(days);
  const byWindow = {};
  for (const w of ['2025', '2026']) {
    byWindow[w] = packageFor(days.filter((d) => d.window === w));
  }
  variants[`topk_${topK}`] = { topK, merged, byWindow };
}

const base = variants.topk_3.merged;
const report = Object.fromEntries(
  Object.entries(variants).map(([id, v]) => {
    const m = v.merged;
    return [
      id,
      {
        ...v,
        deltaVsTop3: {
          singles50: m.singles.usd50 - base.singles.usd50,
          p2_usd10: m.p2.usd10 - base.p2.usd10,
          p3_usd10: m.p3.usd10 - base.p3.usd10,
          pkg_s50_p2_10: m.pkg.singles50_plus_2leg10 - base.pkg.singles50_plus_2leg10,
          pkg_full: m.pkg.singles50_plus_2leg10_plus_3leg10 - base.pkg.singles50_plus_2leg10_plus_3leg10,
          y25_pkg: v.byWindow['2025'].pkg.singles50_plus_2leg10 - variants.topk_3.byWindow['2025'].pkg.singles50_plus_2leg10,
          y26_pkg: v.byWindow['2026'].pkg.singles50_plus_2leg10 - variants.topk_3.byWindow['2026'].pkg.singles50_plus_2leg10,
        },
      },
    ];
  })
);

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'shadow_only',
  baselineProfile: 'ev02_max230 + earlySoft0.20',
  stakeNote: '單場@$50 + 同日Top1×Top2@$10（可選+3串@$10）；串賠=十進制相乘理想值',
  variants: report,
};

fs.writeFileSync(
  new URL('../tmp-topk-parlay-package.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);

for (const [id, v] of Object.entries(report)) {
  const m = v.merged;
  const d = v.deltaVsTop3;
  console.log(
    `${id}: s50=${m.singles.usd50} p2=${m.p2.n}@${m.p2.hr}->$${m.p2.usd10} p3=${m.p3.n}@${m.p3.hr}->$${m.p3.usd10} PKG=${m.pkg.singles50_plus_2leg10} Δ=${d.pkg_s50_p2_10} y25Δ=${d.y25_pkg} y26Δ=${d.y26_pkg} full=${m.pkg.singles50_plus_2leg10_plus_3leg10}`
  );
}
