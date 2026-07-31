/**
 * MLB 紙上帳本。
 *
 * 實際下注仍使用既有 bet_log；本帳本僅接受新真實資料管線中、已通過
 * 資料及策略資格的 candidate，並以 candidate_id 保證冪等。
 *
 * 路徑 γ：日內鎖定 B 名額晉升為 paper_candidate 後由此建注／結算；
 * 選注常數仍只來自 MLB_PAPER_RULE_PROFILE（建議 ev02_max230）。
 */
import db from '../db/database.js';
import { config } from '../config.js';
import { decimalToImpliedProb, removeVig } from '../utils/odds.js';
import { getFrozenBShadowObservationSummary } from './MlbFrozenBShadow.js';

/** 鎖定基準 KPI（@$50，見 MLB-B-BASELINE-LOCK.md）— 對照用，非活體帳本 */
export const MLB_B_BASELINE_LOCK_KPI = Object.freeze({
  lockId: 'B-baseline-2026-07-30',
  profile: 'ev02_max230',
  overlayId: 'frozen_b+shrink',
  stakeUsdReference: 50,
  bets: 611,
  hitRate: 0.5532,
  avgOdds: 2.046,
  usd50: 4007,
  windowNote:
    '約 2024-04～09 + 2025-04～09 + 2026-04～07 PIT；含 residual_b+shrink 疊加',
  previousLockId: 'B-baseline-2026-07-28',
});

