// Portal-side helpers for the INSTRUCTOR PI FOLDER document checklist.
//
// ---------------------------------------------------------------------------
// WHERE THE CHECKLIST NOW LIVES
// ---------------------------------------------------------------------------
// It used to be a mirror of the HubSpot contact property `instructor_documents`
// — which nothing ever wrote, so filling in a PI-folder form never ticked
// anything off. The source of truth is now the instructor dashboard's Postgres
// (`instructor_onboarding`), reached through its /api/instructor-checklist
// endpoint. All the Jotform classification logic lives THERE, in
// pd-dashboard's netlify/functions/_shared/instructor-checklist.js, so the
// admin roster and this portal can never drift apart.
//
// This module keeps only what the portal itself still needs:
//   1. submitterEmail()   — used by get-instructor-submissions.js for its own
//                           Jotform reads, and deliberately identical to the
//                           dashboard's copy.
//   2. HUBSPOT_MIRROR     — item key → HubSpot option label, for the one-way
//                           mirror that keeps existing HubSpot lists working.

// ---------------------------------------------------------------------------
// HubSpot mirror map
// ---------------------------------------------------------------------------
// HubSpot is downstream now: we push, we never read. The `instructor_documents`
// property has 10 options and the canonical checklist has 14 items, so four
// dashboard items have nowhere to go — Flight, Money & Credit Card, First Aid
// Kit and Van Use policies. They are intentionally absent below; add an option
// in HubSpot and a line here if you ever want them mirrored.
//
// Values must match the HubSpot property's options EXACTLY. Anything that
// doesn't match a real option is dropped before the write, so a typo here
// fails quiet instead of 400-ing the whole payload.
export const HUBSPOT_MIRROR = new Map(Object.entries({
  contract:            "Signed Contract",
  personal_info:       "Personal Information Form",
  policy_drug_alcohol: "Drug & Alcohol Policy",
  policy_device:       "Device Policy",
  doc_passport:        "Passport",
  doc_drivers_license: "Drivers License",
  doc_wfr:             "WFR Certificate",
  doc_police_check:    "Police/FBI/Background Check",
  doc_photos:          "2 Photos",
  doc_visa:            "Visa"
  // policy_flight / policy_money / policy_first_aid / policy_van — no option.
}));

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------
export function normalise(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[’']/g, "")        // driver's → drivers
    .replace(/[^a-z0-9]+/g, " ") // punctuation, slashes AND underscores → space
    .replace(/\s+/g, " ")
    .trim();
}

// Flatten a Jotform answer into plain strings. Answers arrive as strings,
// arrays, or objects (address / name sub-fields), and any can be null.
function answerValues(answer) {
  if (answer == null) return [];
  if (Array.isArray(answer)) return answer.flatMap(answerValues);
  if (typeof answer === "object") return Object.values(answer).flatMap(answerValues);
  const s = String(answer).trim();
  return s ? [s] : [];
}

// Email fields that belong to somebody OTHER than the submitter. Several
// PI-folder forms carry more than one: the Personal Information form has the
// instructor's email (qid 6) and a Next-of-Kin's (qid 40).
const THIRD_PARTY_EMAIL_RE =
  /next of kin|next-of-kin|emergency|referee|reference|guardian|parent|partner|spouse|supervisor|employer|doctor|gp\b/i;

// The submitter's own email: the first email field in display order, skipping
// any labelled as a third party's. Returns null when there is none.
//
// Matching on ANY email a submission mentions would serve one instructor's
// submission PDF to whoever they listed as their next of kin.
export function submitterEmail(submission) {
  const answers = submission?.answers || {};
  let best = null;
  for (const [qid, a] of Object.entries(answers)) {
    if (!a || typeof a !== "object") continue;
    if (String(a.type || "").toLowerCase() !== "control_email") continue;
    if (THIRD_PARTY_EMAIL_RE.test(String(a.text || a.name || ""))) continue;
    const [value] = answerValues(a.answer);
    if (!value) continue;
    const order = parseInt(a.order, 10);
    const rank = [Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER, parseInt(qid, 10) || 0];
    if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && rank[1] < best.rank[1])) {
      best = { rank, email: value.toLowerCase() };
    }
  }
  return best?.email || null;
}
