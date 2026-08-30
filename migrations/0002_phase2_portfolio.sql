CREATE TABLE IF NOT EXISTS cash_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER,
  entry_type TEXT NOT NULL,
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  entry_date TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);

CREATE INDEX IF NOT EXISTS idx_cash_ledger_entry_date
  ON cash_ledger(entry_date DESC, id DESC);

CREATE TABLE IF NOT EXISTS price_snapshots (
  code TEXT NOT NULL,
  price_date TEXT NOT NULL,
  close REAL NOT NULL,
  atr14 REAL,
  ma10 REAL,
  ma20 REAL,
  ma50 REAL,
  ma200 REAL,
  volume REAL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code, price_date)
);

CREATE INDEX IF NOT EXISTS idx_price_snapshots_date
  ON price_snapshots(price_date DESC, code);

CREATE TABLE IF NOT EXISTS risk_snapshots (
  code TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  price REAL NOT NULL,
  atr14 REAL,
  hard_stop REAL,
  trailing_stop REAL,
  manual_support REAL,
  risk_distance_pct REAL,
  portfolio_risk_amount REAL,
  status TEXT NOT NULL DEFAULT 'Safe' CHECK (status IN ('Safe','Watch','Partial','Sell','Error')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_risk_snapshots_date
  ON risk_snapshots(snapshot_date DESC, code);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  snapshot_date TEXT PRIMARY KEY,
  cash REAL NOT NULL DEFAULT 0,
  holdings_value REAL NOT NULL DEFAULT 0,
  total_equity REAL NOT NULL DEFAULT 0,
  unrealised_pl REAL NOT NULL DEFAULT 0,
  realised_pl REAL NOT NULL DEFAULT 0,
  open_downside REAL NOT NULL DEFAULT 0,
  portfolio_heat_pct REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS journal_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  entry_date TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_journal_notes_entry_date
  ON journal_notes(entry_date DESC, id DESC);
