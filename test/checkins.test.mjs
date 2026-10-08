// node --test test/checkins.test.mjs
// The weekly check-in proxy: session required, booking email forced to the
// session's email, upstream 401/403 never surfaced as 401. No network.
import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET = "s".repeat(64);
process.env.INSTRUCTOR_PORTAL_KEY = "k".repeat(32);
process.env.CHECKINS_API_URL = "https://dash.test/api/checkins/";

const { createToken } = await import("../netlify/functions/_shared/auth.js");
const { handler } = await import("../netlify/functions/checkins.js");

let CALLS = [], RESP = { status: 200, body: { ok: true } };
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes("hubapi.com")) return new Response("{}", { status: 500 }); // version lookup → fail open
  CALLS.push({ url: String(url), init }); return new Response(JSON.stringify(RESP.body), { status: RESP.status }); };
const auth = { authorization: "Bearer " + createToken({ email: "Ana@Gmail.com", ver: 0 }) };

test("requires a session", async () => {
  const r = await handler({ httpMethod: "GET", headers: {}, queryStringParameters: { action: "slots" } });
  assert.equal(r.statusCode, 401);
});

test("slots and mine", async () => {
  CALLS = [];
  assert.equal((await handler({ httpMethod: "GET", headers: auth, queryStringParameters: { action: "slots" } })).statusCode, 200);
  await handler({ httpMethod: "GET", headers: auth, queryStringParameters: { action: "mine" } });
  assert.equal(CALLS[0].url, "https://dash.test/api/checkins/slots");
  assert.equal(CALLS[1].url, "https://dash.test/api/checkins/mine?email=ana%40gmail.com");
  assert.equal(CALLS[0].init.headers["X-PD-Service-Key"], "k".repeat(32));
});

test("book uses the session email, not the body", async () => {
  CALLS = [];
  await handler({ httpMethod: "POST", headers: auth, body: JSON.stringify({ action: "book", start: "2026-10-12T20:00:00Z", email: "someone@else.com", name: "Ana", repeatWeeks: 6 }) });
  const sent = JSON.parse(CALLS[0].init.body);
  assert.equal(sent.email, "ana@gmail.com");
  assert.equal(sent.repeatWeeks, 6);
});

test("upstream auth failures don't sign the instructor out", async () => {
  RESP = { status: 403, body: { error: "Forbidden" } };
  assert.equal((await handler({ httpMethod: "GET", headers: auth, queryStringParameters: { action: "slots" } })).statusCode, 502);
  RESP = { status: 409, body: { error: "taken" } };
  assert.equal((await handler({ httpMethod: "POST", headers: auth, body: JSON.stringify({ action: "book" }) })).statusCode, 409);
});

test("unknown action", async () => {
  assert.equal((await handler({ httpMethod: "GET", headers: auth, queryStringParameters: {} })).statusCode, 400);
});
