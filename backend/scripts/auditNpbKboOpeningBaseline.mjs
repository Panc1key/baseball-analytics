/**
 * NPB/KBO 初盤資料盤點 + 泊松/Elo 獨贏紙上 OOS（PIT odds）
 * 不動 MLB Locked B。
 *
 * 用法: node scripts/auditNpbKboOpeningBaseline.mjs
 * 產物: tmp-npb-kbo-opening-baseline.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { config } from '../src/config.js';
import { analyzeMatchup } from '../src/services/TeamAnalyzer.js';
import { pickGameRecommendations } from '../src/services/RecommendationRules.js';
import { evaluateBaseballMarketResult } from '../src/services/AnalysisEngine.js';
import { extractMarkets } from '../src/utils/odds.js';
import { qualifiesFlatBet } from '../src/services/BetStrategy.js';
import { createWalkForwardElo } from '../src/services/BaseballElo.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const STAKE = 50;
const LEAGUES = ['NPB', 'KBO'];

function emptyBag() {
  return { n: 0, w: 0, l: 0, p: 0, unit: 0 };
}
function addBag(bag, result, odds) {
  bag.n += 1;
  if (result === 'win') {
    bag.w += 1;
    bag.unit += Number(odds) - 1;
  } else if (result === 'loss') {
    bag.l += 1;
    bag.unit -= 1;
  } else if (result === 'push') {
    bag.p += 1;
  }
}
function fmtBag(bag) {
  const decided = bag.w + bag.l;
  return {
    bets: bag.n,
    wins: bag.w,
    losses: bag.l,
    pushes: bag.p,
    hitRate: decided ? Number((bag.w / decided).toFixed(4)) : null,
    roi: bag.n ? Number((bag.unit / bag.n).toFixed(4)) : null,
    usd50: Math.round(bag.unit * STAKE),
  };
}

function inventoryLeague(league) {
  const games = db
    .prepare(
      `SELECT COUNT(*) AS c,
              MIN(date(commence_time)) AS d0,
              MAX(date(commence_time)) AS d1
       FROM games WHERE league = ?`
    )
    .get(league);
  const completed = db
    .prepare(
      `SELECT COUNT(*) AS c FROM games
       WHERE league = ? AND completed = 1
         AND home_score IS NOT NULL AND away_score IS NOT NULL
         AND NOT (home_score = 0 AND away_score = 0)`
    )
    .get(league);
  const draws = db
    .prepare(
      `SELECT COUNT(*) AS c FROM games
       WHERE league = ? AND completed = 1
         AND home_score IS NOT NULL AND away_score IS NOT NULL
         AND home_score = away_score
         AND NOT (home_score = 0 AND away_score = 0)`
    )
    .get(league);
  const withRaw = db
    .prepare(
      `SELECT COUNT(*) AS c FROM games
       WHERE league = ? AND raw_odds IS NOT NULL AND length(raw_odds) > 10`
    )
    .get(league);
  const withPit = db
    .prepare(
      `SELECT COUNT(DISTINCT g.id) AS c
       FROM games g
       JOIN odds_snapshots s ON s.game_id = g.id
       WHERE g.league = ?
         AND g.completed = 1
         AND datetime(s.captured_at) < datetime(g.commence_time)
         AND s.source NOT LIKE '%_post_start%'`
    )
    .get(league);
  const teamStats = db
    .prepare(
      `SELECT COUNT(*) AS c,
              SUM(CASE WHEN elo IS NOT NULL THEN 1 ELSE 0 END) AS withElo,
              SUM(CASE WHEN ops_30 IS NOT NULL THEN 1 ELSE 0 END) AS withOps,
              SUM(CASE WHEN whip_30 IS NOT NULL THEN 1 ELSE 0 END) AS withWhip,
              SUM(CASE WHEN rpg_30 IS NOT NULL THEN 1 ELSE 0 END) AS withRpg
       FROM team_stats WHERE league = ?`
    )
    .get(league);

  // settlement note from scores: draws imply possible regulation/extra draw outcomes stored
  return {
    league,
    games: games.c,
    dateRange: { from: games.d0, to: games.d1 },
    completedScorable: completed.c,
    drawsAmongCompleted: draws.c,
    drawRate: completed.c
      ? Number((draws.c / completed.c).toFixed(4))
      : null,
    withRawOdds: withRaw.c,
    completedWithPitOdds: withPit.c,
    teamStatsRows: teamStats.c,
    teamStatsWithElo: teamStats.withElo,
    teamStatsWithOps: teamStats.withOps,
    teamStatsWithWhip: teamStats.withWhip,
    teamStatsWithRpg: teamStats.withRpg,
    starters: {
      NPB: '無專用當日先發服務（僅 npbPitcherSuppressionScale 預留）',
      KBO: '有 KboPitcherService；歷史重放未必注入當日先發',
    }[league],
    settlementNote:
      'evaluateBaseballMarketResult：獨贏平手=push；大小用最終總分（含延長若比分含延長）。庄家「僅規定局」需另對齊。',
  };
}

async function runOos(league) {
  const elo = createWalkForwardElo(league, { seedFromRating: false });
  const chrono = db
    .prepare(
      `SELECT home_team, away_team, home_score, away_score, commence_time
       FROM games
       WHERE league = ? AND completed = 1
         AND home_score IS NOT NULL AND away_score IS NOT NULL
         AND NOT (home_score = 0 AND away_score = 0)
       ORDER BY datetime(commence_time) ASC`
    )
    .all(league);
  const games = db
    .prepare(
      `SELECT * FROM games
       WHERE league = ? AND completed = 1
         AND home_score IS NOT NULL AND away_score IS NOT NULL
         AND NOT (home_score = 0 AND away_score = 0)
         AND raw_odds IS NOT NULL AND length(raw_odds) > 10
       ORDER BY datetime(commence_time) ASC`
    )
    .all(league);

  const bags = {
    h2h_all_gated: emptyBag(),
    h2h_flat: emptyBag(),
    h2h_primary: emptyBag(),
    totals_flat: emptyBag(),
  };
  let analyzed = 0;
  let pitOk = 0;
  let pitFail = 0;
  let noPick = 0;
  let errors = 0;
  let strengthOk = 0;
  let pitcherTagged = 0;
  let eloCursor = 0;
  const byMonth = {};

  const prevCalib = config.enableReliabilityCalibration;
  config.enableReliabilityCalibration = false;

  try {
    for (const game of games) {
      const t = Date.parse(game.commence_time);
      while (eloCursor < chrono.length) {
        const eg = chrono[eloCursor];
        if (Date.parse(eg.commence_time) >= t) break;
        elo.applyGame(eg.home_team, eg.away_team, eg.home_score, eg.away_score);
        eloCursor += 1;
      }

      const pit = resolvePitOdds(game.id, game.commence_time);
      let bookmakers = pit?.bookmakers;
      if (!bookmakers?.length) {
        pitFail += 1;
        try {
          bookmakers = JSON.parse(game.raw_odds || '[]');
        } catch {
          errors += 1;
          continue;
        }
      } else {
        pitOk += 1;
      }
      if (!bookmakers?.length) continue;

      try {
        const analysis = await analyzeMatchup(
          league,
          game.home_team,
          game.away_team,
          bookmakers,
          {
            eloOverride: elo,
            commenceTime: game.commence_time,
          }
        );
        analyzed += 1;
        if (analysis?.hasTeamStrength) strengthOk += 1;
        if (
          analysis?.homePitcherStats ||
          analysis?.awayPitcherStats ||
          analysis?.pitchers
        ) {
          pitcherTagged += 1;
        }

        const picks = pickGameRecommendations(
          game,
          extractMarkets(bookmakers),
          analysis,
          '',
          { bookmakers }
        );
        const usable = (picks || []).filter((p) => p.tier !== 'sample');
        if (!usable.length) {
          noPick += 1;
          continue;
        }

        const month = String(game.commence_time || '').slice(0, 7);
        if (!byMonth[month]) {
          byMonth[month] = {
            flat: emptyBag(),
            gated: emptyBag(),
          };
        }

        for (const p of usable) {
          if (p.market !== 'h2h' && p.market !== 'totals') continue;
          const result = evaluateBaseballMarketResult(
            {
              market: p.market,
              pick: p.pick,
              line: p.line ?? null,
            },
            game
          );
          if (!result || result === 'void') continue;

          const flat = qualifiesFlatBet(
            {
              ...p,
              league,
              hasTeamStrength: analysis?.hasTeamStrength,
            },
            { analysis }
          );

          if (p.market === 'h2h') {
            addBag(bags.h2h_all_gated, result, p.oddsDecimal);
            addBag(byMonth[month].gated, result, p.oddsDecimal);
            if (p.tier === 'primary') {
              addBag(bags.h2h_primary, result, p.oddsDecimal);
            }
            if (flat) {
              addBag(bags.h2h_flat, result, p.oddsDecimal);
              addBag(byMonth[month].flat, result, p.oddsDecimal);
            }
          }
          if (p.market === 'totals' && flat) {
            addBag(bags.totals_flat, result, p.oddsDecimal);
          }
        }
      } catch (err) {
        errors += 1;
        if (errors <= 5) {
          console.warn(`[${league}]`, game.id, err.message);
        }
      }
    }
  } finally {
    config.enableReliabilityCalibration = prevCalib;
  }

  const monthFmt = {};
  for (const [m, v] of Object.entries(byMonth)) {
    monthFmt[m] = { flat: fmtBag(v.flat), gated: fmtBag(v.gated) };
  }

  return {
    league,
    coverage: {
      gamesInReplay: games.length,
      analyzed,
      pitOk,
      pitFailFallbackRaw: pitFail,
      noPickGames: noPick,
      errors,
      strengthOkRate: analyzed
        ? Number((strengthOk / analyzed).toFixed(4))
        : null,
      pitcherTaggedRate: analyzed
        ? Number((pitcherTagged / analyzed).toFixed(4))
        : null,
    },
    oos: {
      h2h_all_non_sample: fmtBag(bags.h2h_all_gated),
      h2h_primary: fmtBag(bags.h2h_primary),
      h2h_flat_bet: fmtBag(bags.h2h_flat),
      totals_flat_bet: fmtBag(bags.totals_flat),
    },
    byMonth: monthFmt,
    gatesNote: {
      h2hMinEdgePctNpb: config.h2hMinEdgePctNpb,
      h2hMinFavoriteProbNpb: config.h2hMinFavoriteProbNpb,
      flatBetMinProbNpb: config.flatBetMinProbNpb,
      flatBetMinEdgePctNpb: config.flatBetMinEdgePctNpb,
      prematchMinOdds: config.prematchMinOdds,
    },
  };
}

console.log('inventory…');
const inventory = {
  NPB: inventoryLeague('NPB'),
  KBO: inventoryLeague('KBO'),
  settlementPolicy: {
    code: 'evaluateBaseballMarketResult',
    h2hDraw: 'push（和局退本）',
    totals: '最終 home+away（資料若含延長則含延長）',
    risk: '若庄家 NPB 只結 9 局／可和局盤，需另開結算適配，不可盲套 MLB',
  },
};

console.log('OOS NPB…');
const npb = await runOos('NPB');
console.log('OOS KBO…');
const kbo = await runOos('KBO');

const out = {
  experimentId: 'npb_kbo_opening_baseline_v1',
  stakeUsd: STAKE,
  inventory,
  oos: { NPB: npb, KBO: kbo },
  nextSteps: [
    '若 flat_bet 獨贏 ROI 非穩正：先收緊門檻或只做觀察，勿抄 MLB Locked B',
    '確認常用庄對 NPB/KBO 獨贏是否接受和局、大小是否含延長',
    'UI：亞聯初盤面板與 MLB 鎖定 B 分開',
    '補 NPB 先發源後再談 ExpectedRuns',
  ],
};

fs.writeFileSync('tmp-npb-kbo-opening-baseline.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  inventory: {
    NPB: { games: inventory.NPB.games, completed: inventory.NPB.completedScorable, draws: inventory.NPB.drawsAmongCompleted, pit: inventory.NPB.completedWithPitOdds },
    KBO: { games: inventory.KBO.games, completed: inventory.KBO.completedScorable, draws: inventory.KBO.drawsAmongCompleted, pit: inventory.KBO.completedWithPitOdds },
  },
  NPB_flat: npb.oos.h2h_flat_bet,
  NPB_primary: npb.oos.h2h_primary,
  NPB_gated: npb.oos.h2h_all_non_sample,
  KBO_flat: kbo.oos.h2h_flat_bet,
  KBO_primary: kbo.oos.h2h_primary,
  KBO_gated: kbo.oos.h2h_all_non_sample,
  totals: { NPB: npb.oos.totals_flat_bet, KBO: kbo.oos.totals_flat_bet },
}, null, 2));
console.log('wrote tmp-npb-kbo-opening-baseline.json');
