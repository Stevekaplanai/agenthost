// Unit tests for the Brain page API proxy (container/brain-lib.js).
// Same harness style as the growth/brain-tokenize tests: the lib is pure CJS,
// all I/O is injected (fetchFn, env), no server boot, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { config, handleBrain, ingestPlan } = require("../container/brain-lib.js");

// Two credentials, on purpose. Reads use the admin panel key (it has to see
// every agent); writes use Steve's own key, so a memory he types is filed
// under HIS name instead of a lane called "panel".
const ENV = {
  MEMORY_SERVICE_URL: "https://brain.example",
  MEMORY_PANEL_KEY: "test-key",
  MEMORY_KEY_STEVE: "steve-key",
};

function fakeRes() {
  const out = { code: null, body: null };
  return {
    out,
    sendJson(res, code, body) { out.code = code; out.body = body; },
  };
}
function fakeReq(method, body) {
  const listeners = {};
  return {
    method,
    on(ev, fn) { listeners[ev] = fn; if (ev === "end" && method !== "GET") queueMicrotask(() => fn()); },
    destroy() {},
    _emit(data) { if (listeners.data) listeners.data(data); if (listeners.end) listeners.end(); },
  };
}
function okFetch(payload) {
  return async (url, opts) => ({
    ok: true, status: 200,
    json: async () => payload || { memories: [], count: 0 },
    _url: url, _opts: opts,
  });
}
function spyFetch(payload, status = 200) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: status < 400, status, json: async () => payload || {} };
  };
  fn.calls = calls;
  return fn;
}

test("config: unconfigured is a state with a reason, not a crash", () => {
  assert.equal(config({}).ok, false);
  assert.match(config({}).why, /MEMORY_SERVICE_URL/);
  assert.equal(config({ MEMORY_SERVICE_URL: "https://x" }).ok, false);
  assert.match(config({ MEMORY_SERVICE_URL: "https://x" }).why, /MEMORY_PANEL_KEY/);
  assert.equal(config(ENV).ok, true);
  assert.equal(config({ MEMORY_SERVICE_URL: "https://x/", MEMORY_PANEL_KEY: "k" }).url, "https://x"); // trailing slash trimmed
});

test("routing: non-brain paths pass through (return false)", () => {
  const { sendJson } = fakeRes();
  assert.equal(handleBrain(new URL("https://g/cc"), { method: "GET" }, {}, sendJson, okFetch(), ENV), false);
  assert.equal(handleBrain(new URL("https://g/brain"), { method: "GET" }, {}, sendJson, okFetch(), ENV), false); // page route is gate.js's job, not the lib's
});

test("unconfigured: every brain route answers 503 configured:false", () => {
  const r = fakeRes();
  const handled = handleBrain(new URL("https://g/brain/api/memories"), { method: "GET" }, {}, r.sendJson, okFetch(), {});
  assert.equal(handled, true);
  assert.equal(r.out.code, 503);
  assert.equal(r.out.body.configured, false);
});

test("GET list: proxies query params, clamps limit, sends the bearer", async () => {
  const fetchFn = spyFetch({ memories: [{ id: "1" }], count: 1 });
  const r = fakeRes();
  handleBrain(new URL("https://g/brain/api/memories?q=dogfood&limit=99999&scope=shared&agent=codex"), { method: "GET" }, {}, r.sendJson, fetchFn, ENV);
  await new Promise((res) => setImmediate(res));
  const call = fetchFn.calls[0];
  assert.match(call.url, /^https:\/\/brain\.example\/memory\?/);
  assert.match(call.url, /q=dogfood/);
  assert.match(call.url, /limit=500/); // clamped to MAX_LIMIT
  assert.match(call.url, /scope=shared/);
  assert.match(call.url, /agent=codex/);
  assert.equal(call.opts.headers.authorization, "Bea" + "rer steve-key"); // reads act as Steve; see the read-key test below
  assert.equal(r.out.code, 200);
  assert.equal(r.out.body.configured, true);
});

test("GET list: junk scope is dropped, not proxied", async () => {
  const fetchFn = spyFetch({ memories: [], count: 0 });
  const r = fakeRes();
  handleBrain(new URL("https://g/brain/api/memories?scope=evil"), { method: "GET" }, {}, r.sendJson, fetchFn, ENV);
  await new Promise((res) => setImmediate(res));
  assert.doesNotMatch(fetchFn.calls[0].url, /scope=evil/);
});

test("POST: rejects bad kind and empty content before any brain call", async () => {
  const fetchFn = spyFetch();
  for (const body of [JSON.stringify({ kind: "note", content: "x" }), JSON.stringify({ kind: "fact", content: "  " })]) {
    const r = fakeRes();
    const req = fakeReq("POST");
    handleBrain(new URL("https://g/brain/api/memories"), req, {}, r.sendJson, fetchFn, ENV);
    req._emit(body);
    await new Promise((res) => setImmediate(res));
    assert.equal(r.out.code, 400);
  }
  assert.equal(fetchFn.calls.length, 0); // validation happened at the boundary
});

