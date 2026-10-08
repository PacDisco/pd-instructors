// Weekly check-in booking, for the WEEKLY CHECK-IN view on the Instructor
// Resources tab. A thin proxy to the PD Dashboard, which owns the Google
// Calendar side (see pd-dashboard/INSTRUCTOR-CHECKINS.md).
//
//   GET  ?action=slots   → bookable start times
//   GET  ?action=mine    → the caller's upcoming check-ins
//   POST {action:"book", start, name?, notes?, repeatWeeks?}
//
// The booking email is ALWAYS the signed-in portal email (from the session
// token), never the request, so nobody can book on someone else's behalf.
// Upstream calls carry X-PD-Service-Key, the same shared secret as
// get-instructor-documents.js.
//
// Not in the service worker's CACHEABLE_DATA list on purpose: slots must be live.
//
// Env: INSTRUCTOR_PORTAL_KEY (already set), CHECKINS_API_URL
//      e.g. https://dashboard.pacificdiscovery.org/api/checkins

import { authenticate, authError } from "./_shared/auth.js";

export async function handler(event) {
  let identity;
  try { identity = await authenticate(event); } catch (e) { return authError(e); }

  const base = String(process.env.CHECKINS_API_URL || "").replace(/\/+$/, "");
  const key = process.env.INSTRUCTOR_PORTAL_KEY || "";
  if (!base || !key) {
    console.error("[checkins] CHECKINS_API_URL / INSTRUCTOR_PORTAL_KEY not configured");
    return jsonResponse(503, { error: "Check-in booking isn't configured yet." });
  }

  const method = event.httpMethod || "GET";
  let action = (event.queryStringParameters || {}).action || "";
  let body = null;
  if (method === "POST") {
    try { body = JSON.parse(event.body || "{}"); } catch { return jsonResponse(400, { error: "Invalid request" }); }
    action = body.action || action;
  }

  let url, init = { headers: { "X-PD-Service-Key": key, Accept: "application/json" } };
  if (method === "GET" && action === "slots") {
    url = `${base}/slots`;
  } else if (method === "GET" && action === "mine") {
    url = `${base}/mine?email=${encodeURIComponent(identity.email)}`;
  } else if (method === "POST" && action === "book") {
    url = `${base}/book`;
    init.method = "POST";
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify({
      start: body.start,
      email: identity.email,
      name: String(body.name || "").slice(0, 100) || identity.email,
      notes: String(body.notes || "").slice(0, 1000),
      repeatWeeks: body.repeatWeeks,
    });
  } else {
    return jsonResponse(400, { error: "Unknown action" });
  }

  try {
    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    // Never pass an upstream 401 through: the portal's fetch wrapper treats
    // 401 as "your session ended" and signs the instructor out.
    const status = res.status === 401 || res.status === 403 ? 502 : res.status;
    if (res.status === 403) console.error("[checkins] dashboard rejected the service key");
    return jsonResponse(status, data);
  } catch (err) {
    console.error("[checkins] upstream failed:", err?.message || err);
    return jsonResponse(502, { error: "Couldn't reach the booking service. Please try again." });
  }
}

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}
