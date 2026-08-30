import phase7 from "./index-v7.js";

const VERSION = "8.0.0";
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const n = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;

function decisionFor(h, holdingsValue) {
  const price = n(h.current_price), cost = n(h.avg_cost), peak = n(h.peak_price);
  const risk = String(h.risk_status || "Safe");
  const weight = holdingsValue > 0 ? n(h.shares) * price / holdingsValue * 100 : 0;
  const drawdown = peak > 0 && price > 0 ? (price / peak - 1) * 100 : 0;
  const ret = cost > 0 && price > 0 ? (price / cost - 1) * 100 : 0;
  const distance = h.risk_distance_pct == null ? null : n(h.risk_distance_pct);
  let score = ({Sell:100,Partial:78,Watch:48,Error:65,Safe:10})[risk] ?? 20;
  const reasons = [];

  if (risk === "Sell") reasons.push("ATR active stop is breached.");
  else if (risk === "Partial") reasons.push("Price is inside the ATR partial-reduction zone.");
  else if (risk === "Watch") reasons.push("ATR/MA warning state is active.");
  else if (risk === "Error") reasons.push("Risk data is incomplete and needs review.");

  if (price > 0 && n(h.ma20) > 0 && price < n(h.ma20)) { score += 8; reasons.push("Price is below MA20."); }
  if (price > 0 && n(h.ma50) > 0 && price < n(h.ma50)) { score += 10; reasons.push("Price is below MA50."); }
  if (price > 0 && n(h.ma200) > 0 && price < n(h.ma200)) { score += 14; reasons.push("Price is below MA200."); }
  if (drawdown <= -15) { score += 12; reasons.push(`Drawdown from tracked peak is ${drawdown.toFixed(1)}%.`); }
  else if (drawdown <= -8) { score += 6; reasons.push(`Drawdown from tracked peak is ${drawdown.toFixed(1)}%.`); }
  if (distance != null && distance <= 3) { score += 12; reasons.push(`Only ${distance.toFixed(1)}% above the active stop.`); }
  else if (distance != null && distance <= 6) { score += 5; reasons.push(`Risk distance is ${distance.toFixed(1)}%.`); }
  if (weight >= 30) { score += 12; reasons.push(`Position is ${weight.toFixed(1)}% of invested capital.`); }
  else if (weight >= 20) { score += 6; reasons.push(`Position concentration is ${weight.toFixed(1)}%.`); }
  if (ret <= -12) { score += 5; reasons.push(`Unrealised return is ${ret.toFixed(1)}%.`); }

  score = Math.min(100, Math.round(score));
  let action = score >= 88 ? "EXIT" : score >= 68 ? "REDUCE" : score >= 50 ? "TRIM" : score >= 28 ? "WATCH" : "HOLD";
  if (risk === "Sell") action = "EXIT";
  if (risk === "Partial" && !["EXIT","REDUCE"].includes(action)) action = "REDUCE";
  if (risk === "Watch" && action === "HOLD") action = "WATCH";
  if (!reasons.length) reasons.push("Risk state and trend structure remain within configured limits.");
  return {
    code:h.code,name:h.name,sector:h.sector,action,priority_score:score,risk_status:risk,
    price,weight_pct:weight,return_pct:ret,drawdown_from_peak_pct:drawdown,
    risk_distance_pct:distance,active_stop:n(h.active_stop)||null,ma10:n(h.ma10)||null,ma20:n(h.ma20)||null,
    ma50:n(h.ma50)||null,ma200:n(h.ma200)||null,reasons
  };
}

async function decisionEngine(env) {
  const rows = await env.DB.prepare(`SELECT code,name,sector,shares,avg_cost,current_price,peak_price,risk_status,risk_distance_pct,
    active_stop,ma10,ma20,ma50,ma200,portfolio_risk_amount FROM holdings WHERE shares>0 ORDER BY code`).all();
  const holdings = rows.results || [];
  const holdingsValue = holdings.reduce((s,h)=>s+n(h.shares)*n(h.current_price),0);
  const decisions = holdings.map(h=>decisionFor(h,holdingsValue)).sort((a,b)=>b.priority_score-a.priority_score || a.code.localeCompare(b.code));
  const counts = {HOLD:0,WATCH:0,TRIM:0,REDUCE:0,EXIT:0};
  decisions.forEach(d=>counts[d.action]++);
  const heat = await env.DB.prepare("SELECT portfolio_heat_pct,total_equity FROM portfolio_snapshots ORDER BY snapshot_date DESC LIMIT 1").first();
  const sectorMap = {};
  holdings.forEach(h=>{const v=n(h.shares)*n(h.current_price);sectorMap[h.sector||"Other"]=(sectorMap[h.sector||"Other"]||0)+v;});
  const largestSector = holdingsValue>0 ? Math.max(0,...Object.values(sectorMap).map(v=>v/holdingsValue*100)) : 0;
  const largestPosition = holdingsValue>0 ? Math.max(0,...holdings.map(h=>n(h.shares)*n(h.current_price)/holdingsValue*100)) : 0;
  const portfolioHeat = n(heat?.portfolio_heat_pct);
  let portfolioState = "Normal";
  const portfolioReasons=[];
  if (counts.EXIT>0 || portfolioHeat>=12) { portfolioState="Critical"; }
  else if (counts.REDUCE>0 || portfolioHeat>=8 || largestPosition>=35) { portfolioState="Defensive"; }
  else if (counts.TRIM>0 || counts.WATCH>0 || portfolioHeat>=5 || largestSector>=50) { portfolioState="Elevated"; }
  if (counts.EXIT) portfolioReasons.push(`${counts.EXIT} holding(s) are in EXIT state.`);
  if (counts.REDUCE) portfolioReasons.push(`${counts.REDUCE} holding(s) are in REDUCE state.`);
  if (portfolioHeat>=5) portfolioReasons.push(`Portfolio heat is ${portfolioHeat.toFixed(1)}%.`);
  if (largestPosition>=25) portfolioReasons.push(`Largest position is ${largestPosition.toFixed(1)}% of invested capital.`);
  if (largestSector>=40) portfolioReasons.push(`Largest sector is ${largestSector.toFixed(1)}% of invested capital.`);
  if (!portfolioReasons.length) portfolioReasons.push("No portfolio-level escalation threshold is currently triggered.");
  return {generated_at:new Date().toISOString(),portfolio_state:portfolioState,portfolio_reasons:portfolioReasons,counts,portfolio_heat_pct:portfolioHeat,largest_position_pct:largestPosition,largest_sector_pct:largestSector,decisions};
}

export { decisionEngine };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (env.DB && request.method === "GET" && url.pathname === "/api/decisions") {
      try { return json({ok:true,version:VERSION,phase:8,data:await decisionEngine(env)}); }
      catch(error){ return json({ok:false,version:VERSION,phase:8,error:error?.message||"decision_engine_failed"},500); }
    }
    const response = await phase7.fetch(request, env, ctx);
    if (request.method === "GET" && url.pathname === "/api/health" && response.headers.get("content-type")?.includes("application/json")) {
      try { const p=await response.clone().json(); if(p?.ok) return json({...p,version:VERSION,phase:8,decision_engine:{enabled:true,actions:["HOLD","WATCH","TRIM","REDUCE","EXIT"],portfolio_states:["Normal","Elevated","Defensive","Critical"],priority_queue:true}},response.status); } catch {}
    }
    return response;
  },
  async scheduled(controller, env, ctx) { return phase7.scheduled(controller, env, ctx); }
};
