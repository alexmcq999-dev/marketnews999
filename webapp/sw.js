/* McQCryptoNews — service worker: офлайн-оболочка приложения + пуш-уведомления (OneSignal).
   Регистрируется только вне Telegram (в установленном приложении и в браузере). */
try { importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js"); } catch (e) { /* без пушей */ }

const CACHE = "mcq-shell-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "i18n.js", "sessions.js", "mark.svg", "bg.jpg",
  "manifest.webmanifest", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("mcq-") && k !== CACHE)
    .map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // TradingView, Binance, OneSignal — напрямую
  const isData = url.pathname.includes("/data/") || url.pathname.endsWith(".json") && !url.pathname.endsWith("manifest.webmanifest");
  const isPage = req.mode === "navigate";
  if (isData || isPage) {
    // свежие данные и страница — из сети, без сети — из кэша
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return r;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((m) => m || caches.match("index.html"))));
    return;
  }
  // оболочка (css/js/картинки с ?v=сборки): из кэша, в фоне обновляем
  e.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return r;
    }).catch(() => hit || caches.match(req, { ignoreSearch: true }));
    return hit || net;
  }));
});
