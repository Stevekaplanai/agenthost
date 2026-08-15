import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appOrigin, loadOriginState } from "../src/state.js";
import { formatFleet } from "../src/commands/fleet.js";
import { runningModeProbeCommand } from "../src/commands/mode.js";
import { deployArgs } from "../src/fly.js";

const ROOT = path.resolve(import.meta.dirname, "..");

test("appOrigin keeps the Fly origin fallback for ordinary customer boxes", () => {
  assert.equal(appOrigin("customer-box", null), "https://customer-box.fly.dev");
});

test("appOrigin uses a saved canonical origin without adding a redirect hop", () => {
  assert.equal(
    appOrigin("agenthost-steve", { origin: "https://app.agenthost.space/" }),
    "https://app.agenthost.space",
  );
});

test("appOrigin rejects malformed or unsafe saved origins with a named cause", () => {
  for (const origin of [
    "http://app.agenthost.space",
    "https://user@app.agenthost.space",
    "https://app.agenthost.space/path",
    "https://app.agenthost.space?key=secret",
    "https://app.agenthost.space/#fragment",
  ]) {
    assert.throws(
      () => appOrigin("agenthost-steve", { origin }),
      /saved origin for 'agenthost-steve' must be an absolute HTTPS origin/i,
      origin,
    );
  }
});

test("origin-bearing commands fail closed when saved state is corrupt or unreadable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-origin-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const corrupt = path.join(root, "corrupt.json");
  fs.writeFileSync(corrupt, "{not-json");
  assert.throws(
    () => loadOriginState("agenthost-steve", corrupt),
    /saved state for 'agenthost-steve' is not valid JSON/i,
  );
  assert.throws(
    () => loadOriginState("agenthost-steve", root),
    /could not read saved state for 'agenthost-steve': EISDIR/i,
  );
  assert.equal(loadOriginState("customer-box", path.join(root, "missing.json")), null);
});

test("the CLI open journey names corrupt origin state instead of printing a retired URL", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-origin-cli-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateDir = path.join(home, ".agenthost");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, "agenthost-steve.json"), "{not-json");
  const result = spawnSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "open", "--app", "agenthost-steve"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /saved state for 'agenthost-steve' is not valid JSON/i);
  assert.doesNotMatch(result.stdout + result.stderr, /agenthost-steve\.fly\.dev/);
});

test("the CLI open journey never writes the saved access key into a URL or console output", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-origin-cli-secret-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateDir = path.join(home, ".agenthost");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, "agenthost-steve.json"), JSON.stringify({
    app: "agenthost-steve",
    origin: "https://app.agenthost.space",
    ttydPassword: "do-not-print-this-key",
  }));
  const result = spawnSync(process.execPath, [path.join(ROOT, "bin", "cli.js"), "open", "--app", "agenthost-steve"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^https:\/\/app\.agenthost\.space/m);
  assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-this-key|\?key=/);
});

test("fleet output uses each box's saved origin and preserves BYO fallback", () => {
  const lines = formatFleet([
    { app: "agenthost-steve", origin: "https://app.agenthost.space", region: "iad" },
    { app: "customer-box", region: "sjc" },
  ], "agenthost-steve");
  assert.match(lines[0], /agenthost-steve {2}https:\/\/app\.agenthost\.space {2}iad/);
  assert.match(lines[1], /customer-box {2}https:\/\/customer-box\.fly\.dev {2}sjc/);
});

test("the on-box mode probe presents the canonical Host while using the local socket", () => {
  const command = runningModeProbeCommand("https://app.agenthost.space");
  assert.match(command, /-H "Host: app\.agenthost\.space"/);
  assert.match(command, /http:\/\/127\.0\.0\.1:8080\/mode\.json/);
  assert.doesNotMatch(command, /agenthost-steve\.fly\.dev/);
});

test("custom-origin deploys pass the canonical hostname without changing the customer template", () => {
  const args = deployArgs("agenthost-steve", "C:\\repo\\container\\fly.toml.deploy", {
    AGENTHOST_CANONICAL_HOST: "app.agenthost.space",
  });
  assert.deepEqual(args.slice(-2), ["--env", "AGENTHOST_CANONICAL_HOST=app.agenthost.space"]);
});

test("active CLI commands no longer construct Fly URLs outside the shared resolver", () => {
  const commandDir = path.resolve(import.meta.dirname, "..", "src", "commands");
  for (const name of ["open.js", "doctor.js", "mode.js", "deploy.js", "sync.js", "fleet.js"]) {
    const source = fs.readFileSync(path.join(commandDir, name), "utf8");
    assert.doesNotMatch(source, /https:\/\/\$\{(?:s\.)?app\}\.fly\.dev/, `${name} bypasses appOrigin`);
    assert.doesNotMatch(source, /loadAppState/, `${name} can silently collapse corrupt origin state to BYO fallback`);
    assert.match(source, /appOrigin/, `${name} resolves the persisted app origin`);
  }
});
