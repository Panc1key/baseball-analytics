/**
 * opener / 臨時先發：賽前定義 + 鎖定 B 切片 + 排序輕罰影子
 * 產物：tmp-shadow-opener-spot-starter.json
 * 正式常數不改。
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
import {
  applyFrozenResidualToPrediction,
  applyFrozenToxicShrink,
} from '../src/services/MlbFrozenBShadow.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const RULES = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-28' },
];

/**
 * 賽前可觀測定義（無官方 opener 標籤時的可回放代理）
 * A sparseStart: 本季 GS∈[1,3]
 * B bulpenish: IP/GS < 4 且 GS≤10（偏牛棚體型／短先發）
 * C spotOrOpener: A ∨ B
 * D strictOpenerish: GS≤2 且 IP/GS < 4.5（更嚴）
 */
export function classifySpotStarter(season = {}) {
  const gs = Number(season.gamesStarted);
  const ip = Number(season.inningsPitched);
  const ipPerGs = Number.isFinite(gs) && gs > 0 && Number.isFinite(ip) ? ip / gs : null;
  const sparseStart = Number.isFinite(gs) && gs >= 1 && gs <= 3;
  const bullpenish =
    Number.isFinite(ipPerGs) && ipPerGs > 0 && ipPerGs < 4 && Number.isFinite(gs) && gs <= 10;
  const strictOpenerish =
    Number.isFinite(gs) &&
    gs >= 1 &&
    gs <= 2 &&
    Number.isFinite(ipPerGs) &&
    ipPerGs > 0 &&
    ipPerGs < 4.5;
  return {
    sparseStart,
    bullpenish,
    spotOrOpener: sparseStart || bullpenish,
    strictOpenerish,
    gs: Number.isFinite(gs) ? gs : null,
    ipPerGs,
  };
}

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

function summarize(bets) {
  if (!bets.length) return { n: 0, hr: null, usd50: 0 };
  let hits = 0;
  let unit = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  return {
    n: bets.length,
    hr: Number((hits / bets.length).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}

function selectDays(cands, { flagKey = null, lambda = 0 } = {}) {
  const byDay = new Map();
  for (const c of cands) {
    const penalize = flagKey ? Boolean(c.flags?.[flagKey]) : false;
    const score = c.baseScore - (penalize ? lambda : 0);
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day).push({ ...c, score });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    let slots = [...byDay.get(day)].sort((a, b) => b.score - a.score || b.margin - a.margin);
    slots = slots.slice(0, 3);
    if (slots.length >= 3 && slots[2].margin < 0.5) slots = slots.slice(0, 2);
    if (slots.length >= 2 && slots[1].pickOdds >= 1.85 && slots[1].pickOdds < 1.95) {
      slots = [slots[0], ...slots.slice(2)];
    }
    out.push(...slots);
  }
  return out;
}

console.log('[opener-shadow] building…');
const model = getLatestMlbExpectedRunsValidation().model;
const pool = [];

for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
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
    const hs = Number(row.homeScore);
    const as = Number(row.awayScore);
    if (hs === as) continue;
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

    const base = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const adj = applyFrozenResidualToPrediction(model, base, homeWinPct - 0.5, {
      totalLine: 8.5,
    });
    const ph = adj.homeExpectedRuns;
    const pa = adj.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? Number(adj.markets?.homeWinProbability)
      : Number(adj.markets?.awayWinProbability);
    if (!Number.isFinite(modelProb)) continue;
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < RULES.minimumPickOdds || pickOdds > RULES.maximumPickOdds) continue;
    modelProb = applyFrozenToxicShrink(modelProb, pickOdds, { pickHome, homeWinPct });
    const margin = Math.abs(ph - pa);
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    if (modelProb < RULES.minimumModelProbability) continue;
    if (margin < RULES.minimumExpectedRunMargin) continue;
    if (ev < RULES.minimumExpectedValue) continue;

    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? Number(sig.homeEarlyExitsLast3) || 0
      : Number(sig.awayEarlyExitsLast3) || 0;
    const oppEarly = pickHome
      ? Number(sig.awayEarlyExitsLast3) || 0
      : Number(sig.homeEarlyExitsLast3) || 0;
    const baseScore = scoreMlbMoneylineDailyRank(
      {
        expectedValue: ev,
        modelProbability: modelProb,
        pickEarlyExitsHigher: pickEarly > oppEarly,
      },
      RULES
    );

    const mineSeason = pickHome ? pitchers.home : pitchers.away;
    const flags = classifySpotStarter(mineSeason || {});

    pool.push({
      day: hk(row.commenceTime),
      window: w.key,
      pickOdds,
      hit: pickHome === hs > as,
      margin,
      baseScore,
      flags,
    });
  }
}

