/**
 * 用驗證集最小化 Brier，估計 NPB 混合權重
 * 用法: node src/jobs/fitBlendWeights.js [--days=60]
 *
 * 寫入 backend/data/fitted-weights.json，config 啟動時自動載入
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../db/database.js';
import { config } from '../config.js';
import { analyzeMatchup } from '../services/TeamAnalyzer.js';
import { createWalkForwardElo } from '../services/BaseballElo.js';
import { brierScore, logLoss } from '../services/ProbabilityCalibration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../../data/fitted-weights.json');

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const days = Number(argValue('days') || 60);
const since = new Date();
since.setUTCDate(since.getUTCDate() - days);
const sinceIso = since.toISOString();

config.enableReliabilityCalibration = false;

const games = db
  .prepare(
    `
  SELECT * FROM games
  WHERE league IN ('NPB','KBO')
    AND completed = 1
    AND home_score IS NOT NULL
    AND away_score IS NOT NULL
    AND NOT (home_score = 0 AND away_score = 0)
    AND raw_odds IS NOT NULL
    AND length(raw_odds) > 10
    AND datetime(commence_time) >= datetime(?)
  ORDER BY datetime(commence_time) ASC
`
  )
  .all(sinceIso);

const allChrono = db
  .prepare(
    `
  SELECT league, home_team, away_team, home_score, away_score, commence_time
  FROM games
  WHERE league IN ('NPB','KBO')
    AND completed = 1
    AND home_score IS NOT NULL
    AND away_score IS NOT NULL
    AND NOT (home_score = 0 AND away_score = 0)
  ORDER BY datetime(commence_time) ASC
`
  )
  .all();

function tKey(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
}

async function evaluate(marketW, scoreW, totalsW) {
  config.h2hMarketBlendNpbFull = marketW;
  config.scoreModelBlendNpb = scoreW;
  config.totalsMarketBlendNpbFull = totalsW;

  const walkers = {
    NPB: createWalkForwardElo('NPB', { seedFromRating: false }),
    KBO: createWalkForwardElo('KBO', { seedFromRating: false }),
  };
  let cursor = 0;
  const points = [];

  for (const game of games) {
    while (cursor < allChrono.length) {
      const eg = allChrono[cursor];
      if (tKey(eg.commence_time) >= tKey(game.commence_time)) break;
      walkers[eg.league]?.applyGame(eg.home_team, eg.away_team, eg.home_score, eg.away_score);
      cursor += 1;
    }

    let bookmakers;
    try {
      bookmakers = JSON.parse(game.raw_odds || '[]');
    } catch {
      continue;
    }
    if (!bookmakers.length) continue;

    try {
      const analysis = await analyzeMatchup(
        game.league,
        game.home_team,
        game.away_team,
        bookmakers,
        { eloOverride: walkers[game.league] }
      );
      const hs = Number(game.home_score);
      const as = Number(game.away_score);
      if (hs === as) continue;
      // 用市場混合後勝率，才能估計 h2hMarketBlend*
      points.push({
        p: analysis.homeWinProb,
        y: hs > as ? 1 : 0,
      });
    } catch {
      /* skip */
    }
  }

  return {
    n: points.length,
    brier: brierScore(points),
    logLoss: logLoss(points),
  };
}

const marketGrid = [0.28, 0.34, 0.38, 0.42, 0.48];
const scoreGrid = [0.3, 0.36, 0.42, 0.48, 0.55];
const totalsGrid = [0.35, 0.42, 0.5];

let best = null;
const rows = [];

console.log(`擬合樣本場次 ${games.length}（最近 ${days} 天 NPB/KBO）`);

for (const m of marketGrid) {
  for (const s of scoreGrid) {
    for (const t of totalsGrid) {
      const metrics = await evaluate(m, s, t);
      const row = { h2hMarketBlendNpbFull: m, scoreModelBlendNpb: s, totalsMarketBlendNpbFull: t, ...metrics };
      rows.push(row);
      console.log(
        `m=${m} s=${s} t=${t} → Brier=${metrics.brier?.toFixed(4)} LogLoss=${metrics.logLoss?.toFixed(4)} n=${metrics.n}`
      );
      if (
        metrics.brier != null &&
        metrics.n >= 20 &&
        (!best || metrics.brier < best.brier)
      ) {
        best = row;
      }
    }
  }
}

if (!best) {
  console.error('無法擬合（樣本不足）');
  process.exit(1);
}

const out = {
  ...best,
  fittedAt: new Date().toISOString(),
  days,
  objective: 'min_brier_home_win',
  gridSize: rows.length,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log('\n最佳權重:', out);
console.log('已寫入', OUT);
console.log('重啟後端或重新載入 config 後生效（環境變數優先）');
