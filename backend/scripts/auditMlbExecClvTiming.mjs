/**
 * 實驗 1（Grok）：exec_clv_timing
 * 鎖定 B 影子選注 + 賠率軌跡／換投 → 執行層「逆向移動／換投可撤」對照
 * 不改選注常數
 *
 * 用法: node scripts/auditMlbExecClvTiming.mjs
 * 產物: tmp-exec-clv-timing.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { buildFrozenBShadowPickSets } from '../src/services/MlbFrozenBShadow.js';

const STAKE = 50;
const ADVERSE_IMPLIED_PP = 0.03; // 隱含機率對我方下降 ≥3pp
const T_RELEASE_H = 8;

function parseBooks(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function bestPickOdds(bookmakers, pick, homeTeam, awayTeam) {
  let best = null;
  for (const book of bookmakers || []) {
    const m = (book.markets || []).find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const sel = m.outcomes.find((o) => o.name === pick);
    const oppName = pick === homeTeam ? awayTeam : homeTeam;
    const opp = m.outcomes.find((o) => o.name === oppName);
    if (!sel?.price || !opp?.price) continue;
    const price = Number(sel.price);
    if (!Number.isFinite(price)) continue;
    // 取對選邊最優（最高）價，贴近可成交
    if (best == null || price > best) best = price;
  }
  return best;
}

function oddsNear(gameId, homeTeam, awayTeam, pick, targetIso, windowHours = 1.5) {
  const targetMs = Date.parse(targetIso);
  if (!Number.isFinite(targetMs)) return null;
  const from = new Date(targetMs - windowHours * 3600e3).toISOString();
  const to = new Date(targetMs + windowHours * 3600e3).toISOString();
  const rows = db
    .prepare(
      `SELECT captured_at, bookmakers_json
       FROM odds_snapshots
       WHERE game_id = ?
         AND datetime(captured_at) >= datetime(?)
         AND datetime(captured_at) <= datetime(?)
         AND source NOT LIKE '%_post_start'
       ORDER BY captured_at`
    )
    .all(gameId, from, to);
  if (!rows.length) {
    // 放寬：取 target 前最近一筆
    const prev = db
      .prepare(
        `SELECT captured_at, bookmakers_json
         FROM odds_snapshots
         WHERE game_id = ?
           AND datetime(captured_at) <= datetime(?)
           AND source NOT LIKE '%_post_start'
         ORDER BY datetime(captured_at) DESC
         LIMIT 1`
      )
      .get(gameId, targetIso);
    if (!prev) return null;
    const odds = bestPickOdds(parseBooks(prev.bookmakers_json), pick, homeTeam, awayTeam);
    if (odds == null) return null;
    return { at: prev.captured_at, odds, mode: 'prev' };
  }
  let best = null;
  let bestAbs = Infinity;
  for (const r of rows) {
    const abs = Math.abs(Date.parse(r.captured_at) - targetMs);
    if (abs < bestAbs) {
      bestAbs = abs;
      best = r;
    }
  }
  const odds = bestPickOdds(parseBooks(best.bookmakers_json), pick, homeTeam, awayTeam);
  if (odds == null) return null;
  return { at: best.captured_at, odds, mode: 'near', lagMin: Math.round(bestAbs / 60000) };
}

function closingOdds(gameId, homeTeam, awayTeam, pick, commenceTime) {
  const row = db
    .prepare(
      `SELECT captured_at, bookmakers_json
       FROM odds_snapshots
       WHERE game_id = ?
         AND datetime(captured_at) < datetime(?)
         AND source NOT LIKE '%_post_start'
       ORDER BY datetime(captured_at) DESC
       LIMIT 1`
    )
    .get(gameId, commenceTime);
  if (!row) return null;
  const odds = bestPickOdds(parseBooks(row.bookmakers_json), pick, homeTeam, awayTeam);
  if (odds == null) return null;
  return { at: row.captured_at, odds };
}

function starterTimeline(gameId) {
  return db
    .prepare(
      `SELECT captured_at, home_pitcher_name, away_pitcher_name, status
       FROM mlb_probable_starter_snapshots
       WHERE game_id = ?
       ORDER BY captured_at`
    )
    .all(gameId);
}

function pitcherChangedAfter(gameId, afterIso) {
  const rows = starterTimeline(gameId);
  if (rows.length < 2) return { changed: false, detail: null };
  const afterMs = Date.parse(afterIso);
  let ref = null;
  for (const r of rows) {
    const t = Date.parse(r.captured_at);
    if (Number.isFinite(afterMs) && t <= afterMs) ref = r;
  }
  if (!ref) ref = rows[0];
  const last = rows[rows.length - 1];
  const changed =
    (ref.home_pitcher_name || '') !== (last.home_pitcher_name || '') ||
    (ref.away_pitcher_name || '') !== (last.away_pitcher_name || '');
  return {
    changed,
    detail: changed
      ? {
          from: { home: ref.home_pitcher_name, away: ref.away_pitcher_name, at: ref.captured_at },
          to: { home: last.home_pitcher_name, away: last.away_pitcher_name, at: last.captured_at },
        }
      : null,
  };
}

function summarize(bets, stake = STAKE) {
  if (!bets.length) {
    return { bets: 0, hits: 0, hitRate: null, roi: null, usd50: 0, avgClvPp: null, highEvLossShare: null };
  }
  let hits = 0;
  let unit = 0;
  let clvSum = 0;
  let clvN = 0;
  let highEv = 0;
  let highEvLoss = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.entryOdds - 1;
    } else unit -= 1;
    if (Number.isFinite(b.clvPp)) {
      clvSum += b.clvPp;
      clvN += 1;
    }
    if ((b.ev ?? 0) >= 0.08) {
      highEv += 1;
      if (!b.hit) highEvLoss += 1;
    }
  }
  const n = bets.length;
  return {
    bets: n,
    hits,
    hitRate: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * stake),
    avgClvPp: clvN ? Number(((clvSum / clvN) * 100).toFixed(2)) : null,
    clvN,
    highEvLossShare: highEv ? Number((highEvLoss / highEv).toFixed(4)) : null,
    highEvN: highEv,
  };
}

function byYear(bets) {
  const out = {};
  for (const y of ['2024', '2025', '2026']) {
    out[y] = summarize(bets.filter((b) => b.window === y));
  }
  return out;
}

console.log('Loading locked B shadow picks…');
const { shadow } = buildFrozenBShadowPickSets({});
console.log('picks', shadow.length);

const enriched = [];
let missT8 = 0;
let missClose = 0;
let missGame = 0;

for (const b of shadow) {
  const g = db
    .prepare(
      `SELECT id, home_team, away_team, commence_time FROM games WHERE id = ?`
    )
    .get(b.gameId);
  if (!g) {
    missGame += 1;
    continue;
  }
  const commenceMs = Date.parse(g.commence_time);
  const t8Iso = new Date(commenceMs - T_RELEASE_H * 3600e3).toISOString();
  const atT8 = oddsNear(g.id, g.home_team, g.away_team, b.pick, t8Iso, 2);
  const atClose = closingOdds(g.id, g.home_team, g.away_team, b.pick, g.commence_time);
  if (!atT8) missT8 += 1;
  if (!atClose) missClose += 1;
  if (!atT8 || !atClose) continue;

  const entryOdds = atT8.odds;
  const closeOdds = atClose.odds;
  const entryImp = 1 / entryOdds;
  const closeImp = 1 / closeOdds;
  // CLV：收盤隱含相對進場 — 正＝進場價優於收盤（市場後來更不看好我方＝我方拿了好價？）
  // 標準 CLV：若收盤賠率變短（更熱），我方早拿到較長價 → 正 CLV
  // clvPp = closeImp - entryImp；收盤隱含升＝市場更看好我方＝我進場時價較差 → 負？
  // 常用：CLV = entry implied vs close implied for the bet — positive if close implied > entry implied means market moved toward our side after we bet (we got worse price than close). Actually:
  // Positive CLV traditionally: you beat the closing line = your odds were longer than close = entryOdds > closeOdds = entryImp < closeImp → closeImp - entryImp > 0
  const clvPp = closeImp - entryImp;
  // 逆向（不利）：收盤對我方隱含下降（變長）≥ 3pp → 市場離開我方
  const adverseMove = entryImp - closeImp >= ADVERSE_IMPLIED_PP;
  const pitch = pitcherChangedAfter(g.id, t8Iso);

  enriched.push({
    gameId: b.gameId,
    window: b.window,
    day: b.day,
    pick: b.pick,
    pickHome: b.pickHome,
    hit: b.hit,
    ev: b.ev,
    modelProb: b.modelProb,
    rank: b.rank,
    entryOdds,
    closeOdds,
    entryImp,
    closeImp,
    clvPp,
    adverseMove,
    pitcherChanged: pitch.changed,
    pitcherDetail: pitch.detail,
    highEv: (b.ev ?? 0) >= 0.08,
  });
}

console.log('enriched', enriched.length, 'missT8', missT8, 'missClose', missClose, 'missGame', missGame);

const holdAll = enriched.map((b) => ({ ...b }));
const skipAdverse = enriched.filter((b) => !b.adverseMove);
const skipPitch = enriched.filter((b) => !b.pitcherChanged);
const skipEither = enriched.filter((b) => !b.adverseMove && !b.pitcherChanged);
const skipAdverseOrPitch = skipEither;

const variants = {
  hold_all: summarize(holdAll),
  skip_adverse_3pp: summarize(skipAdverse),
  skip_pitcher_change: summarize(skipPitch),
  skip_adverse_or_pitcher: summarize(skipAdverseOrPitch),
};

const yearsHold = byYear(holdAll);
const yearsSkip = byYear(skipAdverseOrPitch);

const highEvHold = holdAll.filter((b) => b.highEv);
const highEvSkip = skipAdverseOrPitch.filter((b) => b.highEv);

const deltaUsd = variants.skip_adverse_or_pitcher.usd50 - variants.hold_all.usd50;
const y2026Ok = (yearsSkip['2026'].roi ?? -1) >= 0;
const highEvLossDown =
  (variants.skip_adverse_or_pitcher.highEvLossShare ?? 1) <=
  (variants.hold_all.highEvLossShare ?? 1) + 1e-9;

const pass =
  enriched.length >= 40 &&
  deltaUsd >= 0 &&
  y2026Ok &&
  ['2024', '2025', '2026'].every((y) => (yearsSkip[y].roi ?? -1) >= 0) &&
  highEvLossDown;

const out = {
  experimentId: 'exec_clv_timing',
  grokRef: 'optimize_execution first',
  params: {
    releaseHours: T_RELEASE_H,
    adverseImpliedPp: ADVERSE_IMPLIED_PP,
    stake: STAKE,
    entryProxy: 'odds nearest T-8 (or prev)',
    closeProxy: 'last prematch odds snapshot',
  },
  coverage: {
    shadowPicks: shadow.length,
    withClvPath: enriched.length,
    missT8,
    missClose,
    missGame,
    adverseCount: enriched.filter((b) => b.adverseMove).length,
    pitcherChangeCount: enriched.filter((b) => b.pitcherChanged).length,
    eitherFlagCount: enriched.filter((b) => b.adverseMove || b.pitcherChanged).length,
  },
  variants,
  byYear: { hold_all: yearsHold, skip_adverse_or_pitcher: yearsSkip },
  highEvSubset: {
    hold: summarize(highEvHold),
    skip: summarize(highEvSkip),
  },
  delta: {
    usd50: deltaUsd,
    keepRate: enriched.length
      ? Number((skipAdverseOrPitch.length / enriched.length).toFixed(3))
      : null,
    avgClvPpHold: variants.hold_all.avgClvPp,
    avgClvPpSkip: variants.skip_adverse_or_pitcher.avgClvPp,
    highEvLossShareHold: variants.hold_all.highEvLossShare,
    highEvLossShareSkip: variants.skip_adverse_or_pitcher.highEvLossShare,
  },
  passFail: {
    minSample40: enriched.length >= 40,
    deltaUsdNonNeg: deltaUsd >= 0,
    y2026NonNeg: y2026Ok,
    allWindowsNonNeg: ['2024', '2025', '2026'].every((y) => (yearsSkip[y].roi ?? -1) >= 0),
    highEvLossShareDown: highEvLossDown,
    overall: pass,
  },
  verdict: pass
    ? 'PASS — 執行層「逆向≥3pp 或換投可撤」影子可繼續觀察／可當紀律'
    : 'FAIL/REVIEW — 見 passFail；暫勿升格為正式撤單規則',
};

fs.writeFileSync(
  new URL('../tmp-exec-clv-timing.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log(JSON.stringify({ coverage: out.coverage, variants: out.variants, delta: out.delta, passFail: out.passFail, verdict: out.verdict }, null, 2));
console.log('wrote tmp-exec-clv-timing.json');
