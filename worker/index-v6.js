import phase5 from "./index-v5.js";

const VERSION = "6.0.0";
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const clean = (v, n = 32) => String(v ?? "").trim().slice(0, n);
const finite = (v, fallback = null) => Number.isFinite(Number(v)) ? Number(v) : fallback;

async function chartData(env, url) {
  const code = clean(url.searchParams.get("code"), 16).toUpperCase();
  const days = Math.min(260, Math.max(30, Number(url.searchParams.get("days") || 120)));
  if (!code) return json({ ok:false, error:"code_required" }, 400);

  const holding = await env.DB.prepare(`SELECT code,name,sector,shares,avg_cost,current_price,atr14,ma10,ma20,ma50,ma200,
      hard_stop AS manual_hard_stop,active_stop,trailing_stop,partial_stop,watch_stop,peak_price,peak_date,risk_status,risk_reason,latest_price_date
    FROM holdings WHERE code=?`).bind(code).first();
  if (!holding) return json({ ok:false, error:"holding_not_found" }, 404);

  const prices = await env.DB.prepare(`SELECT price_date,open,high,low,close,atr14,ma10,ma20,ma50,ma200,volume,source
    FROM price_snapshots WHERE code=? ORDER BY price_date DESC LIMIT ?`).bind(code, days).all();
  const risk = await env.DB.prepare(`SELECT snapshot_date,price,atr14,hard_stop,trailing_stop,active_stop,partial_stop,watch_stop,status,reason
    FROM risk_snapshots WHERE code=? ORDER BY snapshot_date DESC LIMIT ?`).bind(code, days).all();
  const signals = await env.DB.prepare(`SELECT id,signal_type,severity,message,observed_price,trigger_price,created_at,acknowledged
    FROM signal_events WHERE code=? ORDER BY created_at DESC LIMIT 100`).bind(code).all();

  const priceRows = (prices.results || []).reverse();
  const riskByDate = Object.fromEntries((risk.results || []).map(r => [r.snapshot_date, r]));
  const rows = priceRows.map(p => ({ ...p, risk:riskByDate[p.price_date] || null }));
  return json({
    ok:true, version:VERSION, phase:6, code,
    data:{ holding, rows, signals:signals.results || [], window_days:days }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (env.DB && request.method === "GET" && url.pathname === "/api/chart") return chartData(env, url);
    const response = await phase5.fetch(request, env, ctx);
    if (request.method === "GET" && url.pathname === "/api/health" && response.headers.get("content-type")?.includes("application/json")) {
      try {
        const payload = await response.clone().json();
        if (payload?.ok) return json({ ...payload, version:VERSION, phase:6, chart_review:{ enabled:true, max_sessions:260, ma_lines:[10,20,50,200], atr_levels:true, signal_markers:true } }, response.status);
      } catch {}
    }
    return response;
  },
  async scheduled(controller, env, ctx) {
    return phase5.scheduled(controller, env, ctx);
  }
};