function parseBookmakers(raw) {
  try {
    const value = JSON.parse(raw || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function closingH2h(gameId, pick, homeTeam, awayTeam) {
  const row = db.prepare(`
    SELECT bookmakers_json
    FROM odds_snapshots
    WHERE game_id = ?
      AND datetime(captured_at) < datetime((SELECT commence_time FROM games WHERE id = ?))
      AND source NOT LIKE '%_post_start'
    ORDER BY datetime(captured_at) DESC
    LIMIT 1
  `).get(gameId, gameId);
  if (!row) return null;

  for (const book of parseBookmakers(row.bookmakers_json)) {
    const market = book.markets?.find((item) => item.key === 'h2h');
    const selected = market?.outcomes?.find((item) => item.name === pick);
    const oppositeName = pick === homeTeam ? awayTeam : homeTeam;
    const opposite = market?.outcomes?.find((item) => item.name === oppositeName);
    if (!selected?.price || !opposite?.price) continue;
    const fair = removeVig(
      decimalToImpliedProb(selected.price),
      decimalToImpliedProb(opposite.price)
    );
    return { oddsDecimal: Number(selected.price), marketProb: fair.fairA };
  }
  return null;
}

function evaluateH2h(pick, game) {
  if (['canceled', 'cancelled', 'postponed', 'abandoned', 'void'].includes(String(game.status || '').toLowerCase())) {
    return 'void';
  }
  if (game.home_score == null || game.away_score == null || !game.completed) return null;
  if (pick === game.home_team) return Number(game.home_score) > Number(game.away_score) ? 'win' : 'loss';
  if (pick === game.away_team) return Number(game.away_score) > Number(game.home_score) ? 'win' : 'loss';
  return 'void';
}

function hkDay(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function summarizeSettledRows(rows, stakeUsd = 50) {
  const decided = rows.filter((r) => r.result === 'win' || r.result === 'loss');
  if (!decided.length) {
    return {
      bets: 0,
      wins: 0,
      losses: 0,
      hitRate: null,
      avgOdds: null,
      profitUnits: 0,
      roi: null,
      usd: 0,
      stakeUsd,
    };
  }
  let profitUnits = 0;
  let oddsSum = 0;
  let wins = 0;
  for (const r of decided) {
    oddsSum += Number(r.odds_decimal) || 0;
    if (r.result === 'win') {
      wins += 1;
      profitUnits += (Number(r.odds_decimal) || 0) - 1;
    } else {
      profitUnits -= 1;
    }
  }
  const n = decided.length;
  return {
    bets: n,
    wins,
    losses: n - wins,
    hitRate: Number((wins / n).toFixed(4)),
    avgOdds: Number((oddsSum / n).toFixed(3)),
    profitUnits: Number(profitUnits.toFixed(4)),
    roi: Number((profitUnits / n).toFixed(4)),
    usd: Math.round(profitUnits * stakeUsd),
    stakeUsd,
  };
}

export function createPaperBetFromCandidate(candidateId) {
  const candidate = db.prepare(`
    SELECT c.*, t.mandatory_complete
    FROM mlb_paper_candidates c
    JOIN mlb_prematch_truth_snapshots t ON t.id = c.truth_snapshot_id
    WHERE c.id = ?
  `).get(candidateId);

  if (!candidate) throw new Error('找不到紙上候選');
  if (candidate.status !== 'paper_candidate' || candidate.mandatory_complete !== 1) {
    return { created: false, reason: 'candidate_not_eligible' };
  }
  if (!candidate.pick || !candidate.odds_decimal) {
    return { created: false, reason: 'candidate_market_missing' };
  }
  const existingGameBet = db.prepare(`
    SELECT id
    FROM mlb_paper_bets
    WHERE game_id = ? AND market = ?
    LIMIT 1
  `).get(candidate.game_id, candidate.market);
  if (existingGameBet) {
    return { created: false, reason: 'game_market_already_recorded' };
  }

  const result = db.prepare(`
    INSERT OR IGNORE INTO mlb_paper_bets
      (candidate_id, game_id, market, pick, stake_units, odds_decimal, market_prob,
       model_prob, model_version, strategy_version)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run(
    candidate.id,
    candidate.game_id,
    candidate.market,
    candidate.pick,
    candidate.odds_decimal,
    candidate.market_prob,
    candidate.model_prob,
    candidate.model_version,
    candidate.strategy_version
  );
  return { created: result.changes === 1, id: result.lastInsertRowid || null };
}

export function autoCreateEligiblePaperBets() {
  const candidates = db.prepare(`
    SELECT id
    FROM mlb_paper_candidates
    WHERE status = 'paper_candidate'
  `).all();
  let created = 0;
  for (const { id } of candidates) {
    if (createPaperBetFromCandidate(id).created) created += 1;
  }
  return { candidates: candidates.length, created };
}

export function autoSettleMlbPaperBets() {
  const pending = db.prepare(`
    SELECT p.*, g.home_team, g.away_team, g.home_score, g.away_score, g.completed, g.status
    FROM mlb_paper_bets p
    JOIN games g ON g.id = p.game_id
    WHERE p.result = 'pending'
      AND (g.completed = 1 OR lower(COALESCE(g.status, '')) IN
        ('canceled', 'cancelled', 'postponed', 'abandoned', 'void'))
  `).all();
  const update = db.prepare(`
    UPDATE mlb_paper_bets
    SET result = ?, profit_units = ?, closing_odds_decimal = ?, closing_market_prob = ?,
        clv_prob = ?, settled_at = datetime('now')
    WHERE id = ?
  `);

  let settled = 0;
  const transaction = db.transaction(() => {
    for (const bet of pending) {
      const result = evaluateH2h(bet.pick, bet);
      if (!result) continue;
      const closing = closingH2h(bet.game_id, bet.pick, bet.home_team, bet.away_team);
      const profit = result === 'win' ? bet.odds_decimal - 1 : result === 'loss' ? -1 : 0;
      const clv = closing?.marketProb != null && bet.market_prob != null
        ? closing.marketProb - bet.market_prob
        : null;
      update.run(result, profit, closing?.oddsDecimal ?? null, closing?.marketProb ?? null, clv, bet.id);
      settled += 1;
    }
  });
  transaction();
  return { pending: pending.length, settled };
}

function loadPaperBetRows() {
  return db.prepare(`
    SELECT p.*, g.commence_time AS commenceTime, g.home_team, g.away_team
    FROM mlb_paper_bets p
    JOIN games g ON g.id = p.game_id
    ORDER BY datetime(g.commence_time) ASC, p.id ASC
  `).all();
}

/**
 * 路徑 γ 活體紙上 vs 鎖定基準對照（唯讀）。
 */
export function buildMlbPathGammaPaperReport({
  stakeUsd = 50,
  configStakeUsd = config.mlbPaperFlatStakeUsd,
} = {}) {
  const rows = loadPaperBetRows();
  const settled = rows.filter((r) => r.result === 'win' || r.result === 'loss');
  const pending = rows.filter((r) => r.result === 'pending');

  const overall = summarizeSettledRows(settled, stakeUsd);
  const overallConfigStake = summarizeSettledRows(settled, configStakeUsd);

  const now = Date.now();
  const inLastDays = (days) =>
    settled.filter((r) => {
      const t = Date.parse(r.settled_at || r.commenceTime);
      return Number.isFinite(t) && now - t <= days * 86400000;
    });

  const rolling7 = summarizeSettledRows(inLastDays(7), stakeUsd);
  const rolling30 = summarizeSettledRows(inLastDays(30), stakeUsd);

  const byMonthMap = new Map();
  for (const r of settled) {
    const day = hkDay(r.commenceTime);
    const month = day ? day.slice(0, 7) : 'unknown';
    if (!byMonthMap.has(month)) byMonthMap.set(month, []);
    byMonthMap.get(month).push(r);
  }
  const byMonth = [...byMonthMap.keys()]
    .sort()
    .map((month) => ({ month, ...summarizeSettledRows(byMonthMap.get(month), stakeUsd) }));

  const baseline = MLB_B_BASELINE_LOCK_KPI;
  const sampleReady = overall.bets >= 20;
  const drift = {
    sampleReady,
    hitRateDeltaPp:
      overall.hitRate != null
        ? Number(((overall.hitRate - baseline.hitRate) * 100).toFixed(2))
        : null,
    roiVsBaselineImplied: overall.roi,
    note: sampleReady
      ? '活體結算≥20 注，可開始看勝率／ROI 是否偏離鎖定窗'
      : '樣本不足 20 注；先累積，勿據此改選注常數',
    alert:
      sampleReady && overall.hitRate != null && overall.hitRate < baseline.hitRate - 0.05
        ? 'hit_rate_soft_alert_gt_5pp_below_baseline'
        : sampleReady && overall.roi != null && overall.roi < -0.05
          ? 'roi_soft_alert_below_neg5pct'
          : null,
  };

  const candidateCounts = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM mlb_paper_candidates
    GROUP BY status
  `).all();

  return {
    mode: 'path_gamma',
    generatedAt: new Date().toISOString(),
    profileConfigured: config.mlbPaperRuleProfile,
    profileExpected: 'ev02_max230',
    profileMismatch: config.mlbPaperRuleProfile !== 'ev02_max230',
    baselineLock: baseline,
    liveLedger: {
      paperBets: rows.length,
      pending: pending.length,
      settled: settled.length,
      overallAt50: overall,
      overallAtConfigStake: overallConfigStake,
      rolling7d: rolling7,
      rolling30d: rolling30,
      byMonth,
      recentSettled: settled.slice(-15).map((r) => ({
        id: r.id,
        day: hkDay(r.commenceTime),
        gameId: r.game_id,
        matchup: `${r.away_team} @ ${r.home_team}`,
        pick: r.pick,
        odds: r.odds_decimal,
        result: r.result,
        profitUnits: r.profit_units,
        usd50:
          r.profit_units == null ? null : Math.round(Number(r.profit_units) * stakeUsd),
      })),
    },
    candidateCounts: Object.fromEntries(
      candidateCounts.map((row) => [row.status, row.count])
    ),
    drift,
    frozenBShadow: getFrozenBShadowObservationSummary(),
    operatingRules: [
      '正式紙上：ev02_max230 + 鎖定疊加 frozen_b+shrink（殘差 b + 毒客 shrink）',
      '禁止為抬勝率改選注常數／v4.5 權重／疊加係數',
      '之後優化請另開影子觀察；確認後再升格',
      '回滾疊加：MLB_LOCKED_B_OVERLAY=false；回滾選注 profile：MLB_PAPER_RULE_PROFILE=frozen_v1',
      '活體樣本不足勿下結論',
    ],
  };
}

export function getMlbPaperLedgerSummary() {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS paperBets,
      SUM(CASE WHEN result = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN result IN ('win', 'loss', 'push', 'void') THEN 1 ELSE 0 END) AS settled,
      SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
      COALESCE(SUM(profit_units), 0) AS profitUnits,
      AVG(CASE WHEN clv_prob IS NOT NULL THEN clv_prob END) AS avgClvProb
    FROM mlb_paper_bets
  `).get();
  const candidateCounts = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM mlb_paper_candidates
    GROUP BY status
  `).all();
  const settled = Number(totals.settled || 0);
  const pathGamma = buildMlbPathGammaPaperReport();
  return {
    ...totals,
    roi: settled ? Number(totals.profitUnits || 0) / settled : null,
    candidateCounts: Object.fromEntries(candidateCounts.map((row) => [row.status, row.count])),
    pathGamma: {
      baselineLock: pathGamma.baselineLock,
      overallAt50: pathGamma.liveLedger.overallAt50,
      rolling7d: pathGamma.liveLedger.rolling7d,
      rolling30d: pathGamma.liveLedger.rolling30d,
      byMonth: pathGamma.liveLedger.byMonth,
      drift: pathGamma.drift,
      frozenBShadow: pathGamma.frozenBShadow,
      profileConfigured: pathGamma.profileConfigured,
      profileMismatch: pathGamma.profileMismatch,
      operatingRules: pathGamma.operatingRules,
    },
  };
}
