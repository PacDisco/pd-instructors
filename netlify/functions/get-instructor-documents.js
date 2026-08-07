// Returns the INSTRUCTOR PI FOLDER document checklist for the logged-in
// contact, used by the "INSTRUCTOR PI FOLDER" tab on the portal.
//
// ---------------------------------------------------------------------------
// SOURCE OF TRUTH: THE INSTRUCTOR DASHBOARD, NOT HUBSPOT
// ---------------------------------------------------------------------------
// This used to read a HubSpot contact property (`instructor_documents`) that
// nothing anywhere ever wrote, so filling in a PI-folder form never ticked
// anything off. The checklist now comes from the instructor dashboard's
// Postgres — the same `instructor_onboarding` table the admin Instructors page
// manages — via its service endpoint:
//
//     GET {INSTRUCTOR_API_URL}?email=...
//     X-PD-Service-Key: {INSTRUCTOR_PORTAL_KEY}
//
// That endpoint re-derives from Jotform for this one instructor before
// answering, so a form submitted a minute ago already shows as done, and the
// admin dashboard stays current as a side effect of instructors using the
// portal. It also resolves the instructor's alternate email addresses, which
// fixes the long-standing case of someone filing Jotform from a different
// address than the one on their record.
//
// ---------------------------------------------------------------------------
// HUBSPOT IS NOW A ONE-WAY MIRROR
// ---------------------------------------------------------------------------
// We no longer READ HubSpot for the checklist. We still PUSH the computed set
// into `instructor_documents` so existing HubSpot lists, views, workflows and
// reports keep working during the transition. Ten of the fourteen items have a
// HubSpot option; the four extra policies don't and are skipped (see
// HUBSPOT_MIRROR in _shared/instructor-checklist.js).
//
// The mirror is best-effort and never affects the response. It is:
//   * skipped when a stored value matches no current option, because
//     `instructor_documents` is an enumeration — including such a value 400s
//     the whole payload, and excluding it would DELETE it (the PATCH replaces
//     the property wholesale);
//   * de-duplicated across requests, since HubSpot's CRM search index lags a
//     direct PATCH and every tab open inside that window would otherwise
//     re-issue an identical write.
// Set INSTRUCTOR_CHECKLIST_SYNC=off to stop writing to HubSpot entirely — the
// checklist keeps working, because HubSpot is no longer an input.
//
// ---------------------------------------------------------------------------
// Response shape (unchanged for the frontend):
//   {
//     options:     [<every checklist label>],
//     uploaded:    [<labels completed>],
//     outstanding: [<labels still needed>],
//     items:       [{ item, label, kind, completed }],  // richer, optional
//     contactId:   "<HubSpot id>" | null,
//     synced:      true | false,   // did we write to HubSpot on THIS call
//     degraded:    true            // 503 only: the checklist is unknown, so
//                                  // the caller MUST NOT present it as one
//     warning:     "<string>"
//   }
//
// Email always comes from the verified session token, never the request.
//
// Required env vars:
//   INSTRUCTOR_API_URL     e.g. https://<dashboard-site>/api/instructor-checklist
//   INSTRUCTOR_PORTAL_KEY  shared secret; must match the dashboard's
//   SESSION_SECRET
// Optional:
//   HUBSPOT_API_KEY               mirror is skipped entirely without it
//   INSTRUCTOR_DOCUMENTS_PROPERTY default "instructor_documents"
//   INSTRUCTOR_CHECKLIST_SYNC     "off" disables the HubSpot mirror
//   INSTRUCTOR_API_TIMEOUT_MS     default 9000

import { authenticate, authError } from "./_shared/auth.js";
import { HUBSPOT_MIRROR, normalise } from "./_shared/instructor-checklist.js";

const PROPERTY_NAME = process.env.INSTRUCTOR_DOCUMENTS_PROPERTY || "instructor_documents";
const SYNC_ENABLED = String(process.env.INSTRUCTOR_CHECKLIST_SYNC || "on").toLowerCase() !== "off";
const API_TIMEOUT_MS = Number(process.env.INSTRUCTOR_API_TIMEOUT_MS) > 0
  ? Number(process.env.INSTRUCTOR_API_TIMEOUT_MS)
  : 9000;

