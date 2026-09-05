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
const VERSION = '2026-09-05.24';
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

// --- Web Push (issue #33) ----------------------------------------------------
//
// The push carries NO payload, deliberately. A body would have to be encrypted
// per subscription and would route the detail through Apple's push service to
// get here; instead the banner says something needs attention and the
// dashboard says what. That is also more honest: a pushed payload is a
// snapshot that can already be stale when it is read, while opening the page
// fetches current state.
//
// Two independent things fire this same payload-less push -- a silently
// broken health check AND Tools/Agency/contract.py's mid-run approval gate
// reaching the phone (see that module's docstring). Neither the sender nor
// this handler knows which one woke it, so the text below has to read true
// for both rather than naming a specific check; "Open the dashboard" is
// deliberately generic. This still fires well under one a day against a
// measured tolerance of three to five -- a channel that cries wolf gets
// muted, and half the users who mute a feature's notifications abandon it.
// A gate push cannot be made Time Sensitive from here, and no amount of code
// in this file will change that. Checked 2026-08-29 against the Notifications
// spec, the WebKit Declarative Web Push explainer, and Apple's own web push
// docs: `interruptionLevel` exists only in native UserNotifications, the
// declarative payload has no equivalent field, and the RFC 8030 `Urgency`
// header webpush.py already sends governs APNs delivery priority, never Focus
// passthrough. Time Sensitive on Apple platforms additionally requires an
// entitlement issued only to native App IDs.
//
// So a Focus mode CAN hold an approval gate back overnight, which is exactly
// when a blocked run needs it. The only lever is on the device:
//   Settings > Focus > Sleep > Apps > Allow Notifications From > add Workbench.
// That is all-or-nothing per app -- there is no per-notification override to
// build against. Do not re-solve this in code; confirm the setting instead.
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('Workbench needs you', {
      body: 'Something is waiting on you -- open the dashboard to see what.',
      // One stable tag, so an ongoing fault re-alerting does not stack three
      // banners -- that is how a channel earns a mute. It also means a gate
      // push and a health push are indistinguishable here, which is fine:
      // both resolve to the same Machines screen.
      tag: 'workbench-health',
      renotify: false,
      requireInteraction: false,
    }),
  );
});

// `?view=` is read by app.js's applyLaunchIntent() before the first render.
// It was not read by anything until 2026-08-29, so every tap landed on Today
// no matter what this href said. `focus=gates` additionally scrolls the Gate
// approvals card into view once machine status has loaded.
//
// Machines is the right target for both senders: a health fault and an
// approval gate are both reported there, and the push cannot tell us which
// one it was.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL('./?view=machines&focus=gates', self.location.origin + self.location.pathname).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Focus an open tab rather than piling up new ones.
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          await client.focus();
          if ('navigate' in client) await client.navigate(target);
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});
