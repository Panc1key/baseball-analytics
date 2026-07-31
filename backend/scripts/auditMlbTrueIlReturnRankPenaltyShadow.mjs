/**
 * 真 IL 回歸旗標 × 排序輕罰影子（Grok 對齊後）
 * 產物：tmp-shadow-true-il-return-rank-penalty.json
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

function selectDays(cands, λ = 0) {
  const byDay = new Map();
  for (const c of cands) {
    const score = c.baseScore - (c.pickIsReturn ? λ : 0);
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
    const adjPred = applyFrozenResidualToPrediction(model, base, homeWinPct - 0.5, {
      totalLine: 8.5,
    });
    const ph = adjPred.homeExpectedRuns;
    const pa = adjPred.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? Number(adjPred.markets?.homeWinProbability)
      : Number(adjPred.markets?.awayWinProbability);
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
    const ret = pickHome ? pitchers.homeIlReturn : pitchers.awayIlReturn;
    pool.push({
      day: hk(row.commenceTime),
      window: w.key,
      pickOdds,
      hit: pickHome === hs > as,
      margin,
      baseScore,
      pickIsReturn: Boolean(ret?.isReturnPitcher),
    });
  }
}

const baselinePicks = selectDays(pool, 0);
const baseline = summarize(baselinePicks);
const baseY = (k) => summarize(baselinePicks.filter((b) => b.window === k));

const variants = [0, 0.05, 0.1, 0.15, 0.25].map((λ) => {
  const picks = selectDays(pool, λ);
  const merged = summarize(picks);
  const y25 = summarize(picks.filter((p) => p.window === '2025'));
  const y26 = summarize(picks.filter((p) => p.window === '2026'));
  return {
    lambda: λ,
    merged,
    triggersOnPicks: picks.filter((p) => p.pickIsReturn).length,
    delta: {
      n: merged.n - baseline.n,
      hrPp: Number((((merged.hr ?? 0) - (baseline.hr ?? 0)) * 100).toFixed(2)),
      usd50: merged.usd50 - baseline.usd50,
      y25: y25.usd50 - baseY('2025').usd50,
      y26: y26.usd50 - baseY('2026').usd50,
    },
    dualGeBase: y25.usd50 >= baseY('2025').usd50 && y26.usd50 >= baseY('2026').usd50,
  };
});

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'shadow_rank_penalty_true_il_return',
  baseline,
  baselineReturnPicks: baselinePicks.filter((b) => b.pickIsReturn).length,
  variants,
};
fs.writeFileSync(
  new URL('../tmp-shadow-true-il-return-rank-penalty.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);
console.log('baseline', baseline, 'returnPicks', payload.baselineReturnPicks);
for (const v of variants) {
  if (v.lambda === 0) continue;
  console.log(
    `λ=${v.lambda}: Δn=${v.delta.n} Δ$=${v.delta.usd50} y25=${v.delta.y25} y26=${v.delta.y26} dual=${v.dualGeBase} trig=${v.triggersOnPicks}`
  );
}