// How long to remember a HubSpot write (or a failed one). HubSpot's CRM search
// index — how we read the current value — can lag a direct PATCH by minutes,
// so a short memo would let the identical payload re-fire once a minute for an
// active user. Five minutes covers realistic lag; the `identical` check takes
// over permanently once the index catches up.
const WRITE_MEMO_MS = 300000;
const _writeMemo = new Map(); // contactId -> { value, ts, ok }

function sweep(map, ttl) {
  const now = Date.now();
  for (const [k, v] of map) if (now - v.ts >= ttl) map.delete(k);
}

export async function handler(event) {
  try {
    let identity;
    try { identity = await authenticate(event); } catch (e) { return authError(e); }

    const apiUrl = process.env.INSTRUCTOR_API_URL;
    const apiKey = process.env.INSTRUCTOR_PORTAL_KEY;
    if (!apiUrl || !apiKey) {
      console.error("[get-instructor-documents] INSTRUCTOR_API_URL / INSTRUCTOR_PORTAL_KEY not configured");
      return jsonResponse(503, {
        options: [], uploaded: [], outstanding: [], contactId: null, synced: false,
        degraded: true, warning: "instructor checklist service not configured"
      });
    }

    const email = identity.email;

    // -----------------------------------------------------------------------
    // 1. Ask the dashboard. This is the whole checklist — items, labels, and
    //    completion. No HubSpot involved.
    // -----------------------------------------------------------------------
    let data;
    try {
      data = await fetchChecklist(apiUrl, apiKey, email);
    } catch (err) {
      // Deliberately 503, not 200: this endpoint is in the service worker's
      // CACHEABLE_DATA list and networkFirstData caches any res.ok, so a 200
      // here would overwrite the instructor's last good offline copy with an
      // error state for up to 7 days. A non-ok response is never cached, and
      // the frontend's `!res.ok` branch already renders the right message.
      console.error("[get-instructor-documents] checklist service failed:", err?.message || err);
      return jsonResponse(503, {
        options: [], uploaded: [], outstanding: [], contactId: null, synced: false,
        degraded: true, warning: `checklist service unavailable: ${err?.message || err}`
      });
    }

    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
      // A configured, reachable service that knows of no items at all means
      // the checklist really is empty — not an error.
      return jsonResponse(200, {
        options: [], uploaded: [], outstanding: [], items: [],
        contactId: null, synced: false
      });
    }

    const options     = items.map(i => i.label);
    const uploaded    = items.filter(i => i.completed).map(i => i.label);
    const outstanding = items.filter(i => !i.completed).map(i => i.label);

    // -----------------------------------------------------------------------
    // 2. Mirror into HubSpot. Downstream only — a failure here never changes
    //    what the instructor sees.
    // -----------------------------------------------------------------------
    let contactId = null, synced = false, mirrorWarning = null;
    if (SYNC_ENABLED && process.env.HUBSPOT_API_KEY) {
      try {
        const r = await mirrorToHubSpot(email, items);
        contactId = r.contactId;
        synced = r.synced;
        mirrorWarning = r.warning;
      } catch (e) {
        mirrorWarning = `HubSpot mirror failed: ${e?.message || e}`;
        console.warn(`[get-instructor-documents] ${mirrorWarning}`);
      }
    }

    const body = { options, uploaded, outstanding, items, contactId, synced };
    const warnings = [data?.warning, mirrorWarning].filter(Boolean);
    if (warnings.length) body.warning = warnings.join("; ");
    return jsonResponse(200, body);

  } catch (err) {
    console.error("[get-instructor-documents] threw:", err);
    return jsonResponse(500, { error: err.message || "Server error" });
  }
}

