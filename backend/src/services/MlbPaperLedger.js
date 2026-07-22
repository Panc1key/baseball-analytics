/**
 * MLB 紙上帳本。
 *
 * 實際下注仍使用既有 bet_log；本帳本僅接受新真實資料管線中、已通過
 * 資料及策略資格的 candidate，並以 candidate_id 保證冪等。
 */
import db from '../db/database.js';
import { decimalToImpliedProb, removeVig } from '../utils/odds.js';

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
  return {
    ...totals,
    roi: settled ? Number(totals.profitUnits || 0) / settled : null,
    candidateCounts: Object.fromEntries(candidateCounts.map((row) => [row.status, row.count])),
  };
}

