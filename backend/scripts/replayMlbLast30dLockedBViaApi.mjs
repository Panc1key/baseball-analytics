/**
 * 近 30 香港日：API 補比分 + 回填缺特徵 + 重放鎖定 B，輸出每日命中／$正負
 *
 * 用法: node scripts/replayMlbLast30dLockedBViaApi.mjs
 * 產物: tmp-last30d-locked-b-api-replay.json
 *
 * 注意：7/23 後缺 historical feature 時會呼叫 MLB Stats API 補特徵；
 *       Odds API scores 僅能回看約 3 天（額度小）。
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { OddsApiClient } from '../src/services/OddsApiClient.js';
import { LEAGUES } from '../src/config.js';
import {
  getMlbSchedule,
  matchMlbOfficialGame,
} from '../src/services/MlbStatsService.js';
import {
  MLB_BASELINE_FEATURE_VERSION,
  buildMlbHistoricalFeatureRows,
  enrichRowsWithHistoricalPitchers,
  persistMlbHistoricalFeatureRows,
} from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  buildMlbExpectedRunsSideFeatures,
  predictMlbExpectedRunsMean,
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
  calibrateMlbScoreMarkets,
  MLB_MONEYLINE_RULE_PROFILES,
  scoreMlbMoneylineDailyRank,
  MLB_EXPECTED_RUNS_FEATURE_KEYS,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';

const STAKE = 50;
const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function addDays(day, n) {
  const d = new Date(`${day}T12:00:00+08:00`);
  d.setDate(d.getDate() + n);
  return hk(d.toISOString());
}

const todayHk = hk(new Date().toISOString());
const fromHk = addDays(todayHk, -29);
const enrichFrom = addDays(fromHk, -14); // bullpen 熱身
const missingFeatFrom = '2026-07-23';

console.log(`[1/4] Odds API scores（最多 3 日）…`);
const client = new OddsApiClient();
let oddsScores = { updated: 0, error: null, quota: null };
try {
  const scores = await client.getScores(LEAGUES.MLB.key, 3);
  const upd = db.prepare(`
    UPDATE games SET completed=1, home_score=?, away_score=?, status='completed',
      updated_at=datetime('now')
    WHERE id=? AND league='MLB'
  `);
  for (const game of scores || []) {
    if (!game.completed) continue;
    const hs = parseInt(
      game.scores?.find((s) => s.name === game.home_team)?.score,
      10
    );
    const as = parseInt(
      game.scores?.find((s) => s.name === game.away_team)?.score,
      10
    );
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    const info = upd.run(hs, as, game.id);
    oddsScores.updated += info.changes;
  }
  oddsScores.quota = client.getQuota();
} catch (err) {
  oddsScores.error = err.message;
  console.warn('Odds scores 失敗:', err.message);
}
console.log('  oddsScores', oddsScores);

console.log(`[2/4] MLB Stats API 補近 30 日完賽比分…`);
let mlbScoreSync = { days: 0, matched: 0, updated: 0 };
const updateById = db.prepare(`
  UPDATE games SET completed=1, home_score=?, away_score=?, status='completed',
    official_date=?, updated_at=datetime('now')
  WHERE id=?
`);
for (let i = 0; i < 30; i += 1) {
  const day = addDays(fromHk, i);
  mlbScoreSync.days += 1;
  let schedule = [];
  try {
    schedule = await getMlbSchedule(day);
  } catch (err) {
    console.warn('  schedule fail', day, err.message);
    continue;
  }
  const locals = db
    .prepare(
      `SELECT id, commence_time, home_team, away_team, home_score, away_score, completed
       FROM games WHERE league='MLB' AND date(commence_time) BETWEEN date(?, '-1 day') AND date(?, '+1 day')`
    )
    .all(day, day);
  for (const g of locals) {
    const official = matchMlbOfficialGame(g, schedule);
    if (!official) continue;
    mlbScoreSync.matched += 1;
    const hs = official.teams?.home?.score;
    const as = official.teams?.away?.score;
    const done =
      official.status?.abstractGameState === 'Final' ||
      /final/i.test(String(official.status?.detailedState || ''));
    if (!done || hs == null || as == null) continue;
    if (g.completed && g.home_score === hs && g.away_score === as) continue;
    updateById.run(hs, as, official.officialDate || day, g.id);
    mlbScoreSync.updated += 1;
  }
}
console.log('  mlbScoreSync', mlbScoreSync);

console.log(`[3/4] 回填缺特徵（MLB API enrich）${missingFeatFrom}~${todayHk}…`);
const existingFeatIds = new Set(
  db
    .prepare(
      `SELECT game_id FROM mlb_historical_feature_rows WHERE feature_version=?`
    )
    .all(MLB_BASELINE_FEATURE_VERSION)
    .map((r) => r.game_id)
);

const built = buildMlbHistoricalFeatureRows({ from: missingFeatFrom }).filter(
  (r) => hk(r.commenceTime) <= todayHk && !existingFeatIds.has(r.gameId)
);
console.log('  new team-feature rows to enrich', built.length);

// 熱身列：既有特徵（enrich 用，不強制覆寫）
const warmupRows = db
  .prepare(
    `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
            f.home_win AS homeWin, g.home_team AS homeTeam, g.away_team AS awayTeam,
            g.official_date AS officialDate
     FROM mlb_historical_feature_rows f
     JOIN games g ON g.id = f.game_id
     WHERE f.feature_version = ?
       AND date(f.commence_time) >= date(?)
       AND date(f.commence_time) < date(?)
     ORDER BY f.commence_time`
  )
  .all(MLB_BASELINE_FEATURE_VERSION, enrichFrom, missingFeatFrom)
  .map((r) => ({
    gameId: r.gameId,
    commenceTime: r.commenceTime,
    officialDate: r.officialDate,
    homeTeam: r.homeTeam,
    awayTeam: r.awayTeam,
    features: JSON.parse(r.featuresJson),
    homeWin: r.homeWin,
  }));

const toEnrich = [...warmupRows, ...built].sort(
  (a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime)
);
console.log('  enrich batch size', toEnrich.length, '(含熱身', warmupRows.length, ')');

let persisted = 0;
if (built.length) {
  const enrichedAll = await enrichRowsWithHistoricalPitchers(toEnrich, {
    concurrency: 4,
  });
  const newIds = new Set(built.map((r) => r.gameId));
  const toPersist = enrichedAll.filter((r) => newIds.has(r.gameId));
  persistMlbHistoricalFeatureRows(toPersist, { replaceVersion: false });
  persisted = toPersist.length;
  console.log('  persisted', persisted);
} else {
  console.log('  無需回填');
}

console.log(`[4/4] 重放鎖定 B ${fromHk}~${todayHk}…`);
const model = getLatestMlbExpectedRunsValidation().model;

function books(g, c, h, a) {
  const pit = resolvePitOdds(g, c);
  if (!pit?.bookmakers?.length) return [];
  const out = [];
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const home =
      m.outcomes.find((o) => o.name === h) ||
      m.outcomes.find((o) => String(o.name).includes(String(h).split(' ').pop()));
    const away =
      m.outcomes.find((o) => o.name === a) ||
      m.outcomes.find((o) => String(o.name).includes(String(a).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const ho = +home.price;
    const ao = +away.price;
    if (!Number.isFinite(ho) || !Number.isFinite(ao)) continue;
    out.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao });
  }
  return out;
}

const featRows = db
  .prepare(
    `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
            g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
     FROM mlb_historical_feature_rows f
     JOIN games g ON g.id = f.game_id
     WHERE f.feature_version = ?
       AND g.completed = 1
       AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
       AND date(f.commence_time) >= date(?)
       AND date(f.commence_time) <= date(?)
     ORDER BY f.commence_time`
  )
  .all(MLB_BASELINE_FEATURE_VERSION, fromHk, todayHk);

const candidates = [];
let skip = {
  badScore: 0,
  noBooks: 0,
  noPitcher: 0,
  badVector: 0,
  gates: 0,
};

for (const row of featRows) {
  const hs = +row.homeScore;
  const as = +row.awayScore;
  if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) {
    skip.badScore += 1;
    continue;
  }
  let features;
  try {
    features = JSON.parse(row.featuresJson);
  } catch {
    skip.badVector += 1;
    continue;
  }
  const pitchers = features?.pitchers || {};
  if (
    (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
    (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
  ) {
    skip.noPitcher += 1;
    continue;
  }
  const homeVec = buildMlbExpectedRunsSideFeatures(features, 'home');
  const awayVec = buildMlbExpectedRunsSideFeatures(features, 'away');
  if (!MLB_EXPECTED_RUNS_FEATURE_KEYS.every((k) => Number.isFinite(homeVec[k]))) {
    skip.badVector += 1;
    continue;
  }
  if (!MLB_EXPECTED_RUNS_FEATURE_KEYS.every((k) => Number.isFinite(awayVec[k]))) {
    skip.badVector += 1;
    continue;
  }
  const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
  if (bs.length < 2) {
    skip.noBooks += 1;
    continue;
  }
  bs.sort((a, b) => a.vig - b.vig);
  const best = bs[0];
  if (best.homeOdds < 1.2 || best.awayOdds < 1.2) {
    skip.noBooks += 1;
    continue;
  }

  const ph = predictMlbExpectedRunsMean(model, homeVec);
  const pa = predictMlbExpectedRunsMean(model, awayVec);
  const dist = buildMlbScoreDistribution({
    homeMean: ph,
    awayMean: pa,
    homeDispersion: model.dispersion,
    awayDispersion: model.dispersion,
  });
  const markets = calibrateMlbScoreMarkets(
    deriveMlbScoreMarkets(dist, { totalLine: 8.5 }),
    model.moneylineTemperature ?? 1
  );
  const pickHome = ph >= pa;
  const modelProb = pickHome
    ? +markets.homeWinProbability
    : +markets.awayWinProbability;
  const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
  if (pickOdds < 1.4 || pickOdds > 2.3) {
    skip.gates += 1;
    continue;
  }
  const sig = buildPregameRegimeSignals(features);
  const pickEarly = pickHome
    ? +sig.homeEarlyExitsLast3 || 0
    : +sig.awayEarlyExitsLast3 || 0;
  const oppEarly = pickHome
    ? +sig.awayEarlyExitsLast3 || 0
    : +sig.homeEarlyExitsLast3 || 0;
  if (pickEarly > oppEarly) {
    skip.gates += 1;
    continue;
  }
  const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
  const margin = Math.abs(ph - pa);
  if (ev < B.minimumExpectedValue) {
    skip.gates += 1;
    continue;
  }
  if (margin < B.minimumExpectedRunMargin) {
    skip.gates += 1;
    continue;
  }
  if (modelProb < B.minimumModelProbability) {
    skip.gates += 1;
    continue;
  }
  if (pickOdds < B.minimumPickOdds || pickOdds > B.maximumPickOdds) {
    skip.gates += 1;
    continue;
  }
  const bScore = scoreMlbMoneylineDailyRank(
    { expectedValue: ev, modelProbability: modelProb },
    B
  );
  const pick = pickHome ? row.homeTeam : row.awayTeam;
  const hit = pickHome ? hs > as : as > hs;
  candidates.push({
    day: hk(row.commenceTime),
    gameId: row.gameId,
    matchup: `${row.awayTeam} @ ${row.homeTeam}`,
    pick,
    pickOdds,
    modelProb,
    ev,
    margin,
    bScore,
    hit,
    profitUnits: hit ? pickOdds - 1 : -1,
  });
}

const byDay = new Map();
for (const c of candidates) {
  if (!byDay.has(c.day)) byDay.set(c.day, []);
  byDay.get(c.day).push(c);
}

const picks = [];
for (const day of [...byDay.keys()].sort()) {
  let slots = [...byDay.get(day)]
    .sort((a, b) => b.bScore - a.bScore || b.margin - a.margin)
    .slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
  if (
    slots.length >= 2 &&
    slots[1].pickOdds >= 1.85 &&
    slots[1].pickOdds < 1.95
  ) {
    slots = [slots[0], ...slots.slice(2)];
  }
  slots.forEach((s, i) => picks.push({ ...s, rank: i + 1 }));
}

// 合併紙上帳對照
const paper = db
  .prepare(
    `SELECT p.pick, p.odds_decimal, p.result, p.profit_units, g.commence_time,
            g.home_team, g.away_team
     FROM mlb_paper_bets p JOIN games g ON g.id = p.game_id
     WHERE p.market='h2h' AND p.result IN ('win','loss')
       AND date(g.commence_time) >= date(?) AND date(g.commence_time) <= date(?)`
  )
  .all(fromHk, todayHk);

let cum = 0;
let wins = 0;
let losses = 0;
const dayLines = [];

console.log('');
console.log(`重放鎖定 B（API 補特徵後） ${fromHk} ~ ${todayHk} @$50`);
console.log('日期       | 有單? | W-L  | 命中  | 當日$  | 累計$  | 明細');
console.log('-'.repeat(110));

for (let i = 0; i < 30; i += 1) {
  const d = addDays(fromHk, i);
  const dayPicks = picks.filter((p) => p.day === d);
  let w = 0;
  let l = 0;
  let dayU = 0;
  const parts = [];
  for (const p of dayPicks) {
    if (p.hit) w += 1;
    else l += 1;
    dayU += p.profitUnits;
    const usd = Math.round(p.profitUnits * STAKE);
    parts.push(
      `${p.matchup}→${p.pick}@${p.pickOdds.toFixed(2)} ${p.hit ? 'W' : 'L'}(${usd > 0 ? '+' : ''}${usd})`
    );
  }
  cum += dayU;
  wins += w;
  losses += l;
  const dayUsd = Math.round(dayU * STAKE);
  const cumUsd = Math.round(cum * STAKE);
  const has = dayPicks.length > 0;
  const hr = w + l ? `${Math.round((w / (w + l)) * 100)}%` : '-';
  const dayStr = has ? (dayUsd > 0 ? `+${dayUsd}` : `${dayUsd}`) : '0';
  const cumStr = cumUsd > 0 ? `+${cumUsd}` : `${cumUsd}`;
  const line = `${d} | ${has ? '有' : '無'}    | ${String(has ? `${w}-${l}` : '-').padEnd(4)} | ${hr.padEnd(4)} | ${String(dayStr).padStart(6)} | ${cumStr.padStart(6)} | ${parts.join('； ') || '-'}`;
  console.log(line);
  dayLines.push({
    day: d,
    bets: dayPicks.length,
    w,
    l,
    hitRate: w + l ? w / (w + l) : null,
    usd50: dayUsd,
    cumUsd50: cumUsd,
    picks: dayPicks,
  });
}

const decided = wins + losses;
const usd = Math.round(cum * STAKE);
let paperU = 0;
let paperW = 0;
let paperL = 0;
for (const p of paper) {
  if (p.result === 'win') paperW += 1;
  else paperL += 1;
  paperU += Number(p.profit_units) || 0;
}

const summary = {
  window: { from: fromHk, to: todayHk },
  api: { oddsScores, mlbScoreSync, newFeaturesPersisted: persisted },
  replaySkip: skip,
  featureRowsInWindow: featRows.length,
  lockedB: {
    bets: decided,
    wins,
    losses,
    hitRate: decided ? Number((wins / decided).toFixed(4)) : null,
    usd50: usd,
    verdict: usd > 0 ? '正數' : usd < 0 ? '負數' : '打平',
    daysWithBets: dayLines.filter((d) => d.bets > 0).length,
  },
  livePaperCompare: {
    bets: paperW + paperL,
    wins: paperW,
    losses: paperL,
    hitRate: paperW + paperL ? Number((paperW / (paperW + paperL)).toFixed(4)) : null,
    usd50: Math.round(paperU * STAKE),
    verdict: paperU > 0 ? '正數' : paperU < 0 ? '負數' : '打平',
  },
  days: dayLines,
};

fs.writeFileSync(
  new URL('../tmp-last30d-locked-b-api-replay.json', import.meta.url),
  JSON.stringify(summary, null, 2)
);

console.log('-'.repeat(110));
console.log(
  JSON.stringify(
    {
      lockedB_replay: summary.lockedB,
      live_paper_same_window: summary.livePaperCompare,
      featureRowsInWindow: featRows.length,
      skip,
      wrote: 'tmp-last30d-locked-b-api-replay.json',
    },
    null,
    2
  )
);
