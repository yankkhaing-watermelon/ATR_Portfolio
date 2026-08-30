CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE holdings (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sector TEXT NOT NULL DEFAULT 'Other',
  shares REAL NOT NULL DEFAULT 0 CHECK (shares >= 0),
  avg_cost REAL NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),
  current_price REAL NOT NULL DEFAULT 0 CHECK (current_price >= 0),
  hard_stop REAL,
  ma10 REAL,
  manual_support REAL,
  peak_price REAL,
  peak_date TEXT,
  risk_status TEXT NOT NULL DEFAULT 'Safe' CHECK (risk_status IN ('Safe','Watch','Partial','Sell','Error')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('BUY','SELL','DEPOSIT','WITHDRAWAL','DIVIDEND','ADJUSTMENT')),
  code TEXT,
  name TEXT,
  sector TEXT,
  trade_date TEXT NOT NULL,
  shares REAL,
  price REAL,
  fees REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  realized_pl REAL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_transactions_trade_date ON transactions(trade_date DESC, id DESC);
CREATE INDEX idx_transactions_code ON transactions(code, trade_date DESC);

CREATE TABLE watchlist_items (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_price REAL,
  support_price REAL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE signal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('Safe','Watch','Partial','Sell','Error')),
  message TEXT NOT NULL,
  observed_price REAL,
  trigger_price REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_signal_events_created_at ON signal_events(created_at DESC, id DESC);
CREATE INDEX idx_signal_events_code ON signal_events(code, created_at DESC);
