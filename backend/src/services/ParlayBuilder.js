import db from '../db/database.js';
import { config } from '../config.js';
import {
  calcEV,
  decimalToImpliedProb,
  calibrateModelProb,
  decimalToNetOdds,
  extractMarkets,
} from '../utils/odds.js';
import { classifyBetStrategy, qualifiesParlayAnchor } from './BetStrategy.js';

const PARLAY_MARKETS = ['h2h', 'spreads', 'totals'];
const PARLAY_MARKET_SET = new Set(PARLAY_MARKETS);
const LOTTERY_FILL_MARKETS = ['h2h', 'spreads'];

function lotteryMaxLegOdds() {
  return config.parlayLotteryMaxLegOdds ?? 2.25;
}

function getUpcomingSlateGames() {
  return db
    .prepare(`
      SELECT g.*
      FROM games g
      WHERE g.completed = 0
        AND datetime(g.commence_time) > datetime('now')
        AND datetime(g.commence_time) < datetime('now', '+2 day')
      ORDER BY g.commence_time ASC
    `)
    .all();
}

function getGameMainMarketRecs(gameId) {
  const placeholders = PARLAY_MARKETS.map(() => '?').join(', ');
  return db
    .prepare(`
      SELECT r.*, g.home_team, g.away_team, g.commence_time, g.league
      FROM recommendations r
      JOIN games g ON g.id = r.game_id
      WHERE r.game_id = ?
        AND r.market IN (${placeholders})
        AND r.odds_decimal >= ?
      ORDER BY
        CASE WHEN r.bet_strategy = 'parlay_anchor' THEN 0 ELSE 1 END,
        r.model_prob DESC,
        r.ev DESC
    `)
    .all(gameId, ...PARLAY_MARKETS, config.minParlayLegOdds);
}

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
    betStrategy: rec.bet_strategy || classifyBetStrategy(rec),
    isAnchor: false,
  };
}

function isQualifiedLeg(rec, minLegOdds, mode = 'anchor') {
  if (!PARLAY_MARKET_SET.has(rec.market)) return false;

  const odds = legOdds(rec);
  if (odds < minLegOdds) return false;

  const impliedProb = rec.implied_prob ?? decimalToImpliedProb(odds);
  const modelProb = calibrateModelProb(rec.model_prob, impliedProb, config.maxModelEdgePct);
  const ev = calcEV(modelProb, decimalToNetOdds(odds));

  if (ev < config.parlayMinLegEv || modelProb <= impliedProb) return false;
  if (!rec.tier || !['primary', 'watch'].includes(rec.tier)) return false;

  const anchorOk = qualifiesParlayAnchor({
    ...rec,
    odds_decimal: odds,
    model_prob: modelProb,
  });

  if (mode === 'anchor') return anchorOk;

  if (mode === 'lottery') {
    if (anchorOk) return true;
    // 補腿：獨贏/讓分、低中水、勝率達標（不搶均注高賠腿）
    if (!['h2h', 'spreads'].includes(rec.market)) return false;
    if (odds > (config.parlayAnchorMaxOdds + 0.06)) return false;
    return modelProb >= config.parlayLotteryMinProb;
  }

  return anchorOk;
}

/** 六合彩大串：不卡 EV / tier，盡量涵蓋每場 */
function isLotterySlateLeg(rec, leg) {
  if (!LOTTERY_FILL_MARKETS.includes(rec.market)) return false;
  if (leg.odds < config.minParlayLegOdds) return false;
  if (leg.odds > lotteryMaxLegOdds()) return false;
  return leg.modelProb >= config.parlayLotteryMinProb;
}

function buildFallbackLegFromGame(game) {
  const bookmakers = JSON.parse(game.raw_odds || '[]');
  if (!bookmakers.length) return null;

  const markets = extractMarkets(bookmakers);
  const candidates = [];

  for (const o of Object.values(markets.spreads || {})) {
    if (!o?.price || o.price < config.minParlayLegOdds || o.price > lotteryMaxLegOdds()) continue;
    const pick = o.point != null ? `${o.name} ${o.point > 0 ? '+' : ''}${o.point}` : o.name;
    candidates.push({
      market: 'spreads',
      pick,
      line: o.point ?? null,
      odds: o.price,
      bookmaker: o.bookmaker,
      impliedProb: decimalToImpliedProb(o.price),
      spreadPriority: Math.abs(o.point ?? 0) <= 1.5 ? 0 : 1,
    });
  }

  for (const o of Object.values(markets.h2h || {})) {
    if (!o?.price || o.price < config.minParlayLegOdds || o.price > lotteryMaxLegOdds()) continue;
    candidates.push({
      market: 'h2h',
      pick: o.name,
      line: null,
      odds: o.price,
      bookmaker: o.bookmaker,
      impliedProb: decimalToImpliedProb(o.price),
      spreadPriority: 2,
    });
  }

  if (!candidates.length) return null;

  candidates.sort(
    (a, b) =>
      a.spreadPriority - b.spreadPriority ||
      b.impliedProb - a.impliedProb ||
      b.odds - a.odds
  );

  const best = candidates[0];
  const modelProb = calibrateModelProb(best.impliedProb, best.impliedProb, config.maxModelEdgePct);
  const ev = calcEV(modelProb, decimalToNetOdds(best.odds));

  return {
    gameId: game.id,
    league: game.league,
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    commenceTime: game.commence_time,
    market: best.market,
    marketGroup: 'main',
    pick: best.pick,
    odds: best.odds,
    ev,
    modelProb,
    impliedProb: best.impliedProb,
    edgeProb: 0,
    score: Math.round(best.impliedProb * 100),
    tier: 'fill',
    betStrategy: 'lottery_fill',
    isAnchor: false,
    isLotteryFill: true,
  };
}

