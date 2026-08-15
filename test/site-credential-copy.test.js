import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, "..", "site", "index.html"), "utf8");

test("public security copy describes the real credential path", () => {
  assert.match(html, /Credential files never migrate\./);
  assert.match(html, /Auth values you explicitly supply go straight from your laptop to your cloud provider's encrypted store\./);
  assert.match(html, /No AgentHost backend receives them\./);
  assert.match(html, /excluding credential files; sending approved auth straight to your cloud provider's encrypted store/i);
  assert.doesNotMatch(html, /credentials never leave your disk/i);
  assert.doesNotMatch(html, /keeping them on your disk/i);
});
