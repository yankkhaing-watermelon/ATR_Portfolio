import phase6 from "./index-v6.js";

const VERSION = "7.0.0";
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const n = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const pct = (a, b) => b > 0 ? ((a / b) - 1) * 100 : null;

function maxDrawdown(rows) {
  let peak = -Infinity, worst = 0;
  for (const row of rows) {
    const equity = n(row.total_equity);
    if (!(equity > 0)) continue;
    peak = Math.max(peak, equity);
    if (peak > 0) worst = Math.min(worst, ((equity / peak) - 1) * 100);
  }
  return Number.isFinite(peak) ? worst : null;
}

function returnFromLookback(rows, sessions) {
  if (rows.length < 2) return null;
  const latest = rows[rows.length - 1];
  const idx = Math.max(0, rows.length - 1 - sessions);
  if (idx === rows.length - 1) return null;
  return pct(n(latest.total_equity), n(rows[idx].total_equity));
}

async function analytics(env) {
  const [snapshotsRes, holdingsRes, sellRes, txRes] = await Promise.all([
    env.DB.prepare(`SELECT snapshot_date,cash,holdings_value,total_equity,unrealised_pl,realised_pl,open_downside,portfolio_heat_pct,created_at
      FROM portfolio_snapshots ORDER BY snapshot_date ASC LIMIT 400`).all(),
    env.DB.prepare(`SELECT code,name,sector,shares,avg_cost,current_price,risk_status,active_stop,portfolio_risk_amount
      FROM holdings WHERE shares > 0 ORDER BY code`).all(),
    env.DB.prepare(`SELECT id,code,name,trade_date,shares,price,fees,amount,realized_pl
      FROM transactions WHERE type='SELL' AND realized_pl IS NOT NULL ORDER BY trade_date ASC,id ASC`).all(),
    env.DB.prepare(`SELECT id,type,code,name,trade_date,shares,price,fees,amount,realized_pl
      FROM transactions ORDER BY trade_date ASC,id ASC LIMIT 2000`).all()
  ]);

  const snapshots = snapshotsRes.results || [];
  const holdings = holdingsRes.results || [];
  const sells = sellRes.results || [];
  const transactions = txRes.results || [];
  const latest = snapshots[snapshots.length - 1] || null;

  const wins = sells.filter(r => n(r.realized_pl) > 0);
  const losses = sells.filter(r => n(r.realized_pl) < 0);
  const grossProfit = wins.reduce((s,r) => s + n(r.realized_pl), 0);
  const grossLoss = Math.abs(losses.reduce((s,r) => s + n(r.realized_pl), 0));
  const realised = sells.reduce((s,r) => s + n(r.realized_pl), 0);

  const contributors = holdings.map(h => {
    const marketValue = n(h.shares) * n(h.current_price);
    const costValue = n(h.shares) * n(h.avg_cost);
    return {
      code:h.code, name:h.name, sector:h.sector, risk_status:h.risk_status,
      market_value:marketValue,
      unrealised_pl:marketValue - costValue,
      return_pct:costValue > 0 ? ((marketValue / costValue) - 1) * 100 : null,
      portfolio_risk_amount:n(h.portfolio_risk_amount)
    };
  }).sort((a,b) => b.unrealised_pl - a.unrealised_pl);

  const holdingsValue = contributors.reduce((s,r) => s + r.market_value, 0);
  const sectorMap = {};
  for (const row of contributors) sectorMap[row.sector || "Other"] = (sectorMap[row.sector || "Other"] || 0) + row.market_value;
  const sectors = Object.entries(sectorMap).map(([sector,value]) => ({
    sector, market_value:value, weight_pct:holdingsValue > 0 ? value / holdingsValue * 100 : 0
  })).sort((a,b) => b.market_value - a.market_value);

  const topPosition = contributors.length && holdingsValue > 0 ? Math.max(...contributors.map(r => r.market_value / holdingsValue * 100)) : 0;
  const top3 = contributors.slice().sort((a,b) => b.market_value - a.market_value).slice(0,3).reduce((s,r) => s + r.market_value, 0);
  const cash = latest ? n(latest.cash) : 0;
  const equity = latest ? n(latest.total_equity) : cash + holdingsValue;

  return {
    summary:{
      total_equity:equity,
      cash,
      holdings_value:latest ? n(latest.holdings_value) : holdingsValue,
      cash_pct:equity > 0 ? cash / equity * 100 : 0,
      invested_pct:equity > 0 ? holdingsValue / equity * 100 : 0,
      unrealised_pl:latest ? n(latest.unrealised_pl) : contributors.reduce((s,r) => s + r.unrealised_pl,0),
      realised_pl:latest ? n(latest.realised_pl) : realised,
      open_downside:latest ? n(latest.open_downside) : contributors.reduce((s,r) => s + r.portfolio_risk_amount,0),
      portfolio_heat_pct:latest ? n(latest.portfolio_heat_pct) : 0,
      holdings_count:holdings.length,
      snapshot_count:snapshots.length
    },
    performance:{
      closed_sells:sells.length,
      wins:wins.length,
      losses:losses.length,
      win_rate_pct:sells.length ? wins.length / sells.length * 100 : null,
      gross_profit:grossProfit,
      gross_loss:grossLoss,
      profit_factor:grossLoss > 0 ? grossProfit / grossLoss : null,
      expectancy:sells.length ? realised / sells.length : null,
      max_drawdown_pct:maxDrawdown(snapshots),
      return_1d_pct:returnFromLookback(snapshots,1),
      return_5d_pct:returnFromLookback(snapshots,5),
      return_21d_pct:returnFromLookback(snapshots,21),
      data_note:snapshots.length < 22 ? "Return and drawdown statistics remain provisional until more daily portfolio snapshots accumulate." : ""
    },
    concentration:{
      largest_position_pct:topPosition,
      top3_positions_pct:holdingsValue > 0 ? top3 / holdingsValue * 100 : 0,
      largest_sector_pct:sectors[0]?.weight_pct || 0
    },
    sectors,
    contributors,
    equity_curve:snapshots,
    sell_history:sells.slice().reverse(),
    transaction_count:transactions.length
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (env.DB && request.method === "GET" && url.pathname === "/api/analytics") {
      try {
        return json({ ok:true, version:VERSION, phase:7, data:await analytics(env) });
      } catch (error) {
        return json({ ok:false, version:VERSION, phase:7, error:error?.message || "analytics_failed" }, 500);
      }
    }

    const response = await phase6.fetch(request, env, ctx);
    if (request.method === "GET" && url.pathname === "/api/health" && response.headers.get("content-type")?.includes("application/json")) {
      try {
        const payload = await response.clone().json();
        if (payload?.ok) return json({ ...payload, version:VERSION, phase:7, portfolio_analytics:{
          enabled:true, equity_curve:true, realised_unrealised:true, returns:[1,5,21], win_rate:true,
          profit_factor:true, expectancy:true, max_drawdown:true, sector_allocation:true,
          concentration:true, portfolio_heat_history:true, contributors:true, sell_history:true
        }}, response.status);
      } catch {}
    }
    return response;
  },
  async scheduled(controller, env, ctx) {
    return phase6.scheduled(controller, env, ctx);
  }
};
