const CACHE = "atr-portfolio-v12";
const SHELL = ["/", "/index.html", "/styles.css", "/mobile.css", "/pwa.js", "/app-v4.js", "/manage.html", "/manage.css", "/manage.js", "/risk.html", "/risk.js", "/signals.html", "/signals.js", "/chart.html", "/chart.js", "/analytics.html", "/analytics.js", "/decision.html", "/decision.js", "/daily.html", "/daily.js", "/reviews.html", "/reviews.js", "/manifest.webmanifest", "/icon.svg"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(hit => hit || (event.request.mode === "navigate" ? caches.match("/index.html") : Response.error()))));
});
