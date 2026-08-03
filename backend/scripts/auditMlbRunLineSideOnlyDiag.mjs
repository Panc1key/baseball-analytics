/**
 * 讓分卡關後續：只押 home-1.5 / 只押 away+1.5 三窗診斷（不改主規格）。
 * 產物：tmp-runline-side-only-diag.json
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

function buildAll(model) {
  const all = [];
  for (const w of WINDOWS) {
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
      const pred = predictMlbGameRuns(model, features, { homeSpread: -1.5 });
      const margin = Number(pred.homeExpectedRuns) - Number(pred.awayExpectedRuns);
      const homeCover = Number(pred.markets?.homeSpread?.coverProbability);
      const awayCover = Number(pred.markets?.homeSpread?.lossProbability);
      if (!Number.isFinite(homeCover) || !Number.isFinite(awayCover)) continue;
      const homeCovers = hs - as >= 2;

      const candidates = [
        {
          year: w.key,
          side: 'home-1.5',
          modelProb: homeCover,
          pickOdds: rl.homeOdds,
          fair: rl.fairHome,
          absGap: Math.abs(margin - 1.5),
          meanAgrees: margin > 0,
          hit: homeCovers,
        },
        {
          year: w.key,
          side: 'away+1.5',
          modelProb: awayCover,
          pickOdds: rl.awayOdds,
          fair: rl.fairAway,
          absGap: Math.abs(margin + 1.5),
          meanAgrees: margin < 0,
          hit: !homeCovers,
        },
      ];
      for (const c of candidates) {
        c.ev = c.modelProb * (c.pickOdds - 1) - (1 - c.modelProb);
        c.edge = c.modelProb - c.fair;
        all.push(c);
      }
    }
  }
  return all;
}

function select(pool, { side, minGap, minEv, minEdge, minProb, requireMeanAgree }) {
  return pool.filter((g) => {
    if (g.side !== side) return false;
    if (requireMeanAgree && !g.meanAgrees) return false;
    if (g.absGap < minGap) return false;
    if (g.ev < minEv) return false;
    if (g.edge < minEdge) return false;
    if (g.modelProb < minProb) return false;
    return true;
  });
}

const latest = getLatestMlbExpectedRunsValidation();
console.log('[rl-side] building…');
const pool = buildAll(latest.model);
console.log('legs', pool.length);

const variants = [];
for (const side of ['home-1.5', 'away+1.5']) {
  for (const requireMeanAgree of [true, false]) {
    for (const minGap of [0, 0.25, 0.5]) {
      for (const minEv of [0.02, 0.03, 0.05]) {
        for (const minEdge of [0.02, 0.03, 0.04]) {
          for (const minProb of [0.5, 0.52, 0.55]) {
            const rule = { side, minGap, minEv, minEdge, minProb, requireMeanAgree };
            const picks = select(pool, rule);
            const byYear = {
              2024: summarize(picks.filter((b) => b.year === '2024')),
              2025: summarize(picks.filter((b) => b.year === '2025')),
              2026: summarize(picks.filter((b) => b.year === '2026')),
              merged: summarize(picks),
            };
            if (byYear.merged.bets < 60) continue;
            const allPos =
              (byYear['2024'].roi ?? -1) > 0 &&
              (byYear['2025'].roi ?? -1) > 0 &&
              (byYear['2026'].roi ?? -1) > 0;
            variants.push({
              id: `${side}_agree${requireMeanAgree ? 1 : 0}_g${minGap}_ev${minEv}_e${minEdge}_p${minProb}`,
              rule,
              byYear,
              pass:
                allPos &&
                byYear['2024'].bets >= 40 &&
                byYear['2025'].bets >= 40 &&
                byYear['2026'].bets >= 25 &&
                (byYear.merged.roi ?? -1) >= 0.02,
            });
          }
        }
      }
    }
  }
}

variants.sort((a, b) => (b.byYear.merged.usd50 || 0) - (a.byYear.merged.usd50 || 0));
const pass = variants.filter((v) => v.pass);
const payload = {
  generatedAt: new Date().toISOString(),
  passCount: pass.length,
  preferred: pass[0] || null,
  top: variants.slice(0, 8),
  verdict: pass[0]
    ? {
        promoteShadow: true,
        note: '單邊讓分過三窗；可開研究影子（仍不混 B／totals）',
        rule: pass[0].rule,
        paper: pass[0].byYear,
      }
    : {
        promoteShadow: false,
        note: '單邊讓分仍無三窗穩定規則',
        best: variants[0] || null,
      },
};

fs.writeFileSync(
  new URL('../tmp-runline-side-only-diag.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);
console.log('pass', pass.length);
if (pass[0]) console.log('PREFERRED', pass[0].id, pass[0].byYear);
else console.log('NO PASS best', variants[0]?.id, variants[0]?.byYear);
console.log(payload.verdict);
