/**
 * MLB 單隊大小（team_totals）限額探針
 * - 只拉 team_totals、單 region（us）
 * - 硬頂預算（預設 2000；本腳本另設 sessionCap 可更小）
 * - 對齊最新 truth snapshot 的單隊 μ（若有）
 * - 不接正式、不寫 mlb_paper_bets
 *
 * 用法:
 *   node scripts/probeMlbTeamTotalsBudget.mjs
 *   node scripts/probeMlbTeamTotalsBudget.mjs --budget=80 --maxGames=20
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { OddsApiClient, remainingQuota } from '../src/services/OddsApiClient.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const BUDGET = Math.min(2000, Math.max(1, Number(args.budget) || 80));
const MAX_GAMES = Math.max(1, Number(args.maxGames) || 20);
const REGION = String(args.region || 'us');
const MARKET = 'team_totals';
const MIN_EDGE = Number(args.minEdge) || 0.03;
const MIN_EV = Number(args.minEv) || 0.03;
const MIN_PROB = Number(args.minProb) || 0.52;
const MIN_ODDS = Number(args.minOdds) || 1.7;
const MAX_ODDS = Number(args.maxOdds) || 2.2;

function poissonCdf(k, lambda) {
  const L = Math.max(0.2, Number(lambda) || 0);
  const K = Math.floor(Number(k));
  if (!Number.isFinite(K) || K < 0) return 0;
  let term = Math.exp(-L);
  let sum = term;
  for (let i = 1; i <= K; i += 1) {
    term *= L / i;
    sum += term;
  }
  return Math.min(1, sum);
}

/** 整數線 push；.5 線無 push。Over = total > line */
function teamTotalOverUnderProb(mu, line) {
  const L = Number(line);
  const m = Math.max(0.5, Number(mu) || 4);
  const isHalf = Math.abs(L - Math.round(L)) > 1e-6;
  if (isHalf) {
    const underProb = poissonCdf(Math.floor(L), m); // P(X <= floor) = P(X < line) for .5
    return { overProb: 1 - underProb, underProb, pushProb: 0, isHalf: true };
  }
  const pushFloor = Math.round(L);
  const underProb = poissonCdf(pushFloor - 1, m);
  const pushProb = poissonCdf(pushFloor, m) - underProb;
  const overProb = 1 - underProb - pushProb;
  return { overProb, underProb, pushProb, isHalf: false };
}

function bestTeamTotals(bookmakers, teamName) {
  let best = null;
  for (const book of bookmakers || []) {
    const m = (book.markets || []).find((x) => x.key === 'team_totals');
    if (!m?.outcomes?.length) continue;
    const overs = m.outcomes.filter((o) => /over/i.test(o.name) && o.description === teamName);
    const unders = m.outcomes.filter((o) => /under/i.test(o.name) && o.description === teamName);
    // some books put team in name
    const overs2 =
      overs.length > 0
        ? overs
        : m.outcomes.filter(
            (o) => /over/i.test(o.name) && String(o.name).includes(teamName)
          );
    const unders2 =
      unders.length > 0
        ? unders
        : m.outcomes.filter(
            (o) => /under/i.test(o.name) && String(o.name).includes(teamName)
          );
    for (const over of overs.length ? overs : overs2) {
      const line = Number(over.point);
      const under = (unders.length ? unders : unders2).find(
        (u) => Number(u.point) === line
      );
      const oOdds = Number(over.price);
      const uOdds = Number(under?.price);
      if (!Number.isFinite(line) || !Number.isFinite(oOdds) || !Number.isFinite(uOdds)) continue;
      const vig = 1 / oOdds + 1 / uOdds;
      if (!best || vig < best.vig) {
        const fair = removeVig(decimalToImpliedProb(oOdds), decimalToImpliedProb(uOdds));
        best = {
          team: teamName,
          line,
          overOdds: oOdds,
          underOdds: uOdds,
          fairOver: fair.fairA,
          fairUnder: fair.fairB,
          vig,
          bookmaker: book.key || book.title || null,
        };
      }
    }
  }
  return best;
}

