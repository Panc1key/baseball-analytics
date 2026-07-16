/**
 * 滾球對齊初盤：避免把初盤已拒絕／反向的盤口在開局又推回來
 */
import db from '../db/database.js';
import { config } from '../config.js';

function normalizePickKey(market, pick, line) {
  const p = String(pick || '').trim().toLowerCase();
  const ln = line == null || line === '' ? '' : String(line);
  return `${market}|${p}|${ln}`;
}

function isUnderPick(pick) {
  return /^小\b/i.test(pick || '') || /^under\b/i.test(pick || '');
}

function isOverPick(pick) {
  return /^大\b/i.test(pick || '') || /^over\b/i.test(pick || '');
}

/**
 * 讀取該場最近一次初盤立場（推薦 + 決策宇宙）
 */
export function loadPrematchStance(gameId) {
  if (!gameId || config.liveRespectPrematch === false) {
    return { enabled: false, recommendations: [], rejectedKeys: new Set() };
  }

  const recommendations = db
    .prepare(
      `
    SELECT market, pick, line, tier, calibrated_prob, ev, created_at
    FROM recommendation_snapshots
    WHERE game_id = ?
      AND IFNULL(phase, 'prematch') = 'prematch'
    ORDER BY datetime(created_at) DESC
    LIMIT 12
  `
    )
    .all(gameId);

  // 去重：每市場保留最新一條
  const byMarket = new Map();
  for (const row of recommendations) {
    if (!byMarket.has(row.market)) byMarket.set(row.market, row);
  }
  const latestRecs = [...byMarket.values()];

  const latestRun = db
    .prepare(
      `
    SELECT d.analysis_run_id
    FROM analysis_decisions d
    WHERE d.game_id = ?
    ORDER BY datetime(d.created_at) DESC
    LIMIT 1
  `
    )
    .get(gameId);

  const rejectedKeys = new Set();
  if (latestRun?.analysis_run_id) {
    const rejected = db
      .prepare(
        `
      SELECT market, pick, line, reject_reason, eligible, selected
      FROM analysis_decisions
      WHERE game_id = ?
        AND analysis_run_id = ?
        AND (eligible = 0 OR selected = 0)
    `
      )
      .all(gameId, latestRun.analysis_run_id);

    for (const row of rejected) {
      // 只把「明確不合格」當禁區；未入選但 eligible 的仍可能因盤口變化再看
      if (row.eligible === 0) {
        rejectedKeys.add(normalizePickKey(row.market, row.pick, row.line));
      }
    }
  }

  return {
    enabled: true,
    recommendations: latestRecs,
    rejectedKeys,
  };
}

/**
 * @returns {string|null} reject reason
 */
export function checkPrematchContradiction(candidate, live, stance) {
  if (!stance?.enabled) return null;

  const inningsPlayed = Number(live?.inningsPlayed);
  const homeScore = Number(live?.homeScore);
  const awayScore = Number(live?.awayScore);
  const absMargin =
    Number.isFinite(homeScore) && Number.isFinite(awayScore)
      ? Math.abs(homeScore - awayScore)
      : 0;
  const early =
    Number.isFinite(inningsPlayed) &&
    inningsPlayed < (config.livePrematchGuardMaxInning ?? 6);
  const scoreQuiet = absMargin <= (config.livePrematchGuardMaxMargin ?? 1);

  const key = normalizePickKey(candidate.market, candidate.pick, candidate.line);
  if (early && stance.rejectedKeys.has(key)) {
    return '初盤已濾除此方向（不合格），開局禁止翻案';
  }

  if (!early || !scoreQuiet) return null;

  const recs = stance.recommendations || [];
  if (!recs.length) return null;

  // 初盤推 A 隊相關（獨贏／讓分），滾球在比分未打開時反推 B 隊獨贏
  if (candidate.market === 'h2h') {
    const preH2h = recs.find((r) => r.market === 'h2h');
    const preSpread = recs.find((r) => r.market === 'spreads');
    const favored =
      preH2h?.pick ||
      (preSpread?.pick ? String(preSpread.pick).replace(/\s+[+-]?\d+(\.\d+)?$/, '') : null);
    if (favored && favored !== candidate.pick) {
      return `初盤看好 ${favored}，比分未打開禁止翻推對手獨贏`;
    }
  }

  // 初盤推大、滾球推小（或相反）且仍早段低分差
  if (candidate.market === 'totals') {
    const preTotal = recs.find((r) => r.market === 'totals');
    if (preTotal?.pick) {
      const preUnder = isUnderPick(preTotal.pick);
      const preOver = isOverPick(preTotal.pick);
      const liveUnder = isUnderPick(candidate.pick);
      const liveOver = isOverPick(candidate.pick);
      if ((preOver && liveUnder) || (preUnder && liveOver)) {
        return `初盤為「${preTotal.pick}」，早段禁止反向大小`;
      }
    }
  }

  return null;
}
