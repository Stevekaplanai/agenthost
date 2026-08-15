import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const helper = path.resolve("control-plane", "Read-AgentHostKanbanConfig.ps1");
const launcher = path.resolve("control-plane", "start-local.ps1");
const readToken = "a".repeat(64);
const writeToken = "b".repeat(64);

function invoke(secretFile = "") {
  const script = [
    "& {",
    "param($helper, $secretFile, $repo);",
    "$ErrorActionPreference = 'Stop';",
    ". $helper;",
    "$processEnvironment = @{};",
    "$result = Get-AgentHostKanbanDashboardConfig",
    "-SecretFile $secretFile",
    "-ProcessEnvironment $processEnvironment",
    "-RepositoryRoot $repo;",
    "if ($null -eq $result) { 'null' } else { $result | ConvertTo-Json -Compress };",
    "}",
  ].join(" ");
  return spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", script,
    helper,
    secretFile,
    path.resolve("."),
  ], { encoding: "utf8" });
}

test("dashboard reads only its scoped Kanban values from an external secret file", {
  skip: process.platform !== "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-kanban-config-"));
  const secret = path.join(root, "bridge.env");
  fs.writeFileSync(secret, [
    "AGENTHOST_KANBAN_URL=https://agenthost-steve.tail4bf092.ts.net/kanban/tasks",
    `AGENTHOST_KANBAN_READ_TOKEN=${readToken}`,
    `AGENTHOST_KANBAN_WRITE_TOKEN=${writeToken}`,
    `AGENTHOST_KANBAN_LIFECYCLE_TOKEN=${"c".repeat(64)}`,
    "",
  ].join("\n"));
  try {
    const result = invoke(secret);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      Url: "https://agenthost-steve.tail4bf092.ts.net/kanban/tasks",
      ReadToken: readToken,
      WriteToken: writeToken,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard config fails closed on repository files and incomplete credentials", {
  skip: process.platform !== "win32",
}, () => {
  const contained = invoke(helper);
  assert.notEqual(contained.status, 0);
  assert.match(contained.stderr, /outside the repository/i);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-kanban-config-"));
  const partial = path.join(root, "partial.env");
  const lifecycleOnly = path.join(root, "lifecycle-only.env");
  fs.writeFileSync(partial, [
    "AGENTHOST_KANBAN_URL=https://agenthost-steve.tail4bf092.ts.net/kanban/tasks",
    `AGENTHOST_KANBAN_READ_TOKEN=${readToken}`,
    "",
  ].join("\n"));
  fs.writeFileSync(
    lifecycleOnly,
    `AGENTHOST_KANBAN_LIFECYCLE_TOKEN=${"c".repeat(64)}\n`,
  );
  try {
    const result = invoke(partial);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /all three scoped dashboard values/i);

    const lifecycleResult = invoke(lifecycleOnly);
    assert.notEqual(lifecycleResult.status, 0);
    assert.match(lifecycleResult.stderr, /all three scoped dashboard values/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher injects board credentials only around the server spawn", () => {
  const source = fs.readFileSync(launcher, "utf8");
  assert.match(source, /Read-AgentHostKanbanConfig\.ps1/);
  assert.match(source, /KanbanSecretFile/);
  assert.doesNotMatch(source, /AGENTHOST_KANBAN_LIFECYCLE_TOKEN/);
  const helperSource = fs.readFileSync(helper, "utf8");
  assert.match(helperSource, /FileShare\]::Read/);
  assert.match(helperSource, /StreamReader/);
  assert.match(helperSource, /ReparsePoint/);
  for (const name of [
    "AGENTHOST_KANBAN_URL",
    "AGENTHOST_KANBAN_READ_TOKEN",
    "AGENTHOST_KANBAN_WRITE_TOKEN",
  ]) {
    assert.match(source, new RegExp(`Set-Item[^\\n]+Env:${name}`));
    assert.match(source, new RegExp(`Remove-Item[^\\n]+Env:${name}`));
  }
  const materialize = source.indexOf("$materialized =");
  const inject = source.indexOf("Env:AGENTHOST_KANBAN_URL");
  const spawn = source.indexOf("Start-Process -FilePath $bunExe");
  assert.ok(materialize !== -1 && materialize < inject);
  assert.ok(inject < spawn);
});
