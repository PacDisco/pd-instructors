# Instructor PI Folder — document checklist

How the DOCUMENT CHECKLIST on the **INSTRUCTOR PI FOLDER** tab decides what's
ticked, and what to do when something doesn't tick.

## Where the data comes from

The checklist used to mirror a HubSpot contact property (`instructor_documents`)
that nothing anywhere ever wrote — not this repo, not any Jotform→HubSpot sync.
So filling in a PI-folder form never ticked anything; boxes only turned green
when an admin hand-ticked them in HubSpot.

The source of truth is now the **instructor dashboard's Postgres**
(`instructor_onboarding`) — the same table the admin Instructors page manages.
This portal is a client:

```
GET {INSTRUCTOR_API_URL}?email=<the logged-in instructor>
X-PD-Service-Key: {INSTRUCTOR_PORTAL_KEY}
```

That endpoint re-derives from Jotform for this one instructor before answering,
so a form submitted a minute ago already shows as done, and the admin dashboard
stays current as a side effect of instructors using their portal. It also
resolves the instructor's alternate email addresses, which fixes the
long-standing case of someone filing Jotform from a different address than the
one on their record.

All the Jotform classification logic lives in **pd-dashboard**
(`netlify/functions/_shared/instructor-checklist.js`). Change the item list,
the document mapping, or the filename matchers there — not here — so the admin
roster and this portal can't drift apart. That repo's `INSTRUCTOR-CHECKLIST.md`
documents the rules.

## The 14 items

Eight forms — Signed Contract, Personal Information, and the Device, Drug &
Alcohol, Flight, Money & Credit Card, First Aid Kit and Van Use policies — plus
six documents: Passport, Drivers License, WFR Certificate,
Police/FBI/Background Check, 2 Photos, Visa.

A document ticks only when a **file is actually attached**. Picking a document
type on the upload form and attaching nothing credits nothing.

## HubSpot is now a one-way mirror

We no longer read HubSpot for the checklist. We still push the computed set into
`instructor_documents` so existing HubSpot lists, views, workflows and reports
keep working. Ten of the fourteen items have a HubSpot option; the Flight,
Money, First Aid Kit and Van Use policies don't and are skipped — see
`HUBSPOT_MIRROR` in `netlify/functions/_shared/instructor-checklist.js`.

The mirror never affects what the instructor sees. It is skipped entirely when
the contact holds a value matching no current option (including it would 400 the
enumeration payload; excluding it would erase it), and any valid option the
mirror doesn't own is carried through rather than deleted.

**To retire HubSpot completely:** set `INSTRUCTOR_CHECKLIST_SYNC=off`, or just
remove `HUBSPOT_API_KEY`. The checklist keeps working either way — HubSpot is no
longer an input. There's a test covering exactly that end state.

## When a box won't tick

1. Did the instructor actually **attach a file**, or only pick the type? Check
   SUBMITTED DOCUMENTS on the same tab.
2. Does the Jotform submission email match the instructor's dashboard profile —
   primary or `alt_emails`? Add the alias in the Instructors drawer if not.
3. Is the item **pinned** in the dashboard? A hand-toggled item shows "pinned"
   and the Jotform sync will not change it.
4. Check the function logs for `[get-instructor-documents]` and, on the
   dashboard, `[instructor-checklist]`.

## Environment variables

Required: `INSTRUCTOR_API_URL`, `INSTRUCTOR_PORTAL_KEY`, `SESSION_SECRET`.

| Optional | Default | Purpose |
|---|---|---|
| `HUBSPOT_API_KEY` | — | Without it the HubSpot mirror is skipped entirely |
| `INSTRUCTOR_CHECKLIST_SYNC` | `on` | `off` disables the HubSpot mirror |
| `INSTRUCTOR_DOCUMENTS_PROPERTY` | `instructor_documents` | HubSpot property name |
| `INSTRUCTOR_API_TIMEOUT_MS` | `9000` | Below Netlify's ~10s function budget |

`INSTRUCTOR_PORTAL_KEY` must be the **same value** as on the dashboard site, and
at least 24 characters (`openssl rand -hex 32`).

## Failure behaviour

If the dashboard is unreachable or misconfigured this endpoint returns **503**,
and the tab shows "Couldn't load the document checklist right now."

That's deliberate. This endpoint is in the service worker's `CACHEABLE_DATA`
list and `networkFirstData` caches any `res.ok`, so returning a 200 with an
empty checklist would overwrite the instructor's last good offline copy with an
error state for up to seven days — and an empty `outstanding` list renders as a
green "All documents uploaded", the most reassuring possible falsehood.

## Files

| File | Role |
|---|---|
| `netlify/functions/get-instructor-documents.js` | Calls the dashboard, shapes the response, mirrors to HubSpot |
| `netlify/functions/_shared/instructor-checklist.js` | `submitterEmail` + the HubSpot mirror map |
| `netlify/functions/get-instructor-submissions.js` | Shares `submitterEmail`; filters deleted submissions |
| `public/index.html` | `loadInstructorDocChecklist` handles the degraded response |
| `test/instructor-checklist.test.mjs` | 58 cases — `npm test` |

## Tests

```
npm test
```

Runs offline against a stubbed dashboard and HubSpot: response shaping, the
shared-secret call, every degraded path, and the mirror's delete-safety and
write-deduplication rules.
