// node test/program-access.test.mjs — Instructors only see their own programs.
import assert from "node:assert/strict";
process.env.HUBSPOT_API_KEY = "hs"; process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret";
const A = await import("../netlify/functions/_shared/program-access.js");

// Fake HubSpot: contacts and their program associations.
const PEOPLE = { "ins@pd.org": ["100"], "ins2@pd.org": ["200"], "stu@x.nz": ["100"], "other@x.nz": ["200"], "dir@pd.org": [] };
let fail = false;
A.__setFetch(async (url, opts = {}) => {
  if (fail) return { ok: false, status: 500, json: async () => ({}) };
  const u = String(url);
  if (u.endsWith("/contacts/search")) {
    const e = JSON.parse(opts.body).filterGroups[0].filters[0].value;
    return { ok: true, json: async () => ({ results: PEOPLE[e] ? [{ id: `c-${e}` }] : [] }) };
  }
  const m = /contacts\/c-([^/]+)\/associations\/2-58411705/.exec(decodeURIComponent(u));
  if (m) return { ok: true, json: async () => ({ results: (PEOPLE[m[1]] || []).map((id) => ({ toObjectId: id })) }) };
  throw new Error(`unexpected ${u}`);
});

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("  ✓", name); };
const ins = { email: "ins@pd.org", role: "Instructor" };
const dir = { email: "dir@pd.org", role: "Admissions Director" };
const stu = { email: "stu@x.nz", role: "" };

await t("roles: Instructor is restricted, other admin roles are staff", async () => {
  assert.equal(A.isFullAdmin("Admissions Director"), true); assert.equal(A.isFullAdmin("Instructor"), false); assert.equal(A.isFullAdmin(""), false);
  assert.equal(A.isRestrictedAdmin("instructor"), true);
});
await t("programs: Instructors only their own; staff admins all; students their own", async () => {
  assert.equal(await A.canAccessProgram(ins, "100"), true);
  assert.equal(await A.canAccessProgram(ins, "200"), false);
  assert.equal(await A.canAccessProgram(dir, "200"), true);
  assert.equal(await A.canAccessProgram(stu, "100"), true);
  assert.equal(await A.canAccessProgram(stu, "200"), false);
});
await t("people: Instructors only students on their programs", async () => {
  assert.equal(await A.canAccessPerson(ins, "stu@x.nz"), true);
  assert.equal(await A.canAccessPerson(ins, "other@x.nz"), false);
  assert.equal(await A.canAccessPerson(ins, "nobody@x.nz"), false);
  assert.equal(await A.canAccessPerson(dir, "other@x.nz"), true);
  assert.equal(await A.canAccessPerson(stu, "other@x.nz"), false);
  assert.equal(await A.canAccessPerson(stu, "STU@x.nz"), true, "self");
});
await t("fails closed when HubSpot errors", async () => {
  A.__setFetch.call(null, async () => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.equal(await A.canAccessProgram({ email: "ins2@pd.org", role: "Instructor" }, "200"), false);
  assert.equal(await A.canAccessProgram(dir, "200"), true, "staff admins don't depend on HubSpot");
});
console.log(`${n} passed`);

// ── the endpoints, with a fake HubSpot behind global fetch ──
{
  const PROGRAMS = [{ id: "100", properties: { program_name: "Fall A", program_start_date: "2026-09-10", program_end_date: "2026-11-18" } }, { id: "200", properties: { program_name: "Fall B", program_start_date: "2026-09-10", program_end_date: "2026-11-18" } }];
  globalThis.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (u.endsWith("/contacts/search")) {
      const e = JSON.parse(opts.body).filterGroups[0].filters[0].value;
      return ok({ results: PEOPLE[e] ? [{ id: `c-${e}`, properties: { email: e, admin_role: e.endsWith("@pd.org") ? "x" : "" } }] : [] });
    }
    let m;
    if ((m = /contacts\/c-([^/?]+)\/associations\/2-58411705/.exec(u))) return ok({ results: (PEOPLE[m[1]] || []).map((id) => ({ toObjectId: id })) });
    if (/\/crm\/v3\/objects\/2-58411705\?/.test(u)) return ok({ results: PROGRAMS });
    return { ok: false, status: 599, json: async () => ({}), text: async () => "stub" };
  };
  A.__setFetch((...a) => globalThis.fetch(...a));
  const { createToken } = await import("../netlify/functions/_shared/auth.js");
  const ev = (who, qs = {}) => ({ headers: { authorization: `Bearer ${createToken({ email: who.email, role: who.role, ver: 0 })}` }, queryStringParameters: qs, httpMethod: "GET" });

  await t("get-portals: an Instructor's list is only their programs", async () => {
    const gp = (await import("../netlify/functions/get-portals.js")).handler;
    const mine = JSON.parse((await gp(ev(ins))).body).portals.map((p) => p.id);
    assert.deepEqual(mine, ["100"]);
    const all = JSON.parse((await gp(ev(dir))).body).portals.map((p) => p.id).sort();
    assert.deepEqual(all, ["100", "200"]);
  });
  await t("portal: an Instructor can't open another program by its id", async () => {
    const portal = (await import("../netlify/functions/portal.js")).handler;
    const r = await portal(ev(ins, { portalId: "200" }));
    assert.equal(r.statusCode, 403); assert.match(r.body, /not assigned/);
    const r2 = await portal(ev(ins, { portalId: "100" }));
    assert.ok(!/not assigned/.test(r2.body || ""), "their own program isn't refused");
  });
  await t("students, fast facts, reports, contacts: refused for other programs", async () => {
    for (const f of ["get-students", "get-fast-facts", "get-program-reports", "get-teachers"]) {
      process.env.JOTFORM_API_KEY = "jf";
      const h = (await import(`../netlify/functions/${f}.js`)).handler;
      const r = await h(ev(ins, { portalId: "200" }));
      assert.equal(r.statusCode, 403, f);
    }
  });
  await t("applications / uploads of a student on another program: refused", async () => {
    for (const f of ["get-application-data", "get-uploaded-documents"]) {
      const h = (await import(`../netlify/functions/${f}.js`)).handler;
      const r = await h(ev(ins, { email: "other@x.nz", formId: "1" }));
      assert.equal(r.statusCode, 403, f);
      const ok = await h(ev(ins, { email: "stu@x.nz", formId: "1" }));
      assert.notEqual(ok.statusCode, 403, `${f} own student`);
    }
  });
  await t("admin-invite: Instructors can't invite admins", async () => {
    process.env.SMTP_USER = "x"; process.env.SMTP_PASS = "y";
    const h = (await import("../netlify/functions/admin-invite.js")).handler;
    const r = await h({ ...ev(ins), httpMethod: "POST", body: JSON.stringify({ inviteeEmail: "new@pd.org", role: "Admissions Director" }) });
    assert.equal(r.statusCode, 403);
  });
  console.log(`${n} passed`);
}
