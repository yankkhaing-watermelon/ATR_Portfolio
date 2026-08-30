(() => {
  function patch() {
    const status = document.getElementById("connection-status");
    if (status && status.textContent.includes("Phase 2")) status.textContent = status.textContent.replace("Phase 2", "Phase 3");

    const app = document.getElementById("app");
    if (!app) return;

    for (const node of app.querySelectorAll("b,span,p")) {
      const text = node.textContent || "";
      if (text === "Phase 2 market tables are ready") node.textContent = "Phase 3 market sync is connected";
      if (text.includes("Automated Bursa market-data synchronization is the next phase.")) {
        node.textContent = "Completed daily prices, ATR14 and moving averages can now be synchronized from Manage and are scheduled after Bursa close on weekdays.";
      }
      if (text.includes("Market quotes are not yet automatically synchronized.")) {
        node.textContent = text.replace("Market quotes are not yet automatically synchronized.", "Market data synchronizes after Bursa close on weekdays and can be refreshed manually from Manage.");
      }
      if (text === "Phase 2") node.textContent = "Phase 3";
    }
  }

  const observer = new MutationObserver(patch);
  const app = document.getElementById("app");
  if (app) observer.observe(app, {subtree:true, childList:true, characterData:true});
  patch();
  setInterval(patch, 1500);
})();
