(() => {
  const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent || "");
  let deferredPrompt = null;

  function ensureInstallUI() {
    if (isStandalone()) return;
    const actions = document.querySelector(".actions");
    if (!actions || document.getElementById("pwa-install")) return;

    const button = document.createElement("button");
    button.id = "pwa-install";
    button.className = "pwa-install";
    button.type = "button";
    button.innerHTML = "⇩ <span>Install</span>";
    button.setAttribute("aria-label", "Install ATR Portfolio app");
    button.addEventListener("click", async () => {
      if (deferredPrompt) {
        const prompt = deferredPrompt;
        deferredPrompt = null;
        await prompt.prompt();
        await prompt.userChoice.catch(() => null);
        updateInstallButton();
        return;
      }
      showInstallHelp();
    });
    actions.prepend(button);
    updateInstallButton();
  }

  function updateInstallButton() {
    const button = document.getElementById("pwa-install");
    if (!button) return;
    if (isStandalone()) {
      button.remove();
      return;
    }
    if (deferredPrompt) {
      button.classList.add("ready");
      button.title = "Install ATR Portfolio";
    } else {
      button.classList.remove("ready");
      button.title = isIOS() ? "Add ATR Portfolio to your Home Screen" : "PWA installation help";
    }
  }

  function showInstallHelp() {
    let panel = document.getElementById("pwa-install-help");
    if (panel) { panel.hidden = false; return; }
    panel = document.createElement("div");
    panel.id = "pwa-install-help";
    panel.className = "pwa-install-help";
    panel.innerHTML = `
      <div class="pwa-install-card" role="dialog" aria-modal="true" aria-label="Install ATR Portfolio">
        <button class="pwa-close" type="button" aria-label="Close">×</button>
        <div class="pwa-install-icon">↗<span>MK</span></div>
        <h2>Install ATR Portfolio</h2>
        <p>${isIOS()
          ? "On iPhone or iPad: open this page in Safari, tap the Share button, then choose Add to Home Screen and tap Add."
          : "Open your browser menu and choose Install app or Add to Home screen. If the option is not shown yet, reload the page once and try again."}</p>
        <small>After installation it opens in standalone app mode and keeps the interface shell available offline.</small>
        <button class="primary-btn full pwa-got-it" type="button">Got it</button>
      </div>`;
    document.body.appendChild(panel);
    const close = () => { panel.hidden = true; };
    panel.addEventListener("click", event => { if (event.target === panel) close(); });
    panel.querySelector(".pwa-close").addEventListener("click", close);
    panel.querySelector(".pwa-got-it").addEventListener("click", close);
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        registration.update().catch(() => {});
      } catch (error) {
        console.warn("Service worker registration failed", error);
      }
    });
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredPrompt = event;
    ensureInstallUI();
    updateInstallButton();
    window.dispatchEvent(new CustomEvent("atr-pwa-installable"));
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    document.getElementById("pwa-install")?.remove();
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ensureInstallUI);
  else ensureInstallUI();

  window.ATR_PWA = {
    canInstall: () => Boolean(deferredPrompt),
    isStandalone,
    install: async () => {
      if (!deferredPrompt) { showInstallHelp(); return { outcome: "help" }; }
      const prompt = deferredPrompt;
      deferredPrompt = null;
      await prompt.prompt();
      const choice = await prompt.userChoice;
      updateInstallButton();
      return choice;
    }
  };
})();
