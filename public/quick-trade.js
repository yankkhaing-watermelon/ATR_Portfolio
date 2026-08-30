(()=>{
  const TOKEN_KEY="atr-admin-token";
  const fmt=v=>Number(v).toLocaleString("en-MY",{minimumFractionDigits:2,maximumFractionDigits:3});
  let cachedState=null;

  function token(){return sessionStorage.getItem(TOKEN_KEY)||""}
  async function jsonApi(path,options={},auth=false){
    const headers={accept:"application/json",...(options.headers||{})};
    if(options.body)headers["content-type"]="application/json";
    if(auth){const t=token();if(!t)throw new Error("Enter ADMIN_TOKEN first.");headers.authorization=`Bearer ${t}`}
    const r=await fetch(path,{...options,headers,cache:"no-store"});
    let p;try{p=await r.json()}catch{p={ok:false,error:`HTTP ${r.status}`}}
    if(!r.ok||!p.ok)throw new Error(p.error||`HTTP ${r.status}`);
    return p;
  }
  async function state(){
    if(cachedState)return cachedState;
    const p=await jsonApi("/api/state");cachedState=p.data||{};return cachedState;
  }
  function holdingFromCard(card){
    const code=card.querySelector("h3 small")?.textContent?.trim()||"";
    return code;
  }
  function ensureModal(){
    if(document.getElementById("quick-trade-modal"))return;
    const wrap=document.createElement("div");wrap.id="quick-trade-modal";wrap.className="quick-trade-modal";wrap.hidden=true;
    wrap.innerHTML=`<div class="quick-trade-sheet" role="dialog" aria-modal="true" aria-labelledby="qt-title">
      <div class="quick-trade-head"><div><small id="qt-code"></small><h2 id="qt-title">Record trade</h2><p id="qt-name"></p></div><button type="button" id="qt-close" aria-label="Close">×</button></div>
      <div class="quick-trade-toggle"><button type="button" data-side="BUY">BUY · Top up</button><button type="button" data-side="SELL">SELL · Reduce</button></div>
      <div class="quick-trade-grid">
        <label><span>Shares</span><input id="qt-shares" type="number" min="1" step="1" inputmode="numeric"></label>
        <label><span>Execution price (RM)</span><input id="qt-price" type="number" min="0" step="0.001" inputmode="decimal"></label>
        <label><span>Fees (RM)</span><input id="qt-fees" type="number" min="0" step="0.01" inputmode="decimal" value="0"></label>
        <label><span>Trade date</span><input id="qt-date" type="date"></label>
      </div>
      <label class="quick-trade-note"><span>Notes</span><input id="qt-notes" placeholder="Optional"></label>
      <label class="quick-trade-token" id="qt-token-row"><span>ADMIN_TOKEN</span><input id="qt-token" type="password" autocomplete="off" placeholder="Required for protected write"></label>
      <div class="quick-trade-summary" id="qt-summary"></div>
      <button type="button" id="qt-submit" class="quick-trade-submit">Record BUY</button>
      <div class="quick-trade-result" id="qt-result" aria-live="polite"></div>
    </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click",e=>{if(e.target===wrap)closeModal()});
    document.getElementById("qt-close").onclick=closeModal;
    document.querySelectorAll(".quick-trade-toggle button").forEach(b=>b.onclick=()=>setSide(b.dataset.side));
    ["qt-shares","qt-price","qt-fees"].forEach(id=>document.getElementById(id).addEventListener("input",updateSummary));
    document.getElementById("qt-submit").onclick=submitTrade;
  }
  let active={side:"BUY",holding:null};
  function setSide(side){
    active.side=side;
    document.querySelectorAll(".quick-trade-toggle button").forEach(b=>b.classList.toggle("active",b.dataset.side===side));
    const submit=document.getElementById("qt-submit");submit.textContent=side==="BUY"?"Record BUY · Top up":"Record SELL · Reduce position";
    submit.dataset.side=side;
    updateSummary();
  }
  function updateSummary(){
    const shares=Number(document.getElementById("qt-shares")?.value||0),price=Number(document.getElementById("qt-price")?.value||0),fees=Number(document.getElementById("qt-fees")?.value||0);
    const gross=shares*price;
    const cash=active.side==="BUY"?-(gross+fees):(gross-fees);
    const h=active.holding;
    const remain=h&&active.side==="SELL"?Math.max(0,Number(h.shares||0)-shares):null;
    document.getElementById("qt-summary").innerHTML=`<div><span>Trade value</span><b>RM ${fmt(gross||0)}</b></div><div><span>Cash impact</span><b class="${cash>=0?"good":"bad"}">${cash>=0?"+":"-"}RM ${fmt(Math.abs(cash))}</b></div>${remain==null?"":`<div><span>Shares after SELL</span><b>${remain.toLocaleString("en-MY")}</b></div>`}`;
  }
  function closeModal(){const m=document.getElementById("quick-trade-modal");if(m)m.hidden=true;document.body.classList.remove("quick-trade-open")}
  async function openTrade(code,side){
    ensureModal();
    const d=await state();
    const h=(d.holdings||[]).find(x=>String(x.code)===String(code));
    if(!h)throw new Error(`Holding ${code} was not found.`);
    active={side,holding:h};
    document.getElementById("qt-code").textContent=h.code;
    document.getElementById("qt-name").textContent=h.name||"";
    document.getElementById("qt-shares").value="";
    document.getElementById("qt-price").value=Number(h.current_price||0)>0?Number(h.current_price).toFixed(Number(h.current_price)<1?3:2):"";
    document.getElementById("qt-fees").value="0";
    document.getElementById("qt-date").value=new Date().toISOString().slice(0,10);
    document.getElementById("qt-notes").value="";
    document.getElementById("qt-token-row").hidden=Boolean(token());
    document.getElementById("qt-token").value="";
    document.getElementById("qt-result").textContent="";
    setSide(side);
    const m=document.getElementById("quick-trade-modal");m.hidden=false;document.body.classList.add("quick-trade-open");
  }
  async function submitTrade(){
    const h=active.holding,side=active.side;
    if(!h)return;
    const shares=Number(document.getElementById("qt-shares").value),price=Number(document.getElementById("qt-price").value),fees=Number(document.getElementById("qt-fees").value||0),trade_date=document.getElementById("qt-date").value,notes=document.getElementById("qt-notes").value.trim();
    if(!(shares>0)||!(price>=0)||!Number.isFinite(fees)||fees<0)return showResult("Enter valid shares, price and fees.",true);
    if(side==="SELL"&&shares>Number(h.shares||0))return showResult(`You hold ${Number(h.shares||0).toLocaleString("en-MY")} shares. SELL quantity cannot exceed the holding.`,true);
    const entered=document.getElementById("qt-token").value.trim();if(!token()&&entered)sessionStorage.setItem(TOKEN_KEY,entered);
    if(!token())return showResult("Enter ADMIN_TOKEN first.",true);
    const verb=side==="BUY"?"top up":"reduce";
    if(!confirm(`${side} ${shares.toLocaleString("en-MY")} shares of ${h.code} at RM ${fmt(price)}? This will ${verb} the live D1 position and update cash.`))return;
    const btn=document.getElementById("qt-submit");btn.disabled=true;btn.textContent="Saving…";
    try{
      const body={type:side,code:h.code,name:h.name||h.code,sector:h.sector||"Other",shares,price,fees,trade_date,notes};
      const p=await jsonApi("/api/transactions",{method:"POST",body:JSON.stringify(body)},true);
      try{await jsonApi("/api/risk/run",{method:"POST"},true)}catch{}
      cachedState=null;
      showResult(`${side} recorded. Cash balance: RM ${fmt(p.cash_balance||0)}.${p.realized_pl==null?"":` Realised P/L: RM ${fmt(p.realized_pl)}.`}`,false);
      if(typeof window.loadState==="function")await window.loadState();else setTimeout(()=>location.reload(),650);
    }catch(e){showResult(e.message,true)}finally{btn.disabled=false;setSide(side)}
  }
  function showResult(msg,error){const el=document.getElementById("qt-result");el.textContent=msg;el.classList.toggle("error",Boolean(error));el.classList.toggle("ok",!error)}
  function enhance(){
    document.querySelectorAll("article.card").forEach(card=>{
      if(card.dataset.quickTradeReady)return;
      const code=holdingFromCard(card);if(!code)return;
      const footer=card.querySelector(".card-footer");if(!footer)return;
      const area=footer.querySelector("div")||footer;
      const buy=document.createElement("button");buy.type="button";buy.className="quick-buy";buy.textContent="＋ BUY";buy.onclick=()=>openTrade(code,"BUY").catch(e=>alert(e.message));
      const sell=document.createElement("button");sell.type="button";sell.className="quick-sell";sell.textContent="− SELL";sell.onclick=()=>openTrade(code,"SELL").catch(e=>alert(e.message));
      area.prepend(sell);area.prepend(buy);card.dataset.quickTradeReady="1";
    });
  }
  ensureModal();enhance();
  new MutationObserver(enhance).observe(document.getElementById("app")||document.body,{childList:true,subtree:true});
})();