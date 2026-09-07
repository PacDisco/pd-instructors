# pd-instructors (portal) — document-proxy timeout + offline-cache fallback

Copy these over your repo at the same paths (`CHANGES.diff` in this bundle is
a unified diff of every modified file if you'd rather review before
overwriting). No new env vars are required; one optional one is added.

## Why

Opening a student's flight/medical PDF (or any Jotform-backed document) goes
through `/document-proxy`. That edge function fetches the file from Jotform
with **no timeout** on the fetch. Jotform's on-demand PDF rendering
(`generatePDF`) is sometimes slow — worse over a weak mobile-data connection —
and with nothing bounding the wait, the fetch just hangs until Netlify's own
platform-level execution limit kills the function outright. That's the raw
"This edge function has crashed / the edge function timed out" page Ashley
hit — it's Netlify force-killing a stuck function, not an error your code
returned.

Separately, the service worker's offline cache (`DATA_CACHE`, the thing behind
"Save this trip for offline") only fell back to a saved copy when `fetch()`
**threw** (true network failure / offline). A crashed edge function doesn't
throw — it completes as an ordinary bad HTTP response — so even when a good
cached copy of that exact document already existed from an earlier save, the
crash page was served instead of it.

## What changed

| File | Change |
|---|---|
| `netlify/edge-functions/get-document.js` | Each upstream fetch attempt (primary + fallback) now has a 15s `AbortController` timeout (`DOCUMENT_PROXY_TIMEOUT_MS` to tune). A slow/hung Jotform response now fails that one candidate cleanly (504) and moves to the fallback, or returns a normal error — instead of the whole function getting killed by Netlify. |
| `netlify/functions/get-document.js` | Same change — kept byte-identical to the edge-function version, as it already was. |
| `public/service-worker.js` | `networkFirstData` now also falls back to the last fresh cached copy when the network **response** comes back broken (status ≥ 500 — a crashed/timed-out function, or any other server error), not only when the fetch throws. Refactored the cache-lookup into `freshCachedCopy()` so both paths share the same "is it still within the 7-day window" logic. |

## What this gets you

1. A slow Jotform response can no longer take down the whole document link —
   it fails in ~15s and either falls back to the registered backup URL or
   returns a clean error, instead of an unpredictable platform-level crash.
2. Once a leader has tapped **"Save this trip for offline"** on a decent
   connection, those flight/medical PDFs are warmed into the 7-day
   `DATA_CACHE`. From then on, if a live request over spotty mobile data comes
   back broken, the app now serves that saved copy instead of an error page —
   which is the actual mechanism that makes these documents reliably
   available in the field.

## Still worth knowing

This doesn't make Jotform itself fast — if `generatePDF` is slow or fails
*and* the document was never warmed into the offline cache first (i.e.
nobody tapped "Save this trip for offline" while they had a good connection),
there's nothing to fall back to. The reliable path for field use is: save the
trip while on wifi/office data, then the documents are usable regardless of
what mobile data is doing later.
