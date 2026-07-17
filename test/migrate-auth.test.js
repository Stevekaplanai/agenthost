// --migrate-auth: readLocalCredentials reads ~/.claude/.credentials.json and
// returns it base64'd as CLAUDE_CREDENTIALS (round-trippable), and refuses a
// missing or corrupt file. The value is never a raw credential in the object.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLocalCredentials } from "../src/commands/deploy.js";

function fixtureHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-migrate-auth-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  return home;
}

test("round-trips a valid credentials file into CLAUDE_CREDENTIALS", (t) => {
  const home = fixtureHome(t);
  const creds = { claudeAiOauth: { accessToken: "tok-abc" }, mcpOAuth: { notion: { refreshToken: "r-1" } } };
  const raw = JSON.stringify(creds);
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), raw);

  const out = readLocalCredentials(home);
  assert.deepEqual(Object.keys(out), ["CLAUDE_CREDENTIALS"]);
  // The staged value is base64 of the exact file bytes (decode must reproduce it).
  const decoded = Buffer.from(out.CLAUDE_CREDENTIALS, "base64").toString("utf8");
  assert.equal(decoded, raw, "base64 decodes back to the original file");
  assert.deepEqual(JSON.parse(decoded), creds);
  // The raw token never appears verbatim in the staged value.
  assert.ok(!out.CLAUDE_CREDENTIALS.includes("tok-abc"), "value is encoded, not raw");
});

test("throws a clear error when the credentials file is missing", (t) => {
  const home = fixtureHome(t);
  assert.throws(() => readLocalCredentials(home), /not found/);
});

test("refuses a corrupt (non-JSON) credentials file", (t) => {
  const home = fixtureHome(t);
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "{not json");
  assert.throws(() => readLocalCredentials(home), /not valid JSON/);
});
