import base from "./index.js";

const VERSION = "4.0.0";
const RISK_RULE_VERSION = "atr-risk-v1";
const RISK_COLUMNS = [
  ["atr14", "REAL"],
  ["ma20", "REAL"],
  ["ma50", "REAL"],
  ["ma200", "REAL"],
  ["auto_hard_stop", "REAL"],
  ["trailing_stop", "REAL"],
  ["partial_stop", "REAL"],
  ["watch_stop", "REAL"],
  ["active_stop", "REAL"],
  ["risk_distance_pct", "REAL"],
  ["portfolio_risk_amount", "REAL"],
  ["risk_reason", "TEXT"],
  ["risk_updated_at", "TEXT"],
  ["latest_price_date", "TEXT"]
];

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const cleanText = (value, max = 200) => String(value ?? "").trim().slice(0, max);

async function ensureColumn(db, table, column, type) {
  const info = await db.prepare(`PRAGMA table_info(${table})`).all();
  if (!(info.results || []).some(row => row.name === column)) {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  }
}

async function ensureRiskSchema(db) {
  for (const [name, type] of RISK_COLUMNS) await ensureColumn(db, "holdings", name, type);
  await ensureColumn(db, "risk_snapshots", "active_stop", "REAL");
  await ensureColumn(db, "risk_snapshots", "partial_stop", "REAL");
  await ensureColumn(db, "risk_snapshots", "watch_stop", "REAL");
  await ensureColumn(db, "risk_snapshots", "rule_version", "TEXT");
}

