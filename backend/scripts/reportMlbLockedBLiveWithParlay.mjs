/**
 * 鎖定 B 活體單場 + 同日 2/3 串復盤摘要
 * 串關規則對齊 UI：2 串＝可看選邊中賠率≤2.10 取排名前兩腿；
 * 3 串＝當日已結算紙上腿≥3 時取排名前三（無 UI 正式 3 串；僅復盤對照）。
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { config } from '../src/config.js';
import { buildMlbPathGammaPaperReport } from '../src/services/MlbPaperLedger.js';

const SINGLE_STAKE = Number(config.mlbPaperFlatStakeUsd) || 75;
const PARLAY_STAKE = Number(config.parlayBetUsd) || 1;
const PARLAY_MAX_LEG_ODDS = 2.1;

function hkDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function parseAt(raw) {
  if (!raw) return NaN;
  return Date.parse(String(raw).includes('T') ? raw : `${String(raw).replace(' ', 'T')}Z`);
}

const settled = db
  .prepare(
    `SELECT p.*, g.commence_time, g.home_team, g.away_team, g.home_score, g.away_score,
            c.status AS cand_status, c.rejection_reasons_json
     FROM mlb_paper_bets p
     JOIN games g ON g.id = p.game_id
     LEFT JOIN mlb_paper_candidates c ON c.id = p.candidate_id
     WHERE p.result IN ('win', 'loss', 'push')
     ORDER BY g.commence_time ASC, p.id ASC`
  )
  .all();

const pending = db
  .prepare(`SELECT COUNT(*) AS n FROM mlb_paper_bets WHERE result = 'pending'`)
  .get().n;

function summarizeSingles(rows, stake = SINGLE_STAKE) {
  const decided = rows.filter((r) => r.result === 'win' || r.result === 'loss');
  const pushes = rows.filter((r) => r.result === 'push').length;
  const wins = decided.filter((r) => r.result === 'win').length;
  const losses = decided.length - wins;
  let profitUnits = 0;
  for (const r of decided) {
    const u = Number(r.stake_units) || 1;
    if (r.result === 'win') profitUnits += u * (Number(r.odds_decimal) - 1);
    else profitUnits -= u;
  }
  const stakedUnits = decided.reduce((s, r) => s + (Number(r.stake_units) || 1), 0);
  return {
    bets: decided.length,
    wins,
    losses,
    pushes,
    hitRate: decided.length ? wins / decided.length : null,
    avgOdds: decided.length
      ? decided.reduce((s, r) => s + Number(r.odds_decimal), 0) / decided.length
      : null,
    profitUnits: Number(profitUnits.toFixed(4)),
    stakedUnits,
    roi: stakedUnits ? profitUnits / stakedUnits : null,
    usd: Math.round(profitUnits * stake),
    stakeUsd: stake,
  };
}

/** 每日一注：用當日已結算紙上單，按 candidate 排名理由／開賽時間排序 */
function dailyBuckets(rows) {
  const byDay = new Map();
  for (const r of rows) {
    if (r.result !== 'win' && r.result !== 'loss') continue;
    const day = hkDate(r.commence_time);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  for (const [, list] of byDay) {
    list.sort((a, b) => {
      const ra = rankFromReasons(a.rejection_reasons_json);
      const rb = rankFromReasons(b.rejection_reasons_json);
      if (ra != null && rb != null && ra !== rb) return ra - rb;
      return parseAt(a.commence_time) - parseAt(b.commence_time);
    });
  }
  return byDay;
}

function rankFromReasons(json) {
  try {
    const arr = JSON.parse(json || '[]');
    const hit = arr.find((x) => /^daily_rank_(\d+)$/.test(String(x)));
    if (!hit) return null;
    return Number(String(hit).match(/^daily_rank_(\d+)$/)[1]);
  } catch {
    return null;
  }
}

function evalParlay(legs, stake = PARLAY_STAKE) {
  if (!legs?.length) return null;
  const combinedOdds = legs.reduce((p, l) => p * Number(l.odds_decimal), 1);
  const allWin = legs.every((l) => l.result === 'win');
  const anyLoss = legs.some((l) => l.result === 'loss');
  if (!allWin && !anyLoss) return null;
  const won = allWin;
  const profit = won ? stake * (combinedOdds - 1) : -stake;
  return {
    legs: legs.length,
    combinedOdds: Number(combinedOdds.toFixed(4)),
    result: won ? 'win' : 'loss',
    profitUsd: Number(profit.toFixed(2)),
    stakeUsd: stake,
    picks: legs.map((l) => `${l.pick}@${Number(l.odds_decimal).toFixed(2)}`).join(' × '),
    day: hkDate(legs[0].commence_time),
  };
}

function summarizeParlays(parlays) {
  if (!parlays.length) {
    return { bets: 0, wins: 0, losses: 0, hitRate: null, profitUsd: 0, stakeUsd: PARLAY_STAKE, avgCombinedOdds: null };
  }
  const wins = parlays.filter((p) => p.result === 'win').length;
  const profitUsd = parlays.reduce((s, p) => s + p.profitUsd, 0);
  return {
    bets: parlays.length,
    wins,
    losses: parlays.length - wins,
    hitRate: wins / parlays.length,
    profitUsd: Number(profitUsd.toFixed(2)),
    stakedUsd: parlays.length * PARLAY_STAKE,
    roi: parlays.length ? profitUsd / (parlays.length * PARLAY_STAKE) : null,
    avgCombinedOdds:
      parlays.reduce((s, p) => s + p.combinedOdds, 0) / parlays.length,
    stakeUsd: PARLAY_STAKE,
  };
}

const byDay = dailyBuckets(settled);
const parlays2 = [];
const parlays3 = [];
const dayRows = [];

for (const [day, legs] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const singles = summarizeSingles(legs, SINGLE_STAKE);
  const legs2 = legs.filter((l) => Number(l.odds_decimal) <= PARLAY_MAX_LEG_ODDS).slice(0, 2);
  const p2 = legs2.length >= 2 ? evalParlay(legs2) : null;
  const p3 = legs.length >= 3 ? evalParlay(legs.slice(0, 3)) : null;
  if (p2) parlays2.push(p2);
  if (p3) parlays3.push(p3);
  dayRows.push({
    day,
    singleBets: legs.length,
    singlesHit: `${singles.wins}/${singles.bets}`,
    singlesUsd: singles.usd,
    picks: legs.map((l) => `${l.result === 'win' ? 'W' : 'L'} ${l.pick}@${Number(l.odds_decimal).toFixed(2)}`).join('; '),
    parlay2: p2
      ? `${p2.result} ${p2.combinedOdds} → $${p2.profitUsd}`
      : legs2.length < 2
        ? 'n/a(<2 legs≤2.10)'
        : 'n/a',
    parlay3: p3 ? `${p3.result} ${p3.combinedOdds} → $${p3.profitUsd}` : 'n/a(<3 singles)',
  });
}

const singlesAll = summarizeSingles(settled, SINGLE_STAKE);
const singlesAt2 = summarizeSingles(settled, 2);
const p2sum = summarizeParlays(parlays2);
const p3sum = summarizeParlays(parlays3);

const pathGamma = buildMlbPathGammaPaperReport({ stakeUsd: 50 });

const report = {
  generatedAt: new Date().toISOString(),
  note: {
    singlesStakeConfig: SINGLE_STAKE,
    parlayStakeConfig: PARLAY_STAKE,
    parlay2Rule: 'same-day settled paper legs with odds≤2.10, take top 2 by daily_rank/time',
    parlay3Rule: 'same-day settled paper legs ≥3, take top 3 (replay only; UI has no formal 3-leg)',
  },
  liveSingles: {
    pending,
    atConfigStake: singlesAll,
    atUsd2: singlesAt2,
    atUsd50: summarizeSingles(settled, 50),
    pathGammaOverallAt50: pathGamma.liveLedger?.overallAt50 || null,
    rolling7d: pathGamma.liveLedger?.rolling7d || null,
    byMonth: pathGamma.liveLedger?.byMonth || null,
  },
  liveParlay2: p2sum,
  liveParlay3: p3sum,
  combinedBookApprox: {
    explanation: `單場@$${SINGLE_STAKE} + 有組出的 2串@$${PARLAY_STAKE} + 有組出的 3串@$${PARLAY_STAKE}`,
    singlesUsd: singlesAll.usd,
    parlay2Usd: p2sum.profitUsd,
    parlay3Usd: p3sum.profitUsd,
    totalUsd: Number((singlesAll.usd + p2sum.profitUsd + p3sum.profitUsd).toFixed(2)),
  },
  combinedBookAtUserish: {
    explanation: '單場@$2 + 2串@$1 + 3串@$1（對齊專案業務預設量級）',
    singlesUsd: singlesAt2.usd,
    parlay2Usd: p2sum.profitUsd,
    parlay3Usd: p3sum.profitUsd,
    totalUsd: Number((singlesAt2.usd + p2sum.profitUsd + p3sum.profitUsd).toFixed(2)),
  },
  byDay: dayRows,
  parlay2Details: parlays2,
  parlay3Details: parlays3,
  historicalBaselineLock: {
    source: 'MLB-B-BASELINE-LOCK.md',
    bets: '~611',
    hitRate: '~55.32%',
    roi: '~13.1%',
    usd50: '~+$4007',
    window: '2024-04～09 + 2025-04～09 + 2026-04～07/22',
  },
};

fs.writeFileSync(
  new URL('../tmp-lockedb-live-with-parlay.json', import.meta.url),
  JSON.stringify(report, null, 2)
);

console.log('=== Locked B live + parlays ===');
console.log('SINGLES @config$', SINGLE_STAKE, singlesAll);
console.log('SINGLES @$2', singlesAt2);
console.log('PARLAY2 @$', PARLAY_STAKE, p2sum);
console.log('PARLAY3 @$', PARLAY_STAKE, p3sum);
console.log('COMBINED userish', report.combinedBookAtUserish);
console.log('COMBINED config singles', report.combinedBookApprox);
console.log('days', dayRows.length);
for (const d of dayRows) console.log(d.day, d.singlesHit, d.singlesUsd, '|2|', d.parlay2, '|3|', d.parlay3);
console.log('pending', pending);
console.log('wrote tmp-lockedb-live-with-parlay.json');
