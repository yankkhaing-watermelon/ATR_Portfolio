let holdings = [];
let cashBalance = 0;
let transactions = [];
let watchlistItems = [];
let signalEvents = [];
let summaryData = null;
let mutationEnabled = false;
let dataSource = "loading";
let loadError = "";

const nav = [
  {key:"home",icon:"⌂",label:"Home"},
  {key:"holdings",icon:"▤",label:"Holdings"},
  {key:"market",icon:"⌁",label:"Market"},
  {key:"watch",icon:"☆",label:"Watch"},
  {key:"signals",icon:"⚑",label:"Signals"},
  {key:"journal",icon:"↺",label:"Journal"}
];
const state = {view:"home",risk:"All",query:""};

const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const rm = value => `RM ${num(value).toLocaleString("en-MY",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const metric = (label,value,tone="") => `<div class="metric"><span>${label}</span><strong class="${tone}">${value}</strong></div>`;
const heading = (title,subtitle,action="") => `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action?`<button>＋ ${action}</button>`:""}</div>`;
const section = (title,extra="") => `<div class="section-title"><h2>${title}${extra}</h2></div>`;
const badge = risk => `<span class="risk-badge risk-${String(risk||"Safe").toLowerCase()}">${risk === "Sell" ? "Sell triggered" : risk}</span>`;
const dash = value => value == null || Number.isNaN(Number(value)) ? "—" : rm(value);

function localSummary(){
  const holdingsValue = holdings.reduce((s,h)=>s+h.shares*h.price,0);
  const costValue = holdings.reduce((s,h)=>s+h.shares*h.cost,0);
  const unrealisedPl = holdingsValue-costValue;
  const realisedPl = transactions.reduce((s,row)=>s+num(row.realized_pl),0);
  const openDownside = holdings.reduce((s,h)=>h.stop>0&&h.price>h.stop?s+(h.price-h.stop)*h.shares:s,0);
  const totalEquity = cashBalance+holdingsValue;
  return {
    cash:cashBalance,
    holdings_value:holdingsValue,
    total_equity:totalEquity,
    unrealised_pl:unrealisedPl,
    realised_pl:realisedPl,
    open_downside:openDownside,
    portfolio_heat_pct:totalEquity>0?openDownside/totalEquity*100:0,
    holdings_count:holdings.length
  };
}

function holdingCard(h){
  const value=h.shares*h.price;
  const pnl=h.shares*(h.price-h.cost);
  const pct=h.cost>0?(h.price/h.cost-1)*100:0;
  const riskDistance=h.stop>0?`${((h.price/h.stop-1)*100).toFixed(2)}%`:"—";
  return `<article class="card"><div class="card-heading"><div><h3>${h.name} <small>${h.code}</small></h3><p>${h.sector} · ${h.shares.toLocaleString()} shares</p></div>${badge(h.risk)}</div><div class="metric-grid">${metric("Current price",rm(h.price))}${metric("Market value",rm(value))}${metric("Unrealised P/L",`${pnl>=0?"+":"-"}${rm(Math.abs(pnl))}`,pnl>=0?"good":"bad")}${metric("Return",`${pct>=0?"+":""}${pct.toFixed(2)}%`,pct>=0?"good":"bad")}${metric("Average cost",rm(h.cost))}${metric("Hard stop",h.stop>0?rm(h.stop):"—")}${metric("MA10",h.ma10>0?rm(h.ma10):"—")}${metric("Risk distance",riskDistance)}</div><div class="card-footer"><p>${h.risk==="Sell"&&h.stop>0?`Price ${h.price.toFixed(3)} is at or below the hard stop ${h.stop.toFixed(3)}.`:"Rules are monitored against the latest completed close."}</p><div><button>Chart</button><button>Rules</button><button>Review</button></div></div></article>`;
}

function emptyPortfolio(){
  if(dataSource==="error") return `<div class="empty"><b>Cloudflare D1 could not be loaded</b><span>${loadError||"Check /api/health and the D1 binding."}</span></div>`;
  return `<div class="empty"><b>Portfolio database is ready</b><span>No holdings have been added yet. Phase 2 is now using Cloudflare D1 rather than demo records.</span></div>`;
}

function performanceBlock(summary){
  const sells=transactions.filter(row=>row.type==="SELL"&&row.realized_pl!=null);
  const wins=sells.filter(row=>num(row.realized_pl)>0);
  const winRate=sells.length?wins.length/sells.length*100:null;
  const grossProfit=sells.reduce((s,row)=>s+Math.max(0,num(row.realized_pl)),0);
  const grossLoss=Math.abs(sells.reduce((s,row)=>s+Math.min(0,num(row.realized_pl)),0));
  const factor=grossLoss>0?grossProfit/grossLoss:null;
  const expectancy=sells.length?sells.reduce((s,row)=>s+num(row.realized_pl),0)/sells.length:null;
  return `<div class="performance">${metric("Realised P/L",`${summary.realised_pl>=0?"+":"-"}${rm(Math.abs(summary.realised_pl))}`,summary.realised_pl>=0?"good":"bad")}${metric("Win rate",winRate==null?"—":`${winRate.toFixed(1)}%`)}${metric("Profit factor",factor==null?"—":factor.toFixed(2))}${metric("Expectancy",expectancy==null?"—":`${expectancy>=0?"+":"-"}${rm(Math.abs(expectancy))}`,expectancy==null?"":expectancy>=0?"good":"bad")}${metric("Money-weighted","—")}${metric("Max drawdown","—")}</div>`;
}

function allocationBlock(summary){
  if(!holdings.length||summary.holdings_value<=0) return `<article class="allocation"><div class="empty"><b>No sector allocation yet</b><span>Sector weights will appear after holdings are added.</span></div></article>`;
  const totals={};
  holdings.forEach(h=>{totals[h.sector]=(totals[h.sector]||0)+h.shares*h.price});
  const rows=Object.entries(totals).sort((a,b)=>b[1]-a[1]);
  return `<article class="allocation">${rows.map(([name,value])=>{const pct=value/summary.holdings_value*100;return `<div><span>${name}</span><progress value="${pct}" max="100"></progress><b>${pct.toFixed(1)}%</b></div>`}).join("")}</article>`;
}

function home(){
  const summary=summaryData||localSummary();
  const pnl=summary.unrealised_pl;
  const priority=holdings.filter(h=>["Sell","Partial"].includes(h.risk));
  const stamp=dataSource==="d1"?"LIVE":dataSource==="error"?"ERROR":"…";
  return `<section class="equity"><div class="equity-top"><div><span>Total equity</span><strong>${rm(summary.total_equity)}</strong><em class="${pnl>=0?"good":"bad"}">Unrealised ${pnl>=0?"+":"-"}${rm(Math.abs(pnl))}</em></div><div class="stamp"><span>BURSA</span><b>${stamp}</b></div></div><div class="equity-metrics">${metric("Cash",rm(summary.cash))}${metric("Holdings",rm(summary.holdings_value))}${metric("Open downside",rm(summary.open_downside))}${metric("Portfolio heat",`${num(summary.portfolio_heat_pct).toFixed(2)}%`)}</div></section>${holdings.length?"":emptyPortfolio()}${section("Risk overview")}<div class="risk-grid">${["Safe","Watch","Partial","Sell"].map(r=>`<button data-go="holdings"><b class="risk-text-${r.toLowerCase()}">${holdings.filter(h=>h.risk===r).length}</b><span>${r}</span></button>`).join("")}</div>${section("Priority actions",`<i>${priority.length}</i>`)}<div class="stack">${priority.length?priority.map(holdingCard).join(""):'<div class="empty"><b>No priority actions</b><span>Sell and partial-exit alerts will appear here.</span></div>'}</div>${section("Performance")}${performanceBlock(summary)}${section("Sector allocation")}${allocationBlock(summary)}`;
}

function portfolio(){
  const filtered=holdings.filter(h=>(state.risk==="All"||h.risk===state.risk)&&`${h.name} ${h.code} ${h.sector}`.toLowerCase().includes(state.query.toLowerCase()));
  const value=holdings.reduce((s,h)=>s+h.shares*h.price,0);
  return `${heading("Portfolio",`${holdings.length} holdings · ${rm(value)}`)}<label class="search">⌕<input id="portfolio-search" value="${state.query}" placeholder="Search ticker, company or sector"></label><div class="filters">${["All","Safe","Watch","Partial","Sell"].map(r=>`<button data-risk="${r}" class="${state.risk===r?"active":""}">${r}</button>`).join("")}</div><div class="stack">${filtered.length?filtered.map(holdingCard).join(""):holdings.length?'<div class="empty">No holdings match this filter.</div>':emptyPortfolio()}</div>`;
}

function market(){
  return `${heading("Bursa Market","Daily close, ATR and moving-average storage")}<div class="market-search"><label class="search">⌕<input id="market-query" placeholder="e.g. 1155, MAYBANK, 5102"></label><button>Search</button></div><div class="empty"><b>Phase 2 market tables are ready</b><span>Price snapshots, ATR14 and MA fields are now stored in D1. Automated Bursa market-data synchronization is the next phase.</span></div>${section("Data fields")}<div class="performance">${metric("Close","Ready")}${metric("ATR14","Ready")}${metric("MA10 / 20","Ready")}${metric("MA50 / 200","Ready")}${metric("Volume","Ready")}${metric("History","120-session capable")}</div>`;
}

function watch(){
  if(!watchlistItems.length) return `${heading("Watchlist","Targets, support, volume and new-high alerts")}<div class="empty"><b>☆ Your D1 watchlist is empty</b><span>Watchlist records are now backed by Cloudflare D1.</span></div>`;
  return `${heading("Watchlist",`${watchlistItems.length} counters`)}<div class="stack">${watchlistItems.map(row=>`<article class="card"><div class="card-heading"><div><h3>${row.name} <small>${row.code}</small></h3><p>${row.notes||"Monitoring"}</p></div></div><div class="metric-grid">${metric("Target",row.target_price?rm(row.target_price):"—")}${metric("Support",row.support_price?rm(row.support_price):"—")}</div></article>`).join("")}</div>`;
}

function signals(){
  if(signalEvents.length) return `${heading("Signals","Stored ATR and sell-signal events")}<div class="stack">${signalEvents.map(row=>`<article class="card signal"><div class="card-heading"><div><h3>${row.code}</h3><p>${new Date(row.created_at).toLocaleString("en-MY")}</p></div>${badge(row.severity)}</div><p>${row.message}</p><div class="signal-stats">${metric("Observed",row.observed_price==null?"—":rm(row.observed_price))}${metric("Trigger",row.trigger_price==null?"—":rm(row.trigger_price))}${metric("Type",row.signal_type)}</div></article>`).join("")}</div>`;
  if(!holdings.length) return `${heading("Signals","Hard stop, ATR trailing, support close and MA rules")}<div class="empty"><b>No signal events yet</b><span>Signals will be generated after portfolio holdings and completed-close market data are available.</span></div>`;
  return `${heading("Signals","Current holding risk states")}<div class="stack">${holdings.map(h=>`<article class="card signal"><div class="card-heading"><div><h3>${h.name} <small>${h.code}</small></h3><p>Current D1 portfolio state</p></div>${badge(h.risk)}</div><p>${h.risk==="Sell"&&h.stop>0?`Price ${h.price.toFixed(3)} is at or below hard stop ${h.stop.toFixed(3)}.`:"No stored sell event is active for this holding."}</p><div class="signal-stats">${metric("Price",rm(h.price))}${metric("Hard stop",h.stop>0?rm(h.stop):"—")}${metric("MA10",h.ma10>0?rm(h.ma10):"—")}</div></article>`).join("")}</div>`;
}

function journal(){
  const entries=transactions.map(row=>({t:row.type,n:row.name||row.code||row.type,d:row.trade_date,s:num(row.shares),p:num(row.price),amount:num(row.amount),pl:row.realized_pl}));
  return `${heading("Trade journal","Transactions are the source of truth")}<div class="stack">${entries.length?entries.map(e=>`<article class="journal"><span class="type ${e.t.toLowerCase()}">${e.t}</span><h3>${e.n}</h3><p>${e.d}</p><div>${metric("Shares",e.s?e.s.toLocaleString():"—")}${metric("Price",e.p?rm(e.p):"—")}${metric("Value",rm(e.amount||e.s*e.p))}</div></article>`).join(""):'<div class="empty"><b>No transactions yet</b><span>The journal will populate from D1 transaction records.</span></div>'}</div>${section("Settings & data")}<article class="settings"><button>Cloudflare D1<span>Connected</span></button><button>Schema<span>Phase 2</span></button><button>Protected writes<span>${mutationEnabled?"Enabled":"Disabled"}</span></button></article>`;
}

const views={home,holdings:portfolio,market,watch,signals,journal};

function render(){
  const message=dataSource==="d1"?"Portfolio records are loaded from Cloudflare D1.":dataSource==="error"?`D1 load error: ${loadError}`:"Connecting to Cloudflare D1…";
  document.getElementById("app").innerHTML=views[state.view]()+`<p class="disclaimer">${message} Market quotes are not yet automatically synchronized. Verify investment decisions against Bursa or your broker.</p>`;
  document.getElementById("nav").innerHTML=nav.map(n=>`<button data-view="${n.key}" class="${state.view===n.key?"active":""}"><b>${n.icon}</b><span>${n.label}</span></button>`).join("");
  bind();
}

function bind(){
  document.querySelectorAll("[data-view]").forEach(b=>b.onclick=()=>{state.view=b.dataset.view;render();scrollTo(0,0)});
  document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>{state.view=b.dataset.go;render()});
  document.querySelectorAll("[data-risk]").forEach(b=>b.onclick=()=>{state.risk=b.dataset.risk;render()});
  const q=document.getElementById("portfolio-search");
  if(q)q.oninput=e=>{state.query=e.target.value;portfolioLive()};
}

function portfolioLive(){
  const app=document.getElementById("app");
  const active=document.activeElement;
  const pos=active?.selectionStart;
  app.innerHTML=portfolio()+`<p class="disclaimer">Portfolio records are loaded from Cloudflare D1.</p>`;
  bind();
  const q=document.getElementById("portfolio-search");
  q?.focus();
  if(q&&pos!==undefined)q.setSelectionRange(pos,pos);
}

document.getElementById("theme").onclick=()=>{
  const dark=document.documentElement.dataset.theme==="dark";
  document.documentElement.dataset.theme=dark?"light":"dark";
  document.getElementById("theme").textContent=dark?"☾":"☀";
  localStorage.setItem("atr-theme",dark?"light":"dark");
};

async function loadState(){
  const button=document.getElementById("refresh");
  button.classList.add("spin");
  dataSource="loading";
  loadError="";
  try{
    const response=await fetch("/api/state",{headers:{accept:"application/json"},cache:"no-store"});
    const payload=await response.json();
    if(!response.ok||!payload.ok)throw new Error(payload.error||"state_unavailable");
    const data=payload.data||{};
    holdings=(data.holdings||[]).map(row=>({
      code:row.code,
      name:row.name,
      sector:row.sector,
      shares:num(row.shares),
      price:num(row.current_price),
      cost:num(row.avg_cost),
      stop:num(row.hard_stop),
      ma10:num(row.ma10),
      risk:row.risk_status||"Safe"
    }));
    cashBalance=num(data.summary?.cash??data.settings?.cash_balance);
    transactions=data.transactions||[];
    watchlistItems=data.watchlist||[];
    signalEvents=data.signals||[];
    summaryData=data.summary||localSummary();
    mutationEnabled=Boolean(payload.mutation_enabled);
    dataSource="d1";
    document.getElementById("connection-status").textContent="D1 live · Phase 2";
    document.getElementById("updated").textContent=new Date().toLocaleTimeString("en-MY",{hour:"2-digit",minute:"2-digit"});
  }catch(error){
    holdings=[];
    cashBalance=0;
    transactions=[];
    watchlistItems=[];
    signalEvents=[];
    summaryData=null;
    mutationEnabled=false;
    dataSource="error";
    loadError=error.message||"state_unavailable";
    document.getElementById("connection-status").textContent="D1 error";
    document.getElementById("updated").textContent="Not loaded";
  }finally{
    button.classList.remove("spin");
    render();
  }
}

document.getElementById("refresh").onclick=loadState;
const saved=localStorage.getItem("atr-theme");
if(saved)document.documentElement.dataset.theme=saved;
if(saved==="light")document.getElementById("theme").textContent="☾";
if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js");
render();
loadState();