function pickLotteryLegForGame(game) {
  const rows = getGameMainMarketRecs(game.id);
  const legs = [];

  for (const row of rows) {
    const leg = toLeg(row);
    leg.isAnchor = qualifiesParlayAnchor({
      ...row,
      odds_decimal: leg.odds,
      model_prob: leg.modelProb,
    });
    if (isLotterySlateLeg(row, leg)) legs.push(leg);
  }

  const selected = selectLegFromGame(legs);
  if (selected) return selected;

  return buildFallbackLegFromGame(game);
}

/** 當日全場六合彩：每場一腿，含無推薦場次的賠率補腿 */
function buildFullSlateLotteryLegs() {
  const games = getUpcomingSlateGames();
  const legs = [];

  for (const game of games) {
    const leg = pickLotteryLegForGame(game);
    if (leg) legs.push(leg);
  }

  return legs.sort((a, b) => String(a.commenceTime).localeCompare(String(b.commenceTime)));
}

function getQualifiedLegsByGame(minLegOdds, mode = 'anchor') {
  const placeholders = PARLAY_MARKETS.map(() => '?').join(', ');
  const rows = db
    .prepare(`
      SELECT r.*, g.home_team, g.away_team, g.commence_time
      FROM recommendations r
      JOIN games g ON g.id = r.game_id
      WHERE g.completed = 0
        AND datetime(g.commence_time) > datetime('now')
        AND datetime(g.commence_time) < datetime('now', '+2 day')
        AND r.market IN (${placeholders})
        AND r.odds_decimal >= ?
      ORDER BY r.game_id,
        CASE WHEN r.bet_strategy = 'parlay_anchor' THEN 0 ELSE 1 END,
        r.model_prob DESC,
        r.ev DESC
    `)
    .all(...PARLAY_MARKETS, minLegOdds);

  const byGame = new Map();
  for (const row of rows) {
    if (!isQualifiedLeg(row, minLegOdds, mode)) continue;
    const leg = toLeg(row);
    leg.isAnchor = qualifiesParlayAnchor({
      ...row,
      odds_decimal: leg.odds,
      model_prob: leg.modelProb,
    });
    if (!byGame.has(row.game_id)) byGame.set(row.game_id, []);
    const existing = byGame.get(row.game_id);
    const dup = existing.findIndex((l) => l.market === leg.market);
    if (dup >= 0) {
      if (leg.modelProb > existing[dup].modelProb) existing[dup] = leg;
    } else {
      existing.push(leg);
    }
  }
  return byGame;
}

/** 每場選一腿：優先錨腿，否則勝率最高 */
function selectLegFromGame(legs) {
  if (!legs?.length) return null;
  const anchors = legs.filter((l) => l.isAnchor);
  const pool = anchors.length ? anchors : legs.filter((l) => ['h2h', 'spreads'].includes(l.market));
  if (!pool.length) return null;
  pool.sort((a, b) => b.modelProb - a.modelProb || b.ev - a.ev);
  return pool[0];
}

function buildLegSet(legsByGame) {
  const picks = [];
  for (const [, gameLegs] of legsByGame) {
    const leg = selectLegFromGame(gameLegs);
    if (leg) picks.push(leg);
  }
  return picks.sort((a, b) => String(a.commenceTime).localeCompare(String(b.commenceTime)));
}

function capLegs(legs, maxLegs) {
  if (!maxLegs || maxLegs <= 0) return legs;
  return legs.slice(0, maxLegs);
}

