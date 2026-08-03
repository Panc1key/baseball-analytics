/**
 * MLB 讓分 ±1.5 影子 MVP（v2）：兩邊算 EV，取較優邊再過閘。
 * 僅 2026 spreads PIT。產物：tmp-runline-sat-mvp.json
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

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function ym(iso) {
  return hk(iso).slice(0, 7);
}

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

function buildPool(model) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam,
              g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date('2026-04-01')
         AND date(f.commence_time) <= date('2026-07-28')
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
    // 結構同向：選主 -1.5 時 margin 應 >0；選客 +1.5 時 margin 應 <0（弱約束可關）
    const meanAgrees = pickHome ? margin > 0 : margin < 0;
    const homeCovers = hs - as >= 2;
    const hit = pickHome ? homeCovers : !homeCovers;

    pool.push({
      day: hk(row.commenceTime),
      month: ym(row.commenceTime),
      side: pickHome ? 'home-1.5' : 'away+1.5',
      absGap,
      modelProb,
      pickOdds,
      ev,
      edge,
      meanAgrees,
      margin,
      hit,
      score: ev,
    });
  }
  return pool;
}

function select(pool, { minGap, minEv, minEdge, minProb, requireMeanAgree }) {
  return pool.filter((g) => {
    if (requireMeanAgree && !g.meanAgrees) return false;
    if (g.absGap < minGap) return false;
    if (g.ev < minEv) return false;
    if (g.edge < minEdge) return false;
    if (g.modelProb < minProb) return false;
    return true;
  });
}

const latest = getLatestMlbExpectedRunsValidation();
console.log('[runline-v2] building…');
const pool = buildPool(latest.model);
console.log('pool', pool.length);

const train = pool.filter((g) => g.month === '2026-04' || g.month === '2026-05');
const test = pool.filter((g) => g.month === '2026-06' || g.month === '2026-07');

const variants = [];
for (const requireMeanAgree of [false, true]) {
  for (const minGap of [0, 0.25, 0.5, 0.75]) {
    for (const minEv of [0.02, 0.03, 0.05, 0.08]) {
      for (const minEdge of [0.02, 0.03, 0.04, 0.05]) {
        for (const minProb of [0.5, 0.52, 0.55]) {
          const rule = { minGap, minEv, minEdge, minProb, requireMeanAgree };
          const tr = summarize(select(train, rule));
          const te = summarize(select(test, rule));
          const all = summarize(select(pool, rule));
          if (all.bets < 30) continue;
          const pass =
            tr.bets >= 30 &&
            te.bets >= 25 &&
            (tr.roi ?? -1) > 0 &&
            (te.roi ?? -1) > 0 &&
            (te.roi ?? -1) >= 0.02;
          variants.push({
            id: `agree${requireMeanAgree ? 1 : 0}_g${minGap}_ev${minEv}_e${minEdge}_p${minProb}`,
            rule,
            train: tr,
            test: te,
            all2026: all,
            pass,
          });
        }
      }
    }
  }
}
variants.sort((a, b) => (b.test.usd50 || 0) - (a.test.usd50 || 0));
const pass = variants.filter((v) => v.pass);
const preferred = pass.sort(
  (a, b) =>
    (b.test.roi ?? -1) + (b.train.roi ?? -1) - ((a.test.roi ?? -1) + (a.train.roi ?? -1)) ||
    (b.all2026.usd50 || 0) - (a.all2026.usd50 || 0)
)[0];

const naive = summarize(
  select(pool, {
    minGap: 0,
    minEv: -99,
    minEdge: -99,
    minProb: 0.5,
    requireMeanAgree: false,
  })
);

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'shadow_research_runline_v2',
  dataNote: '僅 2026；定邊=兩邊 EV 較優。24/25 需回補 spreads。',
  universe: pool.length,
  naiveEveryGameBestEv: naive,
  holdoutPassCount: pass.length,
  preferred,
  top: variants.slice(0, 12),
  verdict: preferred
    ? {
        promoteShadow: true,
        next: 'backfill_2024_2025_spreads_then_three_window',
        rule: preferred.rule,
        paper: { train: preferred.train, test: preferred.test, all2026: preferred.all2026 },
      }
    : {
        promoteShadow: false,
        reason: '2026 holdout 無穩定過閘；可回補 24/25 後再掃，或暫緩讓分。',
        bestTest: variants[0] || null,
      },
};

fs.writeFileSync(
  new URL('../tmp-runline-sat-mvp.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);
console.log('naive', naive);
console.log('pass', pass.length);
if (preferred) console.log('PREFERRED', preferred.id, preferred.train, preferred.test, preferred.all2026);
else console.log('NO PASS best', variants[0]?.id, variants[0]?.train, variants[0]?.test);
