// Returns everything the logged-in instructor has SUBMITTED across the
// instructor onboarding forms, for the "SUBMITTED DOCUMENTS" section on the
// INSTRUCTOR PI FOLDER tab. Two kinds of source forms:
//
//   1. PDF forms  (policy / info forms) — the submission itself is the
//      document. We return a link to a PDF render of that submission,
//      routed through the /document-proxy edge function (which injects the
//      Jotform API key server-side and streams the file, so the API key and
//      the submission ID never reach the browser).
//
//   2. Upload form (Pacific Discovery - Instructor Document Upload Form) —
//      the submission CONTAINS uploaded files (passport, licence, photos,
//      certificates, …). We return each uploaded file as its own document,
//      same secure-proxy pattern as get-uploaded-documents.js.
//
// Email always comes from the verified session token (the caller's own
// submissions only) — there is no admin "view as" path here.
//
// Response shape:
//   {
//     documents: [
//       { formId, formTitle, kind: "pdf" | "file", label, filename, uploadedAt, url }
//     ]
//   }
//
// Required env vars: JOTFORM_API_KEY, SESSION_SECRET
// Optional env vars:
//   JOTFORM_BASE_URL              — default https://api.jotform.com
//   INSTRUCTOR_PDF_FORM_IDS       — comma-separated; override the PDF-form set
//   INSTRUCTOR_UPLOAD_FORM_IDS    — comma-separated; override the upload-form set

import { authenticate, authError } from "./_shared/auth.js";
import { proxyRef } from "./_shared/docref.js";

// Policy / info forms whose submission is rendered as a PDF. (Positions 7 & 8
// — the Contract Form + its Workflow — and the "Clone of…" duplicate and the
// MASTER.docx are intentionally excluded.)
const PDF_FORM_IDS = (process.env.INSTRUCTOR_PDF_FORM_IDS ||
  "261748248196873,261726712606861,261727594157871,261727420881863,261722834653056")
  .split(",").map(s => s.trim()).filter(Boolean);

// Forms whose submissions carry uploaded files we surface individually.
const UPLOAD_FORM_IDS = (process.env.INSTRUCTOR_UPLOAD_FORM_IDS ||
  "261607538438868")
  .split(",").map(s => s.trim()).filter(Boolean);