const baselinePicks = selectDays(pool);
const baseline = summarize(baselinePicks);
const y = (picks, k) => summarize(picks.filter((b) => b.window === k));
const baseY25 = y(baselinePicks, '2025');
const baseY26 = y(baselinePicks, '2026');

const flagKeys = ['sparseStart', 'bullpenish', 'spotOrOpener', 'strictOpenerish'];
const slices = {};
for (const key of flagKeys) {
  const on = baselinePicks.filter((b) => b.flags[key]);
  const off = baselinePicks.filter((b) => !b.flags[key]);
  slices[key] = {
    on: summarize(on),
    off: summarize(off),
    onShare: baselinePicks.length
      ? Number(((on.length / baselinePicks.length) * 100).toFixed(1))
      : 0,
  };
}

const variants = [];
for (const key of flagKeys) {
  for (const lambda of [0.05, 0.1, 0.15, 0.25]) {
    const picks = selectDays(pool, { flagKey: key, lambda });
    const merged = summarize(picks);
    const y25 = y(picks, '2025');
    const y26 = y(picks, '2026');
    variants.push({
      name: `penalize_${key}_l${lambda}`,
      flagKey: key,
      lambda,
      merged,
      triggers: picks.filter((p) => p.flags[key]).length,
      delta: {
        n: merged.n - baseline.n,
        hrPp: Number((((merged.hr ?? 0) - (baseline.hr ?? 0)) * 100).toFixed(2)),
        usd50: merged.usd50 - baseline.usd50,
        y25: y25.usd50 - baseY25.usd50,
        y26: y26.usd50 - baseY26.usd50,
      },
      dualGeBase: y25.usd50 >= baseY25.usd50 && y26.usd50 >= baseY26.usd50,
    });
  }
}

const positive = variants.filter((v) => v.delta.usd50 > 0 && v.dualGeBase);
const best = [...variants].sort((a, b) => b.delta.usd50 - a.delta.usd50)[0];

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'shadow_only',
  definitions: {
    sparseStart: 'season GS in [1,3]',
    bullpenish: 'IP/GS < 4 and GS<=10',
    spotOrOpener: 'sparseStart OR bullpenish',
    strictOpenerish: 'GS<=2 and IP/GS < 4.5',
    note: '無官方 opener 標籤；此為可回放賽前代理，供 v4.6／排序實驗',
  },
  baseline,
  byWindow: { '2025': baseY25, '2026': baseY26 },
  slicesOnBaselinePicks: slices,
  variants,
  verdict: {
    anyDualPositive: positive.length > 0,
    positive: positive.map((v) => ({ name: v.name, delta: v.delta })),
    bestMerged: best
      ? { name: best.name, delta: best.delta, dual: best.dualGeBase }
      : null,
    plain:
      positive.length === 0
        ? 'opener/臨時先發代理：排序輕罰無雙窗正向；切片若 on 勝率低於 off，更適合進 v4.6 期望得分特徵而非選場輕罰。'
        : '有雙窗正向輕罰候選，可再 WF。',
  },
};

fs.writeFileSync(
  new URL('../tmp-shadow-opener-spot-starter.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);

console.log('baseline', baseline);
console.log('slices');
for (const [k, v] of Object.entries(slices)) {
  console.log(
    `  ${k}: on n=${v.on.n} hr=${v.on.hr} $=${v.on.usd50} | off n=${v.off.n} hr=${v.off.hr} $=${v.off.usd50} share=${v.onShare}%`
  );
}
console.log('\npenalties dual+');
for (const v of variants) {
  if (!v.dualGeBase && v.delta.usd50 <= 0) continue;
  console.log(
    `${v.name}: Δ$=${v.delta.usd50} y25=${v.delta.y25} y26=${v.delta.y26} dual=${v.dualGeBase}`
  );
}
console.log('\nverdict', payload.verdict.plain);
console.log('best', payload.verdict.bestMerged);
