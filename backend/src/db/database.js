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
  `);
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