function parlayKey(legs) {
  return legs
    .map((l) => `${l.gameId}|${l.market}|${l.pick}`)
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
  const avgLegProb = legs.reduce((a, l) => a + l.modelProb, 0) / n;
  const anchorCount = legs.filter((l) => l.isAnchor).length;
  const fillCount = legs.filter((l) => l.isLotteryFill || l.tier === 'fill').length;

  return {
    legs: legs.map((l) => ({ ...l })),
    pickSummary: legs.map((l) => l.pick).join(' + '),
    combined_odds: combinedOdds,
    combined_prob: combinedModelProb,
    combined_implied_prob: combinedImpliedProb,
    combined_ev: combinedEv,
    combined_score: combinedScore,
    avg_leg_prob: avgLegProb,
    anchor_leg_count: anchorCount,
    fill_leg_count: fillCount,
    suggested_stake: stake,
    potential_payout: Math.round(combinedOdds * stake * 100) / 100,
    leg_count: n,
    main_leg_count: n,
    market_mix: {
      h2h: legs.filter((l) => l.market === 'h2h').length,
      spreads: legs.filter((l) => l.market === 'spreads').length,
      totals: legs.filter((l) => l.market === 'totals').length,
    },
    is_lottery: meta.isLottery !== false && n >= 3,
    parlay_label: meta.label || `${n}串1`,
    category: meta.category || 'lottery_full_slate',
    games_covered: legs.length,
    _key: parlayKey(legs),
  };
}

function addParlay(pool, seen, legs, meta) {
  if (legs.length < 2) return;
  const parlay = buildParlayObject(legs, meta);
  const key = parlay._key;
  if (seen.has(key)) return;
  seen.add(key);
  pool.push(parlay);
}

/**
 * 六合彩型大串：當日盡量涵蓋全部場次，錨腿優先 + 主盤補滿
 */
export function buildParlaysFromDb(options = {}) {
  const { limit = 40, maxLegs = config.maxParlayLegs } = options;

  const anchorByGame = getQualifiedLegsByGame(config.parlayAnchorMinOdds, 'anchor');
  const fullAnchor = buildLegSet(anchorByGame);

  const slateLegs = capLegs(
    buildFullSlateLotteryLegs(),
    config.parlayLotteryMaxLegs > 0 ? config.parlayLotteryMaxLegs : Number.MAX_SAFE_INTEGER
  );
  const anchorSlateLegs = capLegs(
    fullAnchor,
    config.parlayLotteryMaxLegs > 0 ? config.parlayLotteryMaxLegs : fullAnchor.length
  );

  const pool = [];
  const seen = new Set();

  // 1. 當日全場大串（主推，六合彩 $1）
  if (slateLegs.length >= 2) {
    const fillCount = slateLegs.filter((l) => l.isLotteryFill || l.tier === 'fill').length;
    addParlay(pool, seen, slateLegs, {
      category: 'lottery_full_slate',
      label: `${slateLegs.length}串1 · 當日全場彩券`,
      isLottery: true,
      fillLegCount: fillCount,
    });
  }

  // 2. 純錨腿全場（更穩版本）
  if (anchorSlateLegs.length >= 2 && parlayKey(anchorSlateLegs) !== parlayKey(slateLegs)) {
    addParlay(pool, seen, anchorSlateLegs, {
      category: 'anchor_full_slate',
      label: `${anchorSlateLegs.length}串1 · 錨腿全場`,
      isLottery: true,
    });
  }

  // 3. 精選短串（3～8 腿，按勝率取前 N）
  const byProb = [...slateLegs].sort((a, b) => b.modelProb - a.modelProb);
  for (const n of [3, 4, 5, 6, 7, 8]) {
    if (byProb.length >= n && n <= maxLegs) {
      addParlay(pool, seen, byProb.slice(0, n), {
        category: 'anchor_short',
        label: `${n}串1 · 高命中精選`,
        isLottery: false,
      });
    }
  }

  const categoryOrder = {
    lottery_full_slate: 0,
    anchor_full_slate: 1,
    anchor_short: 2,
    anchor_cover: 3,
    combo: 9,
  };

  return pool
    .sort((a, b) => {
      const ca = categoryOrder[a.category] ?? 9;
      const cb = categoryOrder[b.category] ?? 9;
      if (ca !== cb) return ca - cb;
      if (b.leg_count !== a.leg_count) return b.leg_count - a.leg_count;
      if (b.avg_leg_prob !== a.avg_leg_prob) return b.avg_leg_prob - a.avg_leg_prob;
      return b.combined_odds - a.combined_odds;
    })
    .slice(0, limit)
    .map(({ _key, ...p }, idx) => ({ ...p, id: `parlay-${idx + 1}` }));
}

export const LEAGUE_MARKETS_INFO = {
  MLB: {
    name: 'MLB 美職',
    bulkMarkets: ['h2h (獨贏)', 'spreads (讓分)', 'totals (大小)'],
    eventMarkets: [],
    note: '均注：高賠正 EV；大串：當日全場錨腿彩券 $1',
  },
  NPB: {
    name: 'NPB 日職',
    bulkMarkets: ['h2h (獨贏)', 'spreads (讓分)', 'totals (大小)'],
    eventMarkets: [],
    note: '均注：高賠正 EV；大串：當日全場',
  },
  KBO: {
    name: 'KBO 韓職',
    bulkMarkets: ['h2h (獨贏)', 'spreads (讓分)', 'totals (大小)'],
    eventMarkets: [],
    note: '均注：高賠正 EV；大串：主盤補腿',
  },
};
