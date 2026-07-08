import db from '../db/database.js';
import { config } from '../config.js';
import { calcEV, decimalToImpliedProb, calibrateModelProb, decimalToNetOdds } from '../utils/odds.js';

const MAIN_MARKETS = new Set(['h2h', 'spreads', 'totals']);

function legOdds(rec) {
  return rec.odds_decimal ?? rec.odds?.price ?? 0;
}

function toLeg(rec) {
  const odds = legOdds(rec);
  const impliedProb = rec.implied_prob ?? decimalToImpliedProb(odds);
  const modelProb = calibrateModelProb(rec.model_prob, impliedProb, config.maxModelEdgePct);
  const ev = calcEV(modelProb, decimalToNetOdds(odds));
  return {
    gameId: rec.game_id,
    league: rec.league,
    homeTeam: rec.home_team,
    awayTeam: rec.away_team,
    commenceTime: rec.commence_time,
    market: rec.market,
    marketGroup: rec.market_group,
    pick: rec.pick,
    odds,
    ev,
    modelProb,
    impliedProb,
    edgeProb: (modelProb - impliedProb) * 100,
    score: rec.score,
    tier: rec.tier,
  };
}

function isQualifiedLeg(rec, minLegOdds) {
  const odds = legOdds(rec);
  if (odds < minLegOdds || !rec.tier || !['primary', 'watch'].includes(rec.tier)) return false;
  const impliedProb = rec.implied_prob ?? decimalToImpliedProb(odds);
  const modelProb = calibrateModelProb(rec.model_prob, impliedProb, config.maxModelEdgePct);
  const ev = calcEV(modelProb, decimalToNetOdds(odds));
  return ev >= config.parlayMinLegEv && modelProb > impliedProb;
}

/** 每場取正 EV 最高的一條（優先主盤） */
function getBestPickPerGame(minLegOdds) {
  const rows = db
    .prepare(`
      SELECT r.*, g.home_team, g.away_team, g.commence_time
      FROM recommendations r
      JOIN games g ON g.id = r.game_id
      WHERE g.completed = 0
        AND datetime(g.commence_time) > datetime('now')
        AND datetime(g.commence_time) < datetime('now', '+2 day')
        AND r.odds_decimal >= ?
        AND r.tier IN ('primary', 'watch')
      ORDER BY r.game_id,
        CASE r.tier WHEN 'primary' THEN 0 ELSE 1 END,
        CASE r.market_group WHEN 'main' THEN 0 ELSE 1 END,
        r.ev DESC,
        r.score DESC
    `)
    .all(minLegOdds);

  const byGame = new Map();
  for (const row of rows) {
    if (!isQualifiedLeg(row, minLegOdds)) continue;
    if (!byGame.has(row.game_id)) byGame.set(row.game_id, toLeg(row));
  }
  return [...byGame.values()];
}

function parlayKey(legs) {
  return legs
    .map((l) => `${l.gameId}|${l.pick}`)
    .sort()
    .join('||');
}

function buildParlayObject(legs, meta = {}) {
  const combinedOdds = legs.reduce((acc, r) => acc * r.odds, 1);
  const combinedModelProb = legs.reduce((acc, r) => acc * (r.modelProb || 0.5), 1);
  const combinedImpliedProb = legs.reduce((acc, r) => acc * (r.impliedProb || decimalToImpliedProb(r.odds)), 1);
  const combinedEv = calcEV(combinedModelProb, combinedOdds - 1);
  const combinedScore = legs.reduce((acc, r) => acc + (r.score || 0), 0);
  const stake = config.parlayBetUsd;
  const n = legs.length;
  const mainLegCount = legs.filter((l) => MAIN_MARKETS.has(l.market)).length;
  const isLottery = n >= 8 || combinedImpliedProb < 0.001;

  return {
    legs: legs.map((l) => ({ ...l })),
    pickSummary: legs.map((l) => l.pick).join(' + '),
    combined_odds: combinedOdds,
    combined_prob: combinedModelProb,
    combined_implied_prob: combinedImpliedProb,
    combined_ev: combinedEv,
    combined_score: combinedScore,
    suggested_stake: stake,
    potential_payout: Math.round(combinedOdds * stake * 100) / 100,
    leg_count: n,
    main_leg_count: mainLegCount,
    is_lottery: isLottery,
    parlay_label: meta.label || `${n}串1`,
    category: meta.category || 'combo',
    games_covered: legs.length,
    _key: parlayKey(legs),
  };
}

