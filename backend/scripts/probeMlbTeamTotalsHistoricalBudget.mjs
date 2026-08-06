/**
 * MLB 單隊大小歷史樣本（限額）
 * - historical event odds：約 10 額／場（team_totals + us）
 * - 硬頂預算預設 2000 → 最多約 200 場
 * - 對已完賽＋有 truth μ 的場：拉 T-8 盤、結算命中
 * - 不接正式
 *
 * 用法:
 *   node scripts/probeMlbTeamTotalsHistoricalBudget.mjs
 *   node scripts/probeMlbTeamTotalsHistoricalBudget.mjs --budget=2000 --days=40
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { OddsApiClient, remainingQuota, isOddsQuotaExhaustedError } from '../src/services/OddsApiClient.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const BUDGET = Math.min(2000, Math.max(10, Number(args.budget) || 2000));
const DAYS = Math.max(7, Number(args.days) || 40);
const REGION = 'us';
const MARKET = 'team_totals';
const HOURS_BEFORE = Number(args.hoursBefore) || 8;
const MIN_EDGE = Number(args.minEdge) || 0.03;
const MIN_EV = Number(args.minEv) || 0.03;
const MIN_PROB = Number(args.minProb) || 0.52;
const MIN_ODDS = Number(args.minOdds) || 1.7;
const MAX_ODDS = Number(args.maxOdds) || 2.2;
const STAKE = 50;

/** Odds historical 只要到秒、且快照約 5 分鐘一格 */
function toHistoricalDateIso(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  const mins = d.getUTCMinutes();
  d.setUTCMinutes(mins - (mins % 5), 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

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

function teamTotalOverUnderProb(mu, line) {
  const L = Number(line);
  const m = Math.max(0.5, Number(mu) || 4);
  const isHalf = Math.abs(L - Math.round(L)) > 1e-6;
  if (isHalf) {
    const underProb = poissonCdf(Math.floor(L), m);
    return { overProb: 1 - underProb, underProb, pushProb: 0 };
  }
  const pushFloor = Math.round(L);
  const underProb = poissonCdf(pushFloor - 1, m);
  const pushProb = poissonCdf(pushFloor, m) - underProb;
  const overProb = 1 - underProb - pushProb;
  return { overProb, underProb, pushProb };
}

function parseMeans(modelInputJson) {
  try {
    const input = JSON.parse(modelInputJson || '{}');
    const pred = input.expectedRuns?.prediction || {};
    const home = Number(pred.homeExpectedRuns);
    const away = Number(pred.awayExpectedRuns);
    if (Number.isFinite(home) && Number.isFinite(away)) return { homeMu: home, awayMu: away };
  } catch {
    /* ignore */
  }
  return null;
}

/** 在該隊所有線裡，選最靠近 μ 且有完整 over/under 的線（避免 6.5 怪線） */
function pickTeamTotalNearMu(bookmakers, teamName, mu) {
  const byLine = new Map();
  for (const book of bookmakers || []) {
    const m = (book.markets || []).find((x) => x.key === 'team_totals');
    if (!m?.outcomes?.length) continue;
    for (const o of m.outcomes) {
      const isTeam =
        o.description === teamName ||
        String(o.name || '').includes(teamName);
      if (!isTeam) continue;
      const line = Number(o.point);
      const price = Number(o.price);
      if (!Number.isFinite(line) || !Number.isFinite(price)) continue;
      if (!byLine.has(line)) byLine.set(line, []);
      const side = /over/i.test(o.name) ? 'over' : /under/i.test(o.name) ? 'under' : null;
      if (!side) continue;
      byLine.get(line).push({ side, price, book: book.key || book.title });
    }
  }
  let best = null;
  for (const [line, arr] of byLine.entries()) {
    const overs = arr.filter((x) => x.side === 'over');
    const unders = arr.filter((x) => x.side === 'under');
    if (!overs.length || !unders.length) continue;
    // 取中位價近似
    const mid = (xs) => {
      const s = xs.map((x) => x.price).sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const oOdds = mid(overs);
    const uOdds = mid(unders);
    const vig = 1 / oOdds + 1 / uOdds;
    const dist = Math.abs(line - Number(mu));
    const cand = {
      team: teamName,
      line,
      overOdds: oOdds,
      underOdds: uOdds,
      vig,
      dist,
      bookmaker: overs[0]?.book || unders[0]?.book || null,
    };
    const fair = removeVig(decimalToImpliedProb(oOdds), decimalToImpliedProb(uOdds));
    cand.fairOver = fair.fairA;
    cand.fairUnder = fair.fairB;
    if (
      !best ||
      dist < best.dist - 1e-9 ||
      (Math.abs(dist - best.dist) < 1e-9 && vig < best.vig)
    ) {
      best = cand;
    }
  }
  return best;
}

function evaluate(mu, market) {
  if (!market || !Number.isFinite(mu)) return null;
  const dist = teamTotalOverUnderProb(mu, market.line);
  const pickOver = dist.overProb >= dist.underProb;
  const modelProb = pickOver ? dist.overProb : dist.underProb;
  const odds = pickOver ? market.overOdds : market.underOdds;
  const fair = pickOver ? market.fairOver : market.fairUnder;
  const edge = modelProb - fair;
  const ev = modelProb * (odds - 1) - (1 - modelProb);
  const pass =
    odds >= MIN_ODDS &&
    odds <= MAX_ODDS &&
    modelProb >= MIN_PROB &&
    edge >= MIN_EDGE &&
    ev >= MIN_EV;
  return {
    pass,
    pick: pickOver ? 'over' : 'under',
    line: market.line,
    mu: Number(mu.toFixed(3)),
    odds: Number(odds.toFixed(3)),
    modelProb: Number(modelProb.toFixed(4)),
    edge: Number(edge.toFixed(4)),
    ev: Number(ev.toFixed(4)),
    absGap: Number(Math.abs(mu - market.line).toFixed(3)),
    bookmaker: market.bookmaker,
  };
}

function settle(pick, line, actualRuns) {
  const a = Number(actualRuns);
  const L = Number(line);
  if (!Number.isFinite(a) || !Number.isFinite(L)) return { result: 'unknown', unit: 0 };
  if (Math.abs(L - Math.round(L)) < 1e-6 && a === L) return { result: 'push', unit: 0 };
  const isOver = a > L;
  const hit = pick === 'over' ? isOver : !isOver;
  return { result: hit ? 'win' : 'loss', unit: null, hit };
}

function summarizeBets(bets) {
  let unit = 0;
  let hits = 0;
  let decided = 0;
  for (const b of bets) {
    if (b.result === 'push' || b.result === 'unknown') continue;
    decided += 1;
    if (b.result === 'win') {
      hits += 1;
      unit += b.odds - 1;
    } else unit -= 1;
  }
  return {
    bets: bets.length,
    decided,
    hitRate: decided ? Number((hits / decided).toFixed(4)) : null,
    roi: decided ? Number((unit / decided).toFixed(4)) : null,
    usd50: Math.round(unit * STAKE),
  };
}

console.log('[hist-team-totals] start', { BUDGET, DAYS, HOURS_BEFORE });

const games = db
  .prepare(
    `SELECT g.id, g.commence_time, g.home_team, g.away_team, g.home_score, g.away_score,
            (
              SELECT s.model_input_json FROM mlb_prematch_truth_snapshots s
              WHERE s.game_id = g.id
              ORDER BY s.rowid DESC LIMIT 1
            ) AS model_input_json
     FROM games g
     WHERE g.league = 'MLB'
       AND g.completed = 1
       AND datetime(g.commence_time) >= datetime('now', ?)
       AND EXISTS (
         SELECT 1 FROM mlb_prematch_truth_snapshots s
         WHERE s.game_id = g.id AND s.model_input_json LIKE '%homeExpectedRuns%'
       )
     ORDER BY datetime(g.commence_time) DESC`
  )
  .all(`-${DAYS} days`);

console.log('[hist-team-totals] candidate games', games.length);

const client = new OddsApiClient();
let spent = 0;
let calls = 0;
let empty = 0;
const rows = [];
const bets = [];

for (const g of games) {
  if (spent + 10 > BUDGET) {
    console.log('[hist-team-totals] budget guard stop', { spent, BUDGET });
    break;
  }
  const means = parseMeans(g.model_input_json);
  if (!means) continue;

  const commenceMs = Date.parse(g.commence_time);
  if (!Number.isFinite(commenceMs)) continue;
  // 太近的完賽場歷史快照常未就緒，跳過免刷錯誤
  if (Date.now() - commenceMs < 36 * 3600000) continue;
  const pitIso = toHistoricalDateIso(commenceMs - HOURS_BEFORE * 3600000);
  if (!pitIso) continue;

  let event;
  try {
    event = await client.getHistoricalEventOdds('baseball_mlb', g.id, pitIso, MARKET, {
      regions: REGION,
      oddsFormat: 'decimal',
    });
  } catch (err) {
    if (isOddsQuotaExhaustedError(err)) {
      console.warn('[hist-team-totals] quota exhausted', err.message);
      break;
    }
    rows.push({
      gameId: g.id,
      matchup: `${g.away_team} @ ${g.home_team}`,
      day: String(g.commence_time).slice(0, 10),
      error: err.message,
    });
    continue;
  }

  calls += 1;
  const q = client.getQuota();
  const cost = Math.max(0, Number(q?.last) || 10);
  spent += cost;
  const books = event?.data?.bookmakers || event?.bookmakers || [];
  if (!books.length) {
    empty += 1;
    continue;
  }

  const homeMkt = pickTeamTotalNearMu(books, g.home_team, means.homeMu);
  const awayMkt = pickTeamTotalNearMu(books, g.away_team, means.awayMu);
  const homeEval = evaluate(means.homeMu, homeMkt);
  const awayEval = evaluate(means.awayMu, awayMkt);

  const day = String(g.commence_time).slice(0, 10);
  const matchup = `${g.away_team} @ ${g.home_team}`;

  for (const [side, ev, actual] of [
    ['home', homeEval, g.home_score],
    ['away', awayEval, g.away_score],
  ]) {
    if (!ev?.pass) continue;
    const settled = settle(ev.pick, ev.line, actual);
    const unit =
      settled.result === 'win'
        ? ev.odds - 1
        : settled.result === 'loss'
          ? -1
          : 0;
    const bet = {
      gameId: g.id,
      day,
      matchup,
      side,
      team: side === 'home' ? g.home_team : g.away_team,
      ...ev,
      actualRuns: Number(actual),
      result: settled.result,
      unit,
      profitUsd: Math.round(unit * STAKE),
    };
    bets.push(bet);
  }

  rows.push({
    gameId: g.id,
    day,
    matchup,
    means,
    homeMarket: homeMkt,
    awayMarket: awayMkt,
    cost,
    remaining: remainingQuota(q),
  });

  if (calls % 10 === 0) {
    console.log(
      JSON.stringify({
        calls,
        spent,
        remaining: remainingQuota(q),
        bets: bets.length,
        last: matchup,
      })
    );
  }
}

const overall = summarizeBets(bets);
const byMonth = {};
for (const b of bets) {
  const m = b.day.slice(0, 7);
  if (!byMonth[m]) byMonth[m] = [];
  byMonth[m].push(b);
}
const monthSummaries = Object.fromEntries(
  Object.entries(byMonth)
    .sort()
    .map(([k, arr]) => [k, summarizeBets(arr)])
);

const out = {
  researchOnly: true,
  wiredToFormal: false,
  openedAt: new Date().toISOString(),
  note:
    '歷史單隊大小限額樣本；非整月全量（全月約需 4500+ 額）。選線=靠近 μ 的 team_totals。',
  budget: {
    cap: BUDGET,
    spentEst: spent,
    calls,
    emptyResponses: empty,
    remaining: remainingQuota(client.getQuota()),
    fullMonthWouldCostApprox: '≈15場/日 × 30日 × 10額 ≈ 4500（超過 2000）',
    thisRunCoversApproxDays: calls ? Number((calls / 15).toFixed(1)) : 0,
  },
  gates: { MIN_EDGE, MIN_EV, MIN_PROB, MIN_ODDS, MAX_ODDS, HOURS_BEFORE },
  overall,
  byMonth: monthSummaries,
  bets: bets.sort((a, b) => String(b.day).localeCompare(String(a.day))),
  sampleRows: rows.slice(0, 20),
};

fs.writeFileSync('tmp-mlb-team-totals-historical.json', JSON.stringify(out, null, 2));
console.log(
  JSON.stringify(
    {
      budget: out.budget,
      overall,
      byMonth: monthSummaries,
      topBets: bets.slice(0, 12).map((b) => ({
        day: b.day,
        team: b.team,
        pick: `${b.pick} ${b.line}`,
        odds: b.odds,
        actual: b.actualRuns,
        result: b.result,
        ev: b.ev,
      })),
    },
    null,
    2
  )
);
console.log('[hist-team-totals] wrote tmp-mlb-team-totals-historical.json');
