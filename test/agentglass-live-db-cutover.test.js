import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationScript = path.join(repositoryRoot, "scripts", "migrate-agentglass-db.mjs");
const windowsWrapper = path.join(repositoryRoot, "scripts", "migrate-agentglass-db.ps1");
const walFixture = path.join(repositoryRoot, "test", "fixtures", "live-wal-database.mjs");
const privateRow = "CUTOVER_TEST_PRIVATE_ROW";

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function temporaryCutover(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agenthost-${label}-`));
  for (const directory of ["live", "backup", "dashboard"]) {
    fs.mkdirSync(path.join(root, directory));
  }
  t.after(() => {
    if (process.platform === "win32") {
      const reset = spawnSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        "$p=$env:AGENTHOST_TEST_CLEANUP_ROOT; if(Test-Path -LiteralPath $p){icacls.exe $p /reset /T /C /Q | Out-Null; Get-ChildItem -Force -LiteralPath $p -Recurse | ForEach-Object {$_.Attributes=$_.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)}}",
      ], {
        encoding: "utf8",
        env: { ...process.env, AGENTHOST_TEST_CLEANUP_ROOT: root },
      });
      assert.equal(reset.status, 0, reset.stderr);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    source: path.join(root, "live", "events.sqlite"),
    backup: path.join(root, "backup", "events.pre-cutover.sqlite"),
    target: path.join(root, "dashboard", "events.sqlite"),
  };
}

async function startLiveWalDatabase(t, source) {
  const child = spawn("bun", [walFixture, source], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => {
    await stopLiveWalDatabase(child);
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error(`WAL fixture timed out: ${stderr}`)), 10_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`WAL fixture exited ${code}: ${stderr}`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("READY\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  assert.ok(fs.statSync(`${source}-wal`).size > 0, "fixture has committed rows in a live WAL");
  return child;
}

async function stopLiveWalDatabase(child) {
  if (child.exitCode !== null) return;
  try { child.stdin.end(); } catch {}
  await Promise.race([once(child, "exit"), delay(2_000)]);
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, "exit"), delay(2_000)]);
  }
}

function runMigration(script, paths) {
  const isPowerShell = script.endsWith(".ps1");
  const executable = isPowerShell ? "powershell.exe" : "bun";
  const prefix = isPowerShell
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
    : [script];
  const flags = isPowerShell
    ? ["-Source", paths.source, "-Backup", paths.backup, "-Target", paths.target]
    : ["--source", paths.source, "--backup", paths.backup, "--target", paths.target];
  return spawnSync(executable, [
    ...prefix,
    ...flags,
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function runVerification(paths, expectedSha256) {
  return spawnSync("bun", [
    migrationScript,
    "--verify",
    "--backup", paths.backup,
    "--target", paths.target,
    "--sha256", expectedSha256,
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function assertSnapshot(paths, result) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(privateRow), "migration never prints database contents");
  assert.ok(!result.stderr.includes(privateRow), "migration errors never print database contents");

  const report = JSON.parse(result.stdout.trim());
  assert.deepEqual(Object.keys(report).sort(), ["bytes", "integrity", "ok", "sha256"]);
  assert.equal(report.ok, true);
  assert.equal(report.integrity, "ok");
  assert.match(report.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.sha256, sha256(paths.backup));
  assert.equal(sha256(paths.backup), sha256(paths.target));
  assert.deepEqual(fs.readFileSync(paths.backup), fs.readFileSync(paths.target));

  for (const databasePath of [paths.backup, paths.target]) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 2);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM events WHERE payload = ?").get(privateRow).count,
        1,
      );
    } finally {
      database.close();
    }
  }
}

test("creates a consistent backup and exact target copy from a live WAL database", async (t) => {
  const paths = temporaryCutover(t, "db-cutover");
  const holder = await startLiveWalDatabase(t, paths.source);
  try {
    const result = runMigration(migrationScript, paths);
    assertSnapshot(paths, result);

    const before = [sha256(paths.backup), sha256(paths.target)];
    const retry = runMigration(migrationScript, paths);
    assert.notEqual(retry.status, 0, "rerun refuses to overwrite either final database");
    assert.deepEqual([sha256(paths.backup), sha256(paths.target)], before);

    const verified = runVerification(paths, before[0]);
    assert.equal(verified.status, 0, verified.stderr);
    fs.appendFileSync(paths.target, "tampered");
    const tampered = runVerification(paths, before[0]);
    assert.notEqual(tampered.status, 0, "post-permission verification detects changed bytes");
  } finally {
    await stopLiveWalDatabase(holder);
  }
});

test("rejects relative, overlapping, and pre-existing destination paths before writing", async (t) => {
  const paths = temporaryCutover(t, "db-path-guards");
  const holder = await startLiveWalDatabase(t, paths.source);
  try {
    const relative = runMigration(migrationScript, { ...paths, backup: "relative.sqlite" });
    assert.notEqual(relative.status, 0);
    assert.ok(!fs.existsSync(paths.target));

    const overlapBackup = path.join(paths.root, "backup", "must-not-exist.sqlite");
    const overlap = runMigration(migrationScript, {
      ...paths,
      backup: overlapBackup,
      target: paths.source,
    });
    assert.notEqual(overlap.status, 0);
    assert.ok(!fs.existsSync(overlapBackup));

    fs.writeFileSync(paths.target, "existing-target");
    const existing = runMigration(migrationScript, paths);
    assert.notEqual(existing.status, 0);
    assert.equal(fs.readFileSync(paths.target, "utf8"), "existing-target");
    assert.ok(!fs.existsSync(paths.backup));
  } finally {
    await stopLiveWalDatabase(holder);
  }
});

test("Windows wrapper leaves the backup read-only and both databases private", {
  skip: process.platform !== "win32",
}, async (t) => {
  const paths = temporaryCutover(t, "db-acl");
  const holder = await startLiveWalDatabase(t, paths.source);
  try {
    const copiedRepository = path.join(paths.root, "agenthost-repository");
    const copiedScripts = path.join(copiedRepository, "scripts");
    fs.mkdirSync(copiedScripts, { recursive: true });
    fs.mkdirSync(path.join(copiedRepository, "control-plane"));
    const copiedWrapper = path.join(copiedScripts, "migrate-agentglass-db.ps1");
    fs.copyFileSync(windowsWrapper, copiedWrapper);
    fs.copyFileSync(migrationScript, path.join(copiedScripts, "migrate-agentglass-db.mjs"));
    const runtimeRoot = path.join(copiedRepository, "control-plane", ".runtime");
    const wrapperPaths = {
      ...paths,
      backup: path.join(runtimeRoot, "backups", "agentglass-pre-cutover.db"),
      target: path.join(runtimeRoot, "data", "agenthost-control-plane.db"),
    };

    const wrongTarget = runMigration(copiedWrapper, {
      ...wrapperPaths,
      target: path.join(runtimeRoot, "data", "wrong.db"),
    });
    assert.notEqual(wrongTarget.status, 0, "wrapper rejects a target the launcher will not use");

    const result = runMigration(copiedWrapper, wrapperPaths);
    assertSnapshot(wrapperPaths, result);
    assert.ok(
      fs.statSync(wrapperPaths.backup).mode,
      "backup remains readable after the wrapper applies its private ACL",
    );
    assert.ok(
      fs.statSync(wrapperPaths.backup).isFile() && fs.statSync(wrapperPaths.target).isFile(),
      "wrapper retains both regular files",
    );

    const aclCheck = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      [
        "$backup=$env:AGENTHOST_TEST_BACKUP; $target=$env:AGENTHOST_TEST_TARGET; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;",
        "$system='S-1-5-18';",
        "function Test-Private($p,$backupMode){",
        "$acl=[IO.File]::GetAccessControl($p);",
        "$rules=@($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]));",
        "if(-not $acl.AreAccessRulesProtected){exit 10};",
        "if(@($rules | Where-Object {$_.AccessControlType -eq 'Allow' -and @($me,$system) -notcontains $_.IdentityReference.Value}).Count){exit 11};",
        "if(@($rules | Where-Object {$_.IdentityReference.Value -eq $me}).Count -ne 1){exit 12};",
        "if(@($rules | Where-Object {$_.IdentityReference.Value -eq $system}).Count -ne 1){exit 13};",
        "if($backupMode -and -not (([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReadOnly))){exit 14};",
        "};",
        "function Test-PrivateDirectory($p){",
        "$acl=[IO.Directory]::GetAccessControl($p);",
        "$rules=@($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]));",
        "if(-not $acl.AreAccessRulesProtected){exit 15};",
        "if(@($rules | Where-Object {$_.AccessControlType -eq 'Allow' -and @($me,$system) -notcontains $_.IdentityReference.Value}).Count){exit 16};",
        "if(@($rules | Where-Object {$_.IdentityReference.Value -eq $me}).Count -ne 1){exit 17};",
        "if(@($rules | Where-Object {$_.IdentityReference.Value -eq $system}).Count -ne 1){exit 18};",
        "};",
        "Test-Private $backup $true; Test-Private $target $false;",
        "Test-PrivateDirectory ([IO.Path]::GetDirectoryName($backup));",
        "Test-PrivateDirectory ([IO.Path]::GetDirectoryName($target));",
      ].join(" "),
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTHOST_TEST_BACKUP: wrapperPaths.backup,
        AGENTHOST_TEST_TARGET: wrapperPaths.target,
      },
      windowsHide: true,
    });
    assert.equal(aclCheck.status, 0, `${aclCheck.stdout}\n${aclCheck.stderr}`);
  } finally {
    await stopLiveWalDatabase(holder);
  }
});
