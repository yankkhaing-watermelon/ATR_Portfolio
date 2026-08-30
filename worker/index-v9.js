import phase8, { decisionEngine } from "./index-v8.js";

const VERSION = "9.0.0";
const json = (data, status = 200) => new Response(JSON.stringify(data), {status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const n = (v, fallback=0) => Number.isFinite(Number(v)) ? Number(v) : fallback;

async function ensureDailySchema(db){
  await db.prepare(`CREATE TABLE IF NOT EXISTS daily_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_date TEXT NOT NULL UNIQUE,
    generated_at TEXT NOT NULL,
    portfolio_state TEXT NOT NULL,
    counts_json TEXT NOT NULL,
    message TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
}

async function tokenMatches(request, env){
  if(!env.ADMIN_TOKEN) return false;
  const header=request.headers.get("authorization")||"";
  const supplied=header.startsWith("Bearer ")?header.slice(7):"";
  if(!supplied) return false;
  const enc=v=>new TextEncoder().encode(v);
  const [a,b]=await Promise.all([crypto.subtle.digest("SHA-256",enc(supplied)),crypto.subtle.digest("SHA-256",enc(env.ADMIN_TOKEN))]);
  const x=new Uint8Array(a),y=new Uint8Array(b);let diff=x.length^y.length;for(let i=0;i<Math.min(x.length,y.length);i++)diff|=x[i]^y[i];return diff===0;
}
async function requireAdmin(request,env){if(!env.ADMIN_TOKEN)return json({ok:false,error:"admin_mutations_disabled"},503);if(!(await tokenMatches(request,env)))return json({ok:false,error:"unauthorized"},401);return null;}

function dailyMessage(d){
  const c=d.counts;
  const urgent=c.EXIT+c.REDUCE;
  if(urgent) return `${d.portfolio_state}: ${urgent} urgent holding(s) require review; ${c.TRIM} trim and ${c.WATCH} watch.`;
  if(c.TRIM||c.WATCH) return `${d.portfolio_state}: no exit/reduce trigger; ${c.TRIM} trim and ${c.WATCH} watch holding(s) need attention.`;
  return `${d.portfolio_state}: all current holdings remain in HOLD with no configured escalation trigger.`;
}

async function generateDaily(env){
  await ensureDailySchema(env.DB);
  const d=await decisionEngine(env);const now=new Date().toISOString();const date=now.slice(0,10);const message=dailyMessage(d);
  await env.DB.prepare(`INSERT INTO daily_reviews(review_date,generated_at,portfolio_state,counts_json,message,payload_json)
    VALUES(?,?,?,?,?,?) ON CONFLICT(review_date) DO UPDATE SET generated_at=excluded.generated_at,portfolio_state=excluded.portfolio_state,counts_json=excluded.counts_json,message=excluded.message,payload_json=excluded.payload_json`)
    .bind(date,now,d.portfolio_state,JSON.stringify(d.counts),message,JSON.stringify(d)).run();
  return {review_date:date,generated_at:now,portfolio_state:d.portfolio_state,counts:d.counts,message,decisions:d.decisions};
}

async function dailyRead(env){
  await ensureDailySchema(env.DB);
  let latest=await env.DB.prepare("SELECT review_date,generated_at,portfolio_state,counts_json,message,payload_json FROM daily_reviews ORDER BY review_date DESC LIMIT 1").first();
  if(!latest) { await generateDaily(env); latest=await env.DB.prepare("SELECT review_date,generated_at,portfolio_state,counts_json,message,payload_json FROM daily_reviews ORDER BY review_date DESC LIMIT 1").first(); }
  const history=await env.DB.prepare("SELECT review_date,generated_at,portfolio_state,counts_json,message FROM daily_reviews ORDER BY review_date DESC LIMIT 30").all();
  const parse=r=>r?{...r,counts:JSON.parse(r.counts_json||"{}"),payload:r.payload_json?JSON.parse(r.payload_json):undefined,counts_json:undefined,payload_json:undefined}:null;
  return {latest:parse(latest),history:(history.results||[]).map(r=>{const x=parse(r);delete x.payload;return x;})};
}

async function notificationCenter(env){
  const d=await decisionEngine(env);
  const unread=await env.DB.prepare(`SELECT id,code,signal_type,severity,message,observed_price,trigger_price,created_at FROM signal_events WHERE COALESCE(acknowledged,0)=0 ORDER BY created_at DESC LIMIT 50`).all();
  const decisionAlerts=d.decisions.filter(x=>x.action!=="HOLD").map(x=>({kind:"DECISION",code:x.code,severity:x.action,message:`${x.action} · ${x.reasons[0]||"Review holding."}`,score:x.priority_score}));
  const signalAlerts=(unread.results||[]).map(x=>({kind:"SIGNAL",...x}));
  return {generated_at:new Date().toISOString(),portfolio_state:d.portfolio_state,unread_signal_count:signalAlerts.length,decision_alert_count:decisionAlerts.length,alerts:[...decisionAlerts,...signalAlerts]};
}

export { generateDaily };

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(env.DB && request.method==="GET" && url.pathname==="/api/daily-review"){
      try{return json({ok:true,version:VERSION,phase:9,data:await dailyRead(env)});}catch(e){return json({ok:false,version:VERSION,phase:9,error:e?.message||"daily_review_failed"},500);}
    }
    if(env.DB && request.method==="POST" && url.pathname==="/api/daily-review/run"){
      const denied=await requireAdmin(request,env);if(denied)return denied;
      try{return json({ok:true,version:VERSION,phase:9,data:await generateDaily(env)});}catch(e){return json({ok:false,error:e?.message||"daily_review_failed"},500);}
    }
    if(env.DB && request.method==="GET" && url.pathname==="/api/notifications"){
      try{return json({ok:true,version:VERSION,phase:9,data:await notificationCenter(env)});}catch(e){return json({ok:false,error:e?.message||"notification_center_failed"},500);}
    }
    const response=await phase8.fetch(request,env,ctx);
    if(request.method==="GET"&&url.pathname==="/api/health"&&response.headers.get("content-type")?.includes("application/json")){
      try{const p=await response.clone().json();if(p?.ok)return json({...p,version:VERSION,phase:9,daily_review:{enabled:true,stored:true,scheduled_after_market_sync:true},notifications:{enabled:true,mode:"in_app_and_browser_when_open",background_push:false}},response.status);}catch{}
    }
    return response;
  },
  async scheduled(controller,env,ctx){
    await phase8.scheduled(controller,env,ctx);
    if(env.DB) await generateDaily(env);
  }
};
