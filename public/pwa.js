(() => {
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

  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredPrompt = event;
    window.dispatchEvent(new CustomEvent("atr-pwa-installable"));
  });

  window.ATR_PWA = {
    canInstall: () => Boolean(deferredPrompt),
    install: async () => {
      if (!deferredPrompt) return { outcome: "unavailable" };
      const prompt = deferredPrompt;
      deferredPrompt = null;
      await prompt.prompt();
      return prompt.userChoice;
    }
  };
})();