// ---------------------------------------------------------------------------
// Dashboard service call
// ---------------------------------------------------------------------------
async function fetchChecklist(apiUrl, apiKey, email) {
  const url = new URL(apiUrl);
  url.searchParams.set("email", email);

  // Netlify's sync function budget is ~10s; time out below it so we return a
  // clean 503 instead of the platform killing us mid-response.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "X-PD-Service-Key": apiKey, Accept: "application/json" },
      signal: ctrl.signal
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// HubSpot one-way mirror
// ---------------------------------------------------------------------------
async function mirrorToHubSpot(email, items) {
  const headers = {
    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
    "Content-Type": "application/json"
  };

  const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST",
    headers,
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email", PROPERTY_NAME]
    })
  });
  if (!searchRes.ok) return { contactId: null, synced: false, warning: `HubSpot contact lookup ${searchRes.status}` };
  const contact = (await searchRes.json()).results?.[0];
  if (!contact?.id) return { contactId: null, synced: false, warning: null };

  const propRes = await fetch(
    `https://api.hubapi.com/crm/v3/properties/contacts/${encodeURIComponent(PROPERTY_NAME)}`,
    { headers }
  );
  if (!propRes.ok) {
    return { contactId: contact.id, synced: false, warning: `HubSpot property read ${propRes.status}` };
  }
  const optionDefs = ((await propRes.json()).options || [])
    .map(o => ({
      label: (o && (o.label || o.value)) || "",
      value: (o && (o.value != null ? o.value : o.label)) || ""
    }))
    .filter(o => o.label);
  const byNorm = new Map();
  for (const o of optionDefs) {
    byNorm.set(normalise(o.label), o);
    if (o.value) byNorm.set(normalise(o.value), o);
  }

  // Completed items → HubSpot option values, dropping anything with no option.
  const values = [];
  for (const i of items) {
    if (!i.completed) continue;
    const mapped = HUBSPOT_MIRROR.get(i.item);
    if (!mapped) continue;
    const opt = byNorm.get(normalise(mapped));
    if (opt) values.push(opt.value);
  }

  const storedValues = String(contact.properties?.[PROPERTY_NAME] || "")
    .split(";").map(s => s.trim()).filter(Boolean);

  // A PATCH replaces this property WHOLESALE, so anything we don't send is
  // deleted. Stored values fall into three groups:
  //
  //   unresolved — matches no current option. Can't be included (HubSpot
  //                rejects the entire enumeration payload) and can't be
  //                dropped (that erases it). So: skip the write entirely.
  //   unmanaged  — a valid option that this mirror never writes, e.g. an
  //                option added in HubSpot for something outside the 14-item
  //                checklist. Must be CARRIED THROUGH, or the first mirror
  //                write silently deletes someone's data.
  //   managed    — an option this mirror owns; replaced by the computed set.
  const managedNorm = new Set(
    [...HUBSPOT_MIRROR.values()].map(normalise).filter(n => byNorm.has(n))
  );
  const unresolved = storedValues.filter(v => !byNorm.has(normalise(v)));
  if (unresolved.length) {
    const msg = `contact ${contact.id}: stored ${PROPERTY_NAME} value(s) match no current option ` +
      `(${unresolved.join(", ")}) — skipping the HubSpot mirror so they aren't erased`;
    console.warn(`[get-instructor-documents] ${msg}`);
    return { contactId: contact.id, synced: false, warning: msg };
  }
  const unmanaged = storedValues
    .filter(v => !managedNorm.has(normalise(v)))
    .map(v => byNorm.get(normalise(v)).value);

  const nextValue = [...new Set([...unmanaged, ...values])].join(";");

  const storedNorm = new Set(storedValues.map(normalise));
  const nextNorm = new Set(nextValue ? nextValue.split(";").map(normalise) : []);
  const identical = storedNorm.size === nextNorm.size && [...nextNorm].every(v => storedNorm.has(v));
  if (identical) return { contactId: contact.id, synced: false, warning: null };

  const memo = _writeMemo.get(contact.id);
  if (memo && memo.value === nextValue && Date.now() - memo.ts < WRITE_MEMO_MS) {
    // The search index hasn't caught up with our write yet, or that exact
    // payload just failed. Either way, don't send it again.
    return { contactId: contact.id, synced: false, warning: null };
  }

  let ok = false, warning = null;
  const patch = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ properties: { [PROPERTY_NAME]: nextValue } })
  });
  ok = patch.ok;
  if (!ok) {
    warning = `HubSpot mirror PATCH ${patch.status}`;
    console.warn(`[get-instructor-documents] ${warning}`,
      (await patch.text().catch(() => "")).slice(0, 300));
  }
  sweep(_writeMemo, WRITE_MEMO_MS);
  _writeMemo.set(contact.id, { value: nextValue, ts: Date.now(), ok });

  return { contactId: contact.id, synced: ok, warning };
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}