function addParlay(pool, seen, legs, meta) {
  if (legs.length < 2) return;
  const parlay = buildParlayObject(legs, meta);
  if (parlay.combined_ev <= 0) return;
  const key = parlay._key;
  if (seen.has(key)) return;
  seen.add(key);
  pool.push(parlay);
}

/**
 * 均注正 EV 導向：每腿須正優勢 + 達 EV 門檻，組合須合計 EV > 0
 * 排序以 combined_ev 為主（長期均注盈利目標）
 */
export function buildParlaysFromDb(options = {}) {
  const {
    limit = 40,
    minLegOdds = config.minParlayLegOdds,
    maxLegs = config.maxParlayLegs,
  } = options;

  const picks = getBestPickPerGame(minLegOdds)
    .filter((p) => p.odds >= minLegOdds && p.ev > 0)
    .sort((a, b) => b.ev - a.ev || b.score - a.score);

  if (picks.length < 2) return [];

  const maxN = Math.min(picks.length, maxLegs);
  const pool = [];
  const seen = new Set();

  // 當日全場（長串彩券型，需正 EV）
  if (picks.length >= 2) {
    addParlay(pool, seen, picks, {
      category: 'full_slate',
      label: `${picks.length}串1 · 當日全場`,
    });
  }

  // 各腿數正 EV 精選：取 EV 最高的前 N 場
  for (let n = 2; n <= maxN; n++) {
    addParlay(pool, seen, picks.slice(0, n), {
      category: 'best_ev',
      label: `${n}串1 · 正 EV`,
    });
  }

  // 主盤優先組合
  const mainPicks = picks.filter((p) => MAIN_MARKETS.has(p.market));
  if (mainPicks.length >= 2) {
    const mainMax = Math.min(mainPicks.length, maxN);
    for (let n = 2; n <= mainMax; n++) {
      addParlay(pool, seen, mainPicks.slice(0, n), {
        category: 'main_markets',
        label: `${n}串1 · 主盤`,
      });
    }
  }

  // 場次覆蓋：按開賽時間分組
  const byTime = [...picks].sort((a, b) =>
    String(a.commenceTime).localeCompare(String(b.commenceTime))
  );
  const chunkSizes = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter((s) => s <= maxN);
  for (const size of chunkSizes) {
    for (let i = 0; i + size <= byTime.length; i += size) {
      addParlay(pool, seen, byTime.slice(i, i + size), {
        category: 'daily_cover',
        label: `${size}串1 · 場次覆蓋`,
      });
    }
    const rem = byTime.length % size;
    if (rem >= 2) {
      addParlay(pool, seen, byTime.slice(-rem), {
        category: 'daily_cover',
        label: `${rem}串1 · 場次收尾`,
      });
    }
  }

  const categoryOrder = {
    best_ev: 0,
    main_markets: 1,
    full_slate: 2,
    daily_cover: 3,
    combo: 4,
  };

  return pool
    .sort((a, b) => {
      const ca = categoryOrder[a.category] ?? 9;
      const cb = categoryOrder[b.category] ?? 9;
      if (ca !== cb) return ca - cb;
      if (b.combined_ev !== a.combined_ev) return b.combined_ev - a.combined_ev;
      return b.combined_prob - a.combined_prob;
    })
    .slice(0, limit)
    .map(({ _key, ...p }, idx) => ({ ...p, id: `parlay-${idx + 1}` }));
}

export const LEAGUE_MARKETS_INFO = {
  MLB: {
    name: 'MLB 美職',
    bulkMarkets: ['h2h (獨贏)', 'spreads (讓分)', 'totals (大小)'],
    eventMarkets: [
      'pitcher_strikeouts (投手三振)',
      'pitcher_outs (投手出局)',
      'pitcher_hits_allowed (投手被安打)',
      'batter_hits (打者安打)',
      'batter_total_bases (打者總壘打)',
      'batter_home_runs (打者全壘打)',
    ],
    note: '主盤一次拉全場；球員盤需逐場 event-odds，消耗較多 API 額度',
  },
  NPB: {
    name: 'NPB 日職',
    bulkMarkets: ['h2h (獨贏)', 'spreads (讓分)', 'totals (大小)'],
    eventMarkets: [],
    note: 'The Odds API 目前未提供 NPB 球員盤口',
  },
  KBO: {
    name: 'KBO 韓職',
    bulkMarkets: ['h2h (獨贏)', 'spreads (讓分)', 'totals (大小)'],
    eventMarkets: [],
    note: 'The Odds API 目前未提供 KBO 球員盤口',
  },
};