function parsePredictionMeans(row) {
  if (!row) return null;
  try {
    const input = JSON.parse(row.model_input_json || '{}');
    const er = input.expectedRuns || {};
    const pred = er.prediction || input.prediction || {};
    const home = Number(
      pred.homeExpectedRuns ??
        pred.homeMean ??
        pred.homeRuns ??
        er.homeExpectedRuns ??
        input.homeExpectedRuns
    );
    const away = Number(
      pred.awayExpectedRuns ??
        pred.awayMean ??
        pred.awayRuns ??
        er.awayExpectedRuns ??
        input.awayExpectedRuns
    );
    if (Number.isFinite(home) && Number.isFinite(away)) {
      return { homeMu: home, awayMu: away, source: 'truth.expectedRuns.prediction' };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function evaluateSide(mu, market, sideLabel) {
  if (!market || !Number.isFinite(mu)) {
    return { pass: false, reasons: ['missing_mu_or_market'], sideLabel };
  }
  const dist = teamTotalOverUnderProb(mu, market.line);
  const pickOver = dist.overProb >= dist.underProb;
  const modelProb = pickOver ? dist.overProb : dist.underProb;
  const odds = pickOver ? market.overOdds : market.underOdds;
  const fair = pickOver ? market.fairOver : market.fairUnder;
  const edge = modelProb - fair;
  const ev = modelProb * (odds - 1) - (1 - modelProb);
  const absGap = Math.abs(mu - market.line);
  const reasons = [];
  if (odds < MIN_ODDS) reasons.push('odds_low');
  if (odds > MAX_ODDS) reasons.push('odds_high');
  if (modelProb < MIN_PROB) reasons.push('prob_low');
  if (edge < MIN_EDGE) reasons.push('edge_low');
  if (ev < MIN_EV) reasons.push('ev_low');
  return {
    pass: reasons.length === 0,
    reasons,
    sideLabel,
    team: market.team,
    pick: pickOver ? 'over' : 'under',
    line: market.line,
    mu: Number(mu.toFixed(3)),
    absGap: Number(absGap.toFixed(3)),
    odds: Number(odds.toFixed(3)),
    modelProb: Number(modelProb.toFixed(4)),
    fair: Number(fair.toFixed(4)),
    edge: Number(edge.toFixed(4)),
    ev: Number(ev.toFixed(4)),
    bookmaker: market.bookmaker,
  };
}

console.log('[team-totals-probe] start', { BUDGET, MAX_GAMES, REGION, MARKET });

const games = db
  .prepare(
    `SELECT id, commence_time, home_team, away_team
     FROM games
     WHERE league = 'MLB'
       AND completed = 0
       AND datetime(commence_time) >= datetime('now', '-2 hours')
     ORDER BY datetime(commence_time) ASC
     LIMIT ?`
  )
  .all(MAX_GAMES);

console.log('[team-totals-probe] upcoming games', games.length);

const client = new OddsApiClient();
let spent = 0;
let calls = 0;
const rows = [];
const actionable = [];

for (const g of games) {
  if (spent >= BUDGET) {
    console.log('[team-totals-probe] budget reached, stop');
    break;
  }

  const snap = db
    .prepare(
      `SELECT model_input_json
       FROM mlb_prematch_truth_snapshots
       WHERE game_id = ?
       ORDER BY rowid DESC
       LIMIT 1`
    )
    .get(g.id);
  const means = parsePredictionMeans(snap);

  const beforeRem = remainingQuota(client.getQuota());
  let event;
  try {
    event = await client.getEventOdds('baseball_mlb', g.id, MARKET, {
      regions: REGION,
      oddsFormat: 'decimal',
    });
  } catch (err) {
    rows.push({
      gameId: g.id,
      matchup: `${g.away_team} @ ${g.home_team}`,
      commenceTime: g.commence_time,
      error: err.message,
      means,
    });
    console.warn('[team-totals-probe] fetch fail', g.id, err.message);
    continue;
  }
  calls += 1;
  const after = client.getQuota();
  const rem = remainingQuota(after);
  const costEst = Math.max(0, Number(after?.last) || (beforeRem != null && rem != null ? beforeRem - rem : 1));
  spent += costEst || 1;

  const books = event?.bookmakers || [];
  const homeMkt = bestTeamTotals(books, g.home_team);
  const awayMkt = bestTeamTotals(books, g.away_team);
  const homeEval = evaluateSide(means?.homeMu, homeMkt, 'home');
  const awayEval = evaluateSide(means?.awayMu, awayMkt, 'away');

  const row = {
    gameId: g.id,
    matchup: `${g.away_team} @ ${g.home_team}`,
    commenceTime: g.commence_time,
    hoursUntil: Number(((Date.parse(g.commence_time) - Date.now()) / 3600000).toFixed(2)),
    means,
    hasTeamTotalsMarket: Boolean(homeMkt || awayMkt),
    homeMarket: homeMkt,
    awayMarket: awayMkt,
    homeEval,
    awayEval,
    quota: { remaining: rem, used: after?.used, costEst },
  };
  rows.push(row);
  if (homeEval.pass) actionable.push({ ...homeEval, matchup: row.matchup, gameId: g.id });
  if (awayEval.pass) actionable.push({ ...awayEval, matchup: row.matchup, gameId: g.id });

  console.log(
    JSON.stringify({
      matchup: row.matchup,
      costEst,
      remaining: rem,
      hasMkt: row.hasTeamTotalsMarket,
      home: homeMkt ? `${homeMkt.line}@${homeEval.pick || '-'} ev=${homeEval.ev}` : null,
      away: awayMkt ? `${awayMkt.line}@${awayEval.pick || '-'} ev=${awayEval.ev}` : null,
      pass: [homeEval.pass && 'home', awayEval.pass && 'away'].filter(Boolean),
    })
  );
}

const coverage = rows.filter((r) => r.hasTeamTotalsMarket).length;
const withMu = rows.filter((r) => r.means).length;
const out = {
  researchOnly: true,
  wiredToFormal: false,
  openedAt: new Date().toISOString(),
  budget: { cap: BUDGET, spentEst: spent, calls, remaining: remainingQuota(client.getQuota()) },
  gates: { MIN_EDGE, MIN_EV, MIN_PROB, MIN_ODDS, MAX_ODDS },
  summary: {
    gamesTried: rows.length,
    coverageWithTeamTotals: coverage,
    coverageRate: rows.length ? Number((coverage / rows.length).toFixed(3)) : null,
    withModelMu: withMu,
    actionableCandidates: actionable.length,
  },
  actionable: actionable.sort((a, b) => (b.ev || 0) - (a.ev || 0)),
  rows,
};

fs.writeFileSync('tmp-mlb-team-totals-probe.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ summary: out.summary, budget: out.budget, actionable: out.actionable }, null, 2));
console.log('[team-totals-probe] wrote tmp-mlb-team-totals-probe.json');
