const MODEL_CACHE = "tsuki-cutout-model-cache-v1";
const CACHE_HOSTS = new Set([
  "staticimgly.com",
  "esm.sh"
]);

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }

  if (!CACHE_HOSTS.has(url.hostname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(MODEL_CACHE);
    const cached = await cache.match(request, { ignoreVary: false });
    if (cached) return cached;

    const response = await fetch(request);
    if (response.ok || response.type === "opaque") {
      try {
        await cache.put(request, response.clone());
      } catch (_) {}
    }
    return response;
  })());
});
