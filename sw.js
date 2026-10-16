// Service worker, deux rôles :
// 1. Transforme /drive/<fileId>?t=<token> en requête authentifiée vers l'API
//    Drive, en conservant l'en-tête Range. Ça permet à <audio> de streamer (et
//    de sauter dans le morceau) et à <img> d'afficher les originaux, alors que
//    ces balises ne savent pas envoyer d'en-tête Authorization. Le jeton reste
//    local : cette URL n'est jamais envoyée sur le réseau.
// 2. Garde une copie des fichiers de l'app : elle s'ouvre même quand le petit
//    serveur local est éteint (le réseau d'abord, la copie sinon).

const CACHE = "mon-cloud-media-app";
const LIB_HOSTS = ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com"];
const APP_FILES = ["./", "index.html", "config.js", "app.js?v=19", "folders.js?v=19", "sources.js?v=19", "books.js?v=19", "review.js?v=19", "shares.js?v=19",
  "styles.css?v=19", "icon.svg", "icon-192.png", "icon-512.png", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_FILES)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Bibliothèques de la liseuse (versions figées) : copie locale d'abord.
  if (LIB_HOSTS.includes(url.hostname) && event.request.method === "GET") {
    event.respondWith(caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok || res.type === "opaque") cache.put(event.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;

  const m = url.pathname.match(/\/drive\/([\w-]+)$/);
  if (m) {
    const token = url.searchParams.get("t");
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const range = event.request.headers.get("Range");
    if (range) headers.set("Range", range);
    const target = `https://www.googleapis.com/drive/v3/files/${m[1]}?alt=media`;
    event.respondWith(fetch(target, { headers }));
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(event.request) || await cache.match(event.request, { ignoreSearch: true })
        || (event.request.mode === "navigate" && await cache.match("./"));
      if (hit) return hit;
      throw err;
    }
  })());
});
