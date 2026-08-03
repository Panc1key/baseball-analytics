/**
 * 讓分 ±1.5 三窗複驗（回補 spreads 後）。產物：tmp-runline-sat-dual-year.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import { getCachedMlbGameWeather } from '../src/services/MlbGameWeatherService.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-28' },
];

function bestRunLine15(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'spreads');
    if (!market?.outcomes?.length) continue;
    const homeMinus = market.outcomes.find(
      (o) => o.name === homeTeam && Number(o.point) === -1.5
    );
    const awayPlus = market.outcomes.find(
      (o) => o.name === awayTeam && Number(o.point) === 1.5
    );
    if (!homeMinus?.price || !awayPlus?.price) continue;
    const homeOdds = Number(homeMinus.price);
    const awayOdds = Number(awayPlus.price);
    if (homeOdds < 1.5 || awayOdds < 1.5 || homeOdds > 2.6 || awayOdds > 2.6) continue;
    const vig = 1 / homeOdds + 1 / awayOdds;
    if (!best || vig < best.vig) {
      const fair = removeVig(decimalToImpliedProb(homeOdds), decimalToImpliedProb(awayOdds));
      best = { homeOdds, awayOdds, fairHome: fair.fairA, fairAway: fair.fairB, vig };
    }
  }
  return best;
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
  return {
    bets: bets.length,
    hitRate: Number((hits / bets.length).toFixed(4)),
    roi: Number((unit / bets.length).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}

function buildYear(model, from, to, year) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam,
              g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, from, to);

  const pool = [];
  let withRl = 0;
  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const hs = Number(row.homeScore);
    const as = Number(row.awayScore);
    features.parkFactor = resolveMlbParkFactor({
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    features.weather = getCachedMlbGameWeather({
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    const rl = bestRunLine15(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (!rl) continue;
    withRl += 1;
    const pred = predictMlbGameRuns(model, features, { homeSpread: -1.5, totalLine: 8.5 });
    const margin = Number(pred.homeExpectedRuns) - Number(pred.awayExpectedRuns);
    const homeCover = Number(pred.markets?.homeSpread?.coverProbability);
    const awayCover = Number(pred.markets?.homeSpread?.lossProbability);
    if (!Number.isFinite(homeCover) || !Number.isFinite(awayCover)) continue;

    const homeEv = homeCover * (rl.homeOdds - 1) - (1 - homeCover);
    const awayEv = awayCover * (rl.awayOdds - 1) - (1 - awayCover);
    const pickHome = homeEv >= awayEv;
    const modelProb = pickHome ? homeCover : awayCover;
    const pickOdds = pickHome ? rl.homeOdds : rl.awayOdds;
    const fair = pickHome ? rl.fairHome : rl.fairAway;
    const ev = pickHome ? homeEv : awayEv;
    const edge = modelProb - fair;
    const absGap = Math.abs(margin - (pickHome ? 1.5 : -1.5));
    const meanAgrees = pickHome ? margin > 0 : margin < 0;
    const homeCovers = hs - as >= 2;
    pool.push({
      year,
      side: pickHome ? 'home-1.5' : 'away+1.5',
      absGap,
      modelProb,
      pickOdds,
      ev,
      edge,
      meanAgrees,
      hit: pickHome ? homeCovers : !homeCovers,
    });
  }
  return { pool, games: rows.length, withRl };
}

function select(pool, rule) {
  return pool.filter((g) => {
    if (rule.requireMeanAgree && !g.meanAgrees) return false;
    if (g.absGap < rule.minGap) return false;
    if (g.ev < rule.minEv) return false;
    if (g.edge < rule.minEdge) return false;
    if (g.modelProb < rule.minProb) return false;
    return true;
  });
}

const latest = getLatestMlbExpectedRunsValidation();
console.log('[runline-3y] building…');
const byYearPool = {};
const all = [];
for (const w of WINDOWS) {
  const built = buildYear(latest.model, w.from, w.to, w.key);
  byYearPool[w.key] = built;
  all.push(...built.pool);
  console.log(w.key, {
    games: built.games,
    withRunLine15: built.withRl,
    candidates: built.pool.length,
  });
}

const variants = [];
for (const requireMeanAgree of [false, true]) {
  for (const minGap of [0, 0.25, 0.5, 0.75]) {
    for (const minEv of [0.02, 0.03, 0.05, 0.08]) {
      for (const minEdge of [0.02, 0.03, 0.04, 0.05]) {
        for (const minProb of [0.5, 0.52, 0.55]) {
          const rule = { minGap, minEv, minEdge, minProb, requireMeanAgree };
          const picks = select(all, rule);
          const y = {
            2024: summarize(picks.filter((b) => b.year === '2024')),
            2025: summarize(picks.filter((b) => b.year === '2025')),
            2026: summarize(picks.filter((b) => b.year === '2026')),
            merged: summarize(picks),
          };
          if (y.merged.bets < 80) continue;
          const allPos =
            (y['2024'].roi ?? -1) > 0 &&
            (y['2025'].roi ?? -1) > 0 &&
            (y['2026'].roi ?? -1) > 0;
          const nOk = y['2024'].bets >= 80 && y['2025'].bets >= 80 && y['2026'].bets >= 40;
          variants.push({
            id: `agree${requireMeanAgree ? 1 : 0}_g${minGap}_ev${minEv}_e${minEdge}_p${minProb}`,
            rule,
            byYear: y,
            allPos,
            nOk,
            pass: allPos && nOk && (y.merged.roi ?? -1) >= 0.02,
          });
        }
      }
    }
  }
}

variants.sort((a, b) => (b.byYear.merged.usd50 || 0) - (a.byYear.merged.usd50 || 0));
const pass = variants.filter((v) => v.pass);
const preferred = pass[0] || null;

const naive = (() => {
  const picks = select(all, {
    minGap: 0,
    minEv: -99,
    minEdge: -99,
    minProb: 0.5,
    requireMeanAgree: false,
  });
  return {
    2024: summarize(picks.filter((b) => b.year === '2024')),
    2025: summarize(picks.filter((b) => b.year === '2025')),
    2026: summarize(picks.filter((b) => b.year === '2026')),
    merged: summarize(picks),
  };
})();

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'shadow_research_runline_3y',
  coverage: Object.fromEntries(
    WINDOWS.map((w) => [
      w.key,
      {
        games: byYearPool[w.key].games,
        withRunLine15: byYearPool[w.key].withRl,
      },
    ])
  ),
  naive,
  passCount: pass.length,
  preferred,
  top: variants.slice(0, 10),
  verdict: preferred
    ? {
        promoteShadow: true,
        reason: '三窗皆正且合併 ROI≥2%；可定讓分研究影子（仍不混鎖定 B／totals）。',
        rule: preferred.rule,
        paper: preferred.byYear,
      }
    : {
        promoteShadow: false,
        reason: '三窗無穩定過閘規則；讓分暫不開衛星規格。',
        bestMerged: variants[0] || null,
      },
};

fs.writeFileSync(
  new URL('../tmp-runline-sat-dual-year.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);
console.log('naive merged', naive.merged);
console.log('pass', pass.length);
if (preferred) console.log('PREFERRED', preferred.id, preferred.byYear);
else console.log('NO PASS best', variants[0]?.id, variants[0]?.byYear);
console.log('VERDICT', payload.verdict);