function baseUrl() {
  return (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");
}

export async function handler(event) {
  try {
    let identity;
    try { identity = await authenticate(event); } catch (e) { return authError(e); }

    if (!process.env.JOTFORM_API_KEY) {
      return jsonResponse(500, { error: "JOTFORM_API_KEY not configured", documents: [] });
    }
    if (!process.env.SESSION_SECRET) {
      return jsonResponse(500, { error: "SESSION_SECRET not configured", documents: [] });
    }

    const email = String(identity.email || "").toLowerCase().trim();
    const apiKey = process.env.JOTFORM_API_KEY;
    const base = baseUrl();

    // Process every form in parallel — each resolves to a (possibly empty)
    // list of documents. Fault-tolerant: a single form failing yields [].
    const pdfTasks = PDF_FORM_IDS.map(id => loadPdfFormDocs(id, email, apiKey, base));
    const upTasks  = UPLOAD_FORM_IDS.map(id => loadUploadFormDocs(id, email, apiKey, base));
    const results  = await Promise.all([...pdfTasks, ...upTasks]);

    const documents = [];
    for (const list of results) for (const d of list) documents.push(d);

    // Newest first.
    documents.sort((a, b) => {
      const ta = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
      const tb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
      return tb - ta;
    });

    return jsonResponse(200, { documents });

  } catch (err) {
    console.error("[get-instructor-submissions] threw:", err);
    return jsonResponse(500, { error: err.message || "Server error", documents: [] });
  }
}

// ---- PDF forms: one document per matching submission -----------------------
async function loadPdfFormDocs(formId, email, apiKey, base) {
  try {
    const [title, subs] = await Promise.all([
      fetchFormTitle(formId, apiKey, base),
      fetchSubmissions(formId, apiKey, base)
    ]);
    const out = [];
    for (const s of subs) {
      if (submissionEmail(s) !== email) continue;
      const sid = String(s.id || "").trim();
      if (!sid) continue;
      // PDF render of the submission via the Jotform API. We sign the URL
      // WITHOUT the api key — the /document-proxy edge function injects it
      // (and the submission id stays hidden inside the signed ref).
      const pdfUrl = `${base}/generatePDF?formID=${encodeURIComponent(formId)}` +
        `&submissionID=${encodeURIComponent(sid)}&download=1`;
      const url = proxyRef(pdfUrl);
      if (!url) continue;
      out.push({
        formId,
        formTitle: title,
        kind: "pdf",
        label: title,
        filename: `${sanitise(title)}.pdf`,
        uploadedAt: s.created_at || null,
        url
      });
    }
    return out;
  } catch (e) {
    console.warn(`[get-instructor-submissions] PDF form ${formId} failed:`, e?.message || e);
    return [];
  }
}

// ---- Upload form: one document per uploaded file ---------------------------
async function loadUploadFormDocs(formId, email, apiKey, base) {
  try {
    const [title, subs] = await Promise.all([
      fetchFormTitle(formId, apiKey, base),
      fetchSubmissions(formId, apiKey, base)
    ]);
    const out = [];
    for (const s of subs) {
      if (submissionEmail(s) !== email) continue;
      const answers = s?.answers || {};
      const ordered = Object.entries(answers)
        .map(([qid, a]) => ({ qid, ...(a || {}) }))
        .sort((x, y) => (parseInt(x.order, 10) || 0) - (parseInt(y.order, 10) || 0));

      let lastText = null;
      for (const a of ordered) {
        const t = String(a.type || "").toLowerCase();
        if (t === "control_textbox" || t === "control_textarea") {
          if (a.answer && String(a.answer).trim()) lastText = String(a.answer).trim();
          continue;
        }
        if (t !== "control_fileupload" || !a.answer) continue;

        const fieldLabel = (lastText && isGenericUploadLabel(a.text || a.name))
          ? lastText
          : (a.text || a.name || title);
        lastText = null;

        const urls = Array.isArray(a.answer) ? a.answer.filter(Boolean) : [String(a.answer)].filter(Boolean);
        for (const u of urls) {
          const url = proxyRef(u);
          if (!url) continue;
          let filename = "Document";
          try { filename = decodeURIComponent(new URL(u).pathname.split("/").pop() || "Document"); } catch (_) {}
          out.push({
            formId,
            formTitle: title,
            kind: "file",
            label: fieldLabel || title,
            filename,
            uploadedAt: s.created_at || null,
            url
          });
        }
      }
    }
    return out;
  } catch (e) {
    console.warn(`[get-instructor-submissions] upload form ${formId} failed:`, e?.message || e);
    return [];
  }
}

// ---- Jotform helpers -------------------------------------------------------
async function fetchSubmissions(formId, apiKey, base) {
  const list = [];
  let offset = 0;
  while (true) {
    const url = `${base}/form/${encodeURIComponent(formId)}/submissions` +
      `?apiKey=${encodeURIComponent(apiKey)}&limit=1000&offset=${offset}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) break;
    const data = await res.json();
    const page = Array.isArray(data?.content) ? data.content : [];
    list.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
    if (offset >= 5000) break;
  }
  return list;
}

async function fetchFormTitle(formId, apiKey, base) {
  try {
    const res = await fetch(
      `${base}/form/${encodeURIComponent(formId)}?apiKey=${encodeURIComponent(apiKey)}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return `Form ${formId}`;
    const data = await res.json();
    return decodeEntities(data?.content?.title || `Form ${formId}`);
  } catch (_) {
    return `Form ${formId}`;
  }
}

function submissionEmail(submission) {
  const answers = submission?.answers || {};
  for (const k of Object.keys(answers)) {
    const a = answers[k];
    if (a && String(a.type || "").toLowerCase() === "control_email" && a.answer) {
      return String(a.answer).toLowerCase().trim();
    }
  }
  return null;
}

function isGenericUploadLabel(label) {
  if (!label) return true;
  const l = String(label).toLowerCase().trim();
  if (!l) return true;
  return /^(additional\s+|please\s+|new\s+|another\s+)?(file\s+|document\s+|attachment\s+|photo\s+|image\s+)?(upload|attachment|file|document)s?$/i.test(l)
    || /^upload(\s+(a|the|your))?\s+(file|document|attachment|photo|image)s?$/i.test(l);
}

function sanitise(s) {
  return String(s || "document").replace(/[^\w.\- ]+/g, "").trim() || "document";
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}
