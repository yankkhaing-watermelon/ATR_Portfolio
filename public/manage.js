const $ = id => document.getElementById(id);
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const rm = value => `RM ${num(value).toLocaleString("en-MY",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
let serverMutationEnabled = false;
let currentState = null;
let marketStatus = {};

function setResult(message, tone = "") {
  const bar = $("result-bar");
  bar.className = `result-bar ${tone}`.trim();
  bar.innerHTML = `<span>${message}</span>`;
}

function token() {
  return sessionStorage.getItem("atr-admin-token") || "";
}

function updateTokenUi() {
  const has = Boolean(token());
  $("admin-token").value = token();
  $("token-pill").textContent = has ? "Token entered" : "Locked";
  $("token-pill").classList.toggle("good", has && serverMutationEnabled);
}

async function api(path, options = {}, auth = false) {
  const headers = {accept:"application/json", ...(options.headers || {})};
  if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
  if (auth) {
    const value = token();
    if (!value) throw new Error("Enter ADMIN_TOKEN first.");
    headers.authorization = `Bearer ${value}`;
  }
  const response = await fetch(path, {...options, headers, cache:"no-store"});
  let payload;
  try { payload = await response.json(); } catch { payload = {ok:false,error:`HTTP ${response.status}`}; }
  if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function formatSyncTime(value) {
  if (!value) return "Not run yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-MY", {dateStyle:"medium", timeStyle:"short"});
}

function updateMarketStatus() {
  $("market-last-sync").textContent = formatSyncTime(marketStatus.market_last_sync);
}

async function checkHealth() {
  try {
    const payload = await api("/api/health");
    serverMutationEnabled = Boolean(payload.mutation_enabled);
    marketStatus = payload.market_sync || {};
    $("manage-status").textContent = payload.schema_ready ? `D1 live · Phase ${payload.phase || 3}` : "D1 schema not ready";
    $("manage-version").textContent = `v${payload.version || "3.x"}`;
    $("lock-state").innerHTML = serverMutationEnabled
      ? "<b class=\"good\">Enabled</b><span>Protected writes</span>"
      : "<b class=\"bad\">Locked</b><span>Protected writes</span>";
    $("token-help").innerHTML = serverMutationEnabled
      ? "Cloudflare protected writes are enabled. Enter the same <b>ADMIN_TOKEN</b> value above to authorize this browser tab."
      : "Add an <b>ADMIN_TOKEN</b> secret in Cloudflare → Worker → Settings → Variables and Secrets, then redeploy. No Wrangler command is required.";
    updateMarketStatus();
    updateTokenUi();
  } catch (error) {
    $("manage-status").textContent = "D1 health check failed";
    $("lock-state").innerHTML = "<b class=\"bad\">Error</b><span>Connection</span>";
    setResult(error.message, "error");
  }
}

function renderActivity(rows = []) {
  const box = $("recent-activity");
  if (!rows.length) {
    box.innerHTML = '<div class="empty-small">No transactions yet.</div>';
    return;
  }
  box.innerHTML = rows.slice(0, 8).map(row => {
    const value = row.type === "BUY" || row.type === "SELL" ? num(row.shares) * num(row.price) : num(row.amount);
    const title = row.name || row.code || row.type;
    return `<div class="activity-item"><div><b>${row.type} · ${title}</b><small>${row.trade_date || ""}</small></div><p>${row.code ? `${row.code} · ` : ""}${value ? rm(value) : ""}${row.realized_pl == null ? "" : ` · Realised ${rm(row.realized_pl)}`}</p></div>`;
  }).join("");
}

async function loadState() {
  try {
    const payload = await api("/api/state");
    currentState = payload.data || {};
    serverMutationEnabled = Boolean(payload.mutation_enabled);
    const summary = currentState.summary || {};
    $("sum-cash").textContent = rm(summary.cash || 0);
    $("sum-holdings").textContent = String((currentState.holdings || []).length);
    $("sum-value").textContent = rm(summary.holdings_value || 0);
    $("sum-equity").textContent = rm(summary.total_equity || 0);
    $("opening-cash").value = num(summary.cash || 0).toFixed(2);
    $("state-note").textContent = `${(currentState.transactions || []).length} transaction records · ${(currentState.signals || []).length} signal events`;
    renderActivity(currentState.transactions || []);
    updateTokenUi();
  } catch (error) {
    setResult(`State load failed: ${error.message}`, "error");
  }
}

function renderMarketSync(data) {
  const box = $("market-sync-result");
  const successes = data.results || [];
  const failures = data.errors || [];
  const rows = successes.map(row => `<div class="activity-item"><div><b>${row.code} · ${row.latest_date}</b><small>${row.provider_symbol} · ${row.source}</small></div><p>Close ${rm(row.close)} · ATR14 ${row.atr14 == null ? "—" : rm(row.atr14)} · MA10 ${row.ma10 == null ? "—" : rm(row.ma10)} · ${row.bars_saved} bars</p></div>`)
    .concat(failures.map(row => `<div class="activity-item"><div><b>${row.code} · Failed</b><small>Market-data error</small></div><p>${row.error}</p></div>`));
  box.innerHTML = rows.length ? rows.join("") : '<div class="empty-small">No holdings were available to synchronize.</div>';
}

async function syncMarketData() {
  if (!serverMutationEnabled) throw new Error("Protected writes are disabled. Add ADMIN_TOKEN in Cloudflare first.");
  if (!(currentState?.holdings || []).length) throw new Error("No portfolio holdings are available to synchronize.");
  const button = $("sync-market");
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Syncing…";
  setResult(`Synchronizing market data for ${(currentState.holdings || []).length} holding${(currentState.holdings || []).length === 1 ? "" : "s"}…`);
  try {
    const payload = await api("/api/market/sync", {method:"POST"}, true);
    const data = payload.data || {};
    renderMarketSync(data);
    await Promise.all([loadState(), checkHealth()]);
    setResult(`Market sync complete: ${data.succeeded || 0} succeeded, ${data.failed || 0} failed. Market value is now recalculated from synchronized closes.`, data.failed ? "error" : "ok");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function addRow(values = {}) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input data-field="code" maxlength="16" placeholder="1155" value="${values.code || ""}"></td>
    <td><input data-field="name" class="company" placeholder="Company name" value="${values.name || ""}"></td>
    <td><input data-field="sector" class="sector" placeholder="Sector" value="${values.sector || ""}"></td>
    <td><input data-field="shares" type="number" min="0" step="1" placeholder="0" value="${values.shares || ""}"></td>
    <td><input data-field="avg_cost" type="number" min="0" step="0.001" placeholder="0.000" value="${values.avg_cost || ""}"></td>
    <td><input data-field="current_price" type="number" min="0" step="0.001" placeholder="0.000" value="${values.current_price || ""}"></td>
    <td><input data-field="hard_stop" type="number" min="0" step="0.001" placeholder="Optional" value="${values.hard_stop || ""}"></td>
    <td><button class="row-remove" type="button" title="Remove row">×</button></td>`;
  tr.querySelector(".row-remove").onclick = () => tr.remove();
  $("opening-rows").appendChild(tr);
}

