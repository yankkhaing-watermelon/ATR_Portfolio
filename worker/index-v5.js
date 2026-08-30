import phase4 from "./index-v4-fix.js";

const VERSION = "5.0.0";
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const cleanText = (value, max = 200) => String(value ?? "").trim().slice(0, max);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

async function ensureSignalSchema(db) {
  const info = await db.prepare("PRAGMA table_info(signal_events)").all();
  const cols = new Set((info.results || []).map(row => row.name));
  if (!cols.has("acknowledged")) await db.prepare("ALTER TABLE signal_events ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0").run();
  if (!cols.has("reviewed_at")) await db.prepare("ALTER TABLE signal_events ADD COLUMN reviewed_at TEXT").run();
  if (!cols.has("review_note")) await db.prepare("ALTER TABLE signal_events ADD COLUMN review_note TEXT NOT NULL DEFAULT ''").run();
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

async function signalInbox(env, url) {
  await ensureSignalSchema(env.DB);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const code = cleanText(url.searchParams.get("code"), 16).toUpperCase();
  const where = ["1=1"];
  const binds = [];
  if (unreadOnly) where.push("acknowledged=0");
  if (code) { where.push("code=?"); binds.push(code); }
  const rows = await env.DB.prepare(`SELECT id,code,signal_type,severity,message,observed_price,trigger_price,created_at,acknowledged,reviewed_at,review_note
    FROM signal_events WHERE ${where.join(" AND ")}
    ORDER BY acknowledged ASC, created_at DESC, id DESC LIMIT 250`).bind(...binds).all();
  const unread = await env.DB.prepare("SELECT COUNT(*) AS n FROM signal_events WHERE acknowledged=0").first();
  return { unread_count: finite(unread?.n), signals: rows.results || [] };
}

async function reviewSignal(request, env, id) {
  const denied = await requireAdmin(request, env); if (denied) return denied;
  await ensureSignalSchema(env.DB);
  const body = await request.json().catch(() => ({}));
  const result = await env.DB.prepare(`UPDATE signal_events SET acknowledged=1, reviewed_at=CURRENT_TIMESTAMP, review_note=? WHERE id=?`)
    .bind(cleanText(body.note, 500), id).run();
  if (!result.meta?.changes) return json({ ok: false, error: "signal_not_found" }, 404);
  return json({ ok: true, id, acknowledged: true });
}

async function updateRiskControls(request, env, code) {
  const denied = await requireAdmin(request, env); if (denied) return denied;
  const body = await request.json();
  const hardStop = body.hard_stop == null || body.hard_stop === "" ? null : finite(body.hard_stop, NaN);
  const support = body.manual_support == null || body.manual_support === "" ? null : finite(body.manual_support, NaN);
  if ((hardStop != null && (!Number.isFinite(hardStop) || hardStop < 0)) || (support != null && (!Number.isFinite(support) || support < 0))) {
    return json({ ok: false, error: "invalid_risk_control" }, 400);
  }
  const result = await env.DB.prepare("UPDATE holdings SET hard_stop=?, manual_support=?, updated_at=CURRENT_TIMESTAMP WHERE code=?")
    .bind(hardStop, support, code).run();
  if (!result.meta?.changes) return json({ ok: false, error: "holding_not_found" }, 404);
  const run = await phase4.fetch(new Request(new URL("/api/risk/run", request.url), { method: "POST", headers: request.headers }), env);
  const payload = await run.json().catch(() => null);
  return json({ ok: true, code, hard_stop: hardStop, manual_support: support, risk_run: payload?.data || null });
}

async function riskHistory(env, url) {
  const code = cleanText(url.searchParams.get("code"), 16).toUpperCase();
  if (!code) return json({ ok: false, error: "code_required" }, 400);
  const rows = await env.DB.prepare(`SELECT code,snapshot_date,price,atr14,hard_stop,trailing_stop,active_stop,partial_stop,watch_stop,risk_distance_pct,portfolio_risk_amount,status,reason,rule_version,created_at
    FROM risk_snapshots WHERE code=? ORDER BY snapshot_date DESC LIMIT 180`).bind(code).all();
  return json({ ok: true, version: VERSION, phase: 5, code, data: rows.results || [] });
}

async function actionSell(request, env) {
  const denied = await requireAdmin(request, env); if (denied) return denied;
  const body = await request.json();
  const code = cleanText(body.code, 16).toUpperCase();
  const shares = finite(body.shares, NaN);
  const price = finite(body.price, NaN);
  if (!code || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(price) || price <= 0) return json({ ok: false, error: "invalid_sell_action" }, 400);
  const h = await env.DB.prepare("SELECT name,sector FROM holdings WHERE code=?").bind(code).first();
  if (!h) return json({ ok: false, error: "holding_not_found" }, 404);
  const txBody = { type: "SELL", code, name: h.name, sector: h.sector, shares, price, fees: finite(body.fees), trade_date: cleanText(body.trade_date, 10), notes: cleanText(body.notes, 1000) };
  const txReq = new Request(new URL("/api/transactions", request.url), { method: "POST", headers: request.headers, body: JSON.stringify(txBody) });
  const txResp = await phase4.fetch(txReq, env);
  const tx = await txResp.json().catch(() => ({ ok: false, error: `HTTP_${txResp.status}` }));
  if (!txResp.ok || !tx.ok) return json(tx, txResp.status);
  const riskReq = new Request(new URL("/api/risk/run", request.url), { method: "POST", headers: request.headers });
  const riskResp = await phase4.fetch(riskReq, env);
  const risk = await riskResp.json().catch(() => null);
  return json({ ok: true, version: VERSION, phase: 5, transaction: tx, risk: risk?.data || null }, 201);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.DB) return phase4.fetch(request, env, ctx);
    await ensureSignalSchema(env.DB);

    if (request.method === "GET" && url.pathname === "/api/signals/inbox") return json({ ok: true, version: VERSION, phase: 5, data: await signalInbox(env, url) });
    const reviewMatch = url.pathname.match(/^\/api\/signals\/(\d+)\/review$/);
    if (request.method === "POST" && reviewMatch) return reviewSignal(request, env, Number(reviewMatch[1]));
    const riskControlMatch = url.pathname.match(/^\/api\/holdings\/([^/]+)\/risk-controls$/);
    if (request.method === "PATCH" && riskControlMatch) return updateRiskControls(request, env, decodeURIComponent(riskControlMatch[1]).toUpperCase());
    if (request.method === "GET" && url.pathname === "/api/risk/history") return riskHistory(env, url);
    if (request.method === "POST" && url.pathname === "/api/actions/sell") return actionSell(request, env);

    const response = await phase4.fetch(request, env, ctx);
    if (request.method === "GET" && url.pathname === "/api/health" && response.headers.get("content-type")?.includes("application/json")) {
      try {
        const payload = await response.clone().json();
        if (payload?.ok) {
          const unread = await env.DB.prepare("SELECT COUNT(*) AS n FROM signal_events WHERE acknowledged=0").first();
          return json({ ...payload, version: VERSION, phase: 5, signal_workflow: { unread_count: finite(unread?.n), review_enabled: true, action_sell_enabled: true } }, response.status);
        }
      } catch {}
    }
    return response;
  },
  async scheduled(controller, env, ctx) {
    return phase4.scheduled(controller, env, ctx);
  }
};
