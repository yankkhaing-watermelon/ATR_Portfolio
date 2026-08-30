import phase4 from "./index-v4.js";

const VERSION = "4.0.2";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

async function stableRiskRead(request, env, ctx) {
  try {
    // Let Phase 4 bootstrap/migrate its risk schema and expose the latest engine status.
    const healthRequest = new Request(new URL("/api/health", request.url), { method: "GET" });
    const healthResponse = await phase4.fetch(healthRequest, env, ctx);
    const health = await healthResponse.json();
    if (!healthResponse.ok || !health.ok) {
      return json({ ok: false, version: VERSION, phase: 4, error: health.error || `health_http_${healthResponse.status}` }, 500);
    }

    // Read the already-computed Phase 4 columns directly. SELECT * is deliberate here:
    // it avoids the fragile enriched SELECT that caused /api/risk to throw HTTP 500.
    const rows = await env.DB.prepare(`
      SELECT *
      FROM holdings
      WHERE shares > 0
      ORDER BY CASE risk_status
        WHEN 'Sell' THEN 1
        WHEN 'Partial' THEN 2
        WHEN 'Watch' THEN 3
        WHEN 'Safe' THEN 4
        ELSE 5
      END, code
    `).all();

    return json({
      ok: true,
      version: VERSION,
      phase: 4,
      engine: health.risk_engine || {},
      data: (rows.results || []).map(row => ({
        ...row,
        name: row.name || row.company_name || row.code,
        sector: row.sector || ""
      }))
    });
  } catch (error) {
    return json({
      ok: false,
      version: VERSION,
      phase: 4,
      error: error?.message || "risk_read_failed"
    }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/risk") {
      return stableRiskRead(request, env, ctx);
    }

    const response = await phase4.fetch(request, env, ctx);

    // Surface the hotfix version on health without changing the Phase 4 engine payload.
    if (request.method === "GET" && url.pathname === "/api/health" && response.headers.get("content-type")?.includes("application/json")) {
      try {
        const payload = await response.clone().json();
        if (payload?.ok) return json({ ...payload, version: VERSION, phase: 4 }, response.status);
      } catch {
        // Fall through to the original response.
      }
    }

    return response;
  },

  async scheduled(controller, env, ctx) {
    return phase4.scheduled(controller, env, ctx);
  }
};
