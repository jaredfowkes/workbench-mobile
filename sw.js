/* Workbench dashboard service worker.

   The dashboard is served from GitHub Pages, which pins Cache-Control to
   max-age=600 and offers no header configuration, so every rebuild forced a
   full re-download of the whole artifact and a cold home-screen launch had
   nothing cached at all. This worker owns caching instead of the HTTP layer.

   Two rules that must not be relaxed:

   1. Only same-origin GET requests are ever cached. Calls to api.github.com and
      raw.githubusercontent.com carry GitHub access in an Authorization header and
      must never be written to a cache the page can read back.
   2. Navigations are stale-while-revalidate: the cached shell paints at once
      and a background fetch refreshes it. When the fresh build id differs, the
      page is told (postMessage) so it can offer "Updated - reload" rather than
      swapping under the user. The one exception is the OAuth callback, which
      stays network-first so a newly published sign-in flow never meets an
      older cached shell mid-login.
   3. Supabase (/functions/v1/, /rest/v1/, /auth/v1/) and GitHub traffic is
      network-only. Google Fonts are the one cross-origin thing cached.
   4. Content-hashed scripts (three.<hash>.js, app.<hash>.js) are cache-first
      in a cache that outlives builds: the name changes whenever the bytes do,
      so a hit is never stale and an unchanged script is never re-downloaded.

   Escape hatch: load any page with ?nosw=1 to unregister and drop all caches.
*/
const VERSION = '2026-10-28.20';
const CACHE_PREFIX = 'workbench-shell-';
const CACHE = CACHE_PREFIX + VERSION;
const FONT_CACHE = 'workbench-fonts-v1';
// Not prefixed CACHE_PREFIX: activate purges old shell caches, and hashed
// scripts must survive a build that did not change them.
const ASSET_CACHE = 'workbench-assets-v1';
const HASHED_SCRIPT = /\/((?:three|app))\.[0-9a-f]{10}\.js$/;
// Newest hashes kept per script; older ones are only reachable from a shell
// that has already been replaced.
const ASSET_KEEP = 3;
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const API_PATHS = ['/functions/v1/', '/rest/v1/', '/auth/v1/', '/storage/v1/', '/realtime/v1/'];
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll rejects the whole install if any single entry 404s; the shell
      // list is small and static, so tolerate misses rather than never
      // activating a worker at all.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))).then(() => c.match(SHELL[0])))
      // The first page load fetched its app script before this worker
      // controlled it, so nothing cached it; without this a second launch
      // offline would have a shell and no code.
      .then((shell) => (shell ? precacheApp(shell).catch(() => {}) : null))
      .then(() => self.skipWaiting()),
  );
});

