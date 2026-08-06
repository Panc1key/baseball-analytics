/**
 * MLB Hybrid 大小：T-8 首次過閘凍結選邊。
 * 對齊回測「在放出時點成交」；日推不再因 EV／盤口漂中途改邊或默默撤單。
 * 獨贏優先：該場已有 mlb_paper_bets 獨贏則不凍大小；後到獨贏可 suppress 已凍大小。
 */
import db from '../db/database.js';
import { MLB_TOTALS_SATELLITE_HYBRID_SPEC } from './MlbTotalsSatellite.js';
import { hasMlbPaperMoneylineBet } from './MlbPaperLedger.js';

export const MLB_TOTALS_HYBRID_FREEZE_SPEC = Object.freeze({
  id: 'totals_hybrid_freeze_v1',
  policy: 'first_actionable_in_release_window',
  note:
    '開賽前放出窗內首次 actionable 即凍結 side/line/odds；開賽前維持可下；不因活體 EV 回撤改單。獨贏紙上注優先、同場互斥。',
});

export function ensureMlbTotalsHybridFreezeTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_totals_hybrid_freezes (
      game_id TEXT PRIMARY KEY,
      commence_time TEXT NOT NULL,
      matchup TEXT,
      side TEXT NOT NULL CHECK (side IN ('over', 'under')),
      line REAL NOT NULL,
      pick TEXT NOT NULL,
      odds_decimal REAL NOT NULL,
      expected_value REAL,
      abs_gap REAL,
      expected_total REAL,
      model_probability REAL,
      market_probability REAL,
      hybrid_path TEXT,
      pitcher_park_debias INTEGER NOT NULL DEFAULT 0,
      spec_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'void')),
      void_reason TEXT,
      frozen_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );
    CREATE INDEX IF NOT EXISTS idx_mlb_totals_hybrid_freezes_status
      ON mlb_totals_hybrid_freezes(status, commence_time);
  `);
}

ensureMlbTotalsHybridFreezeTable();

function pickLabel(side, line) {
  const s = side === 'over' ? '大' : '小';
  return `${s} ${line}`;
}

/**
 * 首次進入放出窗且 actionable → 寫入凍結；已有列則不改。
 * 該場已有獨贏紙上注 → 不凍大小（獨贏優先）。
 * @returns {object|null} 凍結列
 */
export function freezeMlbTotalsHybridOnRelease(candidate) {
  if (!candidate?.gameId || candidate.tier !== 'actionable' || !candidate.side) {
    return getMlbTotalsHybridFreeze(candidate?.gameId);
  }
  if (hasMlbPaperMoneylineBet(candidate.gameId)) {
    return null;
  }
  const existing = getMlbTotalsHybridFreeze(candidate.gameId);
  if (existing) {
    if (existing.status === 'active') return existing;
    return null;
  }

  const line = Number(candidate.line);
  const odds = Number(candidate.oddsDecimal);
  if (!Number.isFinite(line) || !Number.isFinite(odds)) return null;

  const pick = candidate.pick || pickLabel(candidate.side, line);
  db.prepare(
    `INSERT OR IGNORE INTO mlb_totals_hybrid_freezes (
       game_id, commence_time, matchup, side, line, pick, odds_decimal,
       expected_value, abs_gap, expected_total, model_probability, market_probability,
       hybrid_path, pitcher_park_debias, spec_id, status, frozen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))`
  ).run(
    candidate.gameId,
    candidate.commenceTime || null,
    candidate.matchup || null,
    candidate.side,
    line,
    pick,
    odds,
    Number.isFinite(Number(candidate.expectedValue))
      ? Number(candidate.expectedValue)
      : null,
    Number.isFinite(Number(candidate.absGap)) ? Number(candidate.absGap) : null,
    Number.isFinite(Number(candidate.expectedTotal))
      ? Number(candidate.expectedTotal)
      : null,
    Number.isFinite(Number(candidate.modelProbability))
      ? Number(candidate.modelProbability)
      : null,
    Number.isFinite(Number(candidate.marketProbability))
      ? Number(candidate.marketProbability)
      : null,
    candidate.hybridPath || null,
    candidate.pitcherParkDebiasApplied ? 1 : 0,
    MLB_TOTALS_SATELLITE_HYBRID_SPEC.id
  );
  const row = getMlbTotalsHybridFreeze(candidate.gameId);
  return row?.status === 'active' ? row : null;
}

/**
 * 獨贏已凍結／已 fill → 抑制同場大小凍結（板上不顯示）
 */
export function suppressMlbTotalsHybridFreezeForMoneyline(gameId) {
  if (!gameId) return { suppressed: false };
  const result = db
    .prepare(
      `UPDATE mlb_totals_hybrid_freezes
       SET status = 'void', void_reason = 'suppressed_by_ml'
       WHERE game_id = ? AND status = 'active'`
    )
    .run(gameId);
  return { suppressed: result.changes > 0 };
}

export function getMlbTotalsHybridFreeze(gameId) {
  if (!gameId) return null;
  const row = db
    .prepare(`SELECT * FROM mlb_totals_hybrid_freezes WHERE game_id = ?`)
    .get(gameId);
  return row ? mapFreezeRow(row) : null;
}

export function listActiveMlbTotalsHybridFreezes(gameIds = null) {
  if (Array.isArray(gameIds) && gameIds.length) {
    const placeholders = gameIds.map(() => '?').join(',');
    return db
      .prepare(
        `SELECT * FROM mlb_totals_hybrid_freezes
         WHERE status = 'active' AND game_id IN (${placeholders})`
      )
      .all(...gameIds)
      .map(mapFreezeRow);
  }
  return db
    .prepare(
      `SELECT * FROM mlb_totals_hybrid_freezes WHERE status = 'active'
       ORDER BY commence_time ASC`
    )
    .all()
    .map(mapFreezeRow);
}

function mapFreezeRow(row) {
  return {
    gameId: row.game_id,
    commenceTime: row.commence_time,
    matchup: row.matchup,
    side: row.side,
    line: row.line,
    pick: row.pick,
    oddsDecimal: row.odds_decimal,
    expectedValue: row.expected_value,
    absGap: row.abs_gap,
    expectedTotal: row.expected_total,
    modelProbability: row.model_probability,
    marketProbability: row.market_probability,
    hybridPath: row.hybrid_path,
    pitcherParkDebiasApplied: Boolean(row.pitcher_park_debias),
    specId: row.spec_id,
    status: row.status,
    voidReason: row.void_reason,
    frozenAt: row.frozen_at,
    frozen: true,
  };
}

/**
 * 把凍結列轉成日推 pick 列；可附上活體閘門對照（僅診斷）。
 */
export function formatFrozenHybridPick(freeze, liveCandidate = null, rank = 1) {
  const liveWouldBlock =
    liveCandidate && liveCandidate.tier !== 'actionable'
      ? true
      : liveCandidate &&
          (liveCandidate.side !== freeze.side ||
            Number(liveCandidate.line) !== Number(freeze.line));
  return {
    rank,
    gameId: freeze.gameId,
    matchup: freeze.matchup || liveCandidate?.matchup || null,
    commenceTime: freeze.commenceTime || liveCandidate?.commenceTime || null,
    pick: freeze.pick,
    side: freeze.side,
    line: freeze.line,
    oddsDecimal: freeze.oddsDecimal,
    modelProbability: freeze.modelProbability,
    marketProbability: freeze.marketProbability,
    expectedValue: freeze.expectedValue,
    absGap: freeze.absGap,
    expectedTotal: freeze.expectedTotal,
    hybridPath: freeze.hybridPath,
    pitcherParkDebiasApplied: freeze.pitcherParkDebiasApplied,
    frozen: true,
    frozenAt: freeze.frozenAt,
    liveGateWouldBlock: Boolean(liveWouldBlock),
    liveTier: liveCandidate?.tier || null,
  };
}
