// Unit tests for the pure interpreters in `agenthost doctor` -- no live Fly
// account needed; the flyctl/HTTP calls are orchestration around these.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasAuthSecret, gateReachable, parseDiskFree, diskOk } from "../src/commands/doctor.js";

test("hasAuthSecret: either the OAuth token or an API key counts", () => {
  assert.equal(hasAuthSecret(["TTYD_PASSWORD", "CLAUDE_CODE_OAUTH_TOKEN"]), true);
  assert.equal(hasAuthSecret(["ANTHROPIC_API_KEY"]), true);
  assert.equal(hasAuthSecret(["TTYD_PASSWORD", "GITHUB_TOKEN"]), false);
  assert.equal(hasAuthSecret([]), false);
  assert.equal(hasAuthSecret(null), false); // couldn't read secrets
});

test("gateReachable: a serving gate returns 200/301/302/401", () => {
  for (const s of [200, 301, 302, 401]) assert.equal(gateReachable(s), true, `HTTP ${s}`);
  for (const s of [0, 500, 502, 404, 403]) assert.equal(gateReachable(s), false, `HTTP ${s}`);
});

test("parseDiskFree: reads Avail + Use% from a df -h data row, skipping the header", () => {
  const df = [
    "Filesystem      Size  Used Avail Use% Mounted on",
    "/dev/vdb        2.9G  1.1G  1.7G  40% /data",
  ].join("\n");
  assert.deepEqual(parseDiskFree(df), { avail: "1.7G", usePct: 40 });
});

test("parseDiskFree: tolerant of extra lines / plain sizes; null when no data row", () => {
  assert.deepEqual(parseDiskFree("/dev/vdb 3000000 2700000 300000 90% /data"), { avail: "300000", usePct: 90 });
  assert.equal(parseDiskFree(""), null);
  assert.equal(parseDiskFree("df: /data: No such file or directory"), null);
});

test("diskOk: healthy under 90% used", () => {
  assert.equal(diskOk({ avail: "1.7G", usePct: 40 }), true);
  assert.equal(diskOk({ avail: "300M", usePct: 89 }), true);
  assert.equal(diskOk({ avail: "50M", usePct: 90 }), false);
  assert.equal(diskOk({ avail: "10M", usePct: 97 }), false);
  assert.equal(diskOk(null), false);
});