test("POST: valid write proxies with 201", async () => {
  const fetchFn = spyFetch({ id: "abc", kind: "fact" });
  const r = fakeRes();
  const req = fakeReq("POST");
  handleBrain(new URL("https://g/brain/api/memories"), req, {}, r.sendJson, fetchFn, ENV);
  req._emit(JSON.stringify({ kind: "fact", content: "hello brain", scope: "shared", tags: ["a"] }));
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  const call = fetchFn.calls[0];
  assert.equal(call.opts.method, "POST");
  assert.deepEqual(JSON.parse(call.opts.body), { kind: "fact", content: "hello brain", scope: "shared", tags: ["a"] });
  assert.equal(r.out.code, 201);
});

test("DELETE: proxies the id, 404s nothing else", async () => {
  const fetchFn = spyFetch({ deleted: "9abe7d1f-73d2-4087-ae82-e686e5d29774" });
  const r = fakeRes();
  handleBrain(new URL("https://g/brain/api/memory/9abe7d1f-73d2-4087-ae82-e686e5d29774"), { method: "DELETE" }, {}, r.sendJson, fetchFn, ENV);
  await new Promise((res) => setImmediate(res));
  assert.match(fetchFn.calls[0].url, /\/memory\/9abe7d1f-73d2-4087-ae82-e686e5d29774$/);
  assert.equal(fetchFn.calls[0].opts.method, "DELETE");
  assert.equal(r.out.code, 200);
  // an id that isn't a uuid must not match the route at all
  assert.equal(handleBrain(new URL("https://g/brain/api/memory/.../etc"), { method: "DELETE" }, {}, r.sendJson, fetchFn, ENV), false);
});

test("brain refusal surfaces its own words (Rule 16), bounded", async () => {
  const fetchFn = spyFetch({ error: "invalid or revoked key" }, 401);
  const r = fakeRes();
  handleBrain(new URL("https://g/brain/api/memories"), { method: "GET" }, {}, r.sendJson, fetchFn, ENV);
  await new Promise((res) => setImmediate(res));
  assert.equal(r.out.code, 502);
  assert.match(r.out.body.error, /invalid or revoked key/);
});

test("wrong method on a real route is a 405, not a fallthrough", () => {
  const r = fakeRes();
  const handled = handleBrain(new URL("https://g/brain/api/memories"), { method: "PUT" }, {}, r.sendJson, okFetch(), ENV);
  assert.equal(handled, true);
  assert.equal(r.out.code, 405);
});

/** A POST request that actually delivers its body, which fakeReq does not:
 *  fakeReq fires "end" with no "data", so readBody only ever sees "{}". */
function postReq(bodyString) {
  const listeners = {};
  return {
    method: "POST",
    on(ev, fn) {
      listeners[ev] = fn;
      if (ev === "end") {
        queueMicrotask(() => {
          if (listeners.data) listeners.data(bodyString);
          if (listeners.end) listeners.end();
        });
      }
    },
    destroy() {},
  };
}

/* ---------- ingest (added 2026-08-03) ----------
   Steve asked that "new memory" take files. The gate had no door, so the
   Portal could only offer a textarea. These pin the door's contract: refuse
   the unreadable BY NAME before anything crosses the network, and never let a
   size failure look like a parse failure. */

test("ingest: a text file goes to /ingest/text with its content", async () => {
  const fetchFn = spyFetch({ memory_id: "m1" }, 201);
  const r = fakeRes();
  const req = postReq(JSON.stringify({ filename: "handbook.md", content: "# Voice\n\nShort sentences." }));
  handleBrain(new URL("https://g/brain/api/ingest"), req, {}, r.sendJson, fetchFn, ENV);
  await new Promise((res) => setTimeout(res, 5));
  assert.match(fetchFn.calls[0].url, /\/ingest\/text$/);
  assert.equal(JSON.parse(fetchFn.calls[0].opts.body).filename, "handbook.md");
  assert.equal(r.out.code, 201);
  assert.equal(r.out.body.route, "text");
});

test("ingest: a PDF goes to /ingest/text with its base64 bytes as content", async () => {
  const fetchFn = spyFetch({ memory_id: "m1" }, 201);
  const r = fakeRes();
  const req = postReq(JSON.stringify({ filename: "handbook.pdf", mime_type: "application/pdf", bytes_b64: "JVBERi0x" }));
  handleBrain(new URL("https://g/brain/api/ingest"), req, {}, r.sendJson, fetchFn, ENV);
  await new Promise((res) => setTimeout(res, 5));
  assert.match(fetchFn.calls[0].url, /\/ingest\/text$/);
  assert.deepEqual(JSON.parse(fetchFn.calls[0].opts.body), { filename: "handbook.pdf", content: "JVBERi0x" });
  assert.equal(r.out.code, 201);
  assert.equal(r.out.body.route, "text");
});

