// Bump this string any time you ship a release that should bust the
// install-time cache for previously-installed PWA users. The activate
// handler below deletes any cache whose name doesn't match.
const CACHE_NAME = "pacific-discovery-v42-offline-7day";
const STATIC_FILES = ["/index.html", "/login.html", "/site.webmanifest"];

// Separate cache for "field-essential" GET data so a trip leader with no
// signal can still read the information they loaded while online. Kept apart
// from the static cache so the activate-time cleanup doesn't wipe it on every
// release. Populated + served by networkFirstData() below.
const DATA_CACHE = "pd-field-data-v1";

// All read-only GET data endpoints the instructor portal uses. Anything the
// instructor views while online is saved here and replayed offline, so the
// whole portal — not just the core essentials — is usable in the field.
// Writes (login, checkout, push subscribe, update-application) are NOT listed
// and always stay strictly online-only. Keep in sync with the client.
const CACHEABLE_DATA = [
  "/.netlify/functions/portal",                  // core trip data + key contacts
  "/.netlify/functions/get-students",            // student list
  "/.netlify/functions/get-application-data",    // per-student medical / application
  "/.netlify/functions/get-document-checklist",  // per-student document checklist
  "/.netlify/functions/get-insurance",           // global config (doc form, faqs)
  "/.netlify/functions/get-teachers",            // instructors / key contacts
  "/.netlify/functions/get-fast-facts",          // fast-facts cards
  "/.netlify/functions/get-program-reports",     // program reports
  "/.netlify/functions/get-instructor-documents",// instructor resource docs
  "/.netlify/functions/get-instructor-files",    // instructor files
  "/.netlify/functions/get-instructor-submissions",// instructor submissions
  "/.netlify/functions/get-uploaded-documents",  // uploaded document links
  "/.netlify/functions/get-push-config"          // push config
];
function isCacheableData(url) {
  return CACHEABLE_DATA.some(p => url.includes(p));
}

// How long a saved offline copy stays usable. Decoupled from the 12h login
// token on purpose: offline, the server never verifies the token anyway (there
// is no network), so the token's lifetime only governs ONLINE access. This lets
// an instructor take the portal into the field for up to 7 days with no signal.
// The 12h token in _shared/auth.js is UNCHANGED — when back online with an
// expired token the app still forces a fresh login. Past this window a cached
// response is treated as stale, deleted, and the page is told nothing is saved.
// Any online visit — or tapping "Save this trip for offline" again — re-stamps
// the copy and resets the clock. Keep in sync with PD_REMEMBER_TTL_MS in
// index.html.
const DATA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Install — cache static files
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_FILES))
  );
  self.skipWaiting(); // activate immediately
});

// Activate — delete old caches (but KEEP both the current static cache and the
// field-data cache, so an upgrade doesn't wipe the offline field data).
self.addEventListener("activate", e => {
  const KEEP = [CACHE_NAME, DATA_CACHE];
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k)))
    )
  );
  self.clients.claim(); // take control immediately
});

// Network-first for field-essential GET data: try the network, cache a stamped
// copy on success, and fall back to the last good copy when offline. The
// stamp (X-PD-Cached-At header) lets the page tell a fresh response from a
// cached one and show "last updated …" in the offline banner.
async function networkFirstData(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      try {
        const body = await res.clone().blob();
        const headers = new Headers(res.headers);
        headers.set("X-PD-Cached-At", new Date().toISOString());
        await cache.put(request, new Response(body, {
          status: res.status,
          statusText: res.statusText,
          headers
        }));
      } catch (err) {
        console.warn("[sw] data cache.put skipped:", err && err.message);
      }
    }
    return res;
  } catch (_) {
    // Offline / network error — serve the last good copy if we have one AND it
    // hasn't aged past DATA_MAX_AGE_MS. A stale copy is deleted and treated as
    // "not saved" so the leader is never shown expired trip info.
    const cached = await cache.match(request);
    if (cached) {
      const stamp = cached.headers.get("X-PD-Cached-At");
      const age = stamp ? (Date.now() - new Date(stamp).getTime()) : Infinity;
      if (age <= DATA_MAX_AGE_MS) return cached;
      try { await cache.delete(request); } catch (_) { /* ignore */ }
    }
    // Nothing usable cached for this request: hand back a clear offline marker
    // the page can recognise instead of a generic network failure.
    return new Response(
      JSON.stringify({ error: "You're offline and this hasn't been saved for offline use yet (or the saved copy has expired).", offline: true }),
      { status: 503, headers: { "Content-Type": "application/json", "X-PD-Offline": "1" } }
    );
  }
}

