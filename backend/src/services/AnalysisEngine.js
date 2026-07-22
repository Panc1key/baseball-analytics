import db from '../db/database.js';
import { createHash, randomUUID } from 'crypto';
import { fetchAllLeagueOdds, fetchAllLeagueScores, fetchMlbPlayerProps } from './OddsApiClient.js';
import {
  getMlbStandings,
  getMlbScheduleRange,
  matchMlbTeam,
  matchMlbOfficialGame,
  getProbablePitchers,
  getMlbPitcherPregameFeatures,
} from './MlbStatsService.js';
import {
  analyzeMatchup,
  updateTeamStatsFromScores,
  updateTeamStatsFromDbGames,
  syncNpbStandingsFromYahoo,
} from './TeamAnalyzer.js';
import { rebuildAllBaseballElo, createWalkForwardElo } from './BaseballElo.js';
import { refreshAllRollingTeamForm } from './TeamRollingStats.js';
import { fitAllDixonColesRho } from '../models/DixonColes.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pickGameRecommendations } from './RecommendationRules.js';
import { recordOddsSnapshot, resolvePitOdds } from './PitOddsService.js';

const __analysisDir = path.dirname(fileURLToPath(import.meta.url));
import { buildParlaysFromDb, LEAGUE_MARKETS_INFO, getSlateCoverage } from './ParlayBuilder.js';
import { extractPlayerProps } from './PlayerPropAnalyzer.js';
import {
  decimalToImpliedProb,
  extractMarkets,
  removeVig,
} from '../utils/odds.js';
import { config, LEAGUES, BASEBALL_LEAGUE_CODES, BASEBALL_LEAGUE_SQL } from '../config.js';
import { classifyBetStrategy } from './BetStrategy.js';
import { enrichWithSuggestedStake, getStakeSizingMeta } from './StakeSizer.js';
import {
  activeGameWhere,
  isGameStarted,
  prematchAnalyzeGameWhere,
  slateDisplayGameWhere,
} from '../utils/activeGames.js';
import { runLiveAnalysis, getLiveRecommendations, getLiveStatus } from './LiveAnalysisEngine.js';
import { runMlbPrematchTruthPipeline } from './MlbPrematchTruthPipeline.js';
import {
  autoCreateEligiblePaperBets,
  autoSettleMlbPaperBets,
} from './MlbPaperLedger.js';

let refreshPromise = null;

