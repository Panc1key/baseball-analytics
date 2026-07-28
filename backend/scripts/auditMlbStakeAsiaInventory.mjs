/**
 * 注碼階梯紙上示意 + NPB/KBO 資料盤點（與 MLB 選場常數分離；不改規則）
 * 產物：tmp-stake-asia-inventory.json
 *
 * 用法: node scripts/auditMlbStakeAsiaInventory.mjs
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

const RULES = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: 2,
};

const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function hkDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function collectH2hBooks(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return [];
  const books = [];
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
    const homeOdds = Number(home.price);
    const awayOdds = Number(away.price);
    if (!Number.isFinite(homeOdds) || !Number.isFinite(awayOdds)) continue;
    books.push({ homeOdds, awayOdds, vig: 1 / homeOdds + 1 / awayOdds });
  }
  return books;
}

function buildPicks() {
  const validation = getLatestMlbExpectedRunsValidation();
  const all = [];
  for (const w of WINDOWS) {
    const rows = db
      .prepare(
        `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
                g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
         FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
         WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
           AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
         ORDER BY f.commence_time`
      )
      .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);

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
      const books = collectH2hBooks(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
      if (books.length < 2) continue;
      books.sort((a, b) => a.vig - b.vig);
      const best = books[0];
      const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
      const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
      const margin = Math.abs(ph - pa);
      const signals = buildPregameRegimeSignals(features);
      const pickEarly = pickHome
        ? Number(signals.homeEarlyExitsLast3) || 0
        : Number(signals.awayEarlyExitsLast3) || 0;
      const oppEarly = pickHome
        ? Number(signals.awayEarlyExitsLast3) || 0
        : Number(signals.homeEarlyExitsLast3) || 0;
      const pitchers = features?.pitchers || {};
      const homeId = pitchers.homeIdentity?.id ?? pitchers.home?.id ?? null;
      const awayId = pitchers.awayIdentity?.id ?? pitchers.away?.id ?? null;
      if (homeId == null || awayId == null) continue;
      if (ev < RULES.minimumExpectedValue) continue;
      if (margin < RULES.minimumExpectedRunMargin) continue;
      if (modelProb < RULES.minimumModelProbability) continue;
      if (pickOdds < RULES.minimumPickOdds || pickOdds > RULES.maximumPickOdds) continue;
      if (
        best.homeOdds < RULES.minimumEitherSideOdds ||
        best.awayOdds < RULES.minimumEitherSideOdds
      ) {
        continue;
      }
      if (RULES.requirePickEarlyExitsNotHigher && pickEarly > oppEarly) continue;
      pool.push({
        day: hkDate(row.commenceTime),
        hit: pickHome === hs > as,
        pickOdds,
        ev,
        margin,
        modelProb,
        score: scoreMlbMoneylineDailyRank(
          { expectedValue: ev, modelProbability: modelProb },
          RULES
        ),
      });
    }
    const byDay = new Map();
    for (const g of pool) {
      if (!byDay.has(g.day)) byDay.set(g.day, []);
      byDay.get(g.day).push(g);
    }
    for (const day of [...byDay.keys()].sort()) {
      all.push(
        ...[...byDay.get(day)]
          .sort((a, b) => b.score - a.score || b.margin - a.margin)
          .slice(0, RULES.dailyTopK)
      );
    }
  }
  return all;
}

function stakeLadder(picks, stakeUsd) {
  let pnl = 0;
  for (const b of picks) {
    pnl += b.hit ? (b.pickOdds - 1) * stakeUsd : -stakeUsd;
  }
  return {
    stakeUsd,
    bets: picks.length,
    pnlUsd: Math.round(pnl),
    roi: picks.length ? Number((pnl / (picks.length * stakeUsd)).toFixed(4)) : null,
  };
}

const picks = buildPicks();
const unit = picks.reduce((s, b) => s + (b.hit ? b.pickOdds - 1 : -1), 0);

const stakeSimulation = {
  note: '均注階梯：ROI% 不變，總利潤隨注碼線性放大；不碰選場',
  ladders: [25, 50, 75, 100, 150, 500].map((s) => stakeLadder(picks, s)),
  impliedFromUnits: {
    unitPnl: Number(unit.toFixed(2)),
    at50: Math.round(unit * 50),
    at75: Math.round(unit * 75),
    at100: Math.round(unit * 100),
    at150: Math.round(unit * 150),
  },
  suggestedProductLadder: [
    { bankrollHintUsd: 4000, flatStakeUsd: 50 },
    { bankrollHintUsd: 10000, flatStakeUsd: 100 },
    { bankrollHintUsd: 15000, flatStakeUsd: 150 },
  ],
};

const leagueCounts = db
  .prepare(
    `SELECT league, COUNT(*) AS games,
            SUM(CASE WHEN completed=1 THEN 1 ELSE 0 END) AS completed,
            MIN(date(commence_time)) AS minDate,
            MAX(date(commence_time)) AS maxDate
     FROM games
     GROUP BY league
     ORDER BY games DESC`
  )
  .all();

const oddsByLeague = db
  .prepare(
    `SELECT g.league, COUNT(DISTINCT o.game_id) AS gamesWithOdds, COUNT(*) AS snapshots
     FROM odds_snapshots o
     JOIN games g ON g.id = o.game_id
     GROUP BY g.league
     ORDER BY gamesWithOdds DESC`
  )
  .all();

const featureRowsByHint = {
  mlb_historical_feature_rows: db
    .prepare(`SELECT COUNT(*) AS n FROM mlb_historical_feature_rows`)
    .get()?.n,
};

const asiaTables = db
  .prepare(
    `SELECT name FROM sqlite_master WHERE type='table'
     AND (name LIKE '%npb%' OR name LIKE '%kbo%' OR name LIKE '%feature%')`
  )
  .all();

const asia = {
  note: '亞聯需獨立產線；禁止併入 MLB ev02_max230 常數',
  gamesByLeague: leagueCounts,
  oddsCoverageByLeague: oddsByLeague,
  relatedTables: asiaTables,
  mlbFeatureRows: featureRowsByHint,
  readiness: {
    npb: leagueCounts.some((r) => /npb/i.test(String(r.league)))
      ? 'has_games_rows'
      : 'no_npb_league_in_games',
    kbo: leagueCounts.some((r) => /kbo/i.test(String(r.league)))
      ? 'has_games_rows'
      : 'no_kbo_league_in_games',
    expectedRunsModel: 'mlb_only_do_not_reuse_blindly',
  },
};

const out = {
  experimentId: 'stake-asia-inventory-2026-07-27',
  generatedAt: new Date().toISOString(),
  baselinePicks: {
    profile: 'ev02_max230',
    minimumH2hBookmakers: 2,
    bets: picks.length,
    hitRate: picks.length
      ? Number((picks.filter((b) => b.hit).length / picks.length).toFixed(4))
      : null,
  },
  stakeSimulation,
  asia,
  recommendation: {
    stake: '產品決策即可採用均注階梯；不必改選場',
    asia:
      asia.readiness.npb === 'has_games_rows' || asia.readiness.kbo === 'has_games_rows'
        ? '有 games 列可再盤點賠率／特徵覆蓋後另開紙上規則'
        : '庫內尚無清晰 NPB/KBO league 列；加場需先接資料管線',
  },
};

fs.writeFileSync(
  new URL('../tmp-stake-asia-inventory.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify({ stake: stakeSimulation, asiaReady: asia.readiness, rec: out.recommendation }, null, 2));
