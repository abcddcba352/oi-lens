export const evidenceDDL = [
  'CREATE TABLE IF NOT EXISTS cash_participation (symbol TEXT NOT NULL, date TEXT NOT NULL, volume REAL NOT NULL, delivery REAL, source TEXT NOT NULL, PRIMARY KEY(symbol,date))',
  'CREATE INDEX IF NOT EXISTS cash_participation_date_idx ON cash_participation(date)',
  'CREATE TABLE IF NOT EXISTS futures_daily (symbol TEXT NOT NULL, date TEXT NOT NULL, expiry TEXT NOT NULL, close REAL NOT NULL, previous_close REAL NOT NULL, oi REAL NOT NULL, oi_change REAL NOT NULL, volume REAL NOT NULL, lot_size REAL NOT NULL, source TEXT NOT NULL, PRIMARY KEY(symbol,date,expiry))',
  'CREATE INDEX IF NOT EXISTS futures_daily_date_idx ON futures_daily(date)',
  'CREATE TABLE IF NOT EXISTS sector_prices (benchmark TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL, PRIMARY KEY(benchmark,date))',
  'CREATE INDEX IF NOT EXISTS sector_prices_date_idx ON sector_prices(date)',
  'CREATE TABLE IF NOT EXISTS sector_membership (symbol TEXT NOT NULL, benchmark TEXT NOT NULL, observed_date TEXT NOT NULL, PRIMARY KEY(symbol,benchmark,observed_date))',
  'CREATE INDEX IF NOT EXISTS sector_membership_observed_idx ON sector_membership(observed_date)',
  'CREATE TABLE IF NOT EXISTS sector_imports (benchmark TEXT NOT NULL, observed_date TEXT NOT NULL, PRIMARY KEY(benchmark,observed_date))',
  'CREATE INDEX IF NOT EXISTS sector_imports_observed_idx ON sector_imports(observed_date)',
];
