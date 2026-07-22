import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../data');
const dbPath = path.join(dataDir, 'analytics.db');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    league TEXT NOT NULL,
    commence_time TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    home_score INTEGER,
    away_score INTEGER,
    official_date TEXT,
    raw_odds TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS team_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    league TEXT NOT NULL,
    team_name TEXT NOT NULL,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    runs_scored REAL DEFAULT 0,
    runs_allowed REAL DEFAULT 0,
    last_10_wins INTEGER DEFAULT 0,
    last_10_losses INTEGER DEFAULT 0,
    streak TEXT DEFAULT '',
    rating REAL DEFAULT 0.5,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(league, team_name)
  );

  CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    league TEXT NOT NULL,
    market TEXT NOT NULL,
    pick TEXT NOT NULL,
    line REAL,
    odds_decimal REAL NOT NULL,
    bookmaker TEXT,
    model_prob REAL NOT NULL,
    implied_prob REAL NOT NULL,
    ev REAL NOT NULL,
    confidence REAL NOT NULL,
    reasoning TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (game_id) REFERENCES games(id)
  );

  CREATE TABLE IF NOT EXISTS parlay_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    legs TEXT NOT NULL,
    combined_odds REAL NOT NULL,
    combined_prob REAL NOT NULL,
    combined_ev REAL NOT NULL,
    suggested_stake REAL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bet_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rec_type TEXT NOT NULL,
    rec_id INTEGER,
    game_id TEXT,
    league TEXT,
    market TEXT,
    pick TEXT,
    stake REAL NOT NULL,
    odds_decimal REAL NOT NULL,
    potential_return REAL,
    result TEXT DEFAULT 'pending',
    profit REAL,
    settled_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_games_league ON games(league);
  CREATE INDEX IF NOT EXISTS idx_games_commence ON games(commence_time);
  CREATE INDEX IF NOT EXISTS idx_recommendations_ev ON recommendations(ev DESC);
  CREATE INDEX IF NOT EXISTS idx_team_stats_league ON team_stats(league, team_name);

  CREATE TABLE IF NOT EXISTS mlb_boxscore_cache (
    game_pk INTEGER PRIMARY KEY,
    payload_json TEXT NOT NULL,
    fetched_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_bet_log_rec ON bet_log(rec_type, rec_id, result);
`);

function migrateSchema() {
  const addCol = (sql) => {
    try {
      db.exec(sql);
    } catch {
      /* column exists */
    }
  };
  addCol('ALTER TABLE recommendations ADD COLUMN tier TEXT DEFAULT \'watch\'');
  addCol('ALTER TABLE recommendations ADD COLUMN score REAL DEFAULT 0');
  addCol('ALTER TABLE recommendations ADD COLUMN edge_prob REAL DEFAULT 0');
  addCol('ALTER TABLE recommendations ADD COLUMN data_quality REAL DEFAULT 0');
  addCol('ALTER TABLE recommendations ADD COLUMN market_group TEXT DEFAULT \'main\'');
  addCol('ALTER TABLE games ADD COLUMN raw_props TEXT');
  addCol('ALTER TABLE games ADD COLUMN official_date TEXT');
  addCol("ALTER TABLE games ADD COLUMN status TEXT DEFAULT 'scheduled'");
  addCol('ALTER TABLE recommendations ADD COLUMN bet_strategy TEXT');
  addCol('ALTER TABLE recommendations ADD COLUMN pick_rank INTEGER');
  addCol('ALTER TABLE recommendations ADD COLUMN actionable_score REAL');
  addCol('ALTER TABLE recommendations ADD COLUMN suggested_stake REAL');
  addCol('ALTER TABLE recommendations ADD COLUMN stake_multiplier REAL');
  addCol("ALTER TABLE recommendations ADD COLUMN phase TEXT DEFAULT 'prematch'");
  addCol('ALTER TABLE recommendations ADD COLUMN raw_model_prob REAL');
  addCol('ALTER TABLE recommendations ADD COLUMN market_prob REAL');
  addCol('ALTER TABLE recommendations ADD COLUMN calibrated_prob REAL');
  addCol('ALTER TABLE recommendations ADD COLUMN push_prob REAL DEFAULT 0');
  addCol("ALTER TABLE recommendations ADD COLUMN model_version TEXT DEFAULT 'legacy'");
  addCol('ALTER TABLE recommendations ADD COLUMN analysis_run_id TEXT');
  addCol('ALTER TABLE bet_log ADD COLUMN line REAL');
  addCol('ALTER TABLE bet_log ADD COLUMN bet_strategy TEXT');
  addCol("ALTER TABLE bet_log ADD COLUMN phase TEXT DEFAULT 'prematch'");
  addCol('ALTER TABLE bet_log ADD COLUMN raw_model_prob REAL');
  addCol('ALTER TABLE bet_log ADD COLUMN market_prob REAL');
  addCol('ALTER TABLE bet_log ADD COLUMN calibrated_prob REAL');
  addCol('ALTER TABLE bet_log ADD COLUMN implied_prob REAL');
  addCol('ALTER TABLE bet_log ADD COLUMN ev REAL');
  addCol("ALTER TABLE bet_log ADD COLUMN model_version TEXT DEFAULT 'legacy'");
  addCol('ALTER TABLE recommendation_snapshots ADD COLUMN closing_odds_decimal REAL');
  addCol('ALTER TABLE recommendation_snapshots ADD COLUMN closing_implied_prob REAL');
  addCol('ALTER TABLE recommendation_snapshots ADD COLUMN clv_prob REAL');
  addCol('ALTER TABLE team_stats ADD COLUMN goals_for REAL DEFAULT 0');
  addCol('ALTER TABLE team_stats ADD COLUMN goals_against REAL DEFAULT 0');
  addCol('ALTER TABLE team_stats ADD COLUMN draws INTEGER DEFAULT 0');
  addCol('ALTER TABLE team_stats ADD COLUMN elo REAL DEFAULT 1500');
  addCol('ALTER TABLE team_stats ADD COLUMN avg_30 REAL');
  addCol('ALTER TABLE team_stats ADD COLUMN obp_30 REAL');
  addCol('ALTER TABLE team_stats ADD COLUMN slg_30 REAL');
  addCol('ALTER TABLE team_stats ADD COLUMN ops_30 REAL');
  addCol('ALTER TABLE team_stats ADD COLUMN era_30 REAL');
  addCol('ALTER TABLE team_stats ADD COLUMN whip_30 REAL');
  addCol('ALTER TABLE team_stats ADD COLUMN rpg_30 REAL');
  addCol('ALTER TABLE team_stats ADD COLUMN rapg_30 REAL');
  addCol('ALTER TABLE team_stats ADD COLUMN games_30 INTEGER DEFAULT 0');
  addCol('ALTER TABLE team_stats ADD COLUMN rolling_window_days INTEGER DEFAULT 30');
  addCol('ALTER TABLE team_stats ADD COLUMN rolling_updated_at TEXT');
  addCol('ALTER TABLE external_prematch_payloads ADD COLUMN game_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_recommendations_bet_strategy ON recommendations(bet_strategy)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_recommendations_score ON recommendations(score DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_recommendations_tier ON recommendations(tier)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_recommendations_phase ON recommendations(phase)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_recommendations_run ON recommendations(analysis_run_id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS analysis_runs (
      id TEXT PRIMARY KEY,
      model_version TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'prematch',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      recommendation_count INTEGER DEFAULT 0,
      metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS recommendation_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_run_id TEXT NOT NULL,
      recommendation_id INTEGER,
      game_id TEXT NOT NULL,
      league TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'prematch',
      market TEXT NOT NULL,
      pick TEXT NOT NULL,
      line REAL,
      odds_decimal REAL NOT NULL,
      bookmaker TEXT,
      raw_model_prob REAL NOT NULL,
      market_prob REAL,
      calibrated_prob REAL NOT NULL,
      implied_prob REAL NOT NULL,
      push_prob REAL DEFAULT 0,
      ev REAL NOT NULL,
      confidence REAL,
      tier TEXT,
      score REAL,
      edge_prob REAL,
      data_quality REAL,
      bet_strategy TEXT,
      pick_rank INTEGER,
      suggested_stake REAL,
      reasoning TEXT,
      model_version TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT 'pending',
      profit_units REAL,
      closing_odds_decimal REAL,
      closing_implied_prob REAL,
      clv_prob REAL,
      home_score INTEGER,
      away_score INTEGER,
      settled_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id),
      FOREIGN KEY (game_id) REFERENCES games(id),
      UNIQUE(analysis_run_id, game_id, phase, market, pick, line)
    );

    CREATE INDEX IF NOT EXISTS idx_rec_snapshots_game
      ON recommendation_snapshots(game_id, result);
    CREATE INDEX IF NOT EXISTS idx_rec_snapshots_model
      ON recommendation_snapshots(model_version, league, market);
    CREATE INDEX IF NOT EXISTS idx_analysis_runs_started
      ON analysis_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS odds_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      league TEXT NOT NULL,
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      bookmakers_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'odds_api',
      UNIQUE(game_id, captured_at)
    );

    CREATE INDEX IF NOT EXISTS idx_odds_snapshots_game_time
      ON odds_snapshots(game_id, captured_at);

    CREATE TABLE IF NOT EXISTS model_run_configs (
      analysis_run_id TEXT PRIMARY KEY,
      model_version TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      weights_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id)
    );

    CREATE TABLE IF NOT EXISTS feature_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_run_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      league TEXT NOT NULL,
      features_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(analysis_run_id, game_id),
      FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );

    CREATE INDEX IF NOT EXISTS idx_feature_snapshots_game
      ON feature_snapshots(game_id, created_at);

    CREATE TABLE IF NOT EXISTS analysis_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_run_id TEXT NOT NULL,
      feature_snapshot_id INTEGER,
      game_id TEXT NOT NULL,
      league TEXT NOT NULL,
      market TEXT NOT NULL,
      pick TEXT NOT NULL,
      line REAL,
      odds_decimal REAL NOT NULL,
      raw_model_prob REAL,
      market_prob REAL,
      model_prob REAL NOT NULL,
      implied_prob REAL NOT NULL,
      ev REAL NOT NULL,
      edge_prob REAL,
      data_quality REAL,
      actionable_score REAL,
      eligible INTEGER NOT NULL DEFAULT 1,
      selected INTEGER NOT NULL DEFAULT 0,
      bet_strategy TEXT,
      reject_reason TEXT,
      model_version TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(analysis_run_id, game_id, market, pick, line),
      FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id),
      FOREIGN KEY (feature_snapshot_id) REFERENCES feature_snapshots(id),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );

    CREATE INDEX IF NOT EXISTS idx_analysis_decisions_model
      ON analysis_decisions(model_version, league, market, selected);

    /*
     * MLB 賽前真實資料管線（v3）
     *
     * 與舊 recommendations / flat_bet 管線完全分離：
     * - truth snapshots 是每次賽前資料蒐集的不可變證據；
     * - candidates 是研究／紙上追蹤用的決策，不代表實投；
     * - paper bets 是唯一可結算的模擬帳本。
     */
    CREATE TABLE IF NOT EXISTS mlb_prematch_truth_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      commence_time TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      completeness REAL NOT NULL,
      mandatory_complete INTEGER NOT NULL DEFAULT 0,
      gate_status TEXT NOT NULL,
      gate_reasons_json TEXT NOT NULL DEFAULT '[]',
      source_versions_json TEXT NOT NULL DEFAULT '{}',
      model_input_json TEXT,
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, game_id),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );

    CREATE INDEX IF NOT EXISTS idx_mlb_truth_game_time
      ON mlb_prematch_truth_snapshots(game_id, captured_at DESC);

    /*
     * 官方 probable starter 的不可變賽前身份快照。
     * captured_at 必須早於 commence_time；歷史實際先發不得寫入此表。
     */
    CREATE TABLE IF NOT EXISTS mlb_probable_starter_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      official_game_pk INTEGER,
      commence_time TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('complete', 'partial')),
      home_pitcher_id INTEGER,
      home_pitcher_name TEXT,
      away_pitcher_id INTEGER,
      away_pitcher_name TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(game_id, captured_at, source),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );

    CREATE INDEX IF NOT EXISTS idx_mlb_probable_starter_game_time
      ON mlb_probable_starter_snapshots(game_id, captured_at DESC);

    CREATE TABLE IF NOT EXISTS mlb_paper_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      truth_snapshot_id INTEGER NOT NULL UNIQUE,
      game_id TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'h2h',
      pick TEXT,
      odds_decimal REAL,
      market_prob REAL,
      model_prob REAL,
      model_version TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      status TEXT NOT NULL,
      rejection_reasons_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (truth_snapshot_id) REFERENCES mlb_prematch_truth_snapshots(id),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );

    CREATE INDEX IF NOT EXISTS idx_mlb_paper_candidates_status
      ON mlb_paper_candidates(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS mlb_paper_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL UNIQUE,
      game_id TEXT NOT NULL,
      market TEXT NOT NULL,
      pick TEXT NOT NULL,
      line REAL,
      stake_units REAL NOT NULL DEFAULT 1,
      odds_decimal REAL NOT NULL,
      market_prob REAL,
      model_prob REAL,
      model_version TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT 'pending',
      profit_units REAL,
      closing_odds_decimal REAL,
      closing_market_prob REAL,
      clv_prob REAL,
      settled_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (candidate_id) REFERENCES mlb_paper_candidates(id),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );

    CREATE INDEX IF NOT EXISTS idx_mlb_paper_bets_result
      ON mlb_paper_bets(result, created_at DESC);

    /*
     * 可重跑的 MLB 歷史賽前特徵資料集。
     * 一列只使用該場開賽前已完賽的庫內官方賽果；不混入事後市場、打線或天氣。
     */
    CREATE TABLE IF NOT EXISTS mlb_historical_feature_rows (
      game_id TEXT PRIMARY KEY,
      commence_time TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      features_json TEXT NOT NULL,
      home_win INTEGER NOT NULL CHECK (home_win IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );

    CREATE INDEX IF NOT EXISTS idx_mlb_historical_feature_time
      ON mlb_historical_feature_rows(commence_time);

    CREATE TABLE IF NOT EXISTS mlb_baseline_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_version TEXT NOT NULL,
      training_from TEXT NOT NULL,
      training_to TEXT NOT NULL,
      train_samples INTEGER NOT NULL,
      test_samples INTEGER NOT NULL,
      metrics_json TEXT NOT NULL,
      model_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_mlb_baseline_models_recent
      ON mlb_baseline_models(created_at DESC);

    /*
     * MLB 模型驗證帳：每次評估與每個時間 fold 均不可變保存。
     * 正式模型不得以 final test 挑特徵或校準參數。
     */
    CREATE TABLE IF NOT EXISTS mlb_model_eval_runs (
      run_id TEXT PRIMARY KEY,
      feature_version TEXT NOT NULL,
      eval_version TEXT NOT NULL,
      evaluation_from TEXT NOT NULL,
      evaluation_to TEXT NOT NULL,
      config_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mlb_model_eval_folds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      fold_key TEXT NOT NULL,
      feature_set TEXT NOT NULL,
      train_from TEXT,
      train_to TEXT,
      calibration_from TEXT,
      calibration_to TEXT,
      test_from TEXT,
      test_to TEXT,
      metrics_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, fold_key, feature_set),
      FOREIGN KEY (run_id) REFERENCES mlb_model_eval_runs(run_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mlb_model_eval_recent
      ON mlb_model_eval_runs(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_mlb_model_eval_folds_run
      ON mlb_model_eval_folds(run_id, fold_key);

    /*
     * MLB 預期得分模型：保存可重播的模型與跨季驗證。
     * 核心輸出為主客隊得分均值及負二項分布，不保存投注建議。
     */
    CREATE TABLE IF NOT EXISTS mlb_expected_runs_models (
      run_id TEXT PRIMARY KEY,
      model_version TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      training_from TEXT NOT NULL,
      training_to TEXT NOT NULL,
      train_samples INTEGER NOT NULL,
      model_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_mlb_expected_runs_recent
      ON mlb_expected_runs_models(created_at DESC);

    /*
     * 外部資料源健康與事故帳。
     * 已發布的 truth snapshot 保持不可變；錯誤版本透過 incident 作廢。
     */
    CREATE TABLE IF NOT EXISTS mlb_data_source_health_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('passed', 'warning', 'failed')),
      checks_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mlb_data_source_incidents (
      incident_key TEXT PRIMARY KEY,
      source_name TEXT NOT NULL,
      affected_version TEXT,
      severity TEXT NOT NULL CHECK (severity IN ('warning', 'blocking')),
      status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
      description TEXT NOT NULL,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_mlb_source_incidents_status
      ON mlb_data_source_incidents(status, severity);

    /*
     * Python collector → Node.js 的單向交接區。
     * 只接受已由 collector 判定為 prematch 的封存快照；不直接等同模型特徵。
     */
    CREATE TABLE IF NOT EXISTS external_prematch_payloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      game_id TEXT,
      collector_payload_id INTEGER,
      endpoint_kind TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      commence_at TEXT NOT NULL,
      source_url TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source, collector_payload_id, payload_sha256)
    );

    CREATE INDEX IF NOT EXISTS idx_external_prematch_event_time
      ON external_prematch_payloads(source, source_event_id, captured_at DESC);

    CREATE INDEX IF NOT EXISTS idx_external_prematch_game_time
      ON external_prematch_payloads(game_id, captured_at DESC);

    /*
     * 後端排程審計帳。以 run_key 去重，避免重啟、重疊 cron 或手動觸發
     * 在同一賽前窗口重複消耗外部賠率額度。
     */
    CREATE TABLE IF NOT EXISTS mlb_prematch_scheduler_runs (
      run_key TEXT PRIMARY KEY,
      trigger_type TEXT NOT NULL,
      game_id TEXT,
      scheduled_for TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      error_message TEXT,
      result_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_mlb_prematch_scheduler_recent
      ON mlb_prematch_scheduler_runs(started_at DESC);
  `);
  addCol('ALTER TABLE mlb_prematch_truth_snapshots ADD COLUMN model_input_json TEXT');
  // 統一歷史結果字典，避免 won/lost 與 win/loss 混用。
  db.exec("UPDATE bet_log SET result = 'win' WHERE result = 'won'");
  db.exec("UPDATE bet_log SET result = 'loss' WHERE result = 'lost'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS football_match_intel (
      game_id TEXT PRIMARY KEY,
      league TEXT NOT NULL,
      fixture_id INTEGER,
      intel_json TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

migrateSchema();

export default db;
