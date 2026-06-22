// Returns the INSTRUCTOR PI FOLDER document checklist for the logged-in
// contact, used by the "INSTRUCTOR PI FOLDER" tab on the portal.
//
// Reads a single multi-checkbox property on the *contact* — internal name
// `instructor_documents` by default (override with the
// INSTRUCTOR_DOCUMENTS_PROPERTY env var if HubSpot ever renames it). The
// property's master list of *options* (defined at the property level in
// HubSpot Settings) is the universe of possible documents. The current
// value on the contact is the subset that has *already been uploaded*.
//
// NOTE on polarity — this is the OPPOSITE of the student-facing
// get-document-checklist.js (where a value on the deal = still pending).
// Here, a selected option on the contact = UPLOADED / done. Anything in the
// property's option list that is NOT selected is still OUTSTANDING.
//
// Response shape:
//   {
//     options:     [<every possible document label>],
//     uploaded:    [<options currently selected on the contact — done>],
//     outstanding: [<options NOT selected — still needed>],
//     contactId:   "<id>" | null
//   }
//
// Email always comes from the verified session token (the caller's own
// record), never from the request — there is no admin "view as" path here.
//
// Required env var: HUBSPOT_API_KEY
// Optional env var: INSTRUCTOR_DOCUMENTS_PROPERTY — override internal name
//                   if HubSpot uses something other than "instructor_documents".

const PROPERTY_NAME = process.env.INSTRUCTOR_DOCUMENTS_PROPERTY || "instructor_documents";

import { authenticate, authError } from "./_shared/auth.js";

export async function handler(event) {
  try {
    let identity;
    try { identity = await authenticate(event); } catch (e) { return authError(e); }
    if (!process.env.HUBSPOT_API_KEY) {
      return jsonResponse(500, { error: "HUBSPOT_API_KEY not configured" });
    }

    const cleanEmail = identity.email;
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // 1. Find the contact by email AND read the instructor_documents value
    //    in the same call (search lets us request specific properties back).
    const contactRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filterGroups: [{
            filters: [{ propertyName: "email", operator: "EQ", value: cleanEmail }]
          }],
          properties: ["email", PROPERTY_NAME]
        })
      }
    );
    if (!contactRes.ok) {
      return jsonResponse(502, {
        error: "Contact lookup failed",
        details: `HubSpot ${contactRes.status}`
      });
    }
    const contactData = await contactRes.json();
    const contact = contactData.results?.[0];
    if (!contact) {
      return jsonResponse(200, { options: [], uploaded: [], outstanding: [], contactId: null });
    }

    // HubSpot multi-checkbox values come back as a semicolon-separated
    // string. Split, trim, drop empties. These are the UPLOADED docs.
    const rawValue = (contact.properties?.[PROPERTY_NAME] || "").trim();
    const uploaded = rawValue
      .split(";")
      .map(s => s.trim())
      .filter(Boolean);

    // 2. Fetch the property definition to get the master list of options
    //    so we can compute "outstanding" = options - uploaded.
    const propRes = await fetch(
      `https://api.hubapi.com/crm/v3/properties/contacts/${encodeURIComponent(PROPERTY_NAME)}`,
      { headers }
    );

    let options = [];
    if (propRes.ok) {
      const propData = await propRes.json();
      options = (propData.options || [])
        .map(o => (o && (o.label || o.value)) || "")
        .filter(Boolean);
    } else {
      // Couldn't read the property definition — fall back to showing
      // just the uploaded list (no "outstanding" items rendered).
      console.warn(`[get-instructor-documents] property fetch failed: ${propRes.status}`);
      options = uploaded.slice();
    }

    // Set-based diff so we don't depend on exact array order / casing.
    const uploadedSet = new Set(uploaded.map(v => v.toLowerCase()));
    const outstanding = options.filter(o => !uploadedSet.has(o.toLowerCase()));

    return jsonResponse(200, {
      options,
      uploaded,
      outstanding,
      contactId: contact.id || null
    });

  } catch (err) {
    console.error("[get-instructor-documents] threw:", err);
    return jsonResponse(500, { error: err.message || "Server error" });
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}
