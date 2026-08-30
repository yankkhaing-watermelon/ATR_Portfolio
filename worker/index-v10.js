import phase9 from "./index-v9.js";
import { decisionEngine } from "./index-v8.js";

const VERSION="10.0.0";
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const n=(v,f=0)=>Number.isFinite(Number(v))?Number(v):f;
const clean=(v,max=1000)=>String(v??"").trim().slice(0,max);

async function ensureReviewSchema(db){
  await db.prepare(`CREATE TABLE IF NOT EXISTS review_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_key TEXT NOT NULL UNIQUE,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    portfolio_state TEXT NOT NULL,
    headline TEXT NOT NULL,
    report_json TEXT NOT NULL,
    user_note TEXT NOT NULL DEFAULT '',
    reviewed INTEGER NOT NULL DEFAULT 0,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
}

async function tokenMatches(request,env){
  if(!env.ADMIN_TOKEN)return false;const h=request.headers.get("authorization")||"";const s=h.startsWith("Bearer ")?h.slice(7):"";if(!s)return false;
  const enc=v=>new TextEncoder().encode(v);const[a,b]=await Promise.all([crypto.subtle.digest("SHA-256",enc(s)),crypto.subtle.digest("SHA-256",enc(env.ADMIN_TOKEN))]);
  const x=new Uint8Array(a),y=new Uint8Array(b);let d=x.length^y.length;for(let i=0;i<Math.min(x.length,y.length);i++)d|=x[i]^y[i];return d===0;
}
async function requireAdmin(req,env){if(!env.ADMIN_TOKEN)return json({ok:false,error:"admin_mutations_disabled"},503);if(!(await tokenMatches(req,env)))return json({ok:false,error:"unauthorized"},401);return null;}

function weekWindow(date=new Date()){
  const d=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()));const day=(d.getUTCDay()+6)%7;
  const start=new Date(d);start.setUTCDate(d.getUTCDate()-day);const end=new Date(start);end.setUTCDate(start.getUTCDate()+6);
  const iso=x=>x.toISOString().slice(0,10);return {start:iso(start),end:iso(end),key:`W:${iso(start)}`};
}

async function generateReview(env,note=""){
  await ensureReviewSchema(env.DB);const w=weekWindow();const decisions=await decisionEngine(env);
  const [snaps,tx,signals]=await Promise.all([
    env.DB.prepare(`SELECT snapshot_date,total_equity,unrealised_pl,realised_pl,portfolio_heat_pct FROM portfolio_snapshots WHERE snapshot_date BETWEEN ? AND ? ORDER BY snapshot_date`).bind(w.start,w.end).all(),
    env.DB.prepare(`SELECT type,code,name,trade_date,shares,price,fees,realized_pl FROM transactions WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date,id`).bind(w.start,w.end).all(),
    env.DB.prepare(`SELECT code,signal_type,severity,message,created_at FROM signal_events WHERE substr(created_at,1,10) BETWEEN ? AND ? ORDER BY created_at`).bind(w.start,w.end).all()
  ]);
  const s=snaps.results||[],t=tx.results||[],g=signals.results||[];const first=s[0],last=s[s.length-1];
  const returnPct=first&&last&&n(first.total_equity)>0?(n(last.total_equity)/n(first.total_equity)-1)*100:null;
  const sells=t.filter(x=>x.type==="SELL"&&x.realized_pl!=null);const realised=sells.reduce((a,x)=>a+n(x.realized_pl),0);
  const report={period_start:w.start,period_end:w.end,portfolio_state:decisions.portfolio_state,counts:decisions.counts,
    weekly_return_pct:returnPct,realised_from_sells:realised,transaction_count:t.length,signal_count:g.length,
    ending_equity:last?n(last.total_equity):null,ending_heat_pct:last?n(last.portfolio_heat_pct):null,
    priority:decisions.decisions.slice(0,10),transactions:t,signals:g,
    observations:[
      `${decisions.counts.EXIT+decisions.counts.REDUCE} urgent decision(s) at report generation.`,
      `${decisions.counts.TRIM+decisions.counts.WATCH} non-urgent holding(s) require monitoring.`,
      returnPct==null?"Weekly return is not yet available because the snapshot series is too short.":`Weekly equity change is ${returnPct.toFixed(2)}%.`
    ]};
  const headline=`${decisions.portfolio_state} · ${decisions.counts.EXIT} EXIT · ${decisions.counts.REDUCE} REDUCE · ${decisions.counts.TRIM} TRIM · ${decisions.counts.WATCH} WATCH`;
  const now=new Date().toISOString();
  await env.DB.prepare(`INSERT INTO review_reports(period_key,period_start,period_end,generated_at,portfolio_state,headline,report_json,user_note)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(period_key) DO UPDATE SET generated_at=excluded.generated_at,portfolio_state=excluded.portfolio_state,headline=excluded.headline,report_json=excluded.report_json,user_note=CASE WHEN excluded.user_note<>'' THEN excluded.user_note ELSE review_reports.user_note END`)
    .bind(w.key,w.start,w.end,now,decisions.portfolio_state,headline,JSON.stringify(report),clean(note,2000)).run();
  return {period_key:w.key,generated_at:now,headline,report};
}

async function readReports(env){
  await ensureReviewSchema(env.DB);const rows=await env.DB.prepare(`SELECT id,period_key,period_start,period_end,generated_at,portfolio_state,headline,report_json,user_note,reviewed,reviewed_at FROM review_reports ORDER BY period_start DESC LIMIT 52`).all();
  return (rows.results||[]).map(r=>({...r,report:JSON.parse(r.report_json||"{}"),report_json:undefined}));
}

async function markReviewed(request,env,id){
  const denied=await requireAdmin(request,env);if(denied)return denied;const body=await request.json().catch(()=>({}));
  const res=await env.DB.prepare(`UPDATE review_reports SET reviewed=1,reviewed_at=CURRENT_TIMESTAMP,user_note=? WHERE id=?`).bind(clean(body.note,2000),id).run();
  if(!res.meta?.changes)return json({ok:false,error:"report_not_found"},404);return json({ok:true,id,reviewed:true});
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(env.DB&&request.method==="GET"&&url.pathname==="/api/reviews"){
      try{return json({ok:true,version:VERSION,phase:10,data:await readReports(env)});}catch(e){return json({ok:false,error:e?.message||"review_read_failed"},500);}
    }
    if(env.DB&&request.method==="POST"&&url.pathname==="/api/reviews/generate"){
      const denied=await requireAdmin(request,env);if(denied)return denied;const body=await request.json().catch(()=>({}));
      try{return json({ok:true,version:VERSION,phase:10,data:await generateReview(env,body.note||"")});}catch(e){return json({ok:false,error:e?.message||"review_generate_failed"},500);}
    }
    const m=url.pathname.match(/^\/api\/reviews\/(\d+)\/review$/);
    if(env.DB&&request.method==="POST"&&m)return markReviewed(request,env,Number(m[1]));
    const response=await phase9.fetch(request,env,ctx);
    if(request.method==="GET"&&url.pathname==="/api/health"&&response.headers.get("content-type")?.includes("application/json")){
      try{const p=await response.clone().json();if(p?.ok)return json({...p,version:VERSION,phase:10,review_reports:{enabled:true,weekly:true,stored:true,journal_notes:true,manual_review:true}},response.status);}catch{}
    }
    return response;
  },
  async scheduled(controller,env,ctx){await phase9.scheduled(controller,env,ctx);if(env.DB)await generateReview(env);}
};
