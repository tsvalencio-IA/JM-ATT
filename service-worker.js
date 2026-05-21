const CACHE_NAME = "jm-guinchos-v18-provas-assinatura-seguradoras";
const ASSETS = [
  "./",
  "./index.html",
  "./jm.html",
  "./formulario.html",
  "./motorista.html",
  "./superadmin.html",
  "./manifest.json",
  "./css/style.css",
  "./js/config.firebase.js",
  "./js/utils.js",
  "./js/firebase.js",
  "./js/tracker.js",
  "./js/google-maps.js",
  "./js/mapa.js",
  "./js/app.js",
  "./js/motorista.js",
  "./js/superadmin.js",
  "./assets/icon.svg"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => null));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isHtmlOrCode(request) {
  const url = new URL(request.url);
  return request.mode === "navigate" || /\.(html|js|css|json)$/i.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (isHtmlOrCode(event.request)) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => null);
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => null);
        return response;
      });
    })
  );
});
