/**
 * 用紙上候補 + 對應 snapshot 重放昨日獨贏 Top
 * 對照 skip 強主毒客（hwp≥0.62 EV≥10%）
 * 產物：tmp-replay-yesterday-skip-slate.json
 */
import fs from 'fs';
import db from '../src/db/database.js';

const FROM = '2026-08-05';
const TO = '2026-08-07';

function summarize(bets) {
  if (!bets.length) {
    return { bets: 0, wins: 0, losses: 0, hitRate: null, usd50: 0, record: null };
  }
  let wins = 0;
  let unit = 0;
  for (const b of bets) {
    if (b.hit) {
      wins += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    wins,
    losses: n - wins,
    hitRate: Number((wins / n).toFixed(4)),
    usd50: Math.round(unit * 50),
    record: `${wins}-${n - wins}`,
  };
}

function parseReasons(json) {
  try {
    return JSON.parse(json || '[]');
  } catch {
    return [];
  }
}

function dailyRank(reasons) {
  for (const r of reasons) {
    const m = String(r).match(/daily_rank_(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

/** 每個 game 取最後一筆已晉升／可看的候補（有 daily_rank） */
const cands = db
  .prepare(
    `SELECT c.id, c.game_id AS gameId, c.pick, c.odds_decimal AS odds, c.model_prob AS modelProb,
            c.market_prob AS marketProb, c.rejection_reasons_json AS reasonsJson,
            c.truth_snapshot_id AS snapId, c.created_at AS createdAt, c.status,
            g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS hs, g.away_score AS ascore,
            g.commence_time AS commenceTime, g.completed
     FROM mlb_paper_candidates c
     JOIN games g ON g.id = c.game_id
     WHERE c.market = 'h2h'
       AND date(g.commence_time) >= date(?) AND date(g.commence_time) <= date(?)
       AND c.rejection_reasons_json LIKE '%daily_rank_%'
     ORDER BY c.id`
  )
  .all(FROM, TO);

const byGame = new Map();
for (const c of cands) {
  const reasons = parseReasons(c.reasonsJson);
  const rank = dailyRank(reasons);
  if (!rank || rank > 3) continue;
  byGame.set(c.gameId, { ...c, reasons, rank });
}

const rows = [];
for (const c of byGame.values()) {
  const snap = db
    .prepare(
      `SELECT model_input_json AS j FROM mlb_prematch_truth_snapshots WHERE id = ?`
    )
    .get(c.snapId);
  let homeWinPct = null;
  let ev = null;
  let side = null;
  let muHome = null;
  let muAway = null;
  if (snap?.j) {
    try {
      const mi = JSON.parse(snap.j);
      const ml = mi.expectedRuns?.moneylineClassification;
      const pred = mi.expectedRuns?.prediction;
      homeWinPct =
        Number(ml?.homeWinPct) ||
        Number(pred?.lockedBOverlay?.homeWinPct) ||
        null;
      ev = Number(ml?.expectedValue);
      side = ml?.side || null;
      muHome = pred?.homeExpectedRuns;
      muAway = pred?.awayExpectedRuns;
    } catch {
      /* ignore */
    }
  }
  const pickHome = c.pick === c.homeTeam;
  if (!side) side = pickHome ? 'home' : 'away';
  if (!Number.isFinite(ev) && Number.isFinite(c.modelProb) && Number.isFinite(c.odds)) {
    ev = c.modelProb * (c.odds - 1) - (1 - c.modelProb);
  }
  const hit =
    c.completed && c.hs != null && c.ascore != null && Number(c.hs) !== Number(c.ascore)
      ? pickHome
        ? Number(c.hs) > Number(c.ascore)
        : Number(c.ascore) > Number(c.hs)
      : null;
  const toxicAway =
    side === 'away' &&
    homeWinPct != null &&
    homeWinPct >= 0.62 &&
    Number(ev) >= 0.1;

  rows.push({
    gameId: c.gameId,
    day: new Date(c.commenceTime).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Hong_Kong',
    }),
    rank: c.rank,
    matchup: `${c.awayTeam} @ ${c.homeTeam}`,
    pick: c.pick,
    side,
    pickOdds: Number(c.odds),
    modelProb: Number(c.modelProb),
    ev: Number(ev),
    homeWinPct,
    muHome,
    muAway,
    toxicAway,
    hit,
    final: c.hs != null ? `${c.ascore}-${c.hs}` : null,
    status: c.status,
  });
}

// 按日重排 Top：official = 原 rank；skip = 去掉 toxic 後同日其餘候補補位
const allRankedCands = db
  .prepare(
    `SELECT c.id, c.game_id AS gameId, c.pick, c.odds_decimal AS odds, c.model_prob AS modelProb,
            c.rejection_reasons_json AS reasonsJson, c.truth_snapshot_id AS snapId,
            g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS hs, g.away_score AS ascore,
            g.commence_time AS commenceTime, g.completed
     FROM mlb_paper_candidates c
     JOIN games g ON g.id = c.game_id
     WHERE c.market = 'h2h'
       AND date(g.commence_time) >= date(?) AND date(g.commence_time) <= date(?)
       AND c.rejection_reasons_json LIKE '%daily_rank_%'
     ORDER BY c.id`
  )
  .all(FROM, TO);

/** gameId -> 最佳（最大 id）候補詳情 */
const enriched = new Map();
for (const c of allRankedCands) {
  const reasons = parseReasons(c.reasonsJson);
  const rank = dailyRank(reasons);
  if (!rank) continue;
  const snap = db
    .prepare(`SELECT model_input_json AS j FROM mlb_prematch_truth_snapshots WHERE id = ?`)
    .get(c.snapId);
  let homeWinPct = null;
  let ev = null;
  let side = null;
  if (snap?.j) {
    try {
      const mi = JSON.parse(snap.j);
      const ml = mi.expectedRuns?.moneylineClassification;
      const pred = mi.expectedRuns?.prediction;
      homeWinPct =
        Number(ml?.homeWinPct) ||
        Number(pred?.lockedBOverlay?.homeWinPct) ||
        null;
      ev = Number(ml?.expectedValue);
      side = ml?.side;
    } catch {
      /* */
    }
  }
  const pickHome = c.pick === c.homeTeam;
  if (!side) side = pickHome ? 'home' : 'away';
  if (!Number.isFinite(ev)) {
    ev = c.modelProb * (c.odds - 1) - (1 - c.modelProb);
  }
  const hit =
    c.completed && c.hs != null && Number(c.hs) !== Number(c.ascore)
      ? pickHome
        ? Number(c.hs) > Number(c.ascore)
        : Number(c.ascore) > Number(c.hs)
      : null;
  const toxicAway =
    side === 'away' && homeWinPct != null && homeWinPct >= 0.62 && ev >= 0.1;
  enriched.set(c.gameId, {
    gameId: c.gameId,
    day: new Date(c.commenceTime).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Hong_Kong',
    }),
    origRank: rank,
    matchup: `${c.awayTeam} @ ${c.homeTeam}`,
    pick: c.pick,
    side,
    pickOdds: Number(c.odds),
    modelProb: Number(c.modelProb),
    ev,
    homeWinPct,
    toxicAway,
    hit,
    final: c.hs != null ? `${c.ascore}-${c.hs}` : null,
  });
}

const officialTop = [...enriched.values()]
  .filter((r) => r.origRank <= 3)
  .sort((a, b) => a.day.localeCompare(b.day) || a.origRank - b.origRank);

// skip 後：同日去掉 toxic，按 origRank 遞補（用同日所有有 rank 的非 toxic）
const byDay = new Map();
for (const r of enriched.values()) {
  if (!byDay.has(r.day)) byDay.set(r.day, []);
  byDay.get(r.day).push(r);
}
const skipTop = [];
for (const day of [...byDay.keys()].sort()) {
  const list = byDay
    .get(day)
    .filter((r) => !r.toxicAway)
    .sort((a, b) => a.origRank - b.origRank)
    .slice(0, 3);
  list.forEach((r, i) => skipTop.push({ ...r, rank: i + 1 }));
}

const paper = db
  .prepare(
    `SELECT b.pick, b.odds_decimal AS odds, b.result, g.home_team, g.away_team,
            g.home_score AS hs, g.away_score AS ascore, g.commence_time
     FROM mlb_paper_bets b JOIN games g ON g.id = b.game_id
     WHERE b.market='h2h' AND date(g.commence_time) >= date(?) AND date(g.commence_time) <= date(?)
     ORDER BY b.id`
  )
  .all(FROM, TO);

const paperSkip = paper.filter((p) => {
  const e = [...enriched.values()].find(
    (x) => x.pick === p.pick && x.matchup.includes(p.home_team)
  );
  return !e?.toxicAway;
});

// totals from earlier snapshot replay logic - reuse quick query
const totSnaps = db
  .prepare(
    `SELECT s.game_id AS gameId, s.commence_time AS commenceTime, s.home_team AS homeTeam,
            s.away_team AS awayTeam, s.model_input_json AS j, g.home_score AS hs, g.away_score AS ascore, g.completed
     FROM mlb_prematch_truth_snapshots s
     JOIN games g ON g.id = s.game_id
     WHERE date(s.commence_time) >= date(?) AND date(s.commence_time) <= date(?)
       AND s.model_input_json IS NOT NULL
     ORDER BY s.id`
  )
  .all(FROM, TO);
const totByGame = new Map();
for (const s of totSnaps) totByGame.set(s.gameId, s);
const totPool = [];
for (const s of totByGame.values()) {
  let mi;
  try {
    mi = JSON.parse(s.j);
  } catch {
    continue;
  }
  const tot = mi.expectedRuns?.totalsSatelliteHybrid;
  if (!tot || tot.tier !== 'actionable') continue;
  const line = Number(tot.line);
  const total = Number(s.hs) + Number(s.ascore);
  let hit = null;
  if (s.completed && Number.isFinite(line) && total !== line) {
    hit = tot.side === 'under' ? total < line : total > line;
  }
  totPool.push({
    day: new Date(s.commenceTime).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Hong_Kong',
    }),
    matchup: `${s.awayTeam} @ ${s.homeTeam}`,
    pick: tot.pick,
    side: tot.side,
    pickOdds: Number(tot.oddsDecimal),
    ev: Number(tot.expectedValue),
    hit,
    actualTotal: Number.isFinite(total) ? total : null,
  });
}
const totByDay = new Map();
for (const t of totPool) {
  if (!totByDay.has(t.day)) totByDay.set(t.day, []);
  totByDay.get(t.day).push(t);
}
const totTop = [];
for (const day of [...totByDay.keys()].sort()) {
  [...totByDay.get(day)]
    .sort((a, b) => (b.ev || 0) - (a.ev || 0))
    .slice(0, 3)
    .forEach((t, i) => totTop.push({ ...t, rank: i + 1 }));
}