function notifyClients(version) {
  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((windows) => windows.forEach((c) => c.postMessage({ type: 'wb-updated', version })));
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        const old = keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE);
        return Promise.all(old.map((k) => caches.delete(k))).then(() => old.length);
      })
      .then((purged) =>
        // The page that is open right now is still running the previous
        // build; tell it a newer one is installed.
        self.clients.claim().then(() => (purged ? notifyClients(VERSION) : null)),
      ),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'wb-drop-caches') {
    event.waitUntil(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))));
    return;
  }
  // A reload fetches its shell before the new page exists, so a wb-updated
  // broadcast from that revalidation reaches nobody. The page therefore asks
  // on load, sending the build it is running; we answer from the cached shell.
  // If revalidation has not finished yet, its own broadcast arrives later and
  // the page listener is attached by then.
  if (event.data && event.data.type === 'wb-check' && event.source) {
    const source = event.source;
    event.waitUntil(
      revalidating
        .then(() => caches.open(CACHE))
        .then((cache) => cache.match(new URL('./', self.location.href).href))
        .then((hit) => (hit ? buildId(hit) : null))
        .then((cached) => {
          if (cached && cached !== event.data.version) source.postMessage({ type: 'wb-updated', version: cached });
        })
        .catch(() => {}),
    );
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

function buildId(res) {
  return res
    .clone()
    .text()
    .then((t) => (t.match(/WB_VERSION\s*=\s*['"]([^'"]+)/) || [])[1] || null)
    .catch(() => null);
}

// The build emits a tiny dashboard-version.json beside the shell. Asking it
// first means an unchanged build costs a few bytes instead of 2 MB. Any
// failure (404, offline, bad JSON) returns null and the caller falls back to
// fetching the full shell.
function remoteVersion() {
  const file = new URL('dashboard-version.json', self.location.href).href;
  return fetch(file, { cache: 'no-store' })
    .then((res) => (res && res.ok ? res.json() : null))
    .then((j) => (j && typeof j.version === 'string' ? j.version : null))
    .catch(() => null);
}

// Fetch the shell, store it, and report whether its build id moved.
async function revalidateShell(cache, shell, request, previous) {
  const before = previous ? await buildId(previous) : null;
  if (before && (await remoteVersion()) === before) return null;
  // Pages serves max-age=600, so a plain fetch can be answered from the HTTP
  // cache with the build we already hold, hiding an update for ten minutes.
  // no-cache revalidates (a 304 when truly unchanged) instead.
  const res = await fetch(request, { cache: 'no-cache' });
  if (!(res && res.ok && res.type === 'basic')) return res;
  const after = await buildId(res);
  // Storage pressure must not turn a successful network load into an
  // apparent sign-in failure.
  try { await cache.put(shell, res.clone()); } catch {}
  // Fetch the new build's script before announcing it, so "reload" is instant.
  try { await precacheApp(res); } catch {}
  if (previous && after && before !== after) await notifyClients(after);
  return res;
}

// The newest in-flight shell revalidation. A page's wb-check must wait on it:
// the reloading page asks within milliseconds, while the fetch is still
// running and the cache still holds the old build.
let revalidating = Promise.resolve();

function navigationStaleWhileRevalidate(request, event) {
  // Cache only the canonical shell URL, never a URL with a query string.
  const shell = new URL('./', self.location.href).href;
  return caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(shell);
    const fresh = revalidateShell(cache, shell, request, hit);
    if (hit) {
      const settled = fresh.catch(() => null);
      revalidating = settled;
      if (event && event.waitUntil) event.waitUntil(settled);
      return hit;
    }
    return fresh.then((res) => res || Response.error()).catch(() => Response.error());
  });
}

function navigationNetworkFirst(request) {
  // The OAuth callback can arrive with a one-use code in its query string.
  // Cache only the canonical shell URL, never that callback URL.
  const shell = new URL('./', self.location.href).href;
  return caches.open(CACHE).then(async (cache) => {
    try {
      const res = await fetch(request);
      if (res && res.ok && res.type === 'basic') {
        try { await cache.put(shell, res.clone()); } catch {}
      }
      return res;
    } catch {
      return (await cache.match(shell)) || Response.error();
    }
  });
}

function isOAuthCallback(url) {
  return url.searchParams.has('code') || url.searchParams.has('error') || url.searchParams.has('state');
}

// Drop all but the newest ASSET_KEEP entries per script name. Cache.keys()
// returns insertion order, so the oldest come first.
async function pruneAssets(cache, stem) {
  try {
    const keys = (await cache.keys()).filter((k) => {
      const m = new URL(k.url).pathname.match(HASHED_SCRIPT);
      return m && m[1] === stem;
    });
    await Promise.all(keys.slice(0, Math.max(0, keys.length - ASSET_KEEP)).map((k) => cache.delete(k)));
  } catch {}
}

// Cache the app script the given shell loads, so the shell and its code are
// always cached together. Failures are swallowed: the page fetches it anyway.
async function precacheApp(shellRes) {
  const text = await shellRes.clone().text();
  const m = text.match(/<script[^>]*\ssrc="(app\.[0-9a-f]{10}\.js)"/);
  if (!m) return;
  const target = new URL(m[1], self.location.href).href;
  const cache = await caches.open(ASSET_CACHE);
  if (await cache.match(target)) return;
  const res = await fetch(target);
  if (res && res.ok && res.type === 'basic') {
    await cache.put(target, res.clone());
    await pruneAssets(cache, 'app');
  }
}

function hashedCacheFirst(request) {
  return caches.open(ASSET_CACHE).then(async (cache) => {
    const hit = await cache.match(request);
    if (hit) return hit;
    const res = await fetch(request);
    if (res && res.ok && res.type === 'basic') {
      try {
        await cache.put(request, res.clone());
        await pruneAssets(cache, new URL(request.url).pathname.match(HASHED_SCRIPT)[1]);
      } catch {}
    }
    return res;
  });
}

function cacheFirst(request) {
  return caches.open(FONT_CACHE).then((cache) =>
    cache.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((res) => {
          if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone()).catch(() => {});
          return res;
        }),
    ),
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  // Every other cross-origin request is authenticated API traffic (GitHub,
  // Supabase). Never intercept it: no caching, no cloning, no reading the
  // Authorization header.
  if (url.origin !== self.location.origin) return;
  if (url.searchParams.has('nosw')) return;
  if (API_PATHS.some((p) => url.pathname.includes(p))) return;

  if (HASHED_SCRIPT.test(url.pathname)) {
    event.respondWith(hashedCacheFirst(req));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      isOAuthCallback(url) ? navigationNetworkFirst(req) : navigationStaleWhileRevalidate(req, event),
    );
    return;
  }
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