function collectOpeningRows() {
  const rows = [...$("opening-rows").querySelectorAll("tr")].map(tr => {
    const get = name => tr.querySelector(`[data-field="${name}"]`)?.value.trim() || "";
    return {
      code:get("code").toUpperCase(), name:get("name"), sector:get("sector") || "Other",
      shares:Number(get("shares")), avg_cost:Number(get("avg_cost")), current_price:Number(get("current_price")),
      hard_stop:get("hard_stop") === "" ? null : Number(get("hard_stop"))
    };
  }).filter(row => row.code || row.name || row.shares);
  for (const row of rows) {
    if (!row.code || !row.name || !Number.isFinite(row.shares) || row.shares <= 0 || !Number.isFinite(row.avg_cost) || row.avg_cost < 0 || !Number.isFinite(row.current_price) || row.current_price < 0) {
      throw new Error(`Complete code, company, shares, average cost and current price for every opening position.`);
    }
    if (row.hard_stop != null && (!Number.isFinite(row.hard_stop) || row.hard_stop < 0)) throw new Error(`Invalid hard stop for ${row.code}.`);
  }
  const codes = rows.map(row => row.code);
  if (new Set(codes).size !== codes.length) throw new Error("Duplicate Bursa codes are not allowed in the opening import.");
  return rows;
}

