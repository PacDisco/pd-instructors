// Streams a Jotform-hosted file through Netlify so portal users can view
// their uploaded documents without needing a Jotform account.
//
// This is the EDGE-FUNCTION version of get-document. It exists because the
// regular serverless function caps responses at ~6MB (after base64 encoding),
// and a single iPhone portrait photo is often 4–8MB raw — which became
// "Function.ResponseSizeTooLarge" once base64'd. Edge functions stream the
// upstream response body straight through with no buffering, lifting that
// cap to ~20MB and eliminating the base64 overhead entirely.
//
// Inputs (querystring):
//   url — the full Jotform file URL returned by /form/{id}/submissions
//
// Required env var (Netlify): JOTFORM_API_KEY
//
// Frontend integration:
//   Build URLs like `/document-proxy?url=<encoded jotform URL>` from
//   get-students.js (portrait photos) and get-uploaded-documents.js
//   (document uploads). Both have been updated.

export default async (request, context) => {
  const url = new URL(request.url);

  // The browser only ever gets an opaque, HMAC-signed `ref` (see
  // _shared/docref.js). We verify + decode it server-side, so the real
  // Jotform URL (and the submission ID in its path) never reaches the client.
  // Raw `?url=` is intentionally no longer accepted.
  const ref = url.searchParams.get("ref");
  if (!ref) {
    return jsonResponse({ error: "Missing ref" }, 400);
  }
  const secret = Netlify.env.get("SESSION_SECRET");
  if (!secret) {
    return jsonResponse({ error: "Server is not configured" }, 500);
  }
  const decoded = await verifyRef(ref, secret);
  if (!decoded || !decoded.u) {
    return jsonResponse({ error: "Invalid or expired reference" }, 403);
  }

  // Primary URL first, then any fallbacks. This lets a caller register a
  // backup endpoint — e.g. Jotform's generatePDF → getSubmissionPDF for Sign
  // submissions that 400 on the first one — so a single failed endpoint
  // doesn't surface as an error when an alternative would have worked.
  const fallbacks = Array.isArray(decoded.f) ? decoded.f : (decoded.f ? [decoded.f] : []);
  const candidates = [decoded.u, ...fallbacks].filter(Boolean);

  let last = { status: 502, body: { error: "Upstream fetch failed" } };
  for (const raw of candidates) {
    const r = await attemptUpstream(raw);
    if (r.ok) {
      // Pass the upstream body straight through. ReadableStream →
      // ReadableStream, no .arrayBuffer(), no base64. This is the whole
      // reason we're an edge fn.
      return new Response(r.response.body, {
        status: 200,
        headers: {
          "Content-Type": r.contentType,
          "Content-Disposition": `inline; filename="${r.filename}"`,
          "Cache-Control": "private, max-age=300"
        }
      });
    }
    last = r;
  }
  return jsonResponse(last.body, last.status);
};

// Validate one candidate URL's host, inject the Jotform API key, and fetch it.
// Returns { ok:true, response, contentType, filename } on success, or
// { ok:false, status, body } describing the failure so the caller can try the
// next candidate (or surface the last error).
async function attemptUpstream(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch (_) {
    return { ok: false, status: 400, body: { error: "Invalid url" } };
  }

  const host = parsed.hostname.toLowerCase();
  const isJotform = (
    host === "jotform.com" || host.endsWith(".jotform.com") ||
    host === "jotfor.ms"   || host.endsWith(".jotfor.ms")
  );
  // HubSpot file CDN hosts. We allow these so that leader-card photos
  // (cross-origin HubSpot images that iOS Safari sometimes refuses to
  // render in <img> when fetched through a service worker) can be
  // proxied as same-origin and rendered reliably on every device.
  const isHubSpotCdn = (
    /\.hubspotusercontent\b/i.test(host) ||  // *.fs1.hubspotusercontent-na1.net etc.
    host.endsWith(".hubspot.com") ||
    host === "hubspot.com" ||
    /\.hubapi\.com$/i.test(host)
  );
  if (!isJotform && !isHubSpotCdn) {
    return { ok: false, status: 400, body: { error: "Only Jotform or HubSpot URLs are allowed", host } };
  }

  // Per-host upstream config. Jotform requires the API key in the URL;
  // HubSpot CDN URLs are public and sometimes already signed.
  if (isJotform) {
    const apiKey = Netlify.env.get("JOTFORM_API_KEY");
    if (!apiKey) {
      return { ok: false, status: 500, body: { error: "Jotform is not configured", details: "Set JOTFORM_API_KEY in Netlify environment variables." } };
    }
    // Most Jotform endpoints accept `apiKey`; the pdf-converter/fill-pdf
    // endpoint expects lowercase `apikey`. Set both — harmless, server-side,
    // and the key never reaches the browser either way.
    parsed.searchParams.set("apiKey", apiKey);
    parsed.searchParams.set("apikey", apiKey);
  }

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), { redirect: "follow" });
  } catch (err) {
    console.error(`[document-proxy] fetch threw for ${parsed.host}${parsed.pathname}:`, err?.message || err);
    return { ok: false, status: 502, body: { error: "Upstream fetch failed", details: String(err?.message || err) } };
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    console.warn(
      `[document-proxy] upstream non-OK ${upstream.status} for ${parsed.host}${parsed.pathname} — ${text.slice(0, 200)}`
    );
    return {
      ok: false,
      status: upstream.status,
      body: { error: `Jotform returned ${upstream.status}`, host: parsed.host, path: parsed.pathname, details: text.slice(0, 500) }
    };
  }

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  const filename = decodeURIComponent(
    parsed.pathname.split("/").pop() || "document"
  ).replace(/"/g, "");

  return { ok: true, response: upstream, contentType, filename };
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// Verify a signed doc-ref token and return the decoded payload { u, f }, or
// null. `f` (optional) is one or more fallback URLs. Mirrors
// netlify/functions/_shared/docref.js exactly:
//   token = base64url(JSON({ u, e, f? })) + "." + hex(HMAC_SHA256(payload))
async function verifyRef(token, secret) {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sigHex = token.slice(dot + 1);
  const enc = new TextEncoder();
  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    ok = await crypto.subtle.verify("HMAC", key, hexToBytes(sigHex), enc.encode(payload));
  } catch (_) {
    return null;
  }
  if (!ok) return null;
  let obj;
  try { obj = JSON.parse(b64urlDecode(payload)); } catch (_) { return null; }
  if (!obj || !obj.u || !obj.e || Date.now() > Number(obj.e)) return null;
  const f = Array.isArray(obj.f)
    ? obj.f.map(String)
    : (obj.f ? [String(obj.f)] : []);
  return { u: String(obj.u), f };
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 || !/^[0-9a-fA-F]*$/.test(hex)) return new Uint8Array();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function b64urlDecode(s) {
  let t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Bind this edge function to /document-proxy. The frontend (and the URL
// builders inside get-students.js / get-uploaded-documents.js) all hit this
// path now instead of /.netlify/functions/get-document.
export const config = {
  path: "/document-proxy"
};