test("ingest: an image goes to /ingest/media with its bytes", async () => {
  const fetchFn = spyFetch({ media_id: "x1" }, 201);
  const r = fakeRes();
  const req = postReq(JSON.stringify({ filename: "shot.png", mime_type: "image/png", bytes_b64: "aGVsbG8=" }));
  handleBrain(new URL("https://g/brain/api/ingest"), req, {}, r.sendJson, fetchFn, ENV);
  await new Promise((res) => setTimeout(res, 5));
  assert.match(fetchFn.calls[0].url, /\/ingest\/media$/);
  assert.equal(JSON.parse(fetchFn.calls[0].opts.body).mime_type, "image/png");
  assert.equal(r.out.body.route, "media");
});

test("ingest: an unreadable type is refused BY NAME, and never reaches the brain", async () => {
  const fetchFn = spyFetch({}, 201);
  const r = fakeRes();
  const req = postReq(JSON.stringify({ filename: "contract.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  handleBrain(new URL("https://g/brain/api/ingest"), req, {}, r.sendJson, fetchFn, ENV);
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(r.out.code, 415);
  assert.match(r.out.body.error, /cannot read \.docx/);
  // the whole point: nothing crossed the network
  assert.equal(fetchFn.calls.length, 0);
});

test("ingest: video says it is deferred, rather than 'unsupported'", () => {
  const plan = ingestPlan("demo.mp4", "video/mp4");
  assert.equal(plan.route, null);
  assert.match(plan.why, /video is not ingested yet/);
});

test("ingest: an oversized file says how big the limit is, not 'request failed'", async () => {
  const fetchFn = spyFetch({}, 201);
  const r = fakeRes();
  // ~1MB of base64 -> comfortably over the 700KB file ceiling
  const req = postReq(JSON.stringify({ filename: "big.png", mime_type: "image/png", bytes_b64: "A".repeat(980_000) }));
  handleBrain(new URL("https://g/brain/api/ingest"), req, {}, r.sendJson, fetchFn, ENV);
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(r.out.code, 413);
  assert.match(r.out.body.error, /limit is/);
  assert.equal(fetchFn.calls.length, 0);
});

test("ingest: extension wins over a vague mime type", () => {
  // A .md served as application/octet-stream is still a markdown file.
  assert.equal(ingestPlan("notes.md", "application/octet-stream").route, "text");
  assert.equal(ingestPlan("clip.wav", "audio/wav").route, "media");
});

/* ---------- who a memory says it came from ----------
   Steve, 2026-08-03, looking at the brain: "what is panel?"

   `panel` was a lane on his team page named after a credential. The memory
   service takes the author from the KEY ROW and refuses to take it from the
   request body -- deliberately, so one agent can never write as another. The
   panel held an ADMIN key (it must read every agent's memories), so everything
   Steve typed into the page was filed under the key's own name.

   The fix keeps the service's rule intact and changes which key the WRITE uses.
   These tests pin both halves: reads stay admin, writes become Steve. */

test("a memory Steve types is written with HIS key, not the panel's", async () => {
  const fetchFn = spyFetch({ id: "m1" }, 201);
  const r = fakeRes();
  const req = fakeReq("POST");
  handleBrain(new URL("https://g/brain/api/memories"), req, {}, r.sendJson, fetchFn, ENV);
  req._emit(JSON.stringify({ kind: "fact", content: "the demo is Thursday", scope: "private" }));
  await new Promise((res) => setImmediate(res));
  const call = fetchFn.calls[0];
  assert.ok(call, "the write never reached the brain");
  assert.equal(
    call.opts.headers.authorization,
    "Bea" + "rer steve-key",
    "written with the panel's admin key -- the memory will be filed under an agent called `panel`, which is a credential, not a person",
  );
});

test("an uploaded file is attributed the same way as a typed memory", async () => {
  const fetchFn = spyFetch({ id: "m2" }, 201);
  const r = fakeRes();
  const req = fakeReq("POST");
  handleBrain(new URL("https://g/brain/api/ingest"), req, {}, r.sendJson, fetchFn, ENV);
  req._emit(JSON.stringify({ filename: "notes.md", content: "# notes" }));
  await new Promise((res) => setImmediate(res));
  assert.equal(fetchFn.calls[0].opts.headers.authorization, "Bea" + "rer steve-key");
});

test("reads act as Steve, so a private memory he wrote comes back to him", async () => {
  // Reading with the panel key instead would hide every private memory Steve
  // writes -- the write succeeds, the page reloads, and his note is gone.
  // Observed on the live box: the row existed, said agent "steve", and no read
  // returned it.
  const fetchFn = spyFetch({ memories: [], count: 0 });
  const r = fakeRes();
  handleBrain(new URL("https://g/brain/api/memories"), { method: "GET" }, {}, r.sendJson, fetchFn, ENV);
  await new Promise((res) => setImmediate(res));
  assert.equal(fetchFn.calls[0].opts.headers.authorization, "Bea" + "rer steve-key");
});

test("with no key of Steve's, reads fall back to the panel key rather than breaking", async () => {
  const noSteve = { MEMORY_SERVICE_URL: "https://brain.example", MEMORY_PANEL_KEY: "test-key" };
  const fetchFn = spyFetch({ memories: [], count: 0 });
  const r = fakeRes();
  handleBrain(new URL("https://g/brain/api/memories"), { method: "GET" }, {}, r.sendJson, fetchFn, noSteve);
  await new Promise((res) => setImmediate(res));
  assert.equal(fetchFn.calls[0].opts.headers.authorization, "Bea" + "rer test-key");
  assert.equal(r.out.code, 200, "reading must keep working even when the author key is absent");
});

test("DELETE keeps the admin key -- removing another agent's memory needs it", async () => {
  const fetchFn = spyFetch({ deleted: "9abe7d1f-73d2-4087-ae82-e686e5d29774" });
  const r = fakeRes();
  handleBrain(new URL("https://g/brain/api/memory/9abe7d1f-73d2-4087-ae82-e686e5d29774"), { method: "DELETE" }, {}, r.sendJson, fetchFn, ENV);
  await new Promise((res) => setImmediate(res));
  assert.equal(fetchFn.calls[0].opts.headers.authorization, "Bea" + "rer test-key");
});

test("with no author key, a write REFUSES and says why -- it never falls back", async () => {
  // A silent fallback to the admin key is exactly how the wrong author got
  // stamped on every memory. Refusing loudly is the point (Rule 16).
  const noSteve = { MEMORY_SERVICE_URL: "https://brain.example", MEMORY_PANEL_KEY: "test-key" };
  const fetchFn = spyFetch({ id: "m3" }, 201);
  const r = fakeRes();
  const req = fakeReq("POST");
  handleBrain(new URL("https://g/brain/api/memories"), req, {}, r.sendJson, fetchFn, noSteve);
  req._emit(JSON.stringify({ kind: "fact", content: "x", scope: "private" }));
  await new Promise((res) => setImmediate(res));
  assert.equal(fetchFn.calls.length, 0, "it wrote anyway, with whatever key it had");
  assert.equal(r.out.code, 503);
  assert.match(r.out.body.error, /MEMORY_KEY_STEVE/, "the refusal must name the missing thing, not say 'failed'");
});

test("a bad request is answered on its own terms, even with no author key", async () => {
  // Ordering guard: the credential check must not mask "we cannot read a .docx".
  const noSteve = { MEMORY_SERVICE_URL: "https://brain.example", MEMORY_PANEL_KEY: "test-key" };
  const r = fakeRes();
  const req = fakeReq("POST");
  handleBrain(new URL("https://g/brain/api/ingest"), req, {}, r.sendJson, spyFetch({}, 201), noSteve);
  req._emit(JSON.stringify({ filename: "contract.docx", mime_type: "application/vnd.openxmlformats" }));
  await new Promise((res) => setImmediate(res));
  assert.equal(r.out.code, 415, "a credential problem hid a request problem");
});

/* ---------- the phone gets a feed, not an archive (task #31) ---------- */
// Unprojected, /brain/api/memories shipped 2.58 MB to render a list -- ~13 KB
// per row, the full text of 195 seeded repo documents. The cut happens
// server-side: slicing in the client still ships the bytes over the radio.

test("long documents are trimmed in the list and say so; real memories arrive whole", async () => {
  const doc = "D".repeat(13000);
  const mem = "a captured lesson, well under the capture cap";
  const fetchFn = spyFetch({ memories: [
    { id: "1", agent: "steve", content: doc },
    { id: "2", agent: "claude", content: mem },
  ], count: 2 });
  const r = fakeRes();
  handleBrain(new URL("https://g/brain/api/memories"), { method: "GET" }, {}, r.sendJson, fetchFn, ENV);
  await new Promise((res) => setImmediate(res));
  const [big, small] = r.out.body.memories;
  assert.equal(big.content.length, 1200, "a 13KB document must not ride the list whole");
  assert.equal(big.content_truncated, true, "a trimmed row must say it was trimmed -- ending mid-sentence silently misrepresents the memory");
  assert.equal(small.content, mem, "anything an agent can capture (<=1000 chars) always arrives complete");
  assert.equal(small.content_truncated, undefined, "an untrimmed row carries no flag");
});
