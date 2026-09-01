import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

let schemaReady: Promise<void> | null = null;

export function getDb() {
  if (!env.DB) {
    throw new Error(
      'Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database.',
    );
  }

  return drizzle(env.DB, { schema });
}

/**
 * Make a fresh local D1 database immediately usable. Hosted environments still
 * use the checked-in Drizzle migrations, while this idempotent guard prevents a
 * changed Miniflare database id from leaving localhost with an empty schema.
 */
export async function ensureDbSchema() {
  if (!env.DB) {
    throw new Error('Cloudflare D1 binding `DB` is unavailable.');
  }
  if (schemaReady) return schemaReady;

  const statements = [
    `CREATE TABLE IF NOT EXISTS instruments (
      id TEXT PRIMARY KEY NOT NULL, symbol TEXT NOT NULL, display_name TEXT NOT NULL,
      instrument_type TEXT NOT NULL, strike_step REAL NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS instruments_symbol_unique ON instruments(symbol)`,
    `CREATE TABLE IF NOT EXISTS market_sessions (
      id TEXT PRIMARY KEY NOT NULL, instrument_id TEXT NOT NULL, session_date TEXT NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
      atr14 REAL, source TEXT NOT NULL,
      FOREIGN KEY (instrument_id) REFERENCES instruments(id)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS market_sessions_instrument_date_unique ON market_sessions(instrument_id, session_date)`,
    `CREATE INDEX IF NOT EXISTS market_sessions_date_idx ON market_sessions(session_date)`,
    `CREATE TABLE IF NOT EXISTS oi_snapshots (
      id TEXT PRIMARY KEY NOT NULL, instrument_id TEXT NOT NULL, captured_at TEXT NOT NULL,
      expiry TEXT NOT NULL, expiry_epoch INTEGER, spot REAL NOT NULL,
      spot_change_percent REAL NOT NULL, atr14 REAL NOT NULL, iv_percentile REAL NOT NULL,
      source TEXT NOT NULL,
      FOREIGN KEY (instrument_id) REFERENCES instruments(id)
    )`,
    `CREATE INDEX IF NOT EXISTS oi_snapshots_instrument_captured_idx ON oi_snapshots(instrument_id, captured_at)`,
    `CREATE INDEX IF NOT EXISTS oi_snapshots_expiry_idx ON oi_snapshots(expiry_epoch)`,
    `CREATE TABLE IF NOT EXISTS oi_strikes (
      id TEXT PRIMARY KEY NOT NULL, snapshot_id TEXT NOT NULL, strike REAL NOT NULL,
      call_oi INTEGER NOT NULL, call_oi_change INTEGER NOT NULL, call_volume INTEGER NOT NULL,
      call_iv REAL, put_oi INTEGER NOT NULL, put_oi_change INTEGER NOT NULL,
      put_volume INTEGER NOT NULL, put_iv REAL,
      FOREIGN KEY (snapshot_id) REFERENCES oi_snapshots(id)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS oi_strikes_snapshot_strike_unique ON oi_strikes(snapshot_id, strike)`,
    `CREATE INDEX IF NOT EXISTS oi_strikes_strike_idx ON oi_strikes(strike)`,
    `CREATE TABLE IF NOT EXISTS level_outcomes (
      id TEXT PRIMARY KEY NOT NULL, instrument_id TEXT NOT NULL, snapshot_id TEXT,
      session_date TEXT NOT NULL, side TEXT NOT NULL, strike REAL NOT NULL,
      tested INTEGER NOT NULL, held INTEGER NOT NULL, features_json TEXT NOT NULL,
      horizon_sessions INTEGER DEFAULT 3 NOT NULL,
      FOREIGN KEY (instrument_id) REFERENCES instruments(id),
      FOREIGN KEY (snapshot_id) REFERENCES oi_snapshots(id)
    )`,
    `CREATE INDEX IF NOT EXISTS level_outcomes_instrument_date_idx ON level_outcomes(instrument_id, session_date)`,
    `CREATE INDEX IF NOT EXISTS level_outcomes_side_tested_idx ON level_outcomes(side, tested)`,
    `CREATE TABLE IF NOT EXISTS wall_predictions (
      id TEXT PRIMARY KEY NOT NULL, instrument_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
      declared_date TEXT NOT NULL, side TEXT NOT NULL, strike REAL NOT NULL,
      spot_at_declaration REAL NOT NULL, oi_at_declaration INTEGER NOT NULL,
      oi_change_at_declaration INTEGER NOT NULL, cluster_score REAL NOT NULL,
      atr14_at_declaration REAL NOT NULL, evaluated_at TEXT,
      horizon_sessions INTEGER DEFAULT 10 NOT NULL, reached INTEGER, days_to_reach INTEGER,
      held INTEGER, bounce_points REAL, bounce_atr REAL, broke INTEGER,
      FOREIGN KEY (instrument_id) REFERENCES instruments(id),
      FOREIGN KEY (snapshot_id) REFERENCES oi_snapshots(id)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS wall_predictions_snapshot_side_unique ON wall_predictions(snapshot_id, side)`,
    `CREATE INDEX IF NOT EXISTS wall_predictions_instrument_date_idx ON wall_predictions(instrument_id, declared_date)`,
    `CREATE INDEX IF NOT EXISTS wall_predictions_instrument_side_idx ON wall_predictions(instrument_id, side)`,
    `CREATE INDEX IF NOT EXISTS wall_predictions_evaluated_idx ON wall_predictions(evaluated_at)`,
    `CREATE TABLE IF NOT EXISTS model_calibrations (
      id TEXT PRIMARY KEY NOT NULL, instrument_id TEXT NOT NULL, trained_at TEXT NOT NULL,
      lookback_start TEXT NOT NULL, lookback_end TEXT NOT NULL, samples INTEGER NOT NULL,
      validation_samples INTEGER NOT NULL, balanced_accuracy REAL, brier_score REAL,
      coefficients_json TEXT NOT NULL,
      FOREIGN KEY (instrument_id) REFERENCES instruments(id)
    )`,
    `CREATE INDEX IF NOT EXISTS model_calibrations_instrument_trained_idx ON model_calibrations(instrument_id, trained_at)`,
  ];

  schemaReady = env.DB.batch(statements.map((statement) => env.DB.prepare(statement)))
    .then(async () => {
      const now = new Date().toISOString();
      await env.DB.batch([
        ['NSE:NIFTY50-INDEX', 'NIFTY 50', 50],
        ['NSE:NIFTYBANK-INDEX', 'NIFTY BANK', 100],
        ['NSE:FINNIFTY-INDEX', 'NIFTY FIN', 50],
        ['NSE:MIDCPNIFTY-INDEX', 'NIFTY MID SELECT', 25],
      ].map(([id, displayName, strikeStep]) => env.DB.prepare(`
        INSERT INTO instruments (id, symbol, display_name, instrument_type, strike_step, updated_at)
        VALUES (?, ?, ?, 'index', ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).bind(id, id, displayName, strikeStep, now)));
      await env.DB.prepare('PRAGMA optimize').run();
    })
    .catch((error) => {
      schemaReady = null;
      throw error;
    });

  return schemaReady;
}