async function tokenMatches(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get("authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!supplied) return false;
  const enc = value => new TextEncoder().encode(value);
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc(supplied)),
    crypto.subtle.digest("SHA-256", enc(env.ADMIN_TOKEN))
  ]);
  const a = new Uint8Array(aHash), b = new Uint8Array(bHash);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, error: "admin_mutations_disabled" }, 503);
  if (!(await tokenMatches(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  return null;
}

function riskReason(status, row, levels) {
  const price = finite(row.close || row.current_price);
  if (status === "Error") return "Risk engine cannot calculate because completed-close ATR data is unavailable.";
  if (status === "Sell") return `Completed close ${price.toFixed(3)} is at or below active stop ${levels.active.toFixed(3)}.`;
  if (status === "Partial") return `Completed close entered the 2 ATR giveback zone from tracked peak ${levels.peak.toFixed(3)}.`;
  if (status === "Watch") {
    if (levels.ma10 > 0 && price < levels.ma10) return `Completed close is below MA10 (${levels.ma10.toFixed(3)}); monitor for further weakness.`;
    return `Completed close is within the ATR warning zone above the partial-exit trigger ${levels.partial.toFixed(3)}.`;
  }
  return `Price remains above the ATR warning and exit levels; tracked peak is ${levels.peak.toFixed(3)}.`;
}

function calculateRisk(row) {
  const price = finite(row.close || row.current_price);
  const atr = finite(row.price_atr14 || row.atr14);
  const avgCost = finite(row.avg_cost);
  const shares = finite(row.shares);
  const manual = Math.max(0, finite(row.hard_stop));
  const ma10 = Math.max(0, finite(row.price_ma10 || row.ma10));
  const peak = Math.max(price, finite(row.peak_price));

  if (!(price > 0) || !(atr > 0)) {
    return {
      status: "Error", price, atr: atr || null, peak, ma10,
      autoHard: 0, trailing: 0, partial: 0, watch: 0, active: manual,
      riskDistancePct: null, riskAmount: 0,
      reason: "Risk engine cannot calculate because completed-close ATR data is unavailable."
    };
  }

  const autoHard = avgCost > 0 ? Math.max(0, avgCost - 2 * atr) : 0;
  const trailing = peak > 0 ? Math.max(0, peak - 3 * atr) : 0;
  const active = Math.max(manual, autoHard, trailing);
  const partial = Math.max(active, peak - 2 * atr);
  const watch = Math.max(partial, peak - 1.5 * atr);

  let status = "Safe";
  if (active > 0 && price <= active) status = "Sell";
  else if (partial > 0 && price <= partial) status = "Partial";
  else if ((watch > 0 && price <= watch) || (ma10 > 0 && price < ma10)) status = "Watch";

  const riskDistancePct = active > 0 ? ((price - active) / price) * 100 : null;
  const riskAmount = active > 0 ? Math.max(0, price - active) * shares : 0;
  const levels = { active, partial, watch, peak, ma10 };
  return {
    status, price, atr, peak, ma10, autoHard, trailing, partial, watch, active,
    riskDistancePct, riskAmount, reason: riskReason(status, row, levels)
  };
}

async function riskSourceRows(db) {
  const result = await db.prepare(`
    SELECT h.*,
      p.price_date AS latest_price_date_join,
      p.close AS latest_close,
      p.atr14 AS price_atr14,
      p.ma10 AS price_ma10,
      p.ma20 AS price_ma20,
      p.ma50 AS price_ma50,
      p.ma200 AS price_ma200
    FROM holdings h
    LEFT JOIN (
      SELECT ps.* FROM price_snapshots ps
      INNER JOIN (
        SELECT code, MAX(price_date) AS max_date FROM price_snapshots GROUP BY code
      ) latest ON latest.code = ps.code AND latest.max_date = ps.price_date
    ) p ON p.code = h.code
    WHERE h.shares > 0
    ORDER BY h.code
  `).all();
  return result.results || [];
}

function signalType(status) {
  if (status === "Sell") return "ATR_SELL";
  if (status === "Partial") return "ATR_PARTIAL";
  if (status === "Watch") return "ATR_WATCH";
  if (status === "Safe") return "RISK_CLEAR";
  return "DATA_ERROR";
}

async function writeRiskRow(db, row, risk, date) {
  const previous = row.risk_status || "Safe";
  const peakDate = risk.peak > finite(row.peak_price) ? (row.latest_price_date_join || date) : (row.peak_date || row.latest_price_date_join || date);
  await db.prepare(`UPDATE holdings SET
      current_price = ?, atr14 = ?, ma10 = ?, ma20 = ?, ma50 = ?, ma200 = ?,
      auto_hard_stop = ?, trailing_stop = ?, partial_stop = ?, watch_stop = ?, active_stop = ?,
      risk_distance_pct = ?, portfolio_risk_amount = ?, risk_status = ?, risk_reason = ?,
      risk_updated_at = CURRENT_TIMESTAMP, latest_price_date = ?, peak_price = ?, peak_date = ?, updated_at = CURRENT_TIMESTAMP
    WHERE code = ?`)
    .bind(
      risk.price, risk.atr, risk.ma10 || null, finite(row.price_ma20, null), finite(row.price_ma50, null), finite(row.price_ma200, null),
      risk.autoHard || null, risk.trailing || null, risk.partial || null, risk.watch || null, risk.active || null,
      risk.riskDistancePct, risk.riskAmount, risk.status, risk.reason,
      row.latest_price_date_join || date, risk.peak || null, peakDate, row.code
    ).run();

  await db.prepare(`INSERT INTO risk_snapshots
      (code, snapshot_date, price, atr14, hard_stop, trailing_stop, manual_support,
       risk_distance_pct, portfolio_risk_amount, status, reason, active_stop, partial_stop, watch_stop, rule_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(code, snapshot_date) DO UPDATE SET
      price=excluded.price, atr14=excluded.atr14, hard_stop=excluded.hard_stop,
      trailing_stop=excluded.trailing_stop, manual_support=excluded.manual_support,
      risk_distance_pct=excluded.risk_distance_pct, portfolio_risk_amount=excluded.portfolio_risk_amount,
      status=excluded.status, reason=excluded.reason, active_stop=excluded.active_stop,
      partial_stop=excluded.partial_stop, watch_stop=excluded.watch_stop, rule_version=excluded.rule_version`)
    .bind(
      row.code, date, risk.price, risk.atr, Math.max(finite(row.hard_stop), risk.autoHard), risk.trailing,
      row.manual_support == null ? null : finite(row.manual_support), risk.riskDistancePct, risk.riskAmount,
      risk.status, risk.reason, risk.active, risk.partial, risk.watch, RISK_RULE_VERSION
    ).run();

  if (previous !== risk.status) {
    const trigger = risk.status === "Sell" ? risk.active : risk.status === "Partial" ? risk.partial : risk.status === "Watch" ? risk.watch : null;
    await db.prepare(`INSERT INTO signal_events
      (code, signal_type, severity, message, observed_price, trigger_price, created_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .bind(row.code, signalType(risk.status), risk.status, risk.reason, risk.price, trigger).run();
  }
}

async function computeRiskSummary(db) {
  const [cashRow, holdingsResult, txResult] = await Promise.all([
    db.prepare("SELECT value FROM settings WHERE key='cash_balance'").first(),
    db.prepare(`SELECT shares, avg_cost, current_price, active_stop, risk_status FROM holdings WHERE shares > 0`).all(),
    db.prepare("SELECT realized_pl FROM transactions WHERE realized_pl IS NOT NULL").all()
  ]);
  const holdings = holdingsResult.results || [];
  const cash = finite(cashRow?.value);
  const holdingsValue = holdings.reduce((s, h) => s + finite(h.shares) * finite(h.current_price), 0);
  const costValue = holdings.reduce((s, h) => s + finite(h.shares) * finite(h.avg_cost), 0);
  const totalEquity = cash + holdingsValue;
  const unrealisedPl = holdingsValue - costValue;
  const realisedPl = (txResult.results || []).reduce((s, row) => s + finite(row.realized_pl), 0);
  const openDownside = holdings.reduce((s, h) => {
    const price = finite(h.current_price), stop = finite(h.active_stop);
    return s + (price > stop && stop > 0 ? (price - stop) * finite(h.shares) : 0);
  }, 0);
  return {
    cash, holdings_value: holdingsValue, cost_value: costValue, total_equity: totalEquity,
    unrealised_pl: unrealisedPl, realised_pl: realisedPl, open_downside: openDownside,
    portfolio_heat_pct: totalEquity > 0 ? (openDownside / totalEquity) * 100 : 0,
    holdings_count: holdings.length
  };
}

async function writeRiskPortfolioSnapshot(db, summary, date) {
  await db.prepare(`INSERT INTO portfolio_snapshots
    (snapshot_date, cash, holdings_value, total_equity, unrealised_pl, realised_pl, open_downside, portfolio_heat_pct, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(snapshot_date) DO UPDATE SET
      cash=excluded.cash, holdings_value=excluded.holdings_value, total_equity=excluded.total_equity,
      unrealised_pl=excluded.unrealised_pl, realised_pl=excluded.realised_pl,
      open_downside=excluded.open_downside, portfolio_heat_pct=excluded.portfolio_heat_pct`)
    .bind(date, summary.cash, summary.holdings_value, summary.total_equity, summary.unrealised_pl,
      summary.realised_pl, summary.open_downside, summary.portfolio_heat_pct).run();
}

async function runRiskEngine(env) {
  await ensureRiskSchema(env.DB);
  const rows = await riskSourceRows(env.DB);
  const date = new Date().toISOString().slice(0, 10);
  const results = [];
  const counts = { Safe: 0, Watch: 0, Partial: 0, Sell: 0, Error: 0 };
  for (const row of rows) {
    const risk = calculateRisk({ ...row, close: row.latest_close });
    await writeRiskRow(env.DB, row, risk, date);
    counts[risk.status] += 1;
    results.push({
      code: row.code,
      status: risk.status,
      price_date: row.latest_price_date_join || null,
      price: risk.price,
      atr14: risk.atr,
      peak_price: risk.peak,
      auto_hard_stop: risk.autoHard,
      trailing_stop: risk.trailing,
      partial_stop: risk.partial,
      watch_stop: risk.watch,
      active_stop: risk.active,
      risk_distance_pct: risk.riskDistancePct,
      portfolio_risk_amount: risk.riskAmount,
      reason: risk.reason
    });
  }
  const summary = await computeRiskSummary(env.DB);
  await writeRiskPortfolioSnapshot(env.DB, summary, date);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('risk_last_run',?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(now),
    env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('risk_rule_version',?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(RISK_RULE_VERSION),
    env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('risk_counts',?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(JSON.stringify(counts))
  ]);
  return { rule_version: RISK_RULE_VERSION, run_at: now, counts, results, summary };
}

async function riskSettings(db) {
  const rows = await db.prepare("SELECT key,value FROM settings WHERE key LIKE 'risk_%' ORDER BY key").all();
  const out = Object.fromEntries((rows.results || []).map(row => [row.key, row.value]));
  if (out.risk_counts) {
    try { out.risk_counts = JSON.parse(out.risk_counts); } catch { /* keep raw */ }
  }
  return out;
}

async function maybeBootstrapRisk(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='risk_last_run'").first();
  if (row?.value) return;
  const market = await env.DB.prepare("SELECT 1 AS ok FROM price_snapshots LIMIT 1").first();
  if (market?.ok) await runRiskEngine(env);
}

async function enrichedHoldings(db) {
  const rows = await db.prepare(`SELECT
      code,name,sector,shares,avg_cost,current_price,
      hard_stop AS manual_hard_stop,
      COALESCE(active_stop,hard_stop) AS hard_stop,
      auto_hard_stop,trailing_stop,partial_stop,watch_stop,active_stop,
      atr14,ma10,ma20,ma50,ma200,manual_support,peak_price,peak_date,
      risk_distance_pct,portfolio_risk_amount,risk_status,risk_reason,risk_updated_at,latest_price_date,updated_at
    FROM holdings WHERE shares > 0
    ORDER BY CASE risk_status WHEN 'Sell' THEN 1 WHEN 'Partial' THEN 2 WHEN 'Watch' THEN 3 WHEN 'Safe' THEN 4 ELSE 5 END,code`).all();
  return rows.results || [];
}

async function enrichStatePayload(payload, env) {
  const holdings = await enrichedHoldings(env.DB);
  const summary = await computeRiskSummary(env.DB);
  payload.version = VERSION;
  payload.phase = 4;
  payload.data = { ...(payload.data || {}), holdings, summary, risk_engine: await riskSettings(env.DB) };
  return payload;
}

async function handleRiskApi(request, env) {
  const url = new URL(request.url);
  await base.fetch(new Request(new URL("/api/health", url), { method: "GET" }), env);
  await ensureRiskSchema(env.DB);
  if (request.method === "GET" && url.pathname === "/api/risk") {
    await maybeBootstrapRisk(env);
    return json({ ok: true, version: VERSION, phase: 4, engine: await riskSettings(env.DB), data: await enrichedHoldings(env.DB) });
  }
  if (request.method === "POST" && url.pathname === "/api/risk/run") {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    return json({ ok: true, version: VERSION, phase: 4, data: await runRiskEngine(env) });
  }
  return json({ ok: false, error: "not_found" }, 404);
}

async function wrapBaseApi(request, env, ctx) {
  const url = new URL(request.url);
  const response = await base.fetch(request, env, ctx);
  if (!response.headers.get("content-type")?.includes("application/json")) return response;
  let payload;
  try { payload = await response.clone().json(); } catch { return response; }
  if (!payload?.ok || !env.DB) return response;
  await ensureRiskSchema(env.DB);

  if (url.pathname === "/api/health" && request.method === "GET") {
    await maybeBootstrapRisk(env);
    return json({ ...payload, version: VERSION, phase: 4, risk_engine: await riskSettings(env.DB) }, response.status);
  }
  if (url.pathname === "/api/state" && request.method === "GET") {
    await maybeBootstrapRisk(env);
    return json(await enrichStatePayload(payload, env), response.status);
  }
  if (url.pathname === "/api/portfolio" && request.method === "GET") {
    await maybeBootstrapRisk(env);
    return json({ ...payload, version: VERSION, phase: 4, data: { summary: await computeRiskSummary(env.DB), holdings: await enrichedHoldings(env.DB) } }, response.status);
  }
  if (url.pathname === "/api/holdings" && request.method === "GET") {
    await maybeBootstrapRisk(env);
    return json({ ...payload, version: VERSION, phase: 4, data: await enrichedHoldings(env.DB) }, response.status);
  }
  if ((url.pathname === "/api/market/sync" || url.pathname === "/api/market/sync-one") && request.method === "POST") {
    const risk = await runRiskEngine(env);
    return json({ ...payload, version: VERSION, phase: 4, risk_engine: risk }, response.status);
  }
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/risk")) return handleRiskApi(request, env);
    if (url.pathname.startsWith("/api/")) return wrapBaseApi(request, env, ctx);
    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env) {
    let marketPromise = null;
    await base.scheduled(controller, env, { waitUntil(promise) { marketPromise = promise; } });
    if (marketPromise) await marketPromise;
    await runRiskEngine(env);
  }
};
