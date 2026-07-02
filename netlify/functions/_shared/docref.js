// Signed references for the /document-proxy.
//
// Document/photo URLs used to be passed to the browser as
//   /document-proxy?url=<raw Jotform URL>
// but Jotform file URLs embed the submission ID in their path
// (/uploads/<user>/<form>/<SUBMISSION_ID>/<file>), so the raw URL leaked the
// submission ID — enough to edit the raw submission via jotform.com/edit/<id>.
//
// Instead we hand the browser an opaque, HMAC-signed token that encodes the
// real URL. The proxy (edge function, and the Node fallback) verifies the
// signature server-side and decodes the URL — the browser never sees the
// Jotform path or the submission ID. Signed with SESSION_SECRET (same secret
// as the session tokens) so there's one secret to manage.
//
// Token format:  base64url(JSON({ u, e })) + "." + hex(HMAC_SHA256(payload))
//   u = real file URL, e = expiry epoch-ms.
// The edge function (Deno/Web Crypto) mirrors this exactly — keep the encoding
// (base64url payload, lowercase-hex signature) identical on both sides.

import crypto from "crypto";

// Refs are DETERMINISTIC within a 7-day window: signDocRef rounds the expiry up
// to the next 7-day boundary, so the same file URL produces the byte-identical
// signed ref on every page load for the life of that window. This is what makes
// documents work offline in the PWA — the app caches a file under its
// /document-proxy?ref=… URL, and the link the page renders later (online OR
// offline, on the same or a later load) resolves to that same URL, so the
// cached copy is found. Matches the 7-day offline data window (DATA_MAX_AGE_MS
// in public/service-worker.js). Trade-off vs. the old rotating 24h ref: a
// leaked proxy link can stay valid up to 7 days — but it still only encodes a
// file URL, never the submission ID.
const REF_WINDOW_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// Expiry rounded up to the next 7-day boundary → identical for every ref minted
// for the same URL within that window (deterministic, cache-stable).
function bucketedExpiry() {
  return Math.ceil(Date.now() / REF_WINDOW_MS) * REF_WINDOW_MS;
}

function b64url(s) {
  return Buffer.from(s, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  let t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Buffer.from(t, "base64").toString("utf8");
}

// Sign a doc-ref. `fallback` (optional) is one or more backup URLs the proxy
// tries in order if the primary fetch fails — e.g. Jotform generatePDF →
// getSubmissionPDF for Sign submissions. Stored as `f` in the payload.
export function signDocRef(url, fallback) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !url) return "";
  const obj = { u: String(url), e: bucketedExpiry() };
  const fb = Array.isArray(fallback)
    ? fallback.filter(Boolean).map(String)
    : (fallback ? [String(fallback)] : []);
  if (fb.length) obj.f = fb;
  const payload = b64url(JSON.stringify(obj));
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

// Full proxy URL the browser uses. Empty string if it can't be signed (caller
// should then omit the link rather than fall back to a raw URL). `fallback` is
// an optional backup URL (or array) the proxy tries if the primary fails.
export function proxyRef(url, fallback) {
  const t = signDocRef(url, fallback);
  return t ? `/document-proxy?ref=${encodeURIComponent(t)}` : "";
}

// Node-side verify (used by the regular get-document.js fallback + tests).
// Returns the decoded URL or null.
export function verifyDocRef(token) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj;
  try { obj = JSON.parse(b64urlDecode(payload)); } catch { return null; }
  if (!obj || !obj.u || !obj.e || Date.now() > Number(obj.e)) return null;
  return String(obj.u);
}