// Fetch — network first for same-origin, total bypass for everything else.
self.addEventListener("fetch", e => {
  const url = e.request.url;

  // API calls.
  if (url.includes("/.netlify/functions/") || url.includes("/document-proxy")) {
    // Field-essential GET data: network-first with an offline cache fallback.
    if (e.request.method === "GET" && isCacheableData(url)) {
      e.respondWith(networkFirstData(e.request));
      return;
    }
    // Everything else (logins, mutations, checkout, document streams) stays
    // strictly online-only — never served from cache.
    e.respondWith(fetch(e.request));
    return;
  }

  // Don't try to handle non-http(s) schemes (chrome-extension://, data:,
  // blob:, etc.) — Cache.put() throws on them, and the browser already
  // handles them natively.
  if (!/^https?:/i.test(url)) return;

  // Cross-origin requests bypass the SW entirely. The browser fetches
  // them natively without our mediation. This avoids a long-standing
  // iOS Safari quirk where opaque (cross-origin) responses returned via
  // a service worker sometimes fail to render in <img> tags, even when
  // the same URL loads fine without an SW. HubSpot/CDN-hosted leader
  // photos hit this path. Same images work on desktop because Chromium
  // handles SW-mediated opaque responses differently.
  let sameOrigin = false;
  try { sameOrigin = new URL(url).origin === self.location.origin; }
  catch (_) { /* malformed URL — let the browser deal */ return; }
  if (!sameOrigin) return;

  // Same-origin GETs only past this point.
  if (e.request.method !== "GET") return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Only cache successful basic (same-origin) responses.
        if (res && res.ok && res.type === "basic") {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone))
            .catch(err => console.warn("[sw] cache.put skipped:", err && err.message));
        }
        return res;
      })
      .catch(() => caches.match(e.request)) // fall back to cache if offline
  );
});

// ---- Web Push ----
// Triggered by /.netlify/functions/send-message-board-push when an
// admin updates the message board. Payload is a JSON blob like:
//   { title: "...", body: "...", url: "/?..." }
// We show a system notification; clicking it focuses an existing portal
// tab if one is open, otherwise opens a new one.
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch (_) {
    try { data = { body: e.data ? e.data.text() : "" }; } catch (_) { /* ignore */ }
  }
  const title = data.title || "Pacific Discovery Student Portal";
  const options = {
    body: data.body || "There's a new message on your trip's Message Board.",
    icon: data.icon || "/web-app-manifest-192x192.png",
    badge: data.badge || "/favicon-96x96.png",
    tag: data.tag || "pacific-discovery-message-board", // dedupe consecutive pushes
    renotify: true,
    data: { url: data.url || "/index.html" }
  };

  // Bump the app-icon badge alongside showing the notification. The
  // Badging API isn't a hard dependency — older browsers / Android
  // sometimes don't have it — so we feature-detect and never let a
  // badge failure kill the notification itself.
  const badgeBump = (async () => {
    try {
      if (self.navigator && typeof self.navigator.setAppBadge === "function") {
        await self.navigator.setAppBadge(1);
      }
    } catch (err) {
      console.warn("[sw] setAppBadge failed:", err && err.message);
    }
  })();

  e.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    badgeBump
  ]));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then((wins) => {
        // Focus the first existing portal tab on this origin if there
        // is one; otherwise open a new one at `url`.
        const here = new URL(self.location.origin).origin;
        for (const w of wins) {
          try {
            if (new URL(w.url).origin === here) {
              w.focus();
              if ("navigate" in w) w.navigate(url);
              return;
            }
          } catch (_) { /* skip */ }
        }
        return self.clients.openWindow(url);
      })
  );
});
