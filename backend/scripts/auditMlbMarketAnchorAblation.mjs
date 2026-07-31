/**
 * MLB 貼市錨定開關實驗（PIT 安全）：對照 ON vs OFF 方向勝率／均注 ROI。
 * 用法: node scripts/auditMlbMarketAnchorAblation.mjs [months]
 */
import 'dotenv/config';
import fs from 'fs';
import db from '../src/db/database.js';
import { config } from '../src/config.js';
import { analyzeMatchup } from '../src/services/TeamAnalyzer.js';
import { buildPointInTimeTeamStatsOverride } from '../src/services/TeamRollingStats.js';
import { resolveStarAbsenceForGame } from '../src/services/StarPlayerImpact.js';

const months = Number(process.argv[2] || 3);
const since = new Date();
since.setUTCMonth(since.getUTCMonth() - months);
const sinceIso = since.toISOString().slice(0, 10);
const limit = Number(process.env.ABLATION_LIMIT || 0);

const rows = db
  .prepare(
    `
  SELECT id AS gameId,
         commence_time AS commenceTime,
         home_team AS homeTeam,
         away_team AS awayTeam,
         home_score AS homeScore,
         away_score AS awayScore,
         raw_odds AS rawOdds
  FROM games
  WHERE league = 'MLB'
    AND completed = 1
    AND home_score IS NOT NULL
    AND away_score IS NOT NULL
    AND NOT (home_score = 0 AND away_score = 0)
    AND datetime(commence_time) >= datetime(?)
  ORDER BY datetime(commence_time) ASC
`
  )
  .all(sinceIso);

const games = limit > 0 ? rows.slice(-limit) : rows;

function summarize(label, disableAnchor, bag) {
  const n = bag.n;
  return {
    label,
    disableAnchor,
    skipped: bag.skipped,
    n,
    hits: bag.hits,
    hitRate: n ? Number((bag.hits / n).toFixed(4)) : null,
    withOddsN: bag.oddsN,
    unitPnl: Number(bag.pnl.toFixed(2)),
    roi: bag.oddsN ? Number((bag.pnl / bag.oddsN).toFixed(4)) : null,
    meanAbsEdgeVsFair: bag.edgeN
      ? Number((bag.absEdgeSum / bag.edgeN).toFixed(4))
      : null,
  };
}

async function runPass(disableAnchor) {
  config.mlbDisableMarketAnchorExperiment = disableAnchor;
  const bag = {
    n: 0,
    hits: 0,
    oddsN: 0,
    pnl: 0,
    edgeN: 0,
    absEdgeSum: 0,
    skipped: 0,
  };

  for (const row of games) {
    const homeScore = Number(row.homeScore);
    const awayScore = Number(row.awayScore);
    if (homeScore === awayScore) {
      bag.skipped += 1;
      continue;
    }

    let bookmakers;
    try {
      bookmakers = JSON.parse(row.rawOdds || '[]');
    } catch {
      bag.skipped += 1;
      continue;
    }
    if (!bookmakers.length) {
      bag.skipped += 1;
      continue;
    }

    let analysis;
    try {
      const teamStatsOverride = await buildPointInTimeTeamStatsOverride(
        'MLB',
        row.commenceTime,
        row.homeTeam,
        row.awayTeam
      );
      let starAbsence = null;
      if (config.enableStarImpact) {
        starAbsence = await resolveStarAbsenceForGame(
          row.homeTeam,
          row.awayTeam,
          row.commenceTime
        );
      }
      analysis = await analyzeMatchup('MLB', row.homeTeam, row.awayTeam, bookmakers, {
        commenceTime: row.commenceTime,
        teamStatsOverride,
        starAbsence,
      });
    } catch {
      bag.skipped += 1;
      continue;
    }

    const pHome = Number(analysis?.homeWinProb);
    if (!Number.isFinite(pHome)) {
      bag.skipped += 1;
      continue;
    }

    const predHome = pHome >= 0.5;
    const hit = predHome === homeScore > awayScore;
    bag.n += 1;
    if (hit) bag.hits += 1;

    if (analysis.marketHomeProb != null) {
      bag.edgeN += 1;
      bag.absEdgeSum += Math.abs(pHome - analysis.marketHomeProb);
    }

    let pickOdds = null;
    for (const book of bookmakers) {
      const m = book.markets?.find((x) => x.key === 'h2h');
      if (!m?.outcomes) continue;
      const home = m.outcomes.find((o) => o.name === row.homeTeam);
      const away = m.outcomes.find((o) => o.name === row.awayTeam);
      if (!home?.price || !away?.price) continue;
      pickOdds = predHome ? Number(home.price) : Number(away.price);
      break;
    }
    if (Number.isFinite(pickOdds)) {
      bag.oddsN += 1;
      bag.pnl += hit ? pickOdds - 1 : -1;
    }
  }

  return summarize(
    disableAnchor ? 'anchor_OFF_raw_model' : 'anchor_ON_blend_clamp',
    disableAnchor,
    bag
  );
}

console.log(
  `MLB 貼市消融（PIT） months=${months} games=${games.length} since=${sinceIso}…`
);

const withAnchor = await runPass(false);
const withoutAnchor = await runPass(true);
config.mlbDisableMarketAnchorExperiment = true;

const out = {
  ok: true,
  pitSafe: true,
  since: sinceIso,
  scannedGames: games.length,
  withAnchor,
  withoutAnchor,
  deltaHitRate:
    withAnchor.hitRate != null && withoutAnchor.hitRate != null
      ? Number((withoutAnchor.hitRate - withAnchor.hitRate).toFixed(4))
      : null,
  deltaRoi:
    withAnchor.roi != null && withoutAnchor.roi != null
      ? Number((withoutAnchor.roi - withAnchor.roi).toFixed(4))
      : null,
  verdict: (() => {
    const hr = withoutAnchor.hitRate;
    if (hr == null) return 'insufficient_data';
    if (hr >= 0.57) return 'raw_positive_clears_076_breakeven';
    if (hr >= 0.541) return 'raw_near_085_breakeven';
    if (hr > 0.5) return 'raw_above_coin_but_likely_losing_after_vig';
    return 'raw_negative_or_coin';
  })(),
  note: [
    'PIT：開賽前隊力覆寫 + games.raw_odds，避免用「今天的戰績」回看舊場',
    'OFF＝不貼總分市、不貼獨贏市、clamp 放寬',
    'ON＝原 MLB 貼市 + 0.22–0.78 clamp',
    '跑完後維持 OFF（實驗預設）',
  ],
};

fs.writeFileSync('tmp-mlb-market-anchor-ablation.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