function getMeta(key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

function setMeta(key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
}

/** app_meta 時間戳距今幾小時；無資料視為過期 */
function metaAgeHours(key) {
  const raw = getMeta(key);
  if (!raw) return Infinity;
  const age = (Date.now() - Date.parse(raw)) / 3600000;
  return Number.isFinite(age) ? age : Infinity;
}

function shouldRebuildHeavy(key, maxAgeHours) {
  return metaAgeHours(key) >= maxAgeHours;
}

export function isRefreshInProgress() {
  return !!refreshPromise;
}

function upsertGame(game, league, rawProps = null) {
  const bookmakersJson = JSON.stringify(game.bookmakers);
  // 開賽後 Odds API 常回滾球縮水盤；初盤 raw_odds 必須鎖定，避免重算成「大 3.5」假 EV
  const started =
    game.commence_time && new Date(game.commence_time).getTime() <= Date.now();
  db.prepare(`
    INSERT INTO games (id, league, commence_time, home_team, away_team, raw_odds, raw_props, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      raw_odds = CASE
        WHEN datetime(games.commence_time) <= datetime('now') THEN games.raw_odds
        ELSE excluded.raw_odds
      END,
      raw_props = COALESCE(excluded.raw_props, games.raw_props),
      updated_at = datetime('now')
  `).run(
    game.id,
    league,
    game.commence_time,
    game.home_team,
    game.away_team,
    bookmakersJson,
    rawProps ? JSON.stringify(rawProps) : null
  );
  // 快照仍記錄當下盤（含滾球）；PIT resolver 只允許 captured_at < commence_time。
  recordOddsSnapshot({
    gameId: game.id,
    league,
    commenceTime: game.commence_time,
    bookmakers: game.bookmakers || [],
    source: started ? 'odds_api_post_start' : 'odds_api',
  });
}

function saveGameProps(gameId, bookmakers) {
  db.prepare(`
    UPDATE games SET raw_props = ?, updated_at = datetime('now') WHERE id = ?
  `).run(JSON.stringify(bookmakers), gameId);
}

function parseSnapshotTime(capturedAt) {
  const s = String(capturedAt || '');
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

function totalsLinesFromBooks(books) {
  try {
    const markets = extractMarkets(books);
    return [
      ...new Set(
        Object.values(markets.totals || {})
          .map((x) => x.point)
          .filter((x) => x != null)
      ),
    ];
  } catch {
    return [];
  }
}

function isSanePrematchTotals(league, lines) {
  if (!lines?.length) return true;
  const min =
    league === 'MLB' ? (config.mlbTotalsLineMin ?? 5.5) : (config.npbTotalsLineMin ?? 6.5);
  const max =
    league === 'MLB' ? (config.mlbTotalsLineMax ?? 14) : (config.npbTotalsLineMax ?? 13);
  return lines.some((p) => p >= min && p <= max);
}

/**
 * 用開賽前最後一筆合理快照還原 games.raw_odds（修復已被滾球盤覆寫的初盤）
 */
export function restorePrematchOddsFromSnapshots() {
  const games = db
    .prepare(
      `
    SELECT id, league, commence_time, raw_odds
    FROM games
    WHERE league IN (${BASEBALL_LEAGUE_SQL})
      AND completed = 0
      AND datetime(commence_time) <= datetime('now')
      AND datetime(commence_time) > datetime('now', '-18 hours')
  `
    )
    .all();

  let restored = 0;
  const update = db.prepare(
    `UPDATE games SET raw_odds = ?, updated_at = datetime('now') WHERE id = ?`
  );

  for (const game of games) {
    const commenceMs = new Date(game.commence_time).getTime();
    if (!Number.isFinite(commenceMs)) continue;

    const snaps = db
      .prepare(
        `
      SELECT captured_at, bookmakers_json
      FROM odds_snapshots
      WHERE game_id = ?
      ORDER BY datetime(captured_at) ASC
    `
      )
      .all(game.id);

    let best = null;
    for (const snap of snaps) {
      const ts = parseSnapshotTime(snap.captured_at);
      if (!Number.isFinite(ts) || ts > commenceMs) continue;
      let books;
      try {
        books = JSON.parse(snap.bookmakers_json);
      } catch {
        continue;
      }
      if (!books?.length) continue;
      const lines = totalsLinesFromBooks(books);
      if (!isSanePrematchTotals(game.league, lines)) continue;
      best = books;
    }

    if (!best) continue;

    const currentLines = totalsLinesFromBooks(JSON.parse(game.raw_odds || '[]'));
    if (isSanePrematchTotals(game.league, currentLines) && currentLines.length) {
      // 現行盤已合理則不覆蓋（避免無謂跳動）
      continue;
    }

    update.run(JSON.stringify(best), game.id);
    restored += 1;
  }

  return { games: games.length, restored };
}

/** 讀取某場應用於初盤分析的 bookmakers（優先開賽前合理快照） */
function loadPrematchBookmakers(game) {
  if (game.league === 'MLB') {
    const pit = resolvePitOdds(game.id, game.commence_time);
    return pit.ok ? pit.bookmakers : [];
  }
  const commenceMs = new Date(game.commence_time).getTime();
  const started = Number.isFinite(commenceMs) && commenceMs <= Date.now();
  if (!started) {
    try {
      return JSON.parse(game.raw_odds || '[]');
    } catch {
      return [];
    }
  }

  const snaps = db
    .prepare(
      `
    SELECT captured_at, bookmakers_json
    FROM odds_snapshots
    WHERE game_id = ?
    ORDER BY datetime(captured_at) ASC
  `
    )
    .all(game.id);

  let best = null;
  for (const snap of snaps) {
    const ts = parseSnapshotTime(snap.captured_at);
    if (!Number.isFinite(ts) || ts > commenceMs) continue;
    try {
      const books = JSON.parse(snap.bookmakers_json);
      if (!books?.length) continue;
      const lines = totalsLinesFromBooks(books);
      if (isSanePrematchTotals(game.league, lines)) best = books;
    } catch {
      /* continue */
    }
  }
  if (best) return best;
  try {
    return JSON.parse(game.raw_odds || '[]');
  } catch {
    return [];
  }
}

function clearOldRecommendations() {
  // 只清「待重算」的初盤：未開賽（等會重跑）+ 完賽/過期
  // 已開賽且仍在展示窗內的初盤推薦保留，方便對帳當時推了什麼
  // 例外：模型版本已變、或違規 sample 冷門獨贏 → 必須清掉重算，否則重啟也看不到新算法
  const keepStartedHours = Math.max(config.liveGameGraceHours ?? 6, 12);
  const minSampleH2h = config.sampleMinH2hProb ?? 0.52;
  db.prepare(
    `
    DELETE FROM recommendations
    WHERE league IN (${BASEBALL_LEAGUE_SQL})
      AND IFNULL(phase, 'prematch') = 'prematch'
      AND game_id IN (
        SELECT id FROM games g
        WHERE g.league IN (${BASEBALL_LEAGUE_SQL})
          AND (
            g.completed = 1
            OR datetime(g.commence_time) > datetime('now')
            OR datetime(g.commence_time) <= datetime('now', '-${keepStartedHours} hours')
          )
      )
  `
  ).run();

  // 舊模型版本的「進行中凍結單」作廢
  db.prepare(
    `
    DELETE FROM recommendations
    WHERE league IN (${BASEBALL_LEAGUE_SQL})
      AND IFNULL(phase, 'prematch') = 'prematch'
      AND IFNULL(model_version, 'legacy') != ?
  `
  ).run(config.modelVersion);

  // 歷史殘留：樣本獨贏低於門檻（37%/43% 這類）一律清除
  db.prepare(
    `
    DELETE FROM recommendations
    WHERE league IN (${BASEBALL_LEAGUE_SQL})
      AND IFNULL(phase, 'prematch') = 'prematch'
      AND tier = 'sample'
      AND market = 'h2h'
      AND model_prob < ?
  `
  ).run(minSampleH2h);

  // 滾球縮水盤污染的「初盤」大小：線不在全場合理帶 → 一律刪除重算
  const npbMin = config.npbTotalsLineMin ?? 6.5;
  const npbMax = config.npbTotalsLineMax ?? 13;
  const mlbMin = config.mlbTotalsLineMin ?? 5.5;
  const mlbMax = config.mlbTotalsLineMax ?? 14;
  db.prepare(
    `
    DELETE FROM recommendations
    WHERE IFNULL(phase, 'prematch') = 'prematch'
      AND market = 'totals'
      AND line IS NOT NULL
      AND (
        (league IN ('NPB','KBO') AND (line < ? OR line > ?))
        OR (league = 'MLB' AND (line < ? OR line > ?))
      )
  `
  ).run(npbMin, npbMax, mlbMin, mlbMax);

  // 樣本層不應出現在使用者初盤列表（僅供內部回測宇宙）
  db.prepare(
    `
    DELETE FROM recommendations
    WHERE league IN (${BASEBALL_LEAGUE_SQL})
      AND IFNULL(phase, 'prematch') = 'prematch'
      AND tier = 'sample'
  `
  ).run();

  db.prepare('DELETE FROM parlay_recommendations').run();
}


function buildRecEntry(game, pick, id) {
  return {
    id,
    gameId: game.id,
    league: game.league,
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    commenceTime: game.commence_time,
    modelProb: pick.modelProb,
    market: pick.market,
    pick: pick.pick,
    ev: pick.ev,
    score: pick.score,
    tier: pick.tier,
    odds: pick.odds,
  };
}

function startAnalysisRun(phase = 'prematch') {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO analysis_runs (id, model_version, phase, started_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(id, config.modelVersion, phase);
  const safeConfig = Object.fromEntries(
    Object.entries(config)
      .filter(([key, value]) => key !== 'oddsApiKey' && ['string', 'number', 'boolean'].includes(typeof value))
      .sort(([a], [b]) => a.localeCompare(b))
  );
  const weightsJson = JSON.stringify(safeConfig);
  const configHash = createHash('sha256').update(weightsJson).digest('hex');
  db.prepare(`
    INSERT INTO model_run_configs
      (analysis_run_id, model_version, config_hash, weights_json)
    VALUES (?, ?, ?, ?)
  `).run(id, config.modelVersion, configHash, weightsJson);
  return id;
}

function saveFeatureSnapshot(analysisRunId, game, analysis) {
  const features = {
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    commenceTime: game.commence_time,
    homeMlb: analysis.homeMlb,
    awayMlb: analysis.awayMlb,
    homePitcherStats: analysis.homePitcherStats,
    awayPitcherStats: analysis.awayPitcherStats,
    homeInjurySummary: analysis.homeInjurySummary,
    awayInjurySummary: analysis.awayInjurySummary,
    h2hComponents: analysis.h2hComponents,
    totalsProjection: analysis.totalsProjection,
    // SSOT prior：滾球條件更新只鎖定這組 λ / 純模型勝率
    scoringHomeRuns: analysis.scoringHomeRuns,
    scoringAwayRuns: analysis.scoringAwayRuns,
    homeRuns: analysis.homeRuns,
    awayRuns: analysis.awayRuns,
    rawModelHomeProb: analysis.rawModelHomeProb,
    homeWinProb: analysis.homeWinProb,
    dataQuality: analysis.dataQuality,
    hasTeamStrength: analysis.hasTeamStrength,
    modelVersion: config.modelVersion,
  };
  return db.prepare(`
    INSERT INTO feature_snapshots
      (analysis_run_id, game_id, league, features_json)
    VALUES (?, ?, ?, ?)
  `).run(analysisRunId, game.id, game.league, JSON.stringify(features)).lastInsertRowid;
}

function saveAnalysisDecisions(
  analysisRunId,
  featureSnapshotId,
  game,
  candidates,
  selected
) {
  const selectedKeys = new Set(
    (selected || []).map((pick) =>
      [pick.market, pick.pick, pick.line ?? ''].join('|')
    )
  );
  const insert = db.prepare(`
    INSERT OR REPLACE INTO analysis_decisions
      (analysis_run_id, feature_snapshot_id, game_id, league, market, pick, line,
       odds_decimal, raw_model_prob, market_prob, model_prob, implied_prob, ev,
       edge_prob, data_quality, actionable_score, eligible, selected, bet_strategy,
       reject_reason, model_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const candidate of candidates || []) {
      const key = [candidate.market, candidate.pick, candidate.line ?? ''].join('|');
      const selectedPick = (selected || []).find(
        (pick) => [pick.market, pick.pick, pick.line ?? ''].join('|') === key
      );
      insert.run(
        analysisRunId,
        featureSnapshotId,
        game.id,
        game.league,
        candidate.market,
        candidate.pick,
        candidate.line ?? null,
        candidate.oddsDecimal,
        candidate.rawModelProb ?? candidate.modelProb,
        candidate.marketProb ?? null,
        candidate.modelProb,
        candidate.impliedProb,
        candidate.ev,
        candidate.edgeProb ?? null,
        candidate.dataQuality ?? null,
        candidate.actionableScore ?? null,
        candidate.eligible === false ? 0 : 1,
        selectedKeys.has(key) ? 1 : 0,
        selectedPick?.bet_strategy ?? null,
        candidate.rejectReason ?? null,
        config.modelVersion
      );
    }
  });
  tx();
}

function finishAnalysisRun(id, recommendationCount, metadata = {}) {
  db.prepare(`
    UPDATE analysis_runs
    SET completed_at = datetime('now'), recommendation_count = ?, metadata_json = ?
    WHERE id = ?
  `).run(recommendationCount, JSON.stringify(metadata), id);
}

function saveRecommendationSnapshot(rec, recommendationId) {
  db.prepare(`
    INSERT INTO recommendation_snapshots
      (analysis_run_id, recommendation_id, game_id, league, phase, market, pick, line,
       odds_decimal, bookmaker, raw_model_prob, market_prob, calibrated_prob,
       implied_prob, push_prob, ev, confidence, tier, score, edge_prob, data_quality,
       bet_strategy, pick_rank, suggested_stake, reasoning, model_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rec.analysisRunId,
    recommendationId,
    rec.gameId,
    rec.league,
    rec.phase || 'prematch',
    rec.market,
    rec.pick,
    rec.line,
    rec.oddsDecimal,
    rec.bookmaker,
    rec.rawModelProb ?? rec.modelProb,
    rec.marketProb ?? rec.impliedProb,
    rec.calibratedProb ?? rec.modelProb,
    rec.impliedProb,
    rec.pushProb ?? 0,
    rec.ev,
    rec.confidence ?? 0.5,
    rec.tier,
    rec.score,
    rec.edgeProb,
    rec.dataQuality,
    rec.betStrategy ?? null,
    rec.pickRank ?? null,
    rec.suggestedStake ?? rec.suggested_stake ?? null,
    rec.reasoning,
    rec.modelVersion || config.modelVersion
  );
}

function saveRecommendation(rec) {
  const betStrategy =
    rec.betStrategy ??
    classifyBetStrategy(
      {
        tier: rec.tier,
        market: rec.market,
        league: rec.league,
        ev: rec.ev,
        edge_prob: rec.edgeProb,
        model_prob: rec.modelProb,
        odds_decimal: rec.oddsDecimal,
        data_quality: rec.dataQuality,
        pick_rank: rec.pickRank,
        pick: rec.pick,
        hasTeamStrength: rec.hasTeamStrength,
      },
      {
        pickRank: rec.pickRank,
        hasTeamStrength: rec.hasTeamStrength,
      }
    );

  const recommendationId = db
    .prepare(`
    INSERT INTO recommendations
      (game_id, league, market, pick, line, odds_decimal, bookmaker, model_prob,
       raw_model_prob, market_prob, calibrated_prob, implied_prob, push_prob,
       ev, confidence, reasoning, tier, score, edge_prob, data_quality, market_group,
       bet_strategy, pick_rank, actionable_score, suggested_stake, stake_multiplier,
       phase, model_version, analysis_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      rec.gameId,
      rec.league,
      rec.market,
      rec.pick,
      rec.line,
      rec.oddsDecimal,
      rec.bookmaker,
      rec.modelProb,
      rec.rawModelProb ?? rec.modelProb,
      rec.marketProb ?? rec.impliedProb,
      rec.calibratedProb ?? rec.modelProb,
      rec.impliedProb,
      rec.pushProb ?? 0,
      rec.ev,
      rec.confidence ?? 0.5,
      rec.reasoning,
      rec.tier,
      rec.score,
      rec.edgeProb,
      rec.dataQuality,
      rec.marketGroup || 'main',
      betStrategy,
      rec.pickRank ?? null,
      rec.actionableScore ?? null,
      rec.suggestedStake ?? rec.suggested_stake ?? null,
      rec.stakeMultiplier ?? rec.stake_multiplier ?? null,
      rec.phase || 'prematch',
      rec.modelVersion || config.modelVersion,
      rec.analysisRunId
    ).lastInsertRowid;

  saveRecommendationSnapshot(
    { ...rec, betStrategy, modelVersion: rec.modelVersion || config.modelVersion },
    recommendationId
  );
  return recommendationId;
}

/**
 * 同步賠率與比分，更新隊伍統計
 * @param {{ forceHeavy?: boolean, leagueCodes?: string[] }} [options]
 * forceHeavy=true 時無視 Yahoo/Elo/近窗快取；leagueCodes 限制外部賠率／比分同步範圍
 */
export async function syncAllData(options = {}) {
  const forceHeavy = options.forceHeavy === true;
  const leagueCodes = Array.isArray(options.leagueCodes) ? options.leagueCodes : null;
  const [oddsData, scoresData] = await Promise.all([
    fetchAllLeagueOdds(leagueCodes),
    fetchAllLeagueScores(leagueCodes),
  ]);

  let mlbStandings = [];
  try {
    mlbStandings = await getMlbStandings();
  } catch (err) {
    console.warn('MLB standings 取得失敗:', err.message);
  }

  for (const [code, { scores, error }] of Object.entries(scoresData.results)) {
    if (error) {
      console.warn(`[${code}] 比分同步失敗:`, error);
      continue;
    }
    updateTeamStatsFromScores(code, scores);

    for (const game of scores) {
      const hsRaw = game.scores?.find((s) => s.name === game.home_team)?.score;
      const asRaw = game.scores?.find((s) => s.name === game.away_team)?.score;
      const hs = hsRaw != null && hsRaw !== '' ? parseInt(hsRaw, 10) : null;
      const as = asRaw != null && asRaw !== '' ? parseInt(asRaw, 10) : null;
      const isDone =
        Boolean(game.completed) ||
        game.status === 'completed' ||
        /終了|final/i.test(String(game.status || ''));
      const gameStatus = isDone
        ? 'completed'
        : game.status || 'in_progress';

      if (!isDone) {
        // 進行中場次也寫入當前比分，供滾球模型使用；勿把已完賽改回 completed=0
        db.prepare(`
          INSERT INTO games (id, league, commence_time, home_team, away_team, completed, home_score, away_score, status, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            completed = CASE WHEN games.completed = 1 OR games.status = 'completed' THEN 1 ELSE 0 END,
            commence_time = excluded.commence_time,
            home_score = COALESCE(excluded.home_score, games.home_score),
            away_score = COALESCE(excluded.away_score, games.away_score),
            status = CASE
              WHEN games.completed = 1 OR games.status = 'completed' THEN 'completed'
              ELSE excluded.status
            END,
            updated_at = datetime('now')
        `).run(game.id, code, game.commence_time, game.home_team, game.away_team, hs, as, gameStatus);
        continue;
      }
      db.prepare(`
        INSERT INTO games (id, league, commence_time, home_team, away_team, completed, home_score, away_score, status, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          completed=1, home_score=?, away_score=?, status=?, updated_at=datetime('now')
      `).run(
        game.id, code, game.commence_time, game.home_team, game.away_team,
        hs, as, gameStatus, hs, as, gameStatus
      );
    }
  }

  for (const [code, { games, error }] of Object.entries(oddsData.results)) {
    if (error) {
      console.warn(`[${code}] 賠率同步失敗:`, error);
      continue;
    }
    for (const game of games) {
      upsertGame(game, code);
    }
  }

  const yahooMaxH = config.baseballYahooMaxAgeHours ?? 6;
  const eloMaxH = config.baseballEloMaxAgeHours ?? 4;
  const rollingMaxH = config.baseballRollingMaxAgeHours ?? 3;
  const isMlbOnlyRefresh =
    Array.isArray(leagueCodes) &&
    leagueCodes.length === 1 &&
    leagueCodes[0] === 'MLB';

  if (!isMlbOnlyRefresh) {
    // NPB：Odds API scores 常為 null → Yahoo 順位表補隊力（免費、不耗 Odds 額度）
    if (forceHeavy || shouldRebuildHeavy('baseball_yahoo_at', yahooMaxH)) {
      try {
        const npbSync = await syncNpbStandingsFromYahoo();
        setMeta('baseball_yahoo_at', new Date().toISOString());
        console.log(`[sync] Yahoo NPB 順位 ${npbSync.count} 隊`);
      } catch (err) {
        console.warn('[sync] Yahoo NPB 順位失敗:', err.message);
      }
    } else {
      console.log(
        `[sync] Yahoo NPB 沿用快取（${metaAgeHours('baseball_yahoo_at').toFixed(1)}h 前）`
      );
    }

    // NPB/KBO：完賽序重放滾動 Elo（供獨贏 / 泊松 λ）
    if (forceHeavy || shouldRebuildHeavy('baseball_elo_at', eloMaxH)) {
      try {
        const elo = rebuildAllBaseballElo();
        setMeta('baseball_elo_at', new Date().toISOString());
        console.log(
          `[sync] Elo 重建 NPB ${elo.NPB.games}場/${elo.NPB.teams}隊 · KBO ${elo.KBO.games}場/${elo.KBO.teams}隊`
        );
      } catch (err) {
        console.warn('[sync] Elo 重建失敗:', err.message);
      }

      // NPB/KBO：用 DB 完賽比分補回戰績/得失分（避免只剩 Elo 空殼 → 永遠樣本）
      try {
        const npbStats = updateTeamStatsFromDbGames('NPB');
        const kboStats = updateTeamStatsFromDbGames('KBO');
        console.log(
          `[sync] 隊力重建 NPB ${npbStats.games}場/${npbStats.teams}隊 · KBO ${kboStats.games}場/${kboStats.teams}隊`
        );
      } catch (err) {
        console.warn('[sync] 隊力重建失敗:', err.message);
      }
    } else {
      console.log(
        `[sync] Elo/隊力沿用快取（${metaAgeHours('baseball_elo_at').toFixed(1)}h 前）`
      );
      // 輕量：只補隊力數字，不做 Elo 重放
      try {
        updateTeamStatsFromDbGames('NPB');
        updateTeamStatsFromDbGames('KBO');
      } catch (err) {
        console.warn('[sync] 隊力輕量更新失敗:', err.message);
      }
    }

    // 近窗形態：完賽累積 RPG + MLB OBP/SLG/OPS/WHIP（初盤 λ 輸入）
    if (forceHeavy || shouldRebuildHeavy('baseball_rolling_at', rollingMaxH)) {
      try {
        const rolling = await refreshAllRollingTeamForm();
        setMeta('baseball_rolling_at', new Date().toISOString());
        console.log(
          `[sync] 近窗形態 NPB ${rolling.NPB.teams}隊 · KBO ${rolling.KBO.teams}隊` +
            ` · MLB OPS ${rolling.MLB_ops?.teams ?? 0}隊` +
            ` · NPB baseball-data ${rolling.NPB_ops?.teams ?? 0}隊` +
            ` · KBO 官網 ${rolling.KBO_ops?.teams ?? 0}隊`
        );
      } catch (err) {
        console.warn('[sync] 近窗形態失敗:', err.message);
      }
    } else {
      console.log(
        `[sync] 近窗形態沿用快取（${metaAgeHours('baseball_rolling_at').toFixed(1)}h 前）`
      );
    }

    // Dixon–Coles ρ：24h 內已擬合則重用，避免每次同步重算
    try {
      const dcPath = path.join(__analysisDir, '../../data/dixon-coles.json');
      let reuse = null;
      if (fs.existsSync(dcPath)) {
        try {
          const prev = JSON.parse(fs.readFileSync(dcPath, 'utf8'));
          const ageH =
            prev.fittedAt != null
              ? (Date.now() - Date.parse(prev.fittedAt)) / 3600000
              : Infinity;
          if (Number.isFinite(ageH) && ageH < 24) reuse = prev;
        } catch {
          /* refit */
        }
      }
      if (reuse?.NPB || reuse?.KBO) {
        if (reuse.NPB?.rho != null) config.dixonColesRhoNpb = reuse.NPB.rho;
        if (reuse.KBO?.rho != null) config.dixonColesRhoKbo = reuse.KBO.rho;
        console.log(
          `[sync] Dixon–Coles 沿用快取 ρ NPB=${reuse.NPB?.rho} · KBO=${reuse.KBO?.rho}` +
            `（${reuse.fittedAt || ''}）`
        );
      } else {
        const dc = fitAllDixonColesRho();
        fs.mkdirSync(path.dirname(dcPath), { recursive: true });
        fs.writeFileSync(
          dcPath,
          JSON.stringify({ ...dc, fittedAt: new Date().toISOString() }, null, 2),
          'utf8'
        );
        if (dc.NPB?.rho != null) config.dixonColesRhoNpb = dc.NPB.rho;
        if (dc.KBO?.rho != null) config.dixonColesRhoKbo = dc.KBO.rho;
        console.log(
          `[sync] Dixon–Coles ρ NPB=${dc.NPB?.rho} (n=${dc.NPB?.n}) · KBO=${dc.KBO?.rho} (n=${dc.KBO?.n})`
        );
      }
    } catch (err) {
      console.warn('[sync] Dixon–Coles 擬合失敗:', err.message);
    }
  } else {
    console.log('[sync] MLB 賽前排程略過 NPB/KBO 重建與衍生資料寫入');
  }

  // 記錄 MLB 當日預期場次（用於串關覆蓋率顯示）
  try {
    const schedule = await getMlbScheduleRange(1);
    const expected = schedule.filter((sg) => {
      const t = sg.gameDate || sg.gameDateTime;
      return t && new Date(t) > new Date();
    }).length;
    setMeta('mlb_slate_expected', expected);
  } catch (err) {
    console.warn('[sync] MLB 賽程統計失敗:', err.message);
  }

  let propsQuota = null;
  if (config.enablePlayerProps && oddsData.results.MLB?.games?.length) {
    try {
      const { propsByGameId, quota } = await fetchMlbPlayerProps(
        oddsData.results.MLB.games,
        config.maxPropGames
      );
      propsQuota = quota;
      for (const [gameId, bookmakers] of Object.entries(propsByGameId)) {
        if (bookmakers?.length) saveGameProps(gameId, bookmakers);
      }
      console.log(`[sync] MLB 球員盤口: ${Object.keys(propsByGameId).length} 場`);
    } catch (err) {
      console.warn('[sync] 球員盤口同步失敗:', err.message);
    }
  }

  return {
    oddsQuota: oddsData.quota,
    scoresQuota: scoresData.quota,
    propsQuota,
    gameCounts: Object.fromEntries(
      Object.entries(oddsData.results).map(([k, v]) => [k, v.games?.length || 0])
    ),
  };
}

/** 對所有初盤場次跑分析並產生推薦 */
export async function runAnalysis() {
  if (config.mlbTruthResearchOnly) {
    return {
      disabled: true,
      mode: 'research_only',
      reason: 'legacy_recommendation_pipeline_disabled',
      singles: 0,
      parlays: 0,
      modelVersion: config.modelVersion,
    };
  }
  clearOldRecommendations();
  try {
    const oddsFix = restorePrematchOddsFromSnapshots();
    if (oddsFix.restored) {
      console.log(`[analysis] 還原初盤盤口 ${oddsFix.restored}/${oddsFix.games} 場`);
    }
  } catch (err) {
    console.warn('[analysis] 還原初盤盤口失敗:', err.message);
  }
  const analysisRunId = startAnalysisRun('prematch');

  // 分析前確保隊力可用；近窗若 sync 剛刷過則沿用，避免連打兩次 MLB Stats API
  try {
    updateTeamStatsFromDbGames('NPB');
    updateTeamStatsFromDbGames('KBO');
    const rollingMaxH = config.baseballRollingMaxAgeHours ?? 3;
    if (shouldRebuildHeavy('baseball_rolling_at', rollingMaxH)) {
      await refreshAllRollingTeamForm();
      setMeta('baseball_rolling_at', new Date().toISOString());
      console.log('[analysis] 近窗形態已補刷');
    } else {
      console.log(
        `[analysis] 近窗形態沿用快取（${metaAgeHours('baseball_rolling_at').toFixed(1)}h 前）`
      );
    }
  } catch (err) {
    console.warn('[analysis] 隊力/近窗形態重建失敗:', err.message);
  }

  let mlbStandings = [];
  let mlbSchedule = [];
  try {
    [mlbStandings, mlbSchedule] = await Promise.all([
      getMlbStandings(),
      getMlbScheduleRange(3),
    ]);
  } catch (err) {
    console.warn('MLB 資料取得失敗:', err.message);
  }
  if (!Array.isArray(mlbStandings)) mlbStandings = [];
  if (!Array.isArray(mlbSchedule)) mlbSchedule = [];

  // 分析候選：常規窗（未開賽+開賽1h）∪ 展示窗內「尚無現行模型初盤」的已開賽場
  // （模型升級後要把凍結的舊推薦重算掉，否則重啟也看不到變化）
  const upcoming = db
    .prepare(`
    SELECT * FROM games g
    WHERE g.league IN (${BASEBALL_LEAGUE_SQL})
      AND g.raw_odds IS NOT NULL
      AND length(g.raw_odds) > 10
      AND (
        ${prematchAnalyzeGameWhere('g')}
        OR (
          ${slateDisplayGameWhere('g')}
          AND NOT EXISTS (
            SELECT 1 FROM recommendations r
            WHERE r.game_id = g.id
              AND IFNULL(r.phase, 'prematch') = 'prematch'
              AND IFNULL(r.model_version, 'legacy') = ?
          )
        )
      )
    ORDER BY g.commence_time ASC
  `)
    .all(config.modelVersion);

  const allRecs = [];
  const hasCurrentPrematchRec = db.prepare(`
    SELECT 1 AS ok FROM recommendations
    WHERE game_id = ?
      AND IFNULL(phase, 'prematch') = 'prematch'
      AND IFNULL(model_version, 'legacy') = ?
    LIMIT 1
  `);

  // NPB/KBO：開賽前 walk-forward Elo（與回測一致；不可直接用「含本場後」的 team_stats.elo）
  const eloWalkers = {
    NPB: createWalkForwardElo('NPB', { seedFromRating: false }),
    KBO: createWalkForwardElo('KBO', { seedFromRating: false }),
  };
  const eloChrono = db
    .prepare(
      `
    SELECT league, home_team, away_team, home_score, away_score, commence_time
    FROM games
    WHERE league IN ('NPB','KBO')
      AND completed = 1
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND NOT (home_score = 0 AND away_score = 0)
    ORDER BY datetime(commence_time) ASC
  `
    )
    .all();
  let eloCursor = 0;
  const datetimeKey = (t) => String(t || '');

  for (const game of upcoming) {
    try {
    const started = isGameStarted(game.commence_time, game.completed);
    if (started && hasCurrentPrematchRec.get(game.id, config.modelVersion)) continue;

    // 已開賽：強制用開賽前合理快照，禁止滾球縮水盤重算「初盤」
    const bookmakers = loadPrematchBookmakers(game);
    if (!bookmakers.length) continue;

    let mlbScheduleGame = null;
    if (game.league === 'MLB') {
      mlbScheduleGame = matchMlbOfficialGame(game, mlbSchedule);
    }

    while (eloCursor < eloChrono.length) {
      const eg = eloChrono[eloCursor];
      if (datetimeKey(eg.commence_time) >= datetimeKey(game.commence_time)) break;
      const w = eloWalkers[eg.league];
      if (w) w.applyGame(eg.home_team, eg.away_team, eg.home_score, eg.away_score);
      eloCursor += 1;
    }
    const eloOverride =
      game.league === 'NPB' || game.league === 'KBO' ? eloWalkers[game.league] : null;

    const analysis = await analyzeMatchup(
      game.league,
      game.home_team,
      game.away_team,
      bookmakers,
      {
        mlbStandings,
        mlbScheduleGame,
        eloOverride,
        commenceTime: game.commence_time,
      }
    );
    const featureSnapshotId = saveFeatureSnapshot(analysisRunId, game, analysis);

    const markets = extractMarkets(bookmakers);
    const reasoning = analysis.factors.join(' | ');

    let decisionCapture = null;
    let propsContext = {
      bookmakers,
      onDecisionCandidates: (payload) => {
        decisionCapture = payload;
      },
    };

    if (game.league === 'MLB' && config.enablePlayerProps) {
      const rawProps = JSON.parse(game.raw_props || '[]');
      const propsMap = extractPlayerProps(rawProps);
      let homePitcherStats = null;
      let awayPitcherStats = null;
      let homePitcherName = null;
      let awayPitcherName = null;

      if (mlbScheduleGame) {
        const pitchers = getProbablePitchers(mlbScheduleGame);
        const pitOptions = {
          cutoffDate: mlbScheduleGame.officialDate ?? null,
          excludeGamePk: mlbScheduleGame.gamePk ?? null,
        };
        homePitcherName = pitchers.home?.name;
        awayPitcherName = pitchers.away?.name;
        [homePitcherStats, awayPitcherStats] = await Promise.all([
          getMlbPitcherPregameFeatures(pitchers.home?.id, game.commence_time, pitOptions),
          getMlbPitcherPregameFeatures(pitchers.away?.id, game.commence_time, pitOptions),
        ]);
      }

      propsContext = {
        ...propsContext,
        propsMap,
        homePitcherStats,
        awayPitcherStats,
        homePitcherName,
        awayPitcherName,
      };
    } else if (game.league === 'MLB' && mlbScheduleGame) {
      const pitchers = getProbablePitchers(mlbScheduleGame);
      const pitOptions = {
        cutoffDate: mlbScheduleGame.officialDate ?? null,
        excludeGamePk: mlbScheduleGame.gamePk ?? null,
      };
      const [homePitcherStats, awayPitcherStats] = await Promise.all([
        getMlbPitcherPregameFeatures(pitchers.home?.id, game.commence_time, pitOptions),
        getMlbPitcherPregameFeatures(pitchers.away?.id, game.commence_time, pitOptions),
      ]);
      propsContext = { ...propsContext, homePitcherStats, awayPitcherStats };
    }

    const picks = pickGameRecommendations(game, markets, analysis, reasoning, propsContext);
    if (decisionCapture) {
      saveAnalysisDecisions(
        analysisRunId,
        featureSnapshotId,
        game,
        decisionCapture.candidates,
        decisionCapture.selected
      );
    }

    // 重算前清掉該場舊初盤，避免凍結殘留與新結果疊加
    db.prepare(
      `
      DELETE FROM recommendations
      WHERE game_id = ? AND IFNULL(phase, 'prematch') = 'prematch'
    `
    ).run(game.id);

    // 樣本層只進 decisions 回測宇宙，不寫使用者初盤推薦
    const publishPicks = (picks || []).filter((p) => p.tier && p.tier !== 'sample');
    for (const pick of publishPicks) {
      const id = saveRecommendation({
        gameId: game.id,
        league: game.league,
        market: pick.market,
        marketGroup: pick.marketGroup || (pick.market?.startsWith('pitcher_') || pick.market?.startsWith('batter_') ? 'props' : 'main'),
        pick: pick.pick,
        line: pick.line ?? null,
        oddsDecimal: pick.oddsDecimal,
        bookmaker: pick.bookmaker || pick.odds?.bookmaker,
        modelProb: pick.modelProb,
        rawModelProb: pick.rawModelProb ?? pick.modelProb,
        marketProb: pick.marketProb ?? pick.impliedProb,
        calibratedProb: pick.calibratedProb ?? pick.modelProb,
        impliedProb: pick.impliedProb,
        pushProb: pick.pushProb ?? 0,
        ev: pick.ev,
        confidence: pick.confidence,
        reasoning: pick.reasoning,
        tier: pick.tier,
        score: pick.score,
        edgeProb: pick.edgeProb,
        dataQuality: pick.dataQuality,
        pickRank: pick.pickRank,
        actionableScore: pick.actionableScore,
        suggestedStake: pick.suggestedStake,
        stakeMultiplier: pick.stakeMultiplier,
        betStrategy: pick.bet_strategy,
        hasTeamStrength: pick.hasTeamStrength ?? analysis?.hasTeamStrength,
        analysisRunId,
        modelVersion: config.modelVersion,
      });
      allRecs.push(buildRecEntry(game, pick, id));
    }
    } catch (err) {
      console.warn(`[analysis] ${game.league} ${game.away_team} @ ${game.home_team} 失敗:`, err.message);
    }
  }

  const parlays = buildParlaysFromDb({ limit: 40 });
  persistParlays(parlays);
  finishAnalysisRun(analysisRunId, allRecs.length, {
    parlays: parlays.length,
    leagues: BASEBALL_LEAGUE_CODES,
  });
  return {
    singles: allRecs.length,
    parlays: parlays.length,
    analysisRunId,
    modelVersion: config.modelVersion,
  };
}

function persistParlays(parlays) {
  db.prepare('DELETE FROM parlay_recommendations').run();
  for (const p of parlays) {
    db.prepare(`
      INSERT INTO parlay_recommendations (legs, combined_odds, combined_prob, combined_ev, suggested_stake)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      JSON.stringify({
        legs: p.legs,
        pickSummary: p.pickSummary,
        combined_score: p.combined_score,
        leg_count: p.leg_count,
        category: p.category,
        parlay_label: p.parlay_label,
        potential_payout: p.potential_payout,
      }),
      p.combined_odds,
      p.combined_prob,
      p.combined_ev,
      p.suggested_stake
    );
  }
}

export function getParlayRecommendations(limit = 40) {
  const dynamic = buildParlaysFromDb({ limit });
  if (dynamic.length) return dynamic;

  return db
    .prepare('SELECT * FROM parlay_recommendations ORDER BY combined_ev DESC LIMIT ?')
    .all(limit)
    .map((p, idx) => {
      const parsed = JSON.parse(p.legs);
      const legs = Array.isArray(parsed) ? parsed : parsed.legs || [];
      const enriched = legs.map((leg) => {
        if (leg.homeTeam) return leg;
        const game = leg.gameId
          ? db.prepare('SELECT league, home_team, away_team, commence_time FROM games WHERE id = ?').get(leg.gameId)
          : null;
        return {
          ...leg,
          league: leg.league || game?.league,
          homeTeam: leg.homeTeam || game?.home_team,
          awayTeam: leg.awayTeam || game?.away_team,
          commenceTime: leg.commenceTime || game?.commence_time,
        };
      });
      return {
        id: p.id || `saved-${idx}`,
        legs: enriched,
        pickSummary: parsed.pickSummary || enriched.map((l) => l.pick).join(' + '),
        combined_odds: p.combined_odds,
        combined_prob: p.combined_prob,
        combined_ev: p.combined_ev,
        combined_score: parsed.combined_score,
        leg_count: parsed.leg_count || enriched.length,
        suggested_stake: p.suggested_stake ?? config.parlayBetUsd,
        potential_payout: parsed.potential_payout ?? p.combined_odds * (p.suggested_stake || config.parlayBetUsd),
        parlay_label: parsed.parlay_label,
        category: parsed.category,
      };
    });
}

export { LEAGUE_MARKETS_INFO };

export function getRecommendations(filters = {}) {
  const {
    league,
    minEv = 0,
    market,
    marketGroup,
    tier,
    betStrategy,
    gamePicks,
    limit = 80,
  } = filters;
  let sql = `
    SELECT r.*, g.home_team, g.away_team, g.commence_time
    FROM recommendations r
    JOIN games g ON g.id = r.game_id
    WHERE r.league IN (${BASEBALL_LEAGUE_SQL})
      AND IFNULL(r.phase, 'prematch') = 'prematch'
      AND r.ev >= ?
      AND ${activeGameWhere('g')}
  `;
  const params = [minEv];

  if (tier) {
    sql += ' AND r.tier = ?';
    params.push(tier);
  }
  if (league) {
    sql += ' AND r.league = ?';
    params.push(league);
  }
  if (market) {
    sql += ' AND r.market = ?';
    params.push(market);
  }
  if (marketGroup === 'props') {
    sql += " AND r.market_group = 'props'";
  } else if (marketGroup === 'main') {
    sql += " AND r.market_group = 'main'";
  }

  if (gamePicks) {
    sql += ' AND r.pick_rank IS NOT NULL';
    sql += ' ORDER BY g.commence_time ASC, r.pick_rank ASC, r.actionable_score DESC';
  } else if (betStrategy === 'flat_bet' || betStrategy === 'parlay_anchor') {
    sql += ' AND r.bet_strategy = ?';
    params.push(betStrategy);
    if (betStrategy === 'flat_bet') {
      sql += " AND r.tier = 'primary' AND r.odds_decimal >= ?";
      params.push(config.flatBetMinOdds);
      sql += ' ORDER BY g.commence_time ASC, COALESCE(r.pick_rank, 99) ASC, r.ev DESC';
    } else {
      sql += ' ORDER BY r.model_prob DESC, r.ev DESC';
    }
  } else {
    sql += " ORDER BY CASE r.tier WHEN 'primary' THEN 0 WHEN 'watch' THEN 1 WHEN 'sample' THEN 2 ELSE 3 END, COALESCE(r.pick_rank, 99) ASC, r.actionable_score DESC, r.score DESC";
  }

  const rows = db.prepare(sql).all(...params);
  const enriched = rows.map((r) => {
    const base = {
      ...r,
      is_started: isGameStarted(r.commence_time),
      /** 真滾球推薦僅 phase=live；初盤已開賽用 is_started */
      is_live: r.phase === 'live',
      pick_rank: r.pick_rank,
      rank_label:
        r.pick_rank === 1 ? '主推' : r.pick_rank === 2 ? '次推' : r.pick_rank ? `第${r.pick_rank}推` : null,
      bet_strategy: r.bet_strategy || classifyBetStrategy(r),
    };
    if (base.suggested_stake == null && base.pick_rank != null) {
      return enrichWithSuggestedStake(base);
    }
    return base;
  });

  const filtered =
    !gamePicks && (betStrategy === 'flat_bet' || betStrategy === 'parlay_anchor')
      ? enriched.filter((r) => r.bet_strategy === betStrategy)
      : enriched;

  return filtered.slice(0, limit);
}

export function getBettingStrategyMeta() {
  const stakeMeta = getStakeSizingMeta();
  return {
    flatBet: {
      label: '均注精選',
      minOdds: config.flatBetMinOdds,
      minProb: config.flatBetMinProb,
      minEdgePct: config.flatBetMinEdgePct,
      minEv: config.minEvThreshold,
      baseUnit: stakeMeta.baseUnit,
      currency: stakeMeta.currency,
      stakeSizing: stakeMeta,
      markets: ['h2h', 'spreads', 'totals', 'props'],
      description: '跨盤口排序 · 基準均注動態建議額 · 高 EV 多投',
    },
    parlayAnchor: {
      label: '串關錨腿',
      minOdds: config.parlayAnchorMinOdds,
      maxOdds: config.parlayAnchorMaxOdds,
      minProb: config.parlayAnchorMinProb,
      baseUnit: stakeMeta.baseUnit,
      currency: stakeMeta.currency,
      stakeRatio: config.parlayAnchorStakeRatio,
      description: '低水高勝率 · 建議額為基準均注的縮倉比例',
    },
  };
}

export function getUpcomingGames(league) {
  let sql = `
    SELECT * FROM games
    WHERE league IN (${BASEBALL_LEAGUE_SQL})
      AND ${activeGameWhere()}
  `;
  const params = [];
  if (league) {
    sql += ' AND league = ?';
    params.push(league);
  }
  sql += ' ORDER BY commence_time ASC';
  return db.prepare(sql).all(...params);
}

export function getBetStats() {
  return db
    .prepare(`
    SELECT
      COUNT(*) as total_bets,
      SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN result = 'pending' THEN 1 ELSE 0 END) as pending,
      COALESCE(SUM(profit), 0) as total_profit,
      COALESCE(SUM(stake), 0) as total_staked
    FROM bet_log
  `)
    .get();
}

/** 樣本外模型表現；只計不可變快照中已結算的 win/loss。 */
export function getModelPerformance(filters = {}) {
  let sql = `
    WITH canonical AS (
      SELECT s.model_version, s.league, s.market, s.calibrated_prob, s.result,
             s.profit_units, s.odds_decimal, s.clv_prob, s.created_at,
             ROW_NUMBER() OVER (
               PARTITION BY s.model_version, s.game_id, s.market, s.pick, COALESCE(s.line, -999)
               ORDER BY datetime(s.created_at) ASC
             ) AS rn
      FROM recommendation_snapshots s
      JOIN games g ON g.id = s.game_id
      WHERE s.phase = 'prematch'
        AND s.result IN ('win', 'loss')
        AND datetime(s.created_at) < datetime(g.commence_time)
    )
    SELECT model_version, league, market, calibrated_prob, result,
           profit_units, odds_decimal, clv_prob, created_at
    FROM canonical
    WHERE rn = 1
  `;
  const params = [];
  if (filters.modelVersion) {
    sql += ' AND model_version = ?';
    params.push(filters.modelVersion);
  }
  if (filters.league) {
    sql += ' AND league = ?';
    params.push(filters.league);
  }
  const rows = db.prepare(sql).all(...params);
  const groups = new Map();

  for (const row of rows) {
    const key = `${row.model_version}|${row.league}|${row.market}`;
    if (!groups.has(key)) {
      groups.set(key, {
        modelVersion: row.model_version,
        league: row.league,
        market: row.market,
        samples: 0,
        wins: 0,
        profitUnits: 0,
        probabilitySum: 0,
        brierSum: 0,
        logLossSum: 0,
        clvSum: 0,
        clvSamples: 0,
      });
    }
    const group = groups.get(key);
    const y = row.result === 'win' ? 1 : 0;
    const p = Math.max(0.001, Math.min(0.999, row.calibrated_prob));
    group.samples += 1;
    group.wins += y;
    group.profitUnits += row.profit_units ?? 0;
    group.probabilitySum += p;
    group.brierSum += (p - y) ** 2;
    group.logLossSum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    if (row.clv_prob != null) {
      group.clvSum += row.clv_prob;
      group.clvSamples += 1;
    }
  }

  return [...groups.values()].map((g) => ({
    modelVersion: g.modelVersion,
    league: g.league,
    market: g.market,
    samples: g.samples,
    wins: g.wins,
    hitRate: g.samples ? g.wins / g.samples : null,
    avgPredictedProb: g.samples ? g.probabilitySum / g.samples : null,
    roi: g.samples ? g.profitUnits / g.samples : null,
    profitUnits: g.profitUnits,
    brierScore: g.samples ? g.brierSum / g.samples : null,
    logLoss: g.samples ? g.logLossSum / g.samples : null,
    avgClvProb: g.clvSamples ? g.clvSum / g.clvSamples : null,
    clvSamples: g.clvSamples,
  }));
}

export function logBet(bet) {
  if (bet.recId != null) {
    const existing = db
      .prepare(`
        SELECT id FROM bet_log
        WHERE rec_id = ? AND rec_type = ? AND result = 'pending'
      `)
      .get(bet.recId, bet.recType || 'single');
    if (existing) {
      const err = new Error('此推薦已記錄投注');
      err.code = 'DUPLICATE_BET';
      throw err;
    }
  }

  const recommendation =
    bet.recType !== 'parlay' && bet.recId != null
      ? db.prepare('SELECT * FROM recommendations WHERE id = ?').get(bet.recId)
      : null;
  const potentialReturn = bet.stake * bet.oddsDecimal;
  return db
    .prepare(`
    INSERT INTO bet_log
      (rec_type, rec_id, game_id, league, market, pick, line, stake, odds_decimal,
       potential_return, bet_strategy, phase, raw_model_prob, market_prob,
       calibrated_prob, implied_prob, ev, model_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      bet.recType || 'single',
      bet.recId,
      bet.gameId ?? recommendation?.game_id,
      bet.league ?? recommendation?.league,
      bet.market ?? recommendation?.market,
      bet.pick ?? recommendation?.pick,
      bet.line ?? recommendation?.line ?? null,
      bet.stake,
      bet.oddsDecimal,
      potentialReturn,
      recommendation?.bet_strategy ?? null,
      recommendation?.phase ?? 'prematch',
      recommendation?.raw_model_prob ?? null,
      recommendation?.market_prob ?? null,
      recommendation?.calibrated_prob ?? recommendation?.model_prob ?? null,
      recommendation?.implied_prob ?? null,
      recommendation?.ev ?? null,
      recommendation?.model_version ?? config.modelVersion
    ).lastInsertRowid;
}

export function settleBet(betId, result, profit) {
  if (!['win', 'loss', 'push', 'void'].includes(result)) {
    throw new Error('result 須為 win/loss/push/void');
  }
  db.prepare(`
    UPDATE bet_log SET result = ?, profit = ?, settled_at = datetime('now') WHERE id = ?
  `).run(result, profit, betId);
}

export function getBetLog(limit = 100) {
  return db.prepare('SELECT * FROM bet_log ORDER BY created_at DESC LIMIT ?').all(limit);
}

function parseSpreadPick(pick) {
  const match = pick.match(/^(.+?)\s+([+-]?\d+\.?\d*)$/);
  if (!match) return null;
  return { team: match[1].trim(), line: parseFloat(match[2]) };
}

function parseTotalPick(pick, fallbackLine = null) {
  const match = String(pick || '').match(/^(大|小|over|under)\s+(\d+(?:\.\d+)?)$/i);
  if (!match && fallbackLine == null) return null;
  const token = match?.[1]?.toLowerCase();
  return {
    side: token === '大' || token === 'over' ? 'over' : 'under',
    line: match ? parseFloat(match[2]) : Number(fallbackLine),
  };
}

/** 所有棒球主盤共用同一結算狀態機。 */
export function evaluateBaseballMarketResult(entry, game) {
  const status = String(game.status || '').toLowerCase();
  if (['canceled', 'cancelled', 'postponed', 'abandoned', 'void'].includes(status)) {
    return 'void';
  }
  if (game.home_score == null || game.away_score == null) {
    const commenceMs = Date.parse(game.commence_time || '');
    const staleWithoutScore =
      Number.isFinite(commenceMs) &&
      Date.now() - commenceMs >= config.settlementVoidAfterHours * 60 * 60 * 1000;
    return game.completed === 1 || staleWithoutScore ? 'void' : null;
  }
  const hs = Number(game.home_score);
  const as = Number(game.away_score);
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;

  if (entry.market === 'h2h') {
    if (entry.pick === game.home_team) {
      return hs > as ? 'win' : hs < as ? 'loss' : 'push';
    }
    if (entry.pick === game.away_team) {
      return as > hs ? 'win' : as < hs ? 'loss' : 'push';
    }
    return null;
  }

  if (entry.market === 'spreads') {
    const parsed = parseSpreadPick(entry.pick);
    if (!parsed) return null;
    const isHome = parsed.team === game.home_team;
    const isAway = parsed.team === game.away_team;
    if (!isHome && !isAway) return null;
    const line = Number.isFinite(Number(entry.line)) ? Number(entry.line) : parsed.line;
    const margin = isHome ? hs - as + line : as - hs + line;
    return margin > 0 ? 'win' : margin < 0 ? 'loss' : 'push';
  }

  if (entry.market === 'totals') {
    const parsed = parseTotalPick(entry.pick, entry.line);
    if (!parsed || !Number.isFinite(parsed.line)) return null;
    const total = hs + as;
    if (total === parsed.line) return 'push';
    return parsed.side === 'over'
      ? total > parsed.line
        ? 'win'
        : 'loss'
      : total < parsed.line
        ? 'win'
        : 'loss';
  }

  return null;
}

function findClosingMarket(entry, game) {
  const closingSnapshot = db.prepare(`
    SELECT bookmakers_json
    FROM odds_snapshots
    WHERE game_id = ?
      AND datetime(captured_at) < datetime(?)
      AND source NOT LIKE '%_post_start'
    ORDER BY datetime(captured_at) DESC
    LIMIT 1
  `).get(entry.game_id, game.commence_time);
  const oddsJson = closingSnapshot?.bookmakers_json ??
    (game.league === 'MLB' ? null : game.raw_odds);
  if (!oddsJson) return null;
  let bookmakers;
  try {
    bookmakers = JSON.parse(oddsJson);
  } catch {
    return null;
  }
  const markets = extractMarkets(bookmakers);
  if (entry.market === 'h2h') {
    const selected = markets.h2h?.[entry.pick]?.price;
    const oppositeTeam =
      entry.pick === game.home_team ? game.away_team : game.home_team;
    const opposite = markets.h2h?.[oppositeTeam]?.price;
    if (!selected) return null;
    const implied = decimalToImpliedProb(selected);
    return {
      odds: selected,
      fairProb: opposite
        ? removeVig(implied, decimalToImpliedProb(opposite)).fairA
        : implied,
    };
  }
  if (entry.market === 'spreads') {
    const parsed = parseSpreadPick(entry.pick);
    const line = Number.isFinite(Number(entry.line)) ? Number(entry.line) : parsed?.line;
    const outcome = Object.values(markets.spreads || {}).find(
      (o) => o.name === parsed?.team && Math.abs(Number(o.point) - line) < 0.001
    );
    if (!outcome?.price) return null;
    const opposite = Object.values(markets.spreads || {}).find(
      (o) =>
        o.name !== parsed?.team &&
        Math.abs(Number(o.point) + line) < 0.001
    );
    const implied = decimalToImpliedProb(outcome.price);
    return {
      odds: outcome.price,
      fairProb: opposite?.price
        ? removeVig(implied, decimalToImpliedProb(opposite.price)).fairA
        : implied,
    };
  }
  if (entry.market === 'totals') {
    const parsed = parseTotalPick(entry.pick, entry.line);
    if (!parsed) return null;
    const key = `${parsed.side === 'over' ? 'Over' : 'Under'}_${parsed.line}`;
    const outcome = markets.totals?.[key];
    if (!outcome?.price) return null;
    const oppositeKey = `${parsed.side === 'over' ? 'Under' : 'Over'}_${parsed.line}`;
    const opposite = markets.totals?.[oppositeKey];
    const implied = decimalToImpliedProb(outcome.price);
    return {
      odds: outcome.price,
      fairProb: opposite?.price
        ? removeVig(implied, decimalToImpliedProb(opposite.price)).fairA
        : implied,
    };
  }
  return null;
}

function calcBetProfit(stake, oddsDecimal, result) {
  if (result === 'win') return stake * oddsDecimal - stake;
  if (result === 'loss') return -stake;
  return 0;
}

/** 依已完成場次比分自動結算待結投注 */
export function autoSettlePendingBets() {
  const pending = db
    .prepare(`
      SELECT b.*, g.home_team, g.away_team, g.home_score, g.away_score,
             g.completed, g.status, g.commence_time
      FROM bet_log b
      JOIN games g ON g.id = b.game_id
      WHERE b.result = 'pending'
        AND (
          g.completed = 1
          OR lower(COALESCE(g.status, '')) IN
             ('canceled', 'cancelled', 'postponed', 'abandoned', 'void')
          OR (
            (g.home_score IS NULL OR g.away_score IS NULL)
            AND datetime(g.commence_time) <= datetime('now', '-${config.settlementVoidAfterHours} hours')
          )
        )
    `)
    .all();

  let settled = 0;
  for (const bet of pending) {
    const result = evaluateBaseballMarketResult(bet, bet);

    if (!result) continue;
    const profit = calcBetProfit(bet.stake, bet.odds_decimal, result);
    settleBet(bet.id, result, profit);
    settled++;
  }
  return settled;
}

/** 自動結算不可變推薦快照，供校準/ROI/Brier 回測使用。 */
export function autoSettleRecommendationSnapshots() {
  const pending = db
    .prepare(`
      SELECT s.*, g.home_team, g.away_team, g.home_score, g.away_score,
             g.raw_odds, g.completed, g.status, g.commence_time
      FROM recommendation_snapshots s
      JOIN games g ON g.id = s.game_id
      WHERE s.result = 'pending'
        AND (
          g.completed = 1
          OR lower(COALESCE(g.status, '')) IN
             ('canceled', 'cancelled', 'postponed', 'abandoned', 'void')
          OR (
            (g.home_score IS NULL OR g.away_score IS NULL)
            AND datetime(g.commence_time) <= datetime('now', '-${config.settlementVoidAfterHours} hours')
          )
        )
        AND s.league IN (${BASEBALL_LEAGUE_SQL})
    `)
    .all();

  const update = db.prepare(`
    UPDATE recommendation_snapshots
    SET result = ?, profit_units = ?, home_score = ?, away_score = ?,
        closing_odds_decimal = ?, closing_implied_prob = ?, clv_prob = ?,
        settled_at = datetime('now')
    WHERE id = ?
  `);

  let settled = 0;
  const tx = db.transaction(() => {
    for (const rec of pending) {
      const result = evaluateBaseballMarketResult(rec, rec);
      if (!result) continue;
      const profitUnits =
        result === 'win' ? rec.odds_decimal - 1 : result === 'loss' ? -1 : 0;
      const closing = findClosingMarket(rec, rec);
      const closingOdds = closing?.odds ?? null;
      const closingImplied = closing?.fairProb ?? null;
      const clv =
        closingImplied != null
          ? closingImplied - (rec.market_prob ?? rec.implied_prob)
          : null;
      update.run(
        result,
        profitUnits,
        rec.home_score,
        rec.away_score,
        closingOdds,
        closingImplied,
        clv,
        rec.id
      );
      settled += 1;
    }
  });
  tx();
  return settled;
}

export function getLoggedRecIds() {
  const rows = db
    .prepare(`
      SELECT rec_type, rec_id FROM bet_log
      WHERE result = 'pending' AND rec_id IS NOT NULL
    `)
    .all();
  const singles = [];
  const parlays = [];
  for (const row of rows) {
    if (row.rec_type === 'parlay') parlays.push(row.rec_id);
    else singles.push(row.rec_id);
  }
  return { singles, parlays };
}

export function getAppStatus() {
  const lastSyncAt = getMeta('last_sync_at');
  const lastAnalysisAt = getMeta('last_analysis_at');
  const quotaRaw = getMeta('odds_quota_remaining');
  const recommendationCount = db
    .prepare(`SELECT COUNT(*) as c FROM recommendations WHERE league IN (${BASEBALL_LEAGUE_SQL})`)
    .get().c;
  const pendingBets = db.prepare(`SELECT COUNT(*) as c FROM bet_log WHERE result = 'pending'`).get().c;

  let needsRefresh = false;
  if (config.oddsApiKey) {
    if (!lastSyncAt) {
      needsRefresh = true;
    } else {
      const hoursSince = (Date.now() - new Date(lastSyncAt).getTime()) / 3600000;
      needsRefresh = hoursSince >= config.staleDataHours;
    }
  }

  return {
    lastSyncAt,
    lastAnalysisAt,
    oddsQuotaRemaining: quotaRaw != null ? parseInt(quotaRaw, 10) : null,
    recommendationCount,
    pendingBets,
    needsRefresh,
    staleDataHours: config.staleDataHours,
    hasApiKey: !!config.oddsApiKey,
    isRefreshing: isRefreshInProgress(),
    loggedRecIds: getLoggedRecIds(),
  };
}

/**
 * 同步 → 分析，帶防重入鎖
 * @param {{ includeLive?: boolean, forceHeavy?: boolean, leagueCodes?: string[] }} [options]
 * includeLive 預設 false（初盤頁不順帶跑滾球）；排程以 leagueCodes=['MLB'] 控制額度。
 */
export async function fullRefresh(options = {}) {
  if (refreshPromise) return refreshPromise;
  const includeLive = options.includeLive === true;
  const forceHeavy = options.forceHeavy === true;
  const leagueCodes = Array.isArray(options.leagueCodes) ? options.leagueCodes : null;

  refreshPromise = (async () => {
    const sync = await syncAllData({ forceHeavy, leagueCodes });
    setMeta('last_sync_at', new Date().toISOString());
    if (sync.oddsQuota?.remaining != null) {
      setMeta('odds_quota_remaining', parseInt(sync.oddsQuota.remaining, 10) || 0);
    }

    const settledBets = autoSettlePendingBets();
    const settledSnapshots = autoSettleRecommendationSnapshots();
    const settledMlbPaperBets = autoSettleMlbPaperBets();
    const analysis = await runAnalysis();
    const mlbTruth = await runMlbPrematchTruthPipeline();
    const createdMlbPaperBets = autoCreateEligiblePaperBets();
    setMeta('last_analysis_at', new Date().toISOString());

    let liveAnalysis = null;
    if (includeLive) {
      try {
        liveAnalysis = await runLiveAnalysis();
        setMeta('last_live_analysis_at', new Date().toISOString());
      } catch (err) {
        console.warn('[live] 滾球分析失敗:', err.message);
      }
    }

    const recommendationCount = db
      .prepare(
        `SELECT COUNT(*) as c FROM recommendations WHERE league IN (${BASEBALL_LEAGUE_SQL}) AND IFNULL(phase, 'prematch') = 'prematch'`
      )
      .get().c;
    const liveRecommendationCount = db
      .prepare(
        `SELECT COUNT(*) as c FROM recommendations WHERE league IN (${BASEBALL_LEAGUE_SQL}) AND phase = 'live'`
      )
      .get().c;
    return {
      sync,
      analysis,
      liveAnalysis,
      recommendationCount,
      liveRecommendationCount,
      settledBets,
      settledSnapshots,
      settledMlbPaperBets,
      mlbTruth,
      createdMlbPaperBets,
    };
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}
