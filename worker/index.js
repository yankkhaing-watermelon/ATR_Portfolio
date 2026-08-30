const VERSION = "2.1.0";
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

const SCHEMA_SQL = [
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

async function ensureSchema(db) {
  if (schemaBootstrapped) return;
  await db.batch(SCHEMA_SQL.map(sql => db.prepare(sql)));
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
  const portfolioHeatPct = totalEquity > 0 ? (openDownside / totalEquity) * 100 : 0;
  return {
    cash,
    holdings_value: holdingsValue,
    cost_value: costValue,
    total_equity: totalEquity,
    unrealised_pl: unrealisedPl,
    realised_pl: realisedPl,
    open_downside: openDownside,
    portfolio_heat_pct: portfolioHeatPct,
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

  const amount = type === "BUY" || type === "SELL" ? shares * price : finite(body.amount);
  const nextCash = currentCash + cashDelta;
  const statements = [
    env.DB.prepare(`INSERT INTO transactions (type, code, name, sector, trade_date, shares, price, fees, amount, realized_pl, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(type, code, cleanText(body.name, 160) || null, cleanText(body.sector, 80) || null, tradeDate,
        shares || null, price || null, fees, amount, realizedPl, cleanText(body.notes, 1000)),
    env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('cash_balance', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(String(nextCash)),
    env.DB.prepare(`INSERT INTO cash_ledger (transaction_id, entry_type, amount, balance_after, entry_date, notes)
      VALUES (NULL, ?, ?, ?, ?, ?)`)
      .bind(type, cashDelta, nextCash, tradeDate, cleanText(body.notes, 1000))
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
  if (!Number.isFinite(cash)) return json({ ok: false, error: "invalid_cash_balance" }, 400);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('cash_balance', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(String(cash)),
    env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('portfolio_initialized', '1', CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value='1', updated_at=CURRENT_TIMESTAMP`)
  ]);
  return json({ ok: true, cash_balance: cash }, 201);
}

async function upsertPriceSnapshot(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const body = await request.json();
  const code = cleanText(body.code, 16).toUpperCase();
  const priceDate = cleanText(body.price_date, 10) || new Date().toISOString().slice(0, 10);
  const close = finite(body.close, -1);
  if (!code || close < 0) return json({ ok: false, error: "invalid_price_snapshot" }, 400);
  const atr14 = maybeFinite(body.atr14);
  const ma10 = maybeFinite(body.ma10);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO price_snapshots (code, price_date, close, atr14, ma10, ma20, ma50, ma200, volume, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code, price_date) DO UPDATE SET close=excluded.close, atr14=excluded.atr14, ma10=excluded.ma10,
        ma20=excluded.ma20, ma50=excluded.ma50, ma200=excluded.ma200, volume=excluded.volume, source=excluded.source`)
      .bind(code, priceDate, close, atr14, ma10, maybeFinite(body.ma20), maybeFinite(body.ma50), maybeFinite(body.ma200), maybeFinite(body.volume), cleanText(body.source, 40) || "manual"),
    env.DB.prepare("UPDATE holdings SET current_price = ?, ma10 = COALESCE(?, ma10), updated_at = CURRENT_TIMESTAMP WHERE code = ?")
      .bind(close, ma10, code)
  ]);
  return json({ ok: true, code, price_date: priceDate, close }, 201);
}

async function readMarket(db, code) {
  if (code) {
    const rows = await db.prepare(`SELECT code, price_date, close, atr14, ma10, ma20, ma50, ma200, volume, source
      FROM price_snapshots WHERE code = ? ORDER BY price_date DESC LIMIT 120`).bind(code).all();
    return rows.results || [];
  }
  const rows = await db.prepare(`SELECT p.code, p.price_date, p.close, p.atr14, p.ma10, p.ma20, p.ma50, p.ma200, p.volume, p.source
    FROM price_snapshots p
    JOIN (SELECT code, MAX(price_date) AS max_date FROM price_snapshots GROUP BY code) latest
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
      return json({
        ok: true,
        service: "atr-portfolio",
        version: VERSION,
        phase: 2,
        db_bound: true,
        schema_ready: schema.ready,
        mutation_enabled: Boolean(env.ADMIN_TOKEN),
        tables: schema.tables
      });
    }

    if (!schema.ready) return json({ ok: false, error: "D1 schema is not initialized", schema_ready: false, tables: schema.tables }, 503);

    if (url.pathname === "/api/state" && request.method === "GET") {
      return json({ ok: true, phase: 2, db_bound: true, schema_ready: true, mutation_enabled: Boolean(env.ADMIN_TOKEN), data: await readState(env.DB) });
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
  }
};
