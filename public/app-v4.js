let holdings=[];
let transactions=[];
let signalEvents=[];
let watchlistItems=[];
let summaryData=null;
let dataSource="loading";
let loadError="";
let phase=4;
const state={view:"home",risk:"All",query:""};
const nav=[
  {key:"home",icon:"⌂",label:"Home"},{key:"holdings",icon:"▤",label:"Holdings"},
  {key:"market",icon:"⌁",label:"Market"},{key:"watch",icon:"☆",label:"Watch"},
  {key:"signals",icon:"⚑",label:"Signals"},{key:"journal",icon:"↺",label:"Journal"}
];
const num=v=>Number.isFinite(Number(v))?Number(v):0;
const maybe=v=>v==null||v===""?null:Number(v);
const rm=v=>`RM ${num(v).toLocaleString("en-MY",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const px=v=>v==null||!Number.isFinite(Number(v))||Number(v)<=0?"—":`RM ${Number(v).toLocaleString("en-MY",{minimumFractionDigits:Number(v)<1?3:2,maximumFractionDigits:3})}`;
const metric=(label,value,tone="")=>`<div class="metric"><span>${label}</span><strong class="${tone}">${value}</strong></div>`;
const section=(title,extra="")=>`<div class="section-title"><h2>${title}${extra}</h2></div>`;
const heading=(title,subtitle)=>`<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div></div>`;
const badge=risk=>`<span class="risk-badge risk-${String(risk||"Safe").toLowerCase()}">${risk==="Sell"?"Sell triggered":risk}</span>`;

function localSummary(){
  const cash=num(summaryData?.cash);
  const holdingsValue=holdings.reduce((s,h)=>s+h.shares*h.price,0);
  const cost=holdings.reduce((s,h)=>s+h.shares*h.cost,0);
  const openDownside=holdings.reduce((s,h)=>s+num(h.riskAmount),0);
  const total=cash+holdingsValue;
  return {cash,holdings_value:holdingsValue,total_equity:total,unrealised_pl:holdingsValue-cost,
    realised_pl:transactions.reduce((s,x)=>s+num(x.realized_pl),0),open_downside:openDownside,
    portfolio_heat_pct:total>0?openDownside/total*100:0,holdings_count:holdings.length};
}

function statusHint(h){
  if(h.reason)return h.reason;
  if(h.risk==="Sell")return "Completed close has breached the active stop.";
  if(h.risk==="Partial")return "Price has entered the partial-exit zone.";
  if(h.risk==="Watch")return "Price is in the ATR warning zone.";
  if(h.risk==="Error")return "Risk data is incomplete.";
  return "ATR risk levels are monitored against completed daily closes.";
}

function holdingCard(h){
  const value=h.shares*h.price;
  const pnl=h.shares*(h.price-h.cost);
  const ret=h.cost>0?(h.price/h.cost-1)*100:0;
  const riskPct=h.riskDistance==null?"—":`${num(h.riskDistance).toFixed(2)}%`;
  return `<article class="card">
    <div class="card-heading"><div><h3>${h.name} <small>${h.code}</small></h3><p>${h.sector} · ${h.shares.toLocaleString()} shares${h.priceDate?` · ${h.priceDate}`:""}</p></div>${badge(h.risk)}</div>
    <div class="metric-grid">
      ${metric("Current price",px(h.price))}${metric("Market value",rm(value))}
      ${metric("Unrealised P/L",`${pnl>=0?"+":"-"}${rm(Math.abs(pnl))}`,pnl>=0?"good":"bad")}
      ${metric("Return",`${ret>=0?"+":""}${ret.toFixed(2)}%`,ret>=0?"good":"bad")}
      ${metric("ATR14",px(h.atr14))}${metric("Active stop",px(h.activeStop))}
      ${metric("3 ATR trail",px(h.trailingStop))}${metric("2 ATR partial",px(h.partialStop))}
      ${metric("Watch level",px(h.watchStop))}${metric("MA10",px(h.ma10))}
      ${metric("Peak",px(h.peak))}${metric("Risk distance",riskPct,h.riskDistance!=null&&h.riskDistance<=0?"bad":"")}
    </div>
    <div class="card-footer"><p>${statusHint(h)}</p><div><button data-go="signals">Signals</button><button onclick="location.href='/risk.html'">Risk</button></div></div>
  </article>`;
}

function empty(text,sub=""){return `<div class="empty"><b>${text}</b>${sub?`<span>${sub}</span>`:""}</div>`}

function performanceBlock(summary){
  const sells=transactions.filter(r=>r.type==="SELL"&&r.realized_pl!=null);
  const wins=sells.filter(r=>num(r.realized_pl)>0);
  const grossProfit=sells.reduce((s,r)=>s+Math.max(0,num(r.realized_pl)),0);
  const grossLoss=Math.abs(sells.reduce((s,r)=>s+Math.min(0,num(r.realized_pl)),0));
  const winRate=sells.length?wins.length/sells.length*100:null;
  const pf=grossLoss>0?grossProfit/grossLoss:null;
  const expectancy=sells.length?sells.reduce((s,r)=>s+num(r.realized_pl),0)/sells.length:null;
  return `<div class="performance">${metric("Realised P/L",`${summary.realised_pl>=0?"+":"-"}${rm(Math.abs(summary.realised_pl))}`,summary.realised_pl>=0?"good":"bad")}${metric("Win rate",winRate==null?"—":`${winRate.toFixed(1)}%`)}${metric("Profit factor",pf==null?"—":pf.toFixed(2))}${metric("Expectancy",expectancy==null?"—":`${expectancy>=0?"+":"-"}${rm(Math.abs(expectancy))}`,expectancy!=null&&expectancy>=0?"good":"bad")}${metric("Open risk",rm(summary.open_downside))}${metric("Portfolio heat",`${num(summary.portfolio_heat_pct).toFixed(2)}%`)}</div>`;
}

function allocationBlock(summary){
  if(!holdings.length||summary.holdings_value<=0)return `<article class="allocation">${empty("No sector allocation yet")}</article>`;
  const totals={};holdings.forEach(h=>totals[h.sector]=(totals[h.sector]||0)+h.shares*h.price);
  return `<article class="allocation">${Object.entries(totals).sort((a,b)=>b[1]-a[1]).map(([name,value])=>{const pct=value/summary.holdings_value*100;return `<div><span>${name}</span><progress value="${pct}" max="100"></progress><b>${pct.toFixed(1)}%</b></div>`}).join("")}</article>`;
}

function home(){
  const s=summaryData||localSummary();
  const priority=holdings.filter(h=>h.risk==="Sell"||h.risk==="Partial");
  const stamp=dataSource==="d1"?"LIVE":"…";
  return `<section class="equity"><div class="equity-top"><div><span>Total equity</span><strong>${rm(s.total_equity)}</strong><em class="${s.unrealised_pl>=0?"good":"bad"}">Unrealised ${s.unrealised_pl>=0?"+":"-"}${rm(Math.abs(s.unrealised_pl))}</em></div><div class="stamp"><span>BURSA</span><b>${stamp}</b></div></div><div class="equity-metrics">${metric("Cash",rm(s.cash))}${metric("Holdings",rm(s.holdings_value))}${metric("Open risk",rm(s.open_downside))}${metric("Portfolio heat",`${num(s.portfolio_heat_pct).toFixed(2)}%`)}</div></section>
  ${holdings.length?"":empty("Portfolio database is ready","Add holdings from Manage to begin monitoring.")}
  ${section("Risk overview")}<div class="risk-grid">${["Safe","Watch","Partial","Sell"].map(r=>`<button data-risk-go="${r}"><b class="risk-text-${r.toLowerCase()}">${holdings.filter(h=>h.risk===r).length}</b><span>${r}</span></button>`).join("")}</div>
  ${section("Priority actions",`<i>${priority.length}</i>`)}<div class="stack">${priority.length?priority.map(holdingCard).join(""):empty("No priority actions","Partial and sell alerts will appear here.")}</div>
  ${section("Performance")}${performanceBlock(s)}${section("Sector allocation")}${allocationBlock(s)}`;
}

function portfolio(){
  const filtered=holdings.filter(h=>(state.risk==="All"||h.risk===state.risk)&&`${h.code} ${h.name} ${h.sector}`.toLowerCase().includes(state.query.toLowerCase()));
  return `${heading("Portfolio",`${holdings.length} holdings · ${rm((summaryData||localSummary()).holdings_value)}`)}<label class="search">⌕<input id="portfolio-search" value="${state.query}" placeholder="Search ticker, company or sector"></label><div class="filters">${["All","Safe","Watch","Partial","Sell"].map(r=>`<button data-risk="${r}" class="${state.risk===r?"active":""}">${r}</button>`).join("")}</div><div class="stack">${filtered.length?filtered.map(holdingCard).join(""):empty("No holdings match this filter")}</div>`;
}

function market(){
  const last=holdings.reduce((d,h)=>!h.priceDate?d:(!d||h.priceDate>d?h.priceDate:d),"");
  return `${heading("Bursa Market","Completed-close data powering ATR Portfolio")}${section("Phase 3 data status")}<div class="performance">${metric("Latest session",last||"—")}${metric("Holdings priced",`${holdings.filter(h=>h.price>0).length}/${holdings.length}`)}${metric("ATR14 ready",`${holdings.filter(h=>h.atr14>0).length}/${holdings.length}`)}${metric("MA10 ready",`${holdings.filter(h=>h.ma10>0).length}/${holdings.length}`)}${metric("MA50 ready",`${holdings.filter(h=>h.ma50>0).length}/${holdings.length}`)}${metric("MA200 ready",`${holdings.filter(h=>h.ma200>0).length}/${holdings.length}`)}</div>${section("Current holdings")}<div class="stack">${holdings.length?holdings.map(h=>`<article class="card"><div class="card-heading"><div><h3>${h.name} <small>${h.code}</small></h3><p>${h.priceDate||"No completed-close date"}</p></div>${badge(h.risk)}</div><div class="metric-grid">${metric("Close",px(h.price))}${metric("ATR14",px(h.atr14))}${metric("MA10",px(h.ma10))}${metric("MA20",px(h.ma20))}${metric("MA50",px(h.ma50))}${metric("MA200",px(h.ma200))}</div></article>`).join(""):empty("No holdings")}</div>`;
}

function watch(){
  if(!watchlistItems.length)return `${heading("Watchlist","Targets, support and review notes")}${empty("☆ Your D1 watchlist is empty")}`;
  return `${heading("Watchlist",`${watchlistItems.length} counters`)}<div class="stack">${watchlistItems.map(r=>`<article class="card"><div class="card-heading"><div><h3>${r.name} <small>${r.code}</small></h3><p>${r.notes||"Monitoring"}</p></div></div><div class="metric-grid">${metric("Target",px(r.target_price))}${metric("Support",px(r.support_price))}</div></article>`).join("")}</div>`;
}

function signals(){
  const current=holdings.filter(h=>h.risk!=="Safe");
  return `${heading("Signals","ATR risk-state changes and current action levels")}${section("Current risk states",`<i>${current.length}</i>`)}<div class="stack">${current.length?current.map(holdingCard).join(""):empty("All tracked holdings are Safe")}</div>${section("Signal history")}<div class="stack">${signalEvents.length?signalEvents.map(r=>`<article class="card signal"><div class="card-heading"><div><h3>${r.code}</h3><p>${new Date(r.created_at).toLocaleString("en-MY")}</p></div>${badge(r.severity)}</div><p>${r.message}</p><div class="signal-stats">${metric("Observed",px(r.observed_price))}${metric("Trigger",px(r.trigger_price))}${metric("Type",r.signal_type)}</div></article>`).join(""):empty("No signal-state changes recorded yet")}</div>`;
}

function journal(){
  return `${heading("Trade journal","Transactions remain the source of truth")}<div class="stack">${transactions.length?transactions.map(e=>`<article class="journal"><span class="type ${String(e.type).toLowerCase()}">${e.type}</span><h3>${e.name||e.code||e.type}</h3><p>${e.trade_date}</p><div>${metric("Shares",e.shares?num(e.shares).toLocaleString():"—")}${metric("Price",e.price?px(e.price):"—")}${metric("Value",rm(num(e.amount)||num(e.shares)*num(e.price)))}</div></article>`).join(""):empty("No transactions yet")}</div>${section("Settings & data")}<article class="settings"><button>Cloudflare D1<span>Connected</span></button><button>Market data<span>Phase 3</span></button><button onclick="location.href='/risk.html'">ATR risk engine<span>Phase 4 ›</span></button></article>`;
}

const views={home,holdings:portfolio,market,watch,signals,journal};
function render(){
  const msg=dataSource==="d1"?"Portfolio, market data and ATR risk states are loaded from Cloudflare D1.":dataSource==="error"?`D1 error: ${loadError}`:"Connecting to Cloudflare D1…";
  document.getElementById("app").innerHTML=views[state.view]()+`<p class="disclaimer">${msg} Signals are rule-based portfolio risk controls, not investment advice. Verify market-sensitive decisions against Bursa or your broker.</p>`;
  document.getElementById("nav").innerHTML=nav.map(n=>`<button data-view="${n.key}" class="${state.view===n.key?"active":""}"><b>${n.icon}</b><span>${n.label}</span></button>`).join("");
  bind();
}
function bind(){
  document.querySelectorAll("[data-view]").forEach(b=>b.onclick=()=>{state.view=b.dataset.view;render();scrollTo(0,0)});
  document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>{state.view=b.dataset.go;render()});
  document.querySelectorAll("[data-risk]").forEach(b=>b.onclick=()=>{state.risk=b.dataset.risk;render()});
  document.querySelectorAll("[data-risk-go]").forEach(b=>b.onclick=()=>{state.risk=b.dataset.riskGo;state.view="holdings";render();scrollTo(0,0)});
  const q=document.getElementById("portfolio-search");if(q)q.oninput=e=>{state.query=e.target.value;render();document.getElementById("portfolio-search")?.focus()};
}

async function loadState(){
  const button=document.getElementById("refresh");button.classList.add("spin");
  try{
    const response=await fetch("/api/state",{headers:{accept:"application/json"},cache:"no-store"});
    const payload=await response.json();if(!response.ok||!payload.ok)throw new Error(payload.error||"state_unavailable");
    phase=num(payload.phase)||4;const d=payload.data||{};
    holdings=(d.holdings||[]).map(r=>({
      code:r.code,name:r.name,sector:r.sector,shares:num(r.shares),cost:num(r.avg_cost),price:num(r.current_price),
      atr14:num(r.atr14),ma10:num(r.ma10),ma20:num(r.ma20),ma50:num(r.ma50),ma200:num(r.ma200),
      manualStop:maybe(r.manual_hard_stop),autoStop:maybe(r.auto_hard_stop),trailingStop:maybe(r.trailing_stop),
      partialStop:maybe(r.partial_stop),watchStop:maybe(r.watch_stop),activeStop:maybe(r.active_stop??r.hard_stop),
      peak:maybe(r.peak_price),peakDate:r.peak_date||null,priceDate:r.latest_price_date||null,
      riskDistance:maybe(r.risk_distance_pct),riskAmount:num(r.portfolio_risk_amount),risk:r.risk_status||"Safe",reason:r.risk_reason||""
    }));
    summaryData=d.summary||localSummary();transactions=d.transactions||[];signalEvents=d.signals||[];watchlistItems=d.watchlist||[];
    dataSource="d1";loadError="";
    document.getElementById("connection-status").textContent=`D1 live · Phase ${phase}`;
    document.getElementById("updated").textContent=new Date().toLocaleTimeString("en-MY",{hour:"2-digit",minute:"2-digit"});
  }catch(error){dataSource="error";loadError=error.message||"state_unavailable";document.getElementById("connection-status").textContent="D1 error";document.getElementById("updated").textContent="Not loaded"}
  finally{button.classList.remove("spin");render()}
}

document.getElementById("theme").onclick=()=>{const dark=document.documentElement.dataset.theme==="dark";document.documentElement.dataset.theme=dark?"light":"dark";document.getElementById("theme").textContent=dark?"☾":"☀";localStorage.setItem("atr-theme",dark?"light":"dark")};
document.getElementById("refresh").onclick=loadState;
const saved=localStorage.getItem("atr-theme");if(saved)document.documentElement.dataset.theme=saved;if(saved==="light")document.getElementById("theme").textContent="☾";
if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js");
render();loadState();