async function importPortfolio() {
  if (!serverMutationEnabled) throw new Error("Protected writes are disabled. Add ADMIN_TOKEN in Cloudflare first.");
  const cash = Number($("opening-cash").value);
  if (!Number.isFinite(cash) || cash < 0) throw new Error("Opening cash must be zero or greater.");
  const rows = collectOpeningRows();
  const existingHoldings = currentState?.holdings?.length || 0;
  const existingTransactions = currentState?.transactions?.length || 0;
  if ((existingHoldings || existingTransactions) && !confirm("D1 already contains portfolio records. Continue and update opening cash / matching holdings?")) return;
  setResult(`Importing opening cash and ${rows.length} holding${rows.length === 1 ? "" : "s"}…`);
  await api("/api/admin/setup", {method:"POST",body:JSON.stringify({cash_balance:cash})}, true);
  for (const row of rows) {
    await api("/api/holdings", {method:"POST",body:JSON.stringify({...row,risk_status:"Safe"})}, true);
  }
  await loadState();
  setResult(`Opening portfolio saved: ${rows.length} holding${rows.length === 1 ? "" : "s"}, cash ${rm(cash)}.`, "ok");
}

function updateTransactionFields() {
  const type = $("tx-type").value;
  const isTrade = type === "BUY" || type === "SELL";
  $("trade-fields").classList.toggle("hidden", !isTrade);
  $("cash-fields").classList.toggle("hidden", isTrade);
}

async function recordTransaction() {
  if (!serverMutationEnabled) throw new Error("Protected writes are disabled. Add ADMIN_TOKEN in Cloudflare first.");
  const type = $("tx-type").value;
  const body = {type,trade_date:$("tx-date").value,notes:$("tx-notes").value.trim()};
  if (type === "BUY" || type === "SELL") {
    body.code = $("tx-code").value.trim().toUpperCase();
    body.name = $("tx-name").value.trim();
    body.sector = $("tx-sector").value.trim() || "Other";
    body.shares = Number($("tx-shares").value);
    body.price = Number($("tx-price").value);
    body.fees = Number($("tx-fees").value || 0);
    if (!body.code || !Number.isFinite(body.shares) || body.shares <= 0 || !Number.isFinite(body.price) || body.price < 0) throw new Error("Trade requires Bursa code, shares and price.");
  } else {
    body.amount = Number($("tx-amount").value);
    if (!Number.isFinite(body.amount) || body.amount === 0) throw new Error("Cash transaction requires a non-zero amount.");
  }
  setResult(`Saving ${type} transaction…`);
  const payload = await api("/api/transactions", {method:"POST",body:JSON.stringify(body)}, true);
  await loadState();
  const suffix = payload.realized_pl == null ? "" : ` Realised P/L: ${rm(payload.realized_pl)}.`;
  setResult(`${type} saved. Cash balance: ${rm(payload.cash_balance)}.${suffix}`, "ok");
  $("tx-shares").value = "";
  $("tx-price").value = "";
  $("tx-amount").value = "";
  $("tx-notes").value = "";
}

$("theme").onclick = () => {
  const dark = document.documentElement.dataset.theme === "dark";
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  $("theme").textContent = dark ? "☾" : "☀";
  localStorage.setItem("atr-theme", dark ? "light" : "dark");
};
$("back").onclick = () => location.href = "/";
$("save-token").onclick = () => {
  const value = $("admin-token").value.trim();
  if (!value) return setResult("Enter ADMIN_TOKEN first.", "error");
  sessionStorage.setItem("atr-admin-token", value);
  updateTokenUi();
  setResult("ADMIN_TOKEN stored for this browser tab. It will be verified on the next protected write.", "ok");
};
$("clear-token").onclick = () => { sessionStorage.removeItem("atr-admin-token"); $("admin-token").value = ""; updateTokenUi(); setResult("Token cleared from this tab."); };
$("reload-state").onclick = loadState;
$("reload-activity").onclick = loadState;
$("sync-market").onclick = () => syncMarketData().catch(error => setResult(error.message, "error"));
$("add-row").onclick = () => addRow();
$("import-portfolio").onclick = () => importPortfolio().catch(error => setResult(error.message, "error"));
$("tx-type").onchange = updateTransactionFields;
$("record-transaction").onclick = () => recordTransaction().catch(error => setResult(error.message, "error"));

const savedTheme = localStorage.getItem("atr-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
if (savedTheme === "light") $("theme").textContent = "☾";
$("tx-date").value = new Date().toISOString().slice(0,10);
addRow();
updateTransactionFields();
updateTokenUi();
Promise.all([checkHealth(), loadState()]);
