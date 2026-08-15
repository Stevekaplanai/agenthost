// test/measurement-disclosure.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
// test/ is ESM (package.json is "type": "module"), so a bare top-level
// require() throws before any assertion runs. container/ is CommonJS, so it
// is loaded through the shim. Match test/measurement-credentials.test.js.
const require = createRequire(import.meta.url);
const { statusPayload, handleMeasurement } = require("../container/measurement-lib.js");

test("status names the credential holder plainly", () => {
  const s = statusPayload({ PIPEDREAM_PROJECT_ID: "p", PIPEDREAM_CLIENT_ID: "c", PIPEDREAM_CLIENT_SECRET: "s" });
  assert.equal(s.connected, true);
  assert.equal(s.credentialHolder, "pipedream");
  assert.deepEqual(s.providers, ["meta_ads"], "the first-time picker receives the exact registered adapter list");
  assert.match(s.disclosure, /Pipedream/);
  assert.match(s.disclosure, /not stored on this box/i);
});

test("an unconfigured box says what is missing and still discloses the model", () => {
  const s = statusPayload({});
  assert.equal(s.connected, false);
  assert.match(s.why, /PIPEDREAM_PROJECT_ID/);
  assert.equal(s.credentialHolder, "pipedream");
});

test("no secret value ever appears in the status payload", () => {
  const s = statusPayload({ PIPEDREAM_PROJECT_ID: "p", PIPEDREAM_CLIENT_ID: "c", PIPEDREAM_CLIENT_SECRET: "SUPERSECRET" });
  assert.equal(JSON.stringify(s).includes("SUPERSECRET"), false);
});

test("a write to the status route is refused with a reason, like every sibling route", () => {
  // It previously fell through unclaimed, because the route matched on method as
  // well as path. Silently not claiming a path is how a route ends up answered by
  // something else entirely.
  const sent = [];
  const claimed = handleMeasurement(
    new URL("http://box/measurement/status"), { method: "POST" }, {},
    (res, status, body) => sent.push({ status, body }), () => null,
  );
  assert.equal(claimed, true, "the path must be claimed regardless of method");
  assert.equal(sent[0].status, 405);
  assert.match(sent[0].body.error, /read-only/);
});

test("the status route reads the INJECTED env, not the developer's own shell", () => {
  // This route called statusPayload() with no argument while every sibling
  // route used deps.env, so a test supplying a fake env silently got
  // process.env -- meaning this status could pass or fail on whatever happened
  // to be exported in the shell that ran it.
  const sent = [];
  const sendJson = (res, status, body) => sent.push({ status, body });
  const run = (env) => handleMeasurement(
    new URL("http://box/measurement/status"), { method: "GET" }, {}, sendJson,
    () => ({}), (req, res, cb) => cb({}), { env },
  );

  assert.equal(run({ PIPEDREAM_PROJECT_ID: "p", PIPEDREAM_CLIENT_ID: "c", PIPEDREAM_CLIENT_SECRET: "s" }), true);
  assert.equal(sent[0].body.connected, true, "a configured env must be reported as configured");

  assert.equal(run({}), true);
  assert.equal(sent[1].body.connected, false, "and an empty one as unconfigured, whatever the real shell holds");
  assert.match(sent[1].body.why, /PIPEDREAM_PROJECT_ID/);
});
