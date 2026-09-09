# Household document pooling

## The problem

A Jotform submission records only the email the submitter typed. Every view of
a student's uploaded documents matched that single address, so what the portal
actually showed was "files submitted under this exact email":

- a parent uploaded the passport → the student's own portal showed nothing, and
  the student uploaded it again
- an instructor opened **UPLOADED DOCUMENTS** for a student → only the subset
  the student had sent themselves, so staff chased documents already on file

## The fix

`netlify/functions/_shared/household.js` resolves the people around a student
in HubSpot, and an upload from any of them now counts as that student's.

Two sources, unioned, because each misses cases the other catches:

| Source | Catches |
|---|---|
| Contacts associated with the student's **deals** | The paying parent, a second parent added later |
| Contacts linked to the student contact-to-contact with a **label** ("Parent") | A parent who was never associated to the deal |

Only labelled contact-to-contact links widen the audience — an unlabelled link
is too weak a signal on its own. Labels matching
`referee|reference|emergency|doctor|gp|school|teacher|instructor|agent|advisor`
are dropped: one family's emergency contact is another family's parent.

Deal fan-out is capped at 10 deals, and lookups are cached in-process for 60s
so the offline-save routine (which warms `get-uploaded-documents` once per
student on the roster) doesn't repeat the same lookups.

## Which emails are matched

`submitterEmails(submission)` returns every email field that could belong to
the submitter, in display order, skipping emergency-contact-style fields:

```
next of kin | emergency | referee | reference | doctor | gp
school | teacher | instructor | agent | advisor | insurer | insurance
```

A submission is kept when one of those addresses is in the household, and the
first match is credited as the uploader.

`Parent/Guardian Email` is deliberately **not** excluded here, unlike
`THIRD_PARTY_EMAIL_RE` in `_shared/instructor-checklist.js`. On an instructor's
own PI-folder form a parent email is a third party; on a student document-upload
form the parent is usually the person submitting, and excluding those fields
would hide exactly the uploads this change exists to surface.

Without the emergency-contact filter there is a real cross-student leak: if
student B names student A's father as her next of kin, B's passport lands on
A's record. There's a test for it.

## What the endpoint returns

`get-uploaded-documents` adds to each document:

| Field | Meaning |
|---|---|
| `uploadedByName` | Contact's name, or `null` when HubSpot had none |
| `uploadedByRole` | Association label — "Parent", "Student" |
| `uploadedByStudent` | True when the student themself uploaded it |
| `uploadedByMe` | True when the logged-in caller uploaded it (never for an instructor) |
| `formId` / `formTitle` | Which form it arrived on, so the modal can group by form |

No email addresses are returned. The Jotform *submission* id is still withheld
(it grants edit access via `jotform.com/edit/<id>`); the *form* id is fine — it
is already public in the embed URL.

Plus a top-level `household` block: `people` (name, role, `isAnchor`,
`isSelf`) and `degraded`.

## Failure behaviour

Every HubSpot step fails soft. On any error the audience falls back to the
anchor email alone — the old behaviour, a thinner list rather than a broken
modal — and `household.degraded` is set to `true`. The modal then warns
"Parent records were unavailable…" instead of implying the list is complete,
and the partial result is not cached.

`degraded` is also how the UI tells "this student has no parents linked in
HubSpot" apart from "we couldn't ask".

## Authorisation

Unchanged. `?email=` still requires an `admin_role` on the caller's token; a
plain student or parent passing someone else's address gets a 403. The
household is resolved around the *requested* student, so an instructor sees
that student's family and nobody else's.

## Tests

`test/uploaded-documents.test.mjs` — 25 cases, wired into `npm test`.
Covers the audience rules, the emergency-contact leak, attribution, the
no-email-in-payload guarantee, and the pre-existing labelling behaviour that
had to survive the refactor.

Note: `npm test` also runs `test/instructor-checklist.test.mjs`, which was
listed in `README-CHANGED-FILES.md` but is not present in this bundle — add it
back from your repo, or drop it from the script.

## Files

| File | Change |
|---|---|
| `netlify/functions/_shared/household.js` | New. Audience resolution + `submitterEmails`. |
| `netlify/functions/get-uploaded-documents.js` | Matches the household; adds uploader + source-form fields; `documentsFromSubmission` exported for tests. |
| `public/index.html` | `renderStudentDocuments` groups by form, shows who uploaded each file, and states whose uploads the list covers. |
| `test/uploaded-documents.test.mjs` | New. |
| `package.json` | `npm test` runs the new file too. |

Requires `HUBSPOT_API_KEY`, which this site already sets for the checklist
mirror. No new environment variables.
