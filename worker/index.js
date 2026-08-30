const VERSION = "2.0.0";
const REQUIRED_TABLES = ["holdings", "settings", "signal_events", "transactions", "watchlist_items"];

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const cleanText = (value, max = 200) => String(value ?? "").trim().slice(0, max);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

async function schemaStatus(db) {
  const result = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  const tables = (result.results || []).map(row => row.name).filter(Boolean);
  return { tables, ready: REQUIRED_TABLES.every(name => tables.includes(name)) };
}

async function readState(db) {
  const [settingsResult, holdingsResult, transactionsResult, watchlistResult, signalsResult] = await db.batch([
    db.prepare("SELECT key, value, updated_at FROM settings ORDER BY key"),
    db.prepare("SELECT code, name, sector, shares, avg_cost, current_price, hard_stop, ma10, manual_support, peak_price, peak_date, risk_status, updated_at FROM holdings WHERE shares > 0 ORDER BY risk_status DESC, code"),
    db.prepare("SELECT id, type, code, name, sector, trade_date, shares, price, fees, amount, realized_pl, notes, created_at, updated_at FROM transactions ORDER BY trade_date DESC, id DESC LIMIT 250"),
    db.prepare("SELECT code, name, target_price, support_price, notes, created_at, updated_at FROM watchlist_items ORDER BY code"),
    db.prepare("SELECT id, code, signal_type, severity, message, observed_price, trigger_price, created_at FROM signal_events ORDER BY created_at DESC, id DESC LIMIT 150")
  ]);
  const settings = Object.fromEntries((settingsResult.results || []).map(row => [row.key, row.value]));
  return {
    settings,
    cash: finite(settings.cash_balance),
    holdings: holdingsResult.results || [],
    transactions: transactionsResult.results || [],
    watchlist: watchlistResult.results || [],
    signals: signalsResult.results || []
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
  `).bind(code, name, cleanText(body.sector, 80) || "Other", shares, avgCost, finite(body.current_price),
    body.hard_stop == null ? null : finite(body.hard_stop), body.ma10 == null ? null : finite(body.ma10),
    body.manual_support == null ? null : finite(body.manual_support), body.peak_price == null ? null : finite(body.peak_price),
    cleanText(body.peak_date, 10) || null, ["Safe","Watch","Partial","Sell","Error"].includes(body.risk_status) ? body.risk_status : "Safe").run();
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
  const statements = [
    env.DB.prepare(`INSERT INTO transactions (type, code, name, sector, trade_date, shares, price, fees, amount, realized_pl, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(type, code, cleanText(body.name, 160) || null, cleanText(body.sector, 80) || null, tradeDate,
        shares || null, price || null, fees, amount, realizedPl, cleanText(body.notes, 1000)),
    env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('cash_balance', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(String(currentCash + cashDelta))
  ];
  if (holdingStatement) statements.push(holdingStatement);
  await env.DB.batch(statements);
  return json({ ok: true, type, code, cash_balance: currentCash + cashDelta, realized_pl: realizedPl }, 201);
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (url.pathname === "/api/health" && request.method === "GET") {
    if (!env.DB) return json({ ok: true, service: "atr-portfolio", version: VERSION, db_bound: false, schema_ready: false });
    try {
      const schema = await schemaStatus(env.DB);
      return json({ ok: true, service: "atr-portfolio", version: VERSION, db_bound: true, schema_ready: schema.ready, tables: schema.tables });
    } catch (error) {
      return json({ ok: false, service: "atr-portfolio", version: VERSION, db_bound: true, error: error.message }, 500);
    }
  }
  if (!env.DB) return json({ ok: false, error: "D1 binding DB is not configured" }, 503);
  try {
    const schema = await schemaStatus(env.DB);
    if (!schema.ready) return json({ ok: false, error: "D1 schema is not initialized", schema_ready: false, tables: schema.tables }, 503);
    if (url.pathname === "/api/state" && request.method === "GET") return json({ ok: true, db_bound: true, schema_ready: true, data: await readState(env.DB) });
    if (url.pathname === "/api/holdings" && request.method === "POST") return upsertHolding(request, env);
    if (url.pathname === "/api/transactions" && request.method === "POST") return recordTransaction(request, env);
    return json({ ok: false, error: "not_found" }, 404);
  } catch (error) {
    return json({ ok: false, error: error.message || "unexpected_error" }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  }
};
