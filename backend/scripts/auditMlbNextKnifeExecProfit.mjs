/**
 * 下一刀：執行層是否推盈利（24/25/26 真實賽果）
 * 不改鎖定 B 選邊；只測「何時下／何時跳過」
 *
 * 用法: node scripts/auditMlbNextKnifeExecProfit.mjs
 * 產物: tmp-next-knife-exec-profit.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { buildFrozenBShadowPickSets } from '../src/services/MlbFrozenBShadow.js';

const STAKE = 50;
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
    if (best == null || price > best) best = price;
  }
  return best;
}

function oddsNear(gameId, homeTeam, awayTeam, pick, targetIso, windowHours = 2) {
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
  return {
    at: best.captured_at,
    odds,
    mode: 'near',
    lagMin: Math.round(bestAbs / 60000),
  };
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

function pitcherChangedAfter(gameId, afterIso) {
  const rows = db
    .prepare(
      `SELECT captured_at, home_pitcher_name, away_pitcher_name
       FROM mlb_probable_starter_snapshots
       WHERE game_id = ?
       ORDER BY captured_at`
    )
    .all(gameId);
  if (rows.length < 2) return { changed: false };
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
  return { changed };
}

function unitAtOdds(hit, odds) {
  return hit ? odds - 1 : -1;
}

function summarize(bets, oddsKey = 'fillOdds') {
  if (!bets.length) {
    return { bets: 0, hits: 0, hitRate: null, roi: null, usd50: 0 };
  }
  let hits = 0;
  let unit = 0;
  for (const b of bets) {
    const odds = Number(b[oddsKey] ?? b.entryOdds ?? b.pickOdds);
    if (b.hit) hits += 1;
    unit += unitAtOdds(b.hit, odds);
  }
  const n = bets.length;
  return {
    bets: n,
    hits,
    hitRate: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
  };
}

function byYear(bets, oddsKey = 'fillOdds') {
  const out = {};
  for (const y of ['2024', '2025', '2026']) {
    out[y] = summarize(
      bets.filter((b) => b.window === y || String(b.month).startsWith(y)),
      oddsKey
    );
  }
  return out;
}

function gate(base, alt, yearsAlt) {
  const delta = alt.usd50 - base.usd50;
  const yearsOk = ['2024', '2025', '2026'].every(
    (y) => (yearsAlt[y].usd50 ?? 0) - (byYear.base?.[y]?.usd50 ?? 0) >= -80
  );
  // year check vs base years passed in
  return {
    deltaUsd: delta,
    totalPositive: delta > 0,
    keepVolume: alt.bets >= base.bets * 0.85,
    pass: delta > 0 && alt.bets >= Math.min(40, base.bets * 0.5),
  };
}

console.log('Loading locked B picks…');
const { shadow } = buildFrozenBShadowPickSets({});

const rows = [];
let miss = { game: 0, t8: 0, close: 0 };

for (const b of shadow) {
  const g = db
    .prepare(
      `SELECT id, home_team, away_team, commence_time FROM games WHERE id = ?`
    )
    .get(b.gameId);
  if (!g) {
    miss.game += 1;
    continue;
  }
  const commenceMs = Date.parse(g.commence_time);
  const t8Iso = new Date(commenceMs - T_RELEASE_H * 3600e3).toISOString();
  const atT8 = oddsNear(g.id, g.home_team, g.away_team, b.pick, t8Iso, 2);
  const atClose = closingOdds(
    g.id,
    g.home_team,
    g.away_team,
    b.pick,
    g.commence_time
  );
  if (!atT8) miss.t8 += 1;
  if (!atClose) miss.close += 1;
  if (!atT8 || !atClose) continue;

  const selOdds = Number(b.pickOdds);
  const entryOdds = atT8.odds;
  const closeOdds = atClose.odds;
  const entryImp = 1 / entryOdds;
  const closeImp = 1 / closeOdds;
  const clvPp = closeImp - entryImp; // >0 beat close
  const adverse1 = entryImp - closeImp >= 0.01;
  const adverse3 = entryImp - closeImp >= 0.03;
  const pitch = pitcherChangedAfter(g.id, t8Iso);
  // T-8 價已比選注價明顯變差（被降水）
  const steamedBeforeFill = entryOdds < selOdds * 0.97;
  // T-8 價比選注價更好（升水）
  const lengthenedBeforeFill = entryOdds > selOdds * 1.03;

  rows.push({
    gameId: b.gameId,
    window: b.window,
    month: b.month,
    day: b.day,
    hit: b.hit,
    pickOdds: selOdds,
    fillOdds: entryOdds,
    closeOdds,
    clvPp,
    adverse1,
    adverse3,
    pitcherChanged: pitch.changed,
    t8Mode: atT8.mode,
    steamedBeforeFill,
    lengthenedBeforeFill,
  });
}

console.log('usable', rows.length, 'miss', miss);

const baseSel = summarize(rows, 'pickOdds'); // 選注價結算（現行回放）
const baseT8 = summarize(rows, 'fillOdds'); // 若都在 T-8 成交
const yearsSel = byYear(rows, 'pickOdds');
const yearsT8 = byYear(rows, 'fillOdds');

const policies = [
  {
    id: 'skip_adverse_1pp',
    keep: (b) => !b.adverse1,
    oddsKey: 'pickOdds',
  },
  {
    id: 'skip_adverse_3pp',
    keep: (b) => !b.adverse3,
    oddsKey: 'pickOdds',
  },
  {
    id: 'skip_pitcher_change',
    keep: (b) => !b.pitcherChanged,
    oddsKey: 'pickOdds',
  },
  {
    id: 'skip_adverse1_or_pitch',
    keep: (b) => !b.adverse1 && !b.pitcherChanged,
    oddsKey: 'pickOdds',
  },
  {
    id: 'skip_steamed_before_t8',
    keep: (b) => !b.steamedBeforeFill,
    oddsKey: 'pickOdds',
  },
  {
    id: 'only_near_t8_snap',
    keep: (b) => b.t8Mode === 'near',
    oddsKey: 'pickOdds',
  },
  {
    id: 'settle_at_t8_odds',
    keep: () => true,
    oddsKey: 'fillOdds',
    note: '不改選場，只假設成交價=T-8',
  },
];

const evaluated = [];
for (const p of policies) {
  const kept = rows.filter(p.keep);
  const s = summarize(kept, p.oddsKey);
  const y = byYear(kept, p.oddsKey);
  const base = p.oddsKey === 'fillOdds' ? baseT8 : baseSel;
  const baseY = p.oddsKey === 'fillOdds' ? yearsT8 : yearsSel;
  const delta = s.usd50 - base.usd50;
  const yearDeltas = {
    '2024': y['2024'].usd50 - baseY['2024'].usd50,
    '2025': y['2025'].usd50 - baseY['2025'].usd50,
    '2026': y['2026'].usd50 - baseY['2026'].usd50,
  };
  const yearsWithinTol = Object.values(yearDeltas).every((d) => d >= -80);
  const pass =
    delta > 0 &&
    yearsWithinTol &&
    s.bets >= 40 &&
    (s.bets >= base.bets * 0.7 || delta >= 150);
  evaluated.push({
    id: p.id,
    note: p.note || null,
    summary: s,
    byYear: y,
    deltaUsdVsBase: delta,
    yearDeltas,
    skipped: rows.length - kept.length,
    pass,
  });
}

evaluated.sort((a, b) => b.deltaUsdVsBase - a.deltaUsdVsBase);
const passers = evaluated.filter((e) => e.pass);
const best = evaluated[0];

const verdict = passers.length
  ? `PROFIT_PUSH_YES — 執行層候選過閘：${passers.map((p) => p.id).join(', ')}`
  : `PROFIT_PUSH_NO — 執行層各刀相對基線未能穩推盈利（或樣本／窗不穩）；不升格正式撤單／時點規則`;

const out = {
  experimentId: 'next_knife_exec_profit',
  thesis: '在鎖定 B 選邊不變下，用時點／CLV／換投規則能否推 @$50',
  coverage: { shadow: shadow.length, usable: rows.length, miss },
  baseline: {
    settleAtSelectionOdds: { ...baseSel, byYear: yearsSel },
    settleAtT8Odds: { ...baseT8, byYear: yearsT8 },
    timingValueUsd: baseT8.usd50 - baseSel.usd50,
    note: 'timingValueUsd>0 表示若都能在 T-8 成交，比選注價回放更好',
  },
  policies: evaluated,
  passers: passers.map((p) => p.id),
  best: { id: best.id, deltaUsd: best.deltaUsdVsBase, pass: best.pass },
  verdict,
  action: passers.length
    ? '可開執行影子觀察（仍不改推送選邊）；活體台帳繼續積'
    : '執行層暫不寫規則；繼續積活體 CLV；日常仍 T-8～T-6 跟鎖定 B',
};

fs.writeFileSync(
  new URL('../tmp-next-knife-exec-profit.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log(
  JSON.stringify(
    {
      usable: rows.length,
      timingValueUsd: out.baseline.timingValueUsd,
      policies: evaluated.map((e) => ({
        id: e.id,
        delta: e.deltaUsdVsBase,
        bets: e.summary.bets,
        skipped: e.skipped,
        yearDeltas: e.yearDeltas,
        pass: e.pass,
      })),
      verdict: out.verdict,
      action: out.action,
    },
    null,
    2
  )
);
console.log('wrote tmp-next-knife-exec-profit.json');
