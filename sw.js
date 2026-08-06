/* Workbench dashboard service worker.

   The dashboard is served from GitHub Pages, which pins Cache-Control to
   max-age=600 and offers no header configuration, so every rebuild forced a
   full re-download of the whole artifact and a cold home-screen launch had
   nothing cached at all. This worker owns caching instead of the HTTP layer.

   Two rules that must not be relaxed:

   1. Only same-origin GET requests are ever cached. Calls to api.github.com and
      raw.githubusercontent.com carry Jared's PAT in an Authorization header and
      must never be written to a cache the page can read back.
   2. The shell is served stale-while-revalidate, never cache-only. A bad build
      must age out on the next load rather than stranding the installed PWA.

   Escape hatch: load any page with ?nosw=1 to unregister and drop all caches.
*/
const VERSION = '2026-08-05.55';
const CACHE = 'workbench-shell-' + VERSION;
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll rejects the whole install if any single entry 404s; the shell
      // list is small and static, so tolerate misses rather than never
      // activating a worker at all.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('workbench-shell-') && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'wb-drop-caches') {
    event.waitUntil(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))));
  }
});

function staleWhileRevalidate(request) {
  return caches.open(CACHE).then((cache) =>
    cache.match(request).then((hit) => {
      const fresh = fetch(request)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);
      // Serve the cached copy immediately when there is one; the revalidation
      // still runs and lands in the cache for the next load.
      return hit || fresh.then((res) => res || Response.error());
    }),
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Cross-origin traffic is the authenticated GitHub API. Never intercept it:
  // no caching, no cloning, no reading the Authorization header.
  if (url.origin !== self.location.origin) return;
  if (url.searchParams.has('nosw')) return;

  event.respondWith(staleWhileRevalidate(req));
});
