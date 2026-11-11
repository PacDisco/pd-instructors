// Which programs a signed-in person may see.
//
// Staff admins (any admin_role except the restricted ones) see every program,
// as before. Instructors — admin_role "Instructor" — see ONLY the programs
// their contact is associated with in HubSpot (custom object 2-58411705, any
// association label), and only the students on those programs. Everyone else
// (students, parents, teachers) also only sees programs they're associated
// with — the same rule portal.js already applies to them.
//
// Env: HUBSPOT_API_KEY; optional RESTRICTED_ADMIN_ROLES (comma-separated,
// default "Instructor") for roles limited to their own programs.
//
// Every check fails CLOSED: a HubSpot error means "no access".

export const PROGRAM_OBJECT = "2-58411705";

let _fetch = (...a) => fetch(...a);
/** Tests swap in a fake HubSpot. */
export function __setFetch(f) { _fetch = f; _cache.clear(); }

const restrictedRoles = () =>
  String(process.env.RESTRICTED_ADMIN_ROLES || "Instructor")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** A staff admin who sees every program (not an Instructor, not a regular user). */
export function isFullAdmin(role) {
  const r = String(role || "").trim().toLowerCase();
  return !!r && !restrictedRoles().includes(r);
}

/** Roles limited to their own programs (Instructor). */
export function isRestrictedAdmin(role) {
  const r = String(role || "").trim().toLowerCase();
  return !!r && restrictedRoles().includes(r);
}

function headers() {
  return { Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`, "Content-Type": "application/json" };
}

// Short per-container cache: a portal page makes several calls in a row.
const _cache = new Map();
const TTL = 60 * 1000;

/** Program ids the contact with this email is associated with ([] if none / unknown). Throws on HubSpot errors. */
export async function programIdsFor(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return [];
  const hit = _cache.get(e);
  if (hit && Date.now() - hit.at < TTL) return hit.ids;
  const res = await _fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: e }] }], properties: ["email"], limit: 1 }),
  });
  if (!res.ok) throw new Error(`HubSpot contact search ${res.status}`);
  const contactId = (await res.json()).results?.[0]?.id;
  let ids = [];
  if (contactId) {
    const a = await _fetch(`https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/${PROGRAM_OBJECT}?limit=500`, { headers: headers() });
    if (!a.ok) throw new Error(`HubSpot associations ${a.status}`);
    ids = ((await a.json()).results || []).map((r) => String(r.toObjectId)).filter(Boolean);
  }
  _cache.set(e, { at: Date.now(), ids });
  return ids;
}

/** May this person see this program? identity = { email, role } from the verified token. */
export async function canAccessProgram(identity, portalId) {
  if (!identity?.email || !portalId) return false;
  if (isFullAdmin(identity.role)) return true;
  try {
    return (await programIdsFor(identity.email)).includes(String(portalId));
  } catch (err) {
    console.warn("[program-access] program check failed (denying):", err?.message || err);
    return false;
  }
}

/**
 * May this person see another person's records (application, medical,
 * uploads)? Full admins: anyone. Instructors: only people on one of their
 * programs. Everyone else: only themselves (callers already allow "self").
 */
export async function canAccessPerson(identity, targetEmail) {
  const target = String(targetEmail || "").trim().toLowerCase();
  if (!identity?.email || !target) return false;
  if (target === String(identity.email).toLowerCase()) return true;
  if (isFullAdmin(identity.role)) return true;
  if (!isRestrictedAdmin(identity.role)) return false;
  try {
    const [mine, theirs] = await Promise.all([programIdsFor(identity.email), programIdsFor(target)]);
    return theirs.some((id) => mine.includes(id));
  } catch (err) {
    console.warn("[program-access] person check failed (denying):", err?.message || err);
    return false;
  }
}

export const forbidden = (message = "You don't have access to this program.") => ({
  statusCode: 403,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ error: message }),
});
