const VERSION = "3.0.0";
const REQUIRED_TABLES = [
  "cash_ledger",
  "holdings",
  "journal_notes",
  "portfolio_snapshots",
  "price_snapshots",
  "risk_snapshots",
  "settings",
  "signal_events",
  "transactions",
  "watchlist_items"
];

const BASE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS holdings (
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
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_trade_date ON transactions(trade_date DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_code ON transactions(code, trade_date DESC)`,
  `CREATE TABLE IF NOT EXISTS watchlist_items (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    target_price REAL,
    support_price REAL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS signal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('Safe','Watch','Partial','Sell','Error')),
    message TEXT NOT NULL,
    observed_price REAL,
    trigger_price REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_signal_events_created_at ON signal_events(created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_signal_events_code ON signal_events(code, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS cash_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER,
    entry_type TEXT NOT NULL,
    amount REAL NOT NULL,
    balance_after REAL NOT NULL,
    entry_date TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cash_ledger_entry_date ON cash_ledger(entry_date DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS price_snapshots (
    code TEXT NOT NULL,
    price_date TEXT NOT NULL,
    open REAL,
    high REAL,
    low REAL,
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_price_snapshots_date ON price_snapshots(price_date DESC, code)`,
  `CREATE TABLE IF NOT EXISTS risk_snapshots (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_risk_snapshots_date ON risk_snapshots(snapshot_date DESC, code)`,
  `CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    snapshot_date TEXT PRIMARY KEY,
    cash REAL NOT NULL DEFAULT 0,
    holdings_value REAL NOT NULL DEFAULT 0,
    total_equity REAL NOT NULL DEFAULT 0,
    unrealised_pl REAL NOT NULL DEFAULT 0,
    realised_pl REAL NOT NULL DEFAULT 0,
    open_downside REAL NOT NULL DEFAULT 0,
    portfolio_heat_pct REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS journal_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT,
    entry_date TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_journal_notes_entry_date ON journal_notes(entry_date DESC, id DESC)`
];

let schemaBootstrapped = false;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const cleanText = (value, max = 200) => String(value ?? "").trim().slice(0, max);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const maybeFinite = value => value == null || value === "" ? null : finite(value);
const ymd = unix => new Date(Number(unix) * 1000).toISOString().slice(0, 10);

async function ensureColumn(db, table, column, sqlType) {
  const info = await db.prepare(`PRAGMA table_info(${table})`).all();
  const present = (info.results || []).some(row => row.name === column);
  if (!present) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`).run();
}

async function ensureSchema(db) {
  if (schemaBootstrapped) return;
  await db.batch(BASE_SCHEMA_SQL.map(sql => db.prepare(sql)));
  await ensureColumn(db, "price_snapshots", "open", "REAL");
  await ensureColumn(db, "price_snapshots", "high", "REAL");
  await ensureColumn(db, "price_snapshots", "low", "REAL");
  await db.prepare(`INSERT INTO settings (key, value, updated_at)
    VALUES ('cash_balance', '0', CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO NOTHING`).run();
  schemaBootstrapped = true;
}

async function schemaStatus(db) {
  const result = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  const tables = (result.results || []).map(row => row.name).filter(Boolean);
  return { tables, ready: REQUIRED_TABLES.every(name => tables.includes(name)) };
}

function summarizePortfolio(cash, holdings, transactions) {
  const holdingsValue = holdings.reduce((sum, row) => sum + finite(row.shares) * finite(row.current_price), 0);
  const costValue = holdings.reduce((sum, row) => sum + finite(row.shares) * finite(row.avg_cost), 0);
  const unrealisedPl = holdingsValue - costValue;
  const realisedPl = transactions.reduce((sum, row) => sum + finite(row.realized_pl), 0);
  const openDownside = holdings.reduce((sum, row) => {
    const stop = finite(row.hard_stop);
    const price = finite(row.current_price);
    if (stop <= 0 || price <= stop) return sum;
    return sum + (price - stop) * finite(row.shares);
  }, 0);
  const totalEquity = cash + holdingsValue;
  return {
    cash,
    holdings_value: holdingsValue,
    cost_value: costValue,
    total_equity: totalEquity,
    unrealised_pl: unrealisedPl,
    realised_pl: realisedPl,
    open_downside: openDownside,
    portfolio_heat_pct: totalEquity > 0 ? (openDownside / totalEquity) * 100 : 0,
    holdings_count: holdings.length
  };
}

async function readState(db) {
  const [settingsResult, holdingsResult, transactionsResult, watchlistResult, signalsResult, ledgerResult, notesResult] = await db.batch([
    db.prepare("SELECT key, value, updated_at FROM settings ORDER BY key"),
    db.prepare("SELECT code, name, sector, shares, avg_cost, current_price, hard_stop, ma10, manual_support, peak_price, peak_date, risk_status, updated_at FROM holdings WHERE shares > 0 ORDER BY CASE risk_status WHEN 'Sell' THEN 1 WHEN 'Partial' THEN 2 WHEN 'Watch' THEN 3 WHEN 'Safe' THEN 4 ELSE 5 END, code"),
    db.prepare("SELECT id, type, code, name, sector, trade_date, shares, price, fees, amount, realized_pl, notes, created_at, updated_at FROM transactions ORDER BY trade_date DESC, id DESC LIMIT 250"),
    db.prepare("SELECT code, name, target_price, support_price, notes, created_at, updated_at FROM watchlist_items ORDER BY code"),
    db.prepare("SELECT id, code, signal_type, severity, message, observed_price, trigger_price, created_at FROM signal_events ORDER BY created_at DESC, id DESC LIMIT 150"),
    db.prepare("SELECT id, transaction_id, entry_type, amount, balance_after, entry_date, notes, created_at FROM cash_ledger ORDER BY entry_date DESC, id DESC LIMIT 250"),
    db.prepare("SELECT id, code, entry_date, title, body, tags, created_at, updated_at FROM journal_notes ORDER BY entry_date DESC, id DESC LIMIT 100")
  ]);
  const settings = Object.fromEntries((settingsResult.results || []).map(row => [row.key, row.value]));
  const cash = finite(settings.cash_balance);
  const holdings = holdingsResult.results || [];
  const transactions = transactionsResult.results || [];
  return {
    settings,
    summary: summarizePortfolio(cash, holdings, transactions),
    holdings,
    transactions,
    cash_ledger: ledgerResult.results || [],
    watchlist: watchlistResult.results || [],
    signals: signalsResult.results || [],
    journal_notes: notesResult.results || []
  };
}

async function tokenMatches(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get("authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!supplied) return false;
  const encode = value => new TextEncoder().encode(value);
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode(supplied)),
    crypto.subtle.digest("SHA-256", encode(env.ADMIN_TOKEN))
  ]);
  const a = new Uint8Array(left), b = new Uint8Array(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, error: "admin_mutations_disabled" }, 503);
  if (!(await tokenMatches(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  return null;
}

function simpleMA(values, length, index) {
  if (index + 1 < length) return null;
  let sum = 0;
  for (let i = index - length + 1; i <= index; i += 1) sum += values[i];
  return sum / length;
}

function calculateIndicators(rows) {
  const closes = rows.map(row => row.close);
  let prevClose = null;
  let atr = null;
  let trWindow = [];
  return rows.map((row, index) => {
    const tr = prevClose == null
      ? row.high - row.low
      : Math.max(row.high - row.low, Math.abs(row.high - prevClose), Math.abs(row.low - prevClose));
    if (index < 14) {
      trWindow.push(tr);
      if (index === 13) atr = trWindow.reduce((a, b) => a + b, 0) / 14;
    } else {
      atr = ((atr * 13) + tr) / 14;
    }
    prevClose = row.close;
    return {
      ...row,
      atr14: index >= 13 ? atr : null,
      ma10: simpleMA(closes, 10, index),
      ma20: simpleMA(closes, 20, index),
      ma50: simpleMA(closes, 50, index),
      ma200: simpleMA(closes, 200, index)
    };
  });
}

function yahooCandidates(code) {
  const clean = cleanText(code, 20).toUpperCase();
  if (!clean) return [];
  if (clean.endsWith(".KL")) return [clean];
  return [`${clean}.KL`];
}

async function fetchYahooDailyBars(code) {
  let lastError = "no_candidate";
  for (const symbol of yahooCandidates(code)) {
    try {
      const endpoint = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=18mo&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
      const response = await fetch(endpoint, {
        headers: {
          "accept": "application/json,text/plain,*/*",
          "user-agent": "Mozilla/5.0 ATR-Portfolio/3.0"
        },
        cf: { cacheTtl: 300, cacheEverything: true }
      });
      if (!response.ok) {
        lastError = `HTTP_${response.status}`;
        continue;
      }
      const payload = await response.json();
      const result = payload?.chart?.result?.[0];
      const quote = result?.indicators?.quote?.[0];
      const timestamps = result?.timestamp || [];
      if (!quote || timestamps.length < 20) {
        lastError = "insufficient_history";
        continue;
      }
      const rows = timestamps.map((stamp, i) => ({
        date: ymd(stamp),
        open: finite(quote.open?.[i], NaN),
        high: finite(quote.high?.[i], NaN),
        low: finite(quote.low?.[i], NaN),
        close: finite(quote.close?.[i], NaN),
        volume: finite(quote.volume?.[i], 0)
      })).filter(row => Number.isFinite(row.open) && Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close) && row.close > 0);
      if (rows.length < 20) {
        lastError = "insufficient_usable_history";
        continue;
      }
      return { symbol, rows: calculateIndicators(rows) };
    } catch (error) {
      lastError = error?.message || "fetch_failed";
    }
  }
  throw new Error(`Yahoo market data unavailable for ${code}: ${lastError}`);
}

async function saveMarketRows(db, code, market) {
  const recent = market.rows.slice(-260);
  const statements = recent.map(row => db.prepare(`
    INSERT INTO price_snapshots (code, price_date, open, high, low, close, atr14, ma10, ma20, ma50, ma200, volume, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'yahoo_raw', CURRENT_TIMESTAMP)
    ON CONFLICT(code, price_date) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
      atr14=excluded.atr14, ma10=excluded.ma10, ma20=excluded.ma20, ma50=excluded.ma50,
      ma200=excluded.ma200, volume=excluded.volume, source=excluded.source
  `).bind(
    code,
    row.date,
    row.open,
    row.high,
    row.low,
    row.close,
    row.atr14,
    row.ma10,
    row.ma20,
    row.ma50,
    row.ma200,
    row.volume
  ));
  for (let i = 0; i < statements.length; i += 75) await db.batch(statements.slice(i, i + 75));
  const latest = recent[recent.length - 1];
  const existing = await db.prepare("SELECT peak_price, peak_date FROM holdings WHERE code = ?").bind(code).first();
  const previousPeak = finite(existing?.peak_price);
  const peakPrice = previousPeak > latest.close ? previousPeak : latest.close;
  const peakDate = previousPeak > latest.close ? existing?.peak_date : latest.date;
  await db.prepare(`UPDATE holdings SET
    current_price = ?, ma10 = ?, peak_price = ?, peak_date = ?, updated_at = CURRENT_TIMESTAMP
    WHERE code = ?`).bind(latest.close, latest.ma10, peakPrice, peakDate, code).run();
  return latest;
}

async function syncOneHolding(db, code) {
  const market = await fetchYahooDailyBars(code);
  const latest = await saveMarketRows(db, code, market);
  return {
    code,
    provider_symbol: market.symbol,
    latest_date: latest.date,
    close: latest.close,
    atr14: latest.atr14,
    ma10: latest.ma10,
    ma20: latest.ma20,
    ma50: latest.ma50,
    ma200: latest.ma200,
    bars_saved: Math.min(260, market.rows.length),
    source: "Yahoo raw OHLC"
  };
}

async function writePortfolioSnapshot(db) {
  const state = await readState(db);
  const s = state.summary;
  const date = new Date().toISOString().slice(0, 10);
  await db.prepare(`INSERT INTO portfolio_snapshots
    (snapshot_date, cash, holdings_value, total_equity, unrealised_pl, realised_pl, open_downside, portfolio_heat_pct, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(snapshot_date) DO UPDATE SET
      cash=excluded.cash, holdings_value=excluded.holdings_value, total_equity=excluded.total_equity,
      unrealised_pl=excluded.unrealised_pl, realised_pl=excluded.realised_pl,
      open_downside=excluded.open_downside, portfolio_heat_pct=excluded.portfolio_heat_pct
  `).bind(date, s.cash, s.holdings_value, s.total_equity, s.unrealised_pl, s.realised_pl, s.open_downside, s.portfolio_heat_pct).run();
  return s;
}

async function syncPortfolioMarketData(env) {
  await ensureSchema(env.DB);
  const holdingsResult = await env.DB.prepare("SELECT code FROM holdings WHERE shares > 0 ORDER BY code").all();
  const codes = (holdingsResult.results || []).map(row => row.code);
  const results = [];
  const errors = [];
  for (let i = 0; i < codes.length; i += 3) {
    const batch = codes.slice(i, i + 3);
    const settled = await Promise.allSettled(batch.map(code => syncOneHolding(env.DB, code)));
    settled.forEach((item, index) => {
      if (item.status === "fulfilled") results.push(item.value);
      else errors.push({ code: batch[index], error: item.reason?.message || "market_sync_failed" });
    });
  }
  const summary = await writePortfolioSnapshot(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('market_last_sync', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(new Date().toISOString()),
    env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('market_last_success_count', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(String(results.length)),
    env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('market_last_error_count', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(String(errors.length))
  ]);
  return { total: codes.length, succeeded: results.length, failed: errors.length, results, errors, summary };
}

async function upsertHolding(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const body = await request.json();
  const code = cleanText(body.code, 16).toUpperCase();
  const name = cleanText(body.name, 160);
  const shares = finite(body.shares, -1);
  const avgCost = finite(body.avg_cost, -1);
  if (!code || !name || shares < 0 || avgCost < 0) return json({ ok: false, error: "invalid_holding" }, 400);
  await env.DB.prepare(`
    INSERT INTO holdings (code, name, sector, shares, avg_cost, current_price, hard_stop, ma10, manual_support, peak_price, peak_date, risk_status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, sector=excluded.sector, shares=excluded.shares,
      avg_cost=excluded.avg_cost, current_price=excluded.current_price, hard_stop=excluded.hard_stop,
      ma10=excluded.ma10, manual_support=excluded.manual_support, peak_price=excluded.peak_price,
      peak_date=excluded.peak_date, risk_status=excluded.risk_status, updated_at=CURRENT_TIMESTAMP
  `).bind(
    code,
    name,
    cleanText(body.sector, 80) || "Other",
    shares,
    avgCost,
    finite(body.current_price),
    maybeFinite(body.hard_stop),
    maybeFinite(body.ma10),
    maybeFinite(body.manual_support),
    maybeFinite(body.peak_price),
    cleanText(body.peak_date, 10) || null,
    ["Safe","Watch","Partial","Sell","Error"].includes(body.risk_status) ? body.risk_status : "Safe"
  ).run();
  return json({ ok: true, holding: code }, 201);
}

async function recordTransaction(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const body = await request.json();
  const type = cleanText(body.type, 16).toUpperCase();
  const allowed = ["BUY","SELL","DEPOSIT","WITHDRAWAL","DIVIDEND","ADJUSTMENT"];
  if (!allowed.includes(type)) return json({ ok: false, error: "invalid_transaction_type" }, 400);
  const code = cleanText(body.code, 16).toUpperCase() || null;
  const shares = finite(body.shares);
  const price = finite(body.price);
  const fees = Math.max(0, finite(body.fees));
  const tradeDate = cleanText(body.trade_date, 10) || new Date().toISOString().slice(0, 10);
  const cashRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'cash_balance'").first();
  const currentCash = finite(cashRow?.value);
  let cashDelta = 0, realizedPl = null, holdingStatement = null;

  if (type === "BUY" || type === "SELL") {
    if (!code || shares <= 0 || price < 0) return json({ ok: false, error: "invalid_trade" }, 400);
    const existing = await env.DB.prepare("SELECT * FROM holdings WHERE code = ?").bind(code).first();
    if (type === "BUY") {
      const oldShares = finite(existing?.shares), oldCost = finite(existing?.avg_cost);
      const newShares = oldShares + shares;
      const newCost = newShares > 0 ? ((oldShares * oldCost) + (shares * price) + fees) / newShares : 0;
      cashDelta = -(shares * price + fees);
      holdingStatement = env.DB.prepare(`
        INSERT INTO holdings (code, name, sector, shares, avg_cost, current_price, risk_status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'Safe', CURRENT_TIMESTAMP)
        ON CONFLICT(code) DO UPDATE SET name=excluded.name, sector=excluded.sector, shares=excluded.shares,
          avg_cost=excluded.avg_cost, current_price=excluded.current_price, updated_at=CURRENT_TIMESTAMP
      `).bind(code, cleanText(body.name, 160) || existing?.name || code, cleanText(body.sector, 80) || existing?.sector || "Other", newShares, newCost, price);
    } else {
      if (!existing || finite(existing.shares) < shares) return json({ ok: false, error: "insufficient_shares" }, 409);
      const remaining = finite(existing.shares) - shares;
      realizedPl = shares * (price - finite(existing.avg_cost)) - fees;
      cashDelta = shares * price - fees;
      holdingStatement = remaining === 0
        ? env.DB.prepare("DELETE FROM holdings WHERE code = ?").bind(code)
        : env.DB.prepare("UPDATE holdings SET shares = ?, current_price = ?, updated_at = CURRENT_TIMESTAMP WHERE code = ?").bind(remaining, price, code);
    }
  } else {
    const amount = finite(body.amount);
    if (amount === 0) return json({ ok: false, error: "amount_required" }, 400);
    cashDelta = type === "WITHDRAWAL" ? -Math.abs(amount) : type === "ADJUSTMENT" ? amount : Math.abs(amount);
  }

  const nextCash = currentCash + cashDelta;
  const amount = type === "BUY" || type === "SELL" ? shares * price : finite(body.amount);
  const insert = await env.DB.prepare(`INSERT INTO transactions (type, code, name, sector, trade_date, shares, price, fees, amount, realized_pl, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(type, code, cleanText(body.name, 160) || null, cleanText(body.sector, 80) || null, tradeDate,
      shares || null, price || null, fees, amount, realizedPl, cleanText(body.notes, 1000)).first();
  const statements = [
    env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('cash_balance', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(String(nextCash)),
    env.DB.prepare(`INSERT INTO cash_ledger (transaction_id, entry_type, amount, balance_after, entry_date, notes)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(insert?.id || null, type, cashDelta, nextCash, tradeDate, cleanText(body.notes, 1000))
  ];
  if (holdingStatement) statements.push(holdingStatement);
  await env.DB.batch(statements);
  return json({ ok: true, type, code, cash_balance: nextCash, realized_pl: realizedPl }, 201);
}

async function setupPortfolio(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const body = await request.json();
  const cash = finite(body.cash_balance, NaN);
  const holdings = Array.isArray(body.holdings) ? body.holdings : [];
  if (!Number.isFinite(cash)) return json({ ok: false, error: "invalid_cash_balance" }, 400);
  const statements = [
    env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('cash_balance', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(String(cash)),
    env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('portfolio_initialized', '1', CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value='1', updated_at=CURRENT_TIMESTAMP`)
  ];
  for (const row of holdings) {
    const code = cleanText(row.code, 16).toUpperCase();
    const name = cleanText(row.name, 160);
    const shares = finite(row.shares, -1);
    const avgCost = finite(row.avg_cost, -1);
    if (!code || !name || shares <= 0 || avgCost < 0) return json({ ok: false, error: `invalid_holding:${code || "unknown"}` }, 400);
    statements.push(env.DB.prepare(`INSERT INTO holdings
      (code, name, sector, shares, avg_cost, current_price, hard_stop, risk_status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Safe', CURRENT_TIMESTAMP)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name, sector=excluded.sector, shares=excluded.shares,
        avg_cost=excluded.avg_cost, current_price=excluded.current_price, hard_stop=excluded.hard_stop, updated_at=CURRENT_TIMESTAMP`)
      .bind(code, name, cleanText(row.sector, 80) || "Other", shares, avgCost, Math.max(0, finite(row.current_price)), maybeFinite(row.hard_stop)));
  }
  await env.DB.batch(statements);
  return json({ ok: true, cash_balance: cash, holdings_imported: holdings.length }, 201);
}

async function upsertPriceSnapshot(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const body = await request.json();
  const code = cleanText(body.code, 16).toUpperCase();
  const date = cleanText(body.price_date, 10);
  const close = finite(body.close, NaN);
  if (!code || !date || !Number.isFinite(close) || close <= 0) return json({ ok: false, error: "invalid_price_snapshot" }, 400);
  await env.DB.prepare(`INSERT INTO price_snapshots
    (code, price_date, open, high, low, close, atr14, ma10, ma20, ma50, ma200, volume, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(code, price_date) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, atr14=excluded.atr14, ma10=excluded.ma10, ma20=excluded.ma20,
      ma50=excluded.ma50, ma200=excluded.ma200, volume=excluded.volume, source=excluded.source`)
    .bind(code, date, maybeFinite(body.open), maybeFinite(body.high), maybeFinite(body.low), close,
      maybeFinite(body.atr14), maybeFinite(body.ma10), maybeFinite(body.ma20), maybeFinite(body.ma50),
      maybeFinite(body.ma200), maybeFinite(body.volume), cleanText(body.source, 40) || "manual").run();
  await env.DB.prepare("UPDATE holdings SET current_price = ?, ma10 = ?, updated_at = CURRENT_TIMESTAMP WHERE code = ?")
    .bind(close, maybeFinite(body.ma10), code).run();
  return json({ ok: true, code, price_date: date }, 201);
}

async function readMarket(db, code = "") {
  if (code) {
    const rows = await db.prepare(`SELECT code, price_date, open, high, low, close, atr14, ma10, ma20, ma50, ma200, volume, source
      FROM price_snapshots WHERE code = ? ORDER BY price_date DESC LIMIT 260`).bind(code).all();
    return rows.results || [];
  }
  const rows = await db.prepare(`SELECT p.code, p.price_date, p.open, p.high, p.low, p.close, p.atr14, p.ma10, p.ma20, p.ma50, p.ma200, p.volume, p.source
    FROM price_snapshots p
    JOIN (SELECT code, MAX(price_date) max_date FROM price_snapshots GROUP BY code) latest
      ON latest.code = p.code AND latest.max_date = p.price_date
    ORDER BY p.code LIMIT 500`).all();
  return rows.results || [];
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!env.DB) return json({ ok: false, service: "atr-portfolio", version: VERSION, db_bound: false, error: "D1 binding DB is not configured" }, 503);

  try {
    await ensureSchema(env.DB);
    const schema = await schemaStatus(env.DB);

    if (url.pathname === "/api/health" && request.method === "GET") {
      const sync = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'market_last_%' ORDER BY key").all();
      return json({
        ok: true,
        service: "atr-portfolio",
        version: VERSION,
        phase: 3,
        db_bound: true,
        schema_ready: schema.ready,
        mutation_enabled: Boolean(env.ADMIN_TOKEN),
        market_sync: Object.fromEntries((sync.results || []).map(row => [row.key, row.value])),
        tables: schema.tables
      });
    }

    if (!schema.ready) return json({ ok: false, error: "D1 schema is not initialized", schema_ready: false, tables: schema.tables }, 503);

    if (url.pathname === "/api/state" && request.method === "GET") {
      return json({ ok: true, phase: 3, db_bound: true, schema_ready: true, mutation_enabled: Boolean(env.ADMIN_TOKEN), data: await readState(env.DB) });
    }
    if (url.pathname === "/api/portfolio" && request.method === "GET") {
      const state = await readState(env.DB);
      return json({ ok: true, data: { summary: state.summary, holdings: state.holdings } });
    }
    if (url.pathname === "/api/holdings" && request.method === "GET") {
      const state = await readState(env.DB);
      return json({ ok: true, data: state.holdings });
    }
    if (url.pathname === "/api/transactions" && request.method === "GET") {
      const state = await readState(env.DB);
      return json({ ok: true, data: state.transactions });
    }
    if (url.pathname === "/api/signals" && request.method === "GET") {
      const state = await readState(env.DB);
      return json({ ok: true, data: state.signals });
    }
    if (url.pathname === "/api/market" && request.method === "GET") {
      const code = cleanText(url.searchParams.get("code"), 16).toUpperCase();
      return json({ ok: true, data: await readMarket(env.DB, code) });
    }
    if (url.pathname === "/api/market/sync" && request.method === "POST") {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return json({ ok: true, phase: 3, data: await syncPortfolioMarketData(env) });
    }
    if (url.pathname === "/api/market/sync-one" && request.method === "POST") {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const body = await request.json();
      const code = cleanText(body.code, 16).toUpperCase();
      if (!code) return json({ ok: false, error: "code_required" }, 400);
      const result = await syncOneHolding(env.DB, code);
      await writePortfolioSnapshot(env.DB);
      return json({ ok: true, phase: 3, data: result });
    }
    if (url.pathname === "/api/holdings" && request.method === "POST") return upsertHolding(request, env);
    if (url.pathname === "/api/transactions" && request.method === "POST") return recordTransaction(request, env);
    if (url.pathname === "/api/admin/setup" && request.method === "POST") return setupPortfolio(request, env);
    if (url.pathname === "/api/admin/prices" && request.method === "POST") return upsertPriceSnapshot(request, env);
    return json({ ok: false, error: "not_found" }, 404);
  } catch (error) {
    return json({ ok: false, service: "atr-portfolio", version: VERSION, error: error.message || "unexpected_error" }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(syncPortfolioMarketData(env));
  }
};