const o = summarize(officialTop.filter((r) => r.hit != null));
const sk = summarize(skipTop.filter((r) => r.hit != null));
const paperSum = summarize(
  paper
    .filter((p) => p.result === 'win' || p.result === 'loss')
    .map((p) => ({ hit: p.result === 'win', pickOdds: Number(p.odds) }))
);
const paperSkipSum = summarize(
  paper
    .filter((p) => p.result === 'win' || p.result === 'loss')
    .filter((p) => {
      const e = [...enriched.values()].find(
        (x) =>
          x.pick === p.pick &&
          (x.matchup.includes(p.home_team) || x.matchup.includes(p.away_team))
      );
      return !e?.toxicAway;
    })
    .map((p) => ({ hit: p.result === 'win', pickOdds: Number(p.odds) }))
);

const totSum = summarize(totTop.filter((t) => t.hit != null));
const combinedOfficial = summarize([
  ...officialTop.filter((r) => r.hit != null),
  ...totTop.filter((t) => t.hit != null),
]);
const combinedSkip = summarize([
  ...skipTop.filter((r) => r.hit != null),
  ...totTop.filter((t) => t.hit != null),
]);

const toxic = [...enriched.values()].filter((r) => r.toxicAway);

const report = {
  experimentId: 'replay-yesterday-skip-from-paper-candidates-2026-08-07',
  window: { from: FROM, to: TO },
  toxicAwayCaught: toxic.map((t) => ({
    matchup: t.matchup,
    pick: t.pick,
    homeWinPct: t.homeWinPct,
    ev: Number(Number(t.ev).toFixed(3)),
    origRank: t.origRank,
    hit: t.hit,
    final: t.final,
  })),
  moneyline: {
    officialTop: officialTop.map((r) => ({
      day: r.day,
      rank: r.origRank,
      matchup: r.matchup,
      pick: r.pick,
      odds: r.pickOdds,
      homeWinPct: r.homeWinPct,
      ev: Number(Number(r.ev).toFixed(3)),
      toxicAway: r.toxicAway,
      hit: r.hit,
      final: r.final,
    })),
    afterSkipTop: skipTop.map((r) => ({
      day: r.day,
      rank: r.rank,
      matchup: r.matchup,
      pick: r.pick,
      odds: r.pickOdds,
      homeWinPct: r.homeWinPct,
      ev: Number(Number(r.ev).toFixed(3)),
      hit: r.hit,
      final: r.final,
    })),
    official: o,
    afterSkip: sk,
    deltaUsd: sk.usd50 - o.usd50,
  },
  totalsTop3: {
    picks: totTop,
    summary: totSum,
  },
  combinedTop3plusTop3: {
    official: combinedOfficial,
    afterMlSkip: combinedSkip,
  },
  actualPaper: {
    all: paperSum,
    ifSkipToxicAwayBets: paperSkipSum,
    rows: paper.map((p) => ({
      matchup: `${p.away_team} @ ${p.home_team}`,
      pick: p.pick,
      odds: p.odds,
      result: p.result,
      final: `${p.ascore}-${p.hs}`,
    })),
  },
  verdict: {
    plainSpeak: '',
    brewersSkipped: toxic.some((t) => t.matchup.includes('Brewers')),
    mlImproves: sk.hitRate != null && o.hitRate != null && sk.hitRate > o.hitRate,
  },
};

report.verdict.plainSpeak = `紙上實盤獨贏 ${paperSum.record}；若當時已 skip 毒客 → ${paperSkipSum.record}。日 Top 模擬 ${o.record} → skip後 ${sk.record}（Δ$${report.moneyline.deltaUsd}）。大小 Top3 ${totSum.record}。組合 ${combinedOfficial.record} → ${combinedSkip.record}。`;

fs.writeFileSync(
  new URL('../tmp-replay-yesterday-skip-slate.json', import.meta.url),
  JSON.stringify(report, null, 2)
);

console.log('TOXIC', JSON.stringify(report.toxicAwayCaught, null, 2));
console.log('OFFICIAL TOP', JSON.stringify(report.moneyline.officialTop, null, 2));
console.log('SKIP TOP', JSON.stringify(report.moneyline.afterSkipTop, null, 2));
console.log('ML', o, '→', sk);
console.log('TOT', totSum);
console.log('COMBINED', combinedOfficial, '→', combinedSkip);
console.log('PAPER', paperSum, '→ skip toxic bets', paperSkipSum);
console.log('VERDICT', report.verdict);
