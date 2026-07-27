/**
 * 選注 A/B：base_p2 vs min185（正式）vs sweet_195_220（研究）
 * 窗：2025-04~09 + 2026-04~07；dailyTopK=3；均注 50/75/100 線性外推
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { config } from '../src/config.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
  MLB_MONEYLINE_RECOMMENDATION_RULES,
} from '../src/services/MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

function hkDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function bestMl(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'h2h');
    if (!market?.outcomes?.length) continue;
    const home =
      market.outcomes.find((o) => o.name === homeTeam) ||
      market.outcomes.find((o) => String(o.name).includes(String(homeTeam).split(' ').pop()));
    const away =
      market.outcomes.find((o) => o.name === awayTeam) ||
      market.outcomes.find((o) => String(o.name).includes(String(awayTeam).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const vig = 1 / home.price + 1 / away.price;
    if (!best || vig < best.vig) best = { homeOdds: Number(home.price), awayOdds: Number(away.price) };
  }
  return best;
}

function summarize(bets) {
  if (!bets.length) return null;
  let unit = 0;
  let oddsSum = 0;
  let hits = 0;
  for (const b of bets) {
    oddsSum += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  const avg = oddsSum / n;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number(avg.toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    unitPnl: Number(unit.toFixed(2)),
    usd50: Math.round(unit * 50),
    usd75: Math.round(unit * 75),
    usd100: Math.round(unit * 100),
    usdPaperStake: Math.round(unit * (config.mlbPaperFlatStakeUsd || 75)),
  };
}

function passesRules(g, rules) {
  if (g.ev < rules.minimumExpectedValue) return false;
  if (g.margin < rules.minimumExpectedRunMargin) return false;
  if (g.modelProb < rules.minimumModelProbability) return false;
  if (rules.minimumPickOdds != null && g.pickOdds < rules.minimumPickOdds) return false;
  if (rules.maximumPickOdds != null && g.pickOdds > rules.maximumPickOdds) return false;
  if (rules.requirePickEarlyExitsNotHigher && g.pickEarly > g.oppEarly) return false;
  return true;
}

function select(pool, rules) {
  const byDay = new Map();
  for (const g of pool) {
    if (!passesRules(g, rules)) continue;
    const score = scoreMlbMoneylineDailyRank(
      { expectedValue: g.ev, modelProbability: g.modelProb },
      rules
    );
    const row = { ...g, score };
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(row);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    out.push(
      ...[...byDay.get(day)]
        .sort((a, b) => b.score - a.score || b.margin - a.margin)
        .slice(0, rules.dailyTopK)
    );
  }
  return out;
}

const validation = getLatestMlbExpectedRunsValidation();
const rows = db
  .prepare(
    `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
            g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
     FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
     WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
       AND ((date(f.commence_time) >= date('2025-04-01') AND date(f.commence_time) <= date('2025-09-30'))
         OR (date(f.commence_time) >= date('2026-04-01') AND date(f.commence_time) <= date('2026-07-22')))
     ORDER BY f.commence_time`
  )
  .all(MLB_BASELINE_FEATURE_VERSION);

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
  const ml = bestMl(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
  if (!ml) continue;
  const pickOdds = pickHome ? ml.homeOdds : ml.awayOdds;
  const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
  const margin = Math.abs(ph - pa);
  const signals = buildPregameRegimeSignals(features);
  const pickEarly = pickHome
    ? Number(signals.homeEarlyExitsLast3) || 0
    : Number(signals.awayEarlyExitsLast3) || 0;
  const oppEarly = pickHome
    ? Number(signals.awayEarlyExitsLast3) || 0
    : Number(signals.homeEarlyExitsLast3) || 0;
  pool.push({
    day: hkDate(row.commenceTime),
    window: row.commenceTime >= '2026-01-01' ? '2026' : '2025',
    hit: pickHome === hs > as,
    pickOdds,
    modelProb,
    ev,
    margin,
    pickEarly,
    oppEarly,
  });
}

const profiles = ['base_p2', 'min185', 'sweet_195_220'];
const byProfile = {};
for (const id of profiles) {
  const rules = MLB_MONEYLINE_RULE_PROFILES[id];
  const all = select(pool, rules);
  byProfile[id] = {
    id,
    label: rules.label,
    isFormal: id === MLB_MONEYLINE_RECOMMENDATION_RULES.id,
    combined: summarize(all),
    y2025: summarize(all.filter((b) => b.window === '2025')),
    y2026: summarize(all.filter((b) => b.window === '2026')),
  };
}

const base = byProfile.base_p2.combined;
const formal = byProfile.min185.combined;
const out = {
  formalProfile: MLB_MONEYLINE_RECOMMENDATION_RULES.id,
  mlbPaperFlatStakeUsd: config.mlbPaperFlatStakeUsd,
  note: '總盈虧為約 9.7 個月合併窗，不是單月；usdPaperStake 用 config.mlbPaperFlatStakeUsd',
  liftFormalVsBase: {
    deltaBets: formal.bets - base.bets,
    deltaHitRate: Number((formal.hitRate - base.hitRate).toFixed(4)),
    deltaRoi: Number((formal.roi - base.roi).toFixed(4)),
    deltaUsd50: formal.usd50 - base.usd50,
    deltaUsd75: formal.usd75 - base.usd75,
    deltaUsd100: formal.usd100 - base.usd100,
    deltaPaperStake: formal.usdPaperStake - base.usdPaperStake,
  },
  byProfile,
  verdict:
    formal.usd50 > base.usd50
      ? 'min185_increases_total_pnl_vs_base'
      : 'min185_does_not_increase_total_pnl',
};

fs.writeFileSync(
  new URL('../tmp-mlb-minodds-ab.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
