# pd-instructors (portal) — changed files

Copy these over your repo at the same paths. `CHANGES.diff` is a unified diff of
every modified file if you'd rather review before overwriting.

**Deploy the dashboard first** — this site now depends on its
`/api/instructor-checklist` endpoint.

## New

| File | What it is |
|---|---|
| `netlify/functions/_shared/instructor-checklist.js` | `submitterEmail` (first email field, skipping next-of-kin / emergency-contact fields) and `HUBSPOT_MIRROR`, the item→HubSpot-option map. The Jotform classification logic lives in **pd-dashboard**, not here. |
| `INSTRUCTOR-DOC-CHECKLIST.md` | Where the checklist comes from, the HubSpot mirror, and how to retire HubSpot entirely. |
| `test/instructor-checklist.test.mjs` | 58 cases. `npm test`. |

## Modified

| File | Change |
|---|---|
| `netlify/functions/get-instructor-documents.js` | Rewritten. Reads the checklist from the dashboard over the shared secret instead of HubSpot; HubSpot is now a one-way mirror that can't delete data or 400-loop; returns 503 (not 200) on failure so the service worker won't cache an error state. |
| `netlify/functions/get-instructor-submissions.js` | Uses the shared `submitterEmail`, so a form listing another instructor as next of kin can't expose the submitter's PDF to them; filters out Jotform-deleted submissions. |
| `public/index.html` | `loadInstructorDocChecklist` handles the degraded response instead of rendering a false "All documents uploaded". |
| `package.json` | Adds `npm test`. |

## Environment variables

Set on this site:

| Var | Value |
|---|---|
| `INSTRUCTOR_API_URL` | `https://<dashboard-site>/api/instructor-checklist` |
| `INSTRUCTOR_PORTAL_KEY` | Same value as on the dashboard (≥24 chars) |

`HUBSPOT_API_KEY` stays for the mirror. Remove it — or set
`INSTRUCTOR_CHECKLIST_SYNC=off` — when you're ready to drop HubSpot; the
checklist keeps working, and there's a test covering that end state.

## Unchanged since the last bundle

Nothing in this repo changed while the dashboard document work was done. If you
already applied the previous portal bundle, you can skip this one.
