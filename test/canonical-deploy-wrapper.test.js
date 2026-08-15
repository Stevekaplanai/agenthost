import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.join(import.meta.dirname, "..");
const REDEPLOY = path.join(ROOT, "scripts", "redeploy-box.sh");
const POWERSHELL_REDEPLOY = path.join(ROOT, "scripts", "redeploy-box.ps1");

function bashPath() {
  if (process.platform !== "win32") return "bash";
  return ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]
    .find((candidate) => fs.existsSync(candidate));
}

const bash = bashPath();
const bashTest = bash ? test : test.skip;

bashTest("self-redeploy accepts the exact canonical host and preserves BYO fallback", () => {
  for (const args of [
    ["--app", "agenthost-steve", "--canonical-host", "app.agenthost.space", "--dry-run"],
    ["--app", "customer-box", "--dry-run"],
  ]) {
    const result = spawnSync(bash, [REDEPLOY, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, FLY_API_TOKEN: "" },
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

bashTest("self-redeploy rejects a valid but wrong production hostname", () => {
  const result = spawnSync(bash, [REDEPLOY,
    "--app", "agenthost-steve", "--canonical-host", "wrong.example", "--dry-run"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, FLY_API_TOKEN: "" },
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be exactly app\.agenthost\.space for agenthost-steve/i);
});

const windowsTest = process.platform === "win32" ? test : test.skip;

windowsTest("PowerShell self-redeploy rejects a valid but wrong production hostname before deployment", () => {
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(powershell, ["-NoProfile", "-File", POWERSHELL_REDEPLOY,
    "-App", "agenthost-steve", "-CanonicalHost", "wrong.example", "-DryRun"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /must be exactly app\.agenthost\.space for agenthost-steve/i);
});
