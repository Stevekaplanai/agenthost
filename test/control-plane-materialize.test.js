import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertContainedPath,
  assertPinnedExecutable,
  finalizeActivation,
  materialize as materializeWithGitPin,
  overlaySignature,
  parseArgs,
  patchFiles,
  readUpstream,
  renameWithRetry,
  repairActivatedControlPlane,
  rollbackActivation,
  verifyPreparedActivation,
  writePreparedMarker,
} from "../control-plane/materialize.mjs";

function run(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || "").trim();
}

const gitLocator = spawnSync(
  process.platform === "win32" ? "where.exe" : "which",
  ["git"],
  { encoding: "utf8" },
);
assert.equal(gitLocator.status, 0, gitLocator.stderr || gitLocator.stdout);
const testGitPath = fs.realpathSync(
  String(gitLocator.stdout).split(/\r?\n/).find(Boolean),
);
const testGitBytes = fs.readFileSync(testGitPath);
const testGitPin = {
  gitPath: testGitPath,
  gitLength: testGitBytes.length,
  gitSha256: createHash("sha256").update(testGitBytes).digest("hex"),
};

function materialize(options = {}) {
  return materializeWithGitPin({ ...options, ...testGitPin });
}

function windowsPowerShell() {
  return path.join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function runPowerShellScript(script, args) {
  const child = spawn(windowsPowerShell(), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    ...args,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [status] = await once(child, "close");
  return { status, stdout, stderr };
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-control-plane-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const source = path.join(root, "upstream");
  fs.mkdirSync(source);
  run(source, "git", ["init", "--quiet"]);
  run(source, "git", ["config", "user.email", "qa@agenthost.space"]);
  run(source, "git", ["config", "user.name", "AgentHost QA"]);
  fs.writeFileSync(path.join(source, "surface.txt"), "upstream\n");
  run(source, "git", ["add", "surface.txt"]);
  run(source, "git", ["commit", "--quiet", "-m", "fixture"]);
  const commit = run(source, "git", ["rev-parse", "HEAD"]);

  const controlPlaneDir = path.join(root, "control-plane");
  const patchesDir = path.join(controlPlaneDir, "patches");
  const overlayDir = path.join(controlPlaneDir, "overlay", "web");
  fs.mkdirSync(patchesDir, { recursive: true });
  fs.mkdirSync(overlayDir, { recursive: true });
  fs.writeFileSync(path.join(controlPlaneDir, "upstream.json"), `${JSON.stringify({
    name: "fixture",
    repository: source,
    release: "test",
    commit,
    license: "MIT",
  })}\n`);
  fs.writeFileSync(path.join(controlPlaneDir, "LICENSE.agentglass"), "fixture license\n");
  fs.writeFileSync(path.join(overlayDir, "brand.txt"), "AgentHost\n");
  fs.writeFileSync(path.join(patchesDir, "10-shell.patch"), [
    "diff --git a/surface.txt b/surface.txt",
    "--- a/surface.txt",
    "+++ b/surface.txt",
    "@@ -1 +1 @@",
    "-upstream",
    "+shell",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(patchesDir, "20-extension.patch"), [
    "diff --git a/surface.txt b/surface.txt",
    "--- a/surface.txt",
    "+++ b/surface.txt",
    "@@ -1 +1 @@",
    "-shell",
    "+interactive",
    "",
  ].join("\n"));

  return {
    root,
    source,
    controlPlaneDir,
    patchesDir,
    target: path.join(controlPlaneDir, ".runtime", "agentglass"),
  };
}

function createPreparedFixtureRuntime(directory, controlPlaneDir) {
  for (const relative of [
    "node_modules",
    path.join("server", "node_modules"),
    path.join("server", "src"),
    path.join("web", "node_modules"),
    path.join("web", "dist"),
  ]) {
    fs.mkdirSync(path.join(directory, relative), { recursive: true });
  }
  for (const [relative, contents] of [
    ["package.json", '{"private":true}\n'],
    ["bun.lock", "fixture-lock\n"],
    [path.join("server", "package.json"), '{"name":"fixture-server"}\n'],
    [path.join("server", "src", "index.ts"), "export const prepared = true;\n"],
    [path.join("web", "package.json"), '{"name":"fixture-web"}\n'],
    [path.join("web", "dist", "index.html"), "<!doctype html><title>prepared</title>\n"],
    [path.join("web", "dist", "asset.js"), "globalThis.prepared = true;\n"],
  ]) {
    fs.writeFileSync(path.join(directory, relative), contents);
  }
  writePreparedMarker(directory, controlPlaneDir);
}

test("AgentGlass is pinned to the audited MIT release", () => {
  const upstream = readUpstream();
  const readme = fs.readFileSync(path.resolve("control-plane", "README.md"), "utf8");
  assert.equal(upstream.release, "v0.6.0+pr357");
  assert.equal(upstream.commit, "6203818c77915c970af4c3ddb75dc246d810db5b");
  assert.equal(upstream.license, "MIT");
  assert.ok(readme.includes(`Release: \`${upstream.release}\``));
  assert.ok(readme.includes(`Commit: \`${upstream.commit}\``));
});

test("materializer accepts explicit source and target arguments", () => {
  const args = parseArgs([
    "--source", "C:\\tmp\\agentglass-v0.5.0",
    "--target", "C:\\work\\runtime\\agentglass",
    "--fresh",
    "--prepare",
    "--bun", "C:\\tools\\bun.exe",
    "--git-path", "C:\\tools\\git.exe",
    "--git-length", "12345",
    "--git-sha256", "a".repeat(64),
  ]);
  assert.equal(args.source, "C:\\tmp\\agentglass-v0.5.0");
  assert.equal(args.target, "C:\\work\\runtime\\agentglass");
  assert.equal(args.fresh, true);
  assert.equal(args.prepare, true);
  assert.equal(args.bun, "C:\\tools\\bun.exe");
  assert.equal(args.gitPath, "C:\\tools\\git.exe");
  assert.equal(args.gitLength, "12345");
  assert.equal(args.gitSha256, "a".repeat(64));
  assert.throws(() => parseArgs(["--finalize", "--rollback"]), /mutually exclusive/);
  assert.throws(
    () => parseArgs(["--git-path", "C:\\tools\\git.exe"]),
    /must be supplied together/i,
  );
  assert.throws(() => parseArgs(["--fresh"]), /must be supplied together/i);
});

test("materializer revalidates the exact pinned Git bytes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-git-pin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "git.exe");
  fs.writeFileSync(executable, "trusted-git");
  const expected = createHash("sha256")
    .update(fs.readFileSync(executable))
    .digest("hex");

  assert.doesNotThrow(() => assertPinnedExecutable(
    executable,
    fs.statSync(executable).size,
    expected,
  ));
  fs.appendFileSync(executable, "-changed");
  assert.throws(
    () => assertPinnedExecutable(executable, 11, expected),
    /length changed before execution|hash changed before execution/i,
  );
  assert.throws(
    () => materializeWithGitPin(),
    /Pinned Git path, length, and hash are required/i,
  );
});

test("prepared-runtime verification is explicit and cannot be mixed with a rebuild", () => {
  const args = parseArgs(["--verify-prepared"]);
  assert.equal(args.verifyPrepared, true);
  assert.throws(
    () => parseArgs(["--verify-prepared", "--fresh"]),
    /cannot rebuild/i,
  );
  assert.throws(
    () => parseArgs(["--verify-prepared", "--source", "C:\\tmp\\agentglass"]),
    /cannot rebuild/i,
  );
});

test("prepared marker refresh is a default-runtime-only lifecycle command", (t) => {
  const args = parseArgs(["--refresh-prepared"]);
  assert.equal(args.refreshPrepared, true);
  assert.equal(args.target, null);
  assert.equal(typeof writePreparedMarker, "function");

  for (const incompatible of [
    ["--finalize"],
    ["--rollback"],
    ["--verify-prepared"],
    ["--source", "C:\\tmp\\agentglass"],
    ["--target", "C:\\tmp\\agentglass"],
    ["--fresh"],
    ["--prepare"],
    ["--bun", "C:\\tools\\bun.exe"],
    [
      "--git-path", "C:\\tools\\git.exe",
      "--git-length", "12345",
      "--git-sha256", "a".repeat(64),
    ],
  ]) {
    assert.throws(
      () => parseArgs(["--refresh-prepared", ...incompatible]),
      /mutually exclusive|only updates the default|does not accept Git/i,
    );
  }

  const fixture = createFixture(t);
  materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
    prepare(staging) {
      createPreparedFixtureRuntime(staging, fixture.controlPlaneDir);
    },
  });
  const marker = path.join(fixture.target, ".agenthost-prepared.json");
  const staleMarker = fs.readFileSync(marker, "utf8");
  const serverEntry = path.join(fixture.target, "server", "src", "index.ts");
  fs.appendFileSync(serverEntry, "export const refreshed = true;\n");
  assert.throws(() => verifyPreparedActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
  }), /build proof does not match/);

  function runtimeSnapshot() {
    const entries = [];
    function visit(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(fixture.target, absolute)
          .split(path.sep).join("/");
        if (relative === ".agenthost-prepared.json") continue;
        if (entry.isDirectory()) {
          entries.push({ path: relative, type: "directory" });
          visit(absolute);
        } else {
          entries.push({
            path: relative,
            type: entry.isFile() ? "file" : "other",
            sha256: createHash("sha256")
              .update(fs.readFileSync(absolute))
              .digest("hex"),
          });
        }
      }
    }
    visit(fixture.target);
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }
  const before = runtimeSnapshot();
  const cli = path.join(fixture.controlPlaneDir, "materialize-cli.mjs");
  fs.copyFileSync(path.resolve("control-plane", "materialize.mjs"), cli);
  const refreshed = spawnSync(process.execPath, [
    cli,
    "--json",
    "--refresh-prepared",
  ], {
    cwd: fixture.root,
    encoding: "utf8",
  });

  assert.equal(refreshed.status, 0, refreshed.stderr || refreshed.stdout);
  const result = JSON.parse(refreshed.stdout);
  assert.equal(path.resolve(result.target), path.resolve(fixture.target));
  assert.equal(result.prepared, true);
  assert.notEqual(fs.readFileSync(marker, "utf8"), staleMarker);
  assert.deepEqual(
    runtimeSnapshot(),
    before,
    "refresh must rewrite only the prepared marker",
  );
  assert.doesNotThrow(() => verifyPreparedActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
  }));
});

test("materializer refuses the runtime root and paths outside it", () => {
  const root = path.resolve("C:\\work\\runtime");
  assert.throws(() => assertContainedPath(root, root), /must be a child/);
  assert.throws(() => assertContainedPath(root, path.resolve(root, "..", "elsewhere")), /must be a child/);
  assert.equal(assertContainedPath(root, path.join(root, "agentglass")), path.join(root, "agentglass"));
});

test("tracked overlay has a reproducible signature and ordered patch seam", () => {
  const attributes = fs.readFileSync(path.resolve(".gitattributes"), "utf8");
  assert.match(overlaySignature(), /^[a-f0-9]{64}$/);
  assert.match(
    attributes,
    /^control-plane\/patches\/\*\.patch text eol=lf$/m,
  );
  assert.deepEqual(
    patchFiles().map((file) => path.basename(file)),
    [
      "10-agenthost-shell.patch",
      "15-agenthost-mobile-auth-hardening.patch",
      "20-kanban.patch",
      "30-agent-room.patch",
      "40-side-effect-guards.patch",
      "50-plugin-inventory.patch",
      "60-dashboard-chat-session-ux.patch",
      "70-box-workspace.patch",
      "71-board-box-task-navigation.patch",
      "80-cc-home-layout.patch",
      "90-windows-conpty-terminal.patch",
      "95-terminal-front-door.patch",
      "96-box-terminal-websocket.patch",
    ],
  );
});

test("launcher, room runtime, and dashboard share the room-directory contract", () => {
  const launcher = fs.readFileSync(path.resolve("scripts", "start-local-room.ps1"), "utf8");
  const roomRuntime = fs.readFileSync(path.resolve("scripts", "local-room.mjs"), "utf8");
  const roomProxy = fs.readFileSync(
    path.resolve("control-plane", "overlay", "server", "src", "agenthost-room.ts"),
    "utf8",
  );
  assert.ok(launcher.includes(
    "$roomStateDirectoryNamePattern = '^agenthost-room-[A-Za-z0-9._-]+$'",
  ));
  assert.match(launcher, /\$stateDirLeaf -cnotmatch/);
  assert.match(launcher, /\$stateDirParent -cne \$wslStateRoot/);
  assert.match(launcher, /WSL-native storage, not a mounted Windows drive/);
  assert.ok(roomRuntime.includes(
    "/^agenthost-room-[A-Za-z0-9._-]+$/",
  ));
  assert.ok(roomProxy.includes(
    "/^agenthost-room-[A-Za-z0-9._-]+$/",
  ));
});

test("shell patch stays out of Kanban and room backend ownership", () => {
  const patch = fs.readFileSync(path.resolve("control-plane", "patches", "10-agenthost-shell.patch"), "utf8");
  assert.doesNotMatch(patch, /AgentHostBoard|agenthost-board|\/agenthost\/board|kanban-bridge|local-room/);
  assert.match(patch, /data-agenthost-radar-actions/);
  assert.match(patch, /maxWidth: 204, maxHeight: 204/);
  assert.match(patch, /Skills & slash commands/);
});

test("dashboard usability patch keeps chat, session identity, and radar fixes reproducible", () => {
  const patch = fs.readFileSync(
    path.resolve("control-plane", "patches", "60-dashboard-chat-session-ux.patch"),
    "utf8",
  );
  const chatCwd = fs.readFileSync(
    path.resolve("control-plane", "overlay", "web", "src", "lib", "chatCwd.ts"),
    "utf8",
  );
  assert.match(chatCwd, /activeCwd \|\| workspace \|\| rememberedCwd \|\| repos\[0\]\?\.root/);
  assert.match(chatCwd, /isChatCwdVisible/);
  assert.match(chatCwd, /clean\.toLowerCase\(\)/);
  assert.match(patch, /DIAL_MAX = 280/);
  assert.match(patch, /DOSSIER_SIDE_AT = 440/);
  assert.match(patch, /const comparePath =/);
  assert.match(patch, /isChatCwdVisible\(chat\.cwd, workspace, repos\)/);
  assert.match(patch, /if \(!scopeKnown \|\| !reposKnown\) return/);
  assert.match(patch, /promptTitle/);
  assert.match(patch, /\[data-view="\$\{view\}"\]/);
});

test("local launcher exposes a functional loopback-only developer workspace", () => {
  const source = fs.readFileSync(path.resolve("control-plane", "start-local.ps1"), "utf8");
  const readme = fs.readFileSync(path.resolve("control-plane", "README.md"), "utf8");
  const readiness = fs.readFileSync(path.resolve("control-plane", "Confirm-AgentHostReadiness.ps1"), "utf8");
  const materializer = fs.readFileSync(path.resolve("control-plane", "materialize.mjs"), "utf8");
  assert.match(source, /AGENTGLASS_BIND = "127\.0\.0\.1"/);
  assert.match(source, /"--fresh"/);
  assert.match(source, /"--prepare"/);
  assert.match(source, /\[switch\]\$PrepareRuntimeOnly/);
  assert.match(source, /\[switch\]\$UsePreparedRuntime/);
  assert.match(source, /"--verify-prepared"/);
  assert.match(source, /PrepareRuntimeOnly[\s\S]+cannot be combined with UsePreparedRuntime/i);
  assert.match(source, /PrepareRuntimeOnly[\s\S]+cannot be combined with server-only options/i);
  assert.match(
    source,
    /if\s*\(\s*\$UsePreparedRuntime\s*\)\s*\{[\s\S]{0,240}\$activationPending\s*=[\s\S]{0,160}\$materializedResult\.backup/i,
  );
  assert.match(source, /UsePreparedRuntime[\s\S]+cannot be combined with Source/i);
  assert.match(readme, /start-local\.ps1 -PrepareRuntimeOnly -Source/);
  assert.doesNotMatch(readme, /materialize\.mjs --source[\s\S]+--prepare/);
  assert.match(source, /"--finalize"/);
  assert.match(source, /"--rollback"/);
  assert.match(source, /\/health[\s\S]+Invoke-WebRequest/);
  assert.match(source, /AGENTGLASS_THEME_SYNC_DISABLED = "1"/);
  assert.match(source, /AGENTGLASS_WALKTHROUGH_DISABLED = "1"/);
  assert.match(source, /Resolve-AgentHostRoomStateRoot/);
  assert.match(source, /AGENTHOST_ROOM_STATE_ROOT = \$roomStateRoot\.WindowsPath/);
  for (const disabled of [
    "AGENTGLASS_TERMINAL_DISABLED",
    "AGENTGLASS_CHAT_DISABLED",
    "AGENTGLASS_WORKSPACE_WRITE_DISABLED",
    "AGENTGLASS_GIT_WRITE_DISABLED",
    "AGENTGLASS_COMMIT_DISABLED",
    "AGENTGLASS_DOCKER_WRITE_DISABLED",
    "AGENTGLASS_FS_BROWSE_DISABLED",
  ]) {
    assert.doesNotMatch(source, new RegExp(disabled));
  }
  assert.doesNotMatch(source, /AGENTHOST_KANBAN_LIFECYCLE_TOKEN|0\.0\.0\.0/);
  assert.match(source, /Remove-Item -LiteralPath "Env:/);
  assert.doesNotMatch(source, /RandomNumberGenerator\]::Fill|ToHexString/);
  assert.match(source, /New-AgentHostToken\.ps1/);
  assert.match(source, /Confirm-AgentHostReadiness\.ps1/);
  assert.match(source, /-ProcessId \$serverProcess\.Id/);
  assert.match(source, /-RequireCanonicalBoard:\$requireCanonicalBoard/);
  assert.match(readiness, /\/api\/loopwatch/);
  assert.match(readiness, /\/agenthost\/board/);
  assert.match(readiness, /Authorization[\s\S]+Bearer \$Token/);
  assert.match(readiness, /StatusCode[\s\S]+401/);
  assert.match(readiness, /Get-Process[\s\S]+WaitForExit/);
  assert.doesNotMatch(source, /--filter agentglass-electron/);
  assert.match(materializer, /"--filter", "agentglass-web"[\s\S]+"--filter", "agentglass-server"/);
  assert.doesNotMatch(materializer, /"--filter", "agentglass-electron"/);
  assert.ok(
    source.indexOf('Invoke-WebRequest') < source.indexOf('Start-Process $url'),
    "health polling must happen before the browser opens",
  );
  assert.ok(
    source.indexOf("Confirm-AgentHostReadiness.ps1") < source.indexOf('"--finalize"'),
    "authenticated readiness and the child liveness re-check must happen before finalization",
  );
  assert.ok(
    source.indexOf('"--verify-prepared"') < source.indexOf("Resolve-AgentHostRoomStateRoot"),
    "prepared proof must fail before launcher state is created or changed",
  );
  assert.ok(
    source.indexOf('"--verify-prepared"') < source.indexOf("Start-Process -FilePath $bunExe"),
    "prepared proof must pass before a dashboard process starts",
  );
  const scrubIndex = source.indexOf('ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }');
  const freshMaterializeIndex = source.indexOf("$materialized = & $nodeExe @materializeArgs");
  const prepareOnlyReturnIndex = source.indexOf('Write-Host "AgentHost Control Plane prepared at $runtime"');
  const stateRootIndex = source.indexOf("$stateRootResolver = Join-Path");
  const kanbanConfigIndex = source.indexOf("$kanbanConfig = Get-AgentHostKanbanDashboardConfig");
  const tokenIndex = source.indexOf("New-AgentHostToken.ps1");
  const dataDirectoryIndex = source.indexOf('Join-Path $controlPlane ".runtime\\data"');
  const serverIndex = source.indexOf("Start-Process -FilePath $bunExe");
  const browserIndex = source.indexOf("Start-Process $url");
  assert.ok(
    scrubIndex >= 0 && scrubIndex < freshMaterializeIndex,
    "third-party preparation must start only after the child environment is scrubbed",
  );
  assert.ok(
    freshMaterializeIndex < prepareOnlyReturnIndex
      && prepareOnlyReturnIndex < tokenIndex
      && prepareOnlyReturnIndex < dataDirectoryIndex
      && prepareOnlyReturnIndex < serverIndex
      && prepareOnlyReturnIndex < browserIndex,
    "prepare-only must return before room-state, token, database, server, and browser setup",
  );
  assert.ok(
    source.indexOf("if (-not $PrepareRuntimeOnly)") < stateRootIndex,
    "prepare-only must explicitly skip room-state and dashboard configuration",
  );
  assert.ok(
    stateRootIndex < freshMaterializeIndex && kanbanConfigIndex < freshMaterializeIndex,
    "normal launch state and Kanban configuration must validate before runtime activation",
  );
  assert.doesNotMatch(source, /tailscale\s+serve|New-NetFirewallRule|netsh\s+/i);
});

test("prepared runtime rollback follows materializer backup presence", {
  skip: process.platform !== "win32",
}, (t) => {
  const source = fs.readFileSync(path.resolve("control-plane", "start-local.ps1"), "utf8");
  const decisionStart = source.indexOf(
    "if ($UsePreparedRuntime) {",
    source.indexOf("$materializedResult ="),
  );
  const decisionEnd = source.indexOf("Push-Location $runtime", decisionStart);
  assert.ok(
    decisionStart >= 0 && decisionEnd > decisionStart,
    "prepared activation must make one bounded rollback decision",
  );
  const decision = source.slice(decisionStart, decisionEnd);
  assert.match(decision, /\$materializedResult\.backup/i);
  assert.doesNotMatch(decision, /\$activationPending\s*=\s*\$true\b/i);

  const failureStart = source.indexOf("$startupFailure = $_", decisionEnd);
  const failureEnd = source.indexOf("} finally {", failureStart);
  const failureHandler = source.slice(failureStart, failureEnd);
  const rollbackGateStart = failureHandler.indexOf("if ($activationPending) {");
  const rollbackGateBoundary = failureHandler.match(
    /\r?\n\s*\}\s*\r?\n\s*throw\s+\$startupFailure/i,
  );
  assert.ok(
    rollbackGateStart >= 0 && rollbackGateBoundary,
    "startup failure must have one bounded activation rollback gate",
  );
  const rollbackGateEnd = rollbackGateBoundary.index
    + rollbackGateBoundary[0].indexOf("}") + 1;
  const rollbackGate = failureHandler.slice(
    rollbackGateStart,
    rollbackGateEnd,
  );
  assert.match(
    rollbackGate,
    /^if\s*\(\s*\$activationPending\s*\)\s*\{[\s\S]*["']--rollback["']/i,
    "startup failure may roll back only when the materializer reported a backup",
  );
  assert.equal(
    (rollbackGate.match(/["']--rollback["']/gi) || []).length,
    1,
    "the gated failure path must contain exactly one rollback invocation",
  );
  assert.doesNotMatch(
    failureHandler.slice(0, rollbackGateStart)
      + failureHandler.slice(rollbackGateEnd),
    /["']--rollback["']/i,
    "no rollback invocation may escape the activationPending gate",
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-activation-pending-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = path.join(root, "probe.ps1");
  fs.writeFileSync(probe, [
    '$ErrorActionPreference = "Stop"',
    "$UsePreparedRuntime = $true",
    "$cases = @(",
    '  [pscustomobject]@{ name = "false"; backup = $false; expected = $false },',
    '  [pscustomobject]@{ name = "null"; backup = $null; expected = $false },',
    '  [pscustomobject]@{ name = "path"; backup = "C:\\runtime\\agentglass.backup"; expected = $true }',
    ")",
    "foreach ($case in $cases) {",
    "  $materializedResult = [pscustomobject]@{",
    "    backup = $case.backup",
    "    reused = $false",
    "  }",
    decision,
    "  $rollbackCalled = $false",
    "  if ($activationPending) { $rollbackCalled = $true }",
    '  if ([bool]$activationPending -ne $case.expected -or $rollbackCalled -ne $case.expected) {',
    '    throw "Incorrect rollback decision for $($case.name) backup."',
    "  }",
    "}",
    'Write-Output "activation-pending-pass"',
    "",
  ].join("\r\n"));
  const result = spawnSync(windowsPowerShell(), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", probe,
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /activation-pending-pass/);
});

test("prepare-only launcher scrubs child credentials and never enters server setup", {
  skip: process.platform !== "win32",
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-prepare-only-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const invocationLog = path.join(root, "node-invocations.txt");
  const forbiddenRoomState = path.join(root, "forbidden-room-state");
  const runtime = path.resolve(
    "control-plane",
    ".runtime",
    "agentglass",
  ).replaceAll("\\", "/");
  const backup = `${runtime}.backup`;
  const resultJson = JSON.stringify({
    target: runtime,
    backup,
    reused: false,
    prepared: true,
  });
  fs.writeFileSync(path.join(bin, "node.cmd"), [
    "@echo off",
    "if defined AGENTHOST_TEST_PARENT_SECRET (",
    "  >&2 echo parent secret leaked into preparation child",
    "  exit /b 91",
    ")",
    "if defined AGENTGLASS_TOKEN (",
    "  >&2 echo server token leaked into preparation child",
    "  exit /b 92",
    ")",
    "if defined AGENTGLASS_DB (",
    "  >&2 echo database path leaked into preparation child",
    "  exit /b 93",
    ")",
    "if defined AGENTHOST_KANBAN_READ_TOKEN (",
    "  >&2 echo board credential leaked into preparation child",
    "  exit /b 94",
    ")",
    "echo %* | findstr.exe /C:\"--prepare\" >nul",
    "if not errorlevel 1 (",
    "  if not \"%GIT_CONFIG_NOSYSTEM%\"==\"1\" exit /b 97",
    "  if /I not \"%GIT_CONFIG_GLOBAL%\"==\"NUL\" exit /b 98",
    "  if not \"%GIT_TERMINAL_PROMPT%\"==\"0\" exit /b 99",
    "  if defined GIT_ASKPASS exit /b 100",
    "  if /I not \"%GCM_INTERACTIVE%\"==\"Never\" exit /b 101",
    ")",
    "echo %* | findstr.exe /C:\"--verify-prepared\" >nul",
    "if not errorlevel 1 (",
    "  if defined GIT_CONFIG_NOSYSTEM exit /b 102",
    "  if defined GIT_CONFIG_GLOBAL exit /b 103",
    "  if defined GIT_TERMINAL_PROMPT exit /b 104",
    "  if defined GIT_ASKPASS exit /b 105",
    "  if defined GCM_INTERACTIVE exit /b 106",
    ")",
    `>>"${invocationLog}" echo %*`,
    `echo ${resultJson}`,
    "",
  ].join("\r\n"));
  fs.writeFileSync(path.join(bin, "bun.cmd"), [
    "@echo off",
    ">&2 echo bun stub must not be launched directly by start-local.ps1",
    "exit /b 95",
    "",
  ].join("\r\n"));
  fs.writeFileSync(path.join(bin, "git.cmd"), [
    "@echo off",
    ">&2 echo git stub must be invoked only by the materializer",
    "exit /b 96",
    "",
  ].join("\r\n"));

  const childEnvironment = { ...process.env };
  for (const key of Object.keys(childEnvironment)) {
    if (key.toLowerCase() === "path") delete childEnvironment[key];
  }
  childEnvironment.Path = [
    bin,
    path.join(process.env.SystemRoot, "System32"),
    process.env.SystemRoot,
  ].join(path.delimiter);
  childEnvironment.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  childEnvironment.AGENTHOST_TEST_PARENT_SECRET = "must-not-leak";
  childEnvironment.AGENTGLASS_TOKEN = "must-not-reach-build";
  childEnvironment.AGENTGLASS_DB = "must-not-reach-build";
  childEnvironment.AGENTHOST_KANBAN_URL = "https://must-not-be-read.invalid";
  childEnvironment.AGENTHOST_KANBAN_READ_TOKEN = "must-not-reach-build";
  childEnvironment.AGENTHOST_ROOM_STATE_ROOT = forbiddenRoomState;

  const launcher = path.resolve("control-plane", "start-local.ps1");
  const fakeSource = path.join(root, "fake-agentglass-source");
  const command = [
    "& {",
    "param($launcher, $source)",
    "function global:Start-Process { throw 'unexpected server or browser process' }",
    "function global:Wait-Process { throw 'unexpected server wait' }",
    "function global:Stop-Process { throw 'unexpected server stop' }",
    "function global:Invoke-WebRequest { throw 'unexpected readiness request' }",
    "function global:New-Item { throw 'unexpected launcher filesystem write' }",
    "& $launcher -PrepareRuntimeOnly -Source $source",
    "}",
  ].join(" ");
  const result = spawnSync(windowsPowerShell(), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", command,
    launcher,
    fakeSource,
  ], {
    encoding: "utf8",
    env: childEnvironment,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const invocations = fs.readFileSync(invocationLog, "utf8")
    .trim()
    .split(/\r?\n/);
  assert.equal(invocations.length, 2);
  assert.match(invocations[0], /--fresh --prepare[\s\S]+--source/);
  assert.match(invocations[1], /--json --verify-prepared[\s\S]+--target/);
  assert.match(result.stdout, /AgentHost Control Plane prepared at/);
  assert.doesNotMatch(result.stdout, /token=|http:\/\/127\.0\.0\.1/);
  assert.equal(fs.existsSync(forbiddenRoomState), false);
});

test("launcher refuses unsafe prepared-runtime flag combinations before execution", {
  skip: process.platform !== "win32",
}, () => {
  const launcher = path.resolve("control-plane", "start-local.ps1");
  for (const [args, expected] of [
    [["-PrepareRuntimeOnly", "-UsePreparedRuntime"], /cannot be combined with UsePreparedRuntime/i],
    [["-PrepareRuntimeOnly", "-NoBrowser"], /cannot be combined with server-only options/i],
    [["-UsePreparedRuntime", "-Source", "C:\\fake-source"], /cannot be combined with Source/i],
  ]) {
    const result = spawnSync(windowsPowerShell(), [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", launcher,
      ...args,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, expected);
  }
});

test("normal launcher validates Kanban configuration before materialization", {
  skip: process.platform !== "win32",
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const invocationLog = path.join(root, "node-invocations.txt");
  fs.writeFileSync(path.join(bin, "node.cmd"), [
    "@echo off",
    `>>"${invocationLog}" echo %*`,
    "exit /b 96",
    "",
  ].join("\r\n"));

  const childEnvironment = { ...process.env };
  for (const key of Object.keys(childEnvironment)) {
    if (key.toLowerCase() === "path" || key.startsWith("AGENTHOST_KANBAN_")) {
      delete childEnvironment[key];
    }
  }
  childEnvironment.Path = [
    bin,
    path.join(process.env.SystemRoot, "System32"),
    process.env.SystemRoot,
  ].join(path.delimiter);
  childEnvironment.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  childEnvironment.AGENTHOST_KANBAN_URL = "https://tasks.example.ts.net";

  const result = spawnSync(windowsPowerShell(), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", path.resolve("control-plane", "start-local.ps1"),
    "-ControlRoot", path.join(root, "room-state"),
    "-NoBrowser",
  ], {
    encoding: "utf8",
    env: childEnvironment,
  });
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Canonical Kanban requires all three scoped dashboard values/i,
  );
  assert.equal(fs.existsSync(invocationLog), false);
});

test("token generation executes under Windows PowerShell 5.1", { skip: process.platform !== "win32" }, () => {
  const powershell = windowsPowerShell();
  const tokenScript = path.resolve("control-plane", "New-AgentHostToken.ps1");
  const token = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", tokenScript,
  ], { encoding: "utf8" });
  assert.equal(token.status, 0, token.stderr || token.stdout);
  assert.match(token.stdout.trim(), /^[a-f0-9]{64}$/);

  const parse = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "& { param($file) [scriptblock]::Create([IO.File]::ReadAllText($file)) | Out-Null }",
    path.resolve("control-plane", "start-local.ps1"),
  ], { encoding: "utf8" });
  assert.equal(parse.status, 0, parse.stderr || parse.stdout);

  const stateRootResolver = path.resolve("scripts", "room-state-root.ps1");
  const parseStateRoot = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "& { param($file) [scriptblock]::Create([IO.File]::ReadAllText($file)) | Out-Null }",
    stateRootResolver,
  ], { encoding: "utf8" });
  assert.equal(parseStateRoot.status, 0, parseStateRoot.stderr || parseStateRoot.stdout);
});

test("authenticated readiness rejects an old server and requires the started child to stay alive", { skip: process.platform !== "win32" }, async (t) => {
  const token = "a".repeat(64);
  const readinessScript = path.resolve("control-plane", "Confirm-AgentHostReadiness.ps1");
  let mode = "old";
  let childToStop = null;
  let unauthenticatedHits = 0;
  let authenticatedHits = 0;
  let boardHits = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true,"service":"agentglass"}');
      return;
    }
    if (req.url === "/agenthost/board") {
      boardHits += 1;
      if (req.headers.authorization !== `Bearer ${token}` || mode === "board-fail") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end('{"error":"unavailable"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        available: true,
        lanes: [
          { id: "queued" },
          { id: "running" },
          { id: "awaiting" },
          { id: "review" },
          { id: "done" },
          { id: "blocked" },
        ],
        columns: {},
        tasks: [],
      }));
      return;
    }
    if (req.url !== "/api/loopwatch") {
      res.writeHead(404).end();
      return;
    }
    const authenticated = req.headers.authorization === `Bearer ${token}`;
    if (authenticated) authenticatedHits += 1;
    else unauthenticatedHits += 1;
    if (!authenticated || mode === "old") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"ok":false,"error":"unauthorized"}');
      return;
    }
    if (mode === "exiting") {
      childToStop.kill();
      await once(childToStop, "close");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"spawns":{"active":0}}');
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => {
    if (childToStop && childToStop.exitCode === null) childToStop.kill();
  });
  const { port } = server.address();
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200, "the old unauthenticated health probe would have accepted this server");

  const oldServer = await runPowerShellScript(readinessScript, [
    "-Port", String(port),
    "-Token", token,
    "-ProcessId", String(process.pid),
  ]);
  assert.notEqual(oldServer.status, 0, "a server with a different token must not become ready");

  mode = "ready";
  const ready = await runPowerShellScript(readinessScript, [
    "-Port", String(port),
    "-Token", token,
    "-ProcessId", String(process.pid),
  ]);
  assert.equal(ready.status, 0, ready.stderr || ready.stdout);
  assert.ok(unauthenticatedHits >= 2, "readiness must prove the endpoint rejects missing credentials");
  assert.ok(authenticatedHits >= 2, "readiness must send the newly generated token");

  const boardReady = await runPowerShellScript(readinessScript, [
    "-Port", String(port),
    "-Token", token,
    "-ProcessId", String(process.pid),
    "-RequireCanonicalBoard",
  ]);
  assert.equal(boardReady.status, 0, boardReady.stderr || boardReady.stdout);
  assert.equal(boardHits, 1, "configured startup must validate the canonical board");

  mode = "board-fail";
  const missingBoard = await runPowerShellScript(readinessScript, [
    "-Port", String(port),
    "-Token", token,
    "-ProcessId", String(process.pid),
    "-RequireCanonicalBoard",
  ]);
  assert.notEqual(missingBoard.status, 0, "configured startup fails if the board is unavailable");

  mode = "exiting";
  childToStop = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
  const exitedChild = await runPowerShellScript(readinessScript, [
    "-Port", String(port),
    "-Token", token,
    "-ProcessId", String(childToStop.pid),
  ]);
  assert.notEqual(exitedChild.status, 0, "readiness must fail when the started child exits after answering");
});

test("materializer applies ordered patches and overlay end to end", (t) => {
  const fixture = createFixture(t);
  const result = materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
  });

  assert.equal(result.reused, false);
  assert.equal(fs.readFileSync(path.join(fixture.target, "surface.txt"), "utf8").replaceAll("\r\n", "\n"), "interactive\n");
  assert.equal(fs.readFileSync(path.join(fixture.target, "web", "brand.txt"), "utf8"), "AgentHost\n");
  assert.equal(fs.readFileSync(path.join(fixture.target, "LICENSE"), "utf8"), "fixture license\n");
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.target, ".agenthost-overlay.json"), "utf8")).commit, result.commit);
});

test("materializer applies Windows CRLF patch files in its sterile Git environment", (t) => {
  const fixture = createFixture(t);
  const lfSignature = overlaySignature(fixture.controlPlaneDir);
  for (const patch of fs.readdirSync(fixture.patchesDir)) {
    const absolute = path.join(fixture.patchesDir, patch);
    const crlf = fs.readFileSync(absolute, "utf8").replaceAll("\n", "\r\n");
    assert.match(crlf, /\r\n/);
    assert.equal(crlf.replaceAll("\r\n", "").includes("\n"), false);
    fs.writeFileSync(
      absolute,
      crlf,
    );
  }
  assert.equal(overlaySignature(fixture.controlPlaneDir), lfSignature);

  const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  try {
    materialize({
      source: fixture.source,
      target: fixture.target,
      fresh: true,
      controlPlaneDir: fixture.controlPlaneDir,
    });
  } finally {
    if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  }

  assert.equal(
    fs.readFileSync(path.join(fixture.target, "surface.txt"), "utf8"),
    "interactive\n",
  );
});

test("materializer failure leaves the previous runtime untouched", (t) => {
  const fixture = createFixture(t);
  materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  fs.writeFileSync(path.join(fixture.target, "proof.txt"), "keep me\n");
  fs.writeFileSync(path.join(fixture.patchesDir, "05-broken.patch"), "not a patch\n");

  assert.throws(() => materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
  }), /git failed/);
  assert.equal(fs.readFileSync(path.join(fixture.target, "proof.txt"), "utf8"), "keep me\n");
});

test("materializer restores the previous runtime when the final swap fails", (t) => {
  const fixture = createFixture(t);
  materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  fs.writeFileSync(path.join(fixture.target, "proof.txt"), "restore me\n");

  const failFinalSwap = (source, target) => {
    if (source.includes(".staging-") && path.resolve(target) === path.resolve(fixture.target)) {
      throw Object.assign(new Error("simulated final swap failure"), { code: "EIO" });
    }
    fs.renameSync(source, target);
  };

  assert.throws(() => materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
    rename: failFinalSwap,
  }), /simulated final swap failure/);
  assert.equal(fs.readFileSync(path.join(fixture.target, "proof.txt"), "utf8"), "restore me\n");
});

test("prepare failure happens before activation and leaves the known-good runtime live", (t) => {
  const fixture = createFixture(t);
  materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  fs.writeFileSync(path.join(fixture.target, "proof.txt"), "known good\n");

  assert.throws(() => materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
    prepare(staging) {
      assert.notEqual(path.resolve(staging), path.resolve(fixture.target));
      assert.equal(fs.readFileSync(path.join(fixture.target, "proof.txt"), "utf8"), "known good\n");
      throw new Error("simulated build failure");
    },
  }), /simulated build failure/);

  assert.equal(fs.readFileSync(path.join(fixture.target, "proof.txt"), "utf8"), "known good\n");
  assert.equal(
    fs.readdirSync(path.dirname(fixture.target)).filter((name) => name.includes(".staging-")).length,
    0,
  );
});

test("post-activation repair runs at the final path after the atomic swap", (t) => {
  const fixture = createFixture(t);
  let stagingDependency = "";
  let activatedDependency = "";

  materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
    prepare(staging) {
      const packageRoot = path.join(staging, "node_modules", ".bun", "fixture");
      const packageLink = path.join(staging, "node_modules", "fixture");
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "index.js"), "ready\n");
      fs.symlinkSync(packageRoot, packageLink, "junction");
      stagingDependency = fs.realpathSync(packageLink);
    },
    activate(target) {
      const packageRoot = path.join(target, "node_modules", ".bun", "fixture");
      const packageLink = path.join(target, "node_modules", "fixture");
      assert.equal(fs.existsSync(packageLink), false);
      fs.unlinkSync(packageLink);
      fs.symlinkSync(packageRoot, packageLink, "junction");
      activatedDependency = fs.realpathSync(packageLink);
    },
  });

  assert.match(stagingDependency, /\.staging-/);
  assert.equal(activatedDependency.startsWith(path.resolve(fixture.target)), true);
  assert.equal(fs.readFileSync(path.join(fixture.target, "node_modules", "fixture", "index.js"), "utf8"), "ready\n");
});

test("real Bun repair rewires Windows workspace junctions at the activated path", {
  skip: process.platform !== "win32" || spawnSync("bun", ["--version"], { encoding: "utf8" }).status !== 0,
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-bun-repair-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousTemp = process.env.TEMP;
  const previousTmp = process.env.TMP;
  const bunTemp = path.join(root, "tmp");
  fs.mkdirSync(bunTemp);
  process.env.TEMP = bunTemp;
  process.env.TMP = bunTemp;
  t.after(() => {
    if (previousTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP;
    else process.env.TMP = previousTmp;
  });
  const staging = path.join(root, "agentglass.staging-test");
  const target = path.join(root, "agentglass");
  for (const name of ["server", "web", "fixture-dep"]) {
    fs.mkdirSync(path.join(staging, name), { recursive: true });
  }
  fs.writeFileSync(path.join(staging, "package.json"), `${JSON.stringify({
    name: "agenthost-repair-fixture",
    private: true,
    workspaces: ["server", "web", "fixture-dep"],
  })}\n`);
  fs.writeFileSync(path.join(staging, "server", "package.json"), `${JSON.stringify({
    name: "agentglass-server",
    version: "1.0.0",
    dependencies: { "fixture-dep": "workspace:*" },
  })}\n`);
  fs.writeFileSync(path.join(staging, "web", "package.json"), `${JSON.stringify({
    name: "agentglass-web",
    version: "1.0.0",
    dependencies: { "fixture-dep": "workspace:*" },
  })}\n`);
  fs.writeFileSync(path.join(staging, "fixture-dep", "package.json"), `${JSON.stringify({
    name: "fixture-dep",
    version: "1.0.0",
  })}\n`);
  run(staging, "bun", ["install", "--ignore-scripts"]);

  const dependencyLink = path.join("server", "node_modules", "fixture-dep");
  assert.match(fs.realpathSync(path.join(staging, dependencyLink)), /\.staging-/);
  fs.renameSync(staging, target);
  assert.equal(fs.existsSync(path.join(target, dependencyLink)), false);

  repairActivatedControlPlane(target, "bun");

  const repaired = fs.realpathSync(path.join(target, dependencyLink));
  assert.equal(repaired.startsWith(path.resolve(target)), true);
  assert.doesNotMatch(repaired, /\.staging-/);
});

test("post-activation repair failure restores the known-good runtime", (t) => {
  const fixture = createFixture(t);
  materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  fs.writeFileSync(path.join(fixture.target, "proof.txt"), "known good\n");

  assert.throws(() => materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
    prepare(staging) {
      fs.writeFileSync(path.join(staging, "built.txt"), "ready\n");
    },
    activate(target) {
      assert.equal(fs.readFileSync(path.join(target, "built.txt"), "utf8"), "ready\n");
      throw new Error("simulated post-activation repair failure");
    },
  }), /simulated post-activation repair failure/);

  assert.equal(fs.readFileSync(path.join(fixture.target, "proof.txt"), "utf8"), "known good\n");
  assert.equal(fs.existsSync(`${fixture.target}.backup`), false);
});

test("failed final swap never deletes a concurrent activation", (t) => {
  const fixture = createFixture(t);
  materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  fs.writeFileSync(path.join(fixture.target, "proof.txt"), "previous runtime\n");

  const collideWithSwap = (source, target) => {
    if (source.includes(".staging-") && path.resolve(target) === path.resolve(fixture.target)) {
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "proof.txt"), "concurrent runtime\n");
      throw Object.assign(new Error("simulated concurrent activation"), { code: "EEXIST" });
    }
    fs.renameSync(source, target);
  };

  assert.throws(() => materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
    rename: collideWithSwap,
  }), /simulated concurrent activation/);

  assert.equal(fs.readFileSync(path.join(fixture.target, "proof.txt"), "utf8"), "concurrent runtime\n");
  assert.equal(fs.existsSync(`${fixture.target}.backup`), false);
});

test("failed startup rolls back the complete activation lifecycle", (t) => {
  const fixture = createFixture(t);
  materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  fs.writeFileSync(path.join(fixture.target, "proof.txt"), "known good\n");

  const activated = materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
    prepare(staging) {
      fs.writeFileSync(path.join(staging, "built.txt"), "ready\n");
    },
  });
  assert.equal(fs.readFileSync(path.join(fixture.target, "built.txt"), "utf8"), "ready\n");
  assert.equal(path.basename(activated.backup), "agentglass.backup");

  const rolledBack = rollbackActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  assert.equal(rolledBack.restored, true);
  assert.equal(fs.readFileSync(path.join(fixture.target, "proof.txt"), "utf8"), "known good\n");
  assert.equal(fs.existsSync(activated.backup), false);
});

test("verified prepared activation keeps rollback until readiness finalizes it", (t) => {
  const fixture = createFixture(t);
  materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  fs.writeFileSync(path.join(fixture.target, "proof.txt"), "known good\n");

  const activated = materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
    prepare(staging) {
      createPreparedFixtureRuntime(staging, fixture.controlPlaneDir);
    },
  });
  const verified = verifyPreparedActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  assert.equal(verified.prepared, true);
  assert.equal(verified.backup, activated.backup);
  assert.equal(fs.existsSync(activated.backup), true);

  const rolledBack = rollbackActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  assert.equal(rolledBack.restored, true);
  assert.equal(fs.readFileSync(path.join(fixture.target, "proof.txt"), "utf8"), "known good\n");

  const activatedAgain = materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
    prepare(staging) {
      createPreparedFixtureRuntime(staging, fixture.controlPlaneDir);
    },
  });
  verifyPreparedActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  const finalized = finalizeActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  assert.equal(finalized.backup, activatedAgain.backup);
  assert.equal(finalized.removed, true);
  assert.equal(finalized.cleanupPending, false);
  assert.equal(fs.existsSync(activatedAgain.backup), false);
});

test("prepared verification rejects stale build proof without changing either runtime", (t) => {
  const fixture = createFixture(t);
  materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  fs.writeFileSync(path.join(fixture.target, "proof.txt"), "rollback copy\n");
  const activated = materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
    prepare(staging) {
      createPreparedFixtureRuntime(staging, fixture.controlPlaneDir);
    },
  });
  const backupProof = fs.readFileSync(path.join(activated.backup, "proof.txt"), "utf8");
  const lockfile = path.join(fixture.target, "bun.lock");
  const originalLockfile = fs.readFileSync(lockfile, "utf8");
  fs.appendFileSync(lockfile, "changed-after-preparation\n");
  assert.throws(() => verifyPreparedActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
  }), /build proof does not match/);
  assert.equal(fs.readFileSync(path.join(activated.backup, "proof.txt"), "utf8"), backupProof);
  fs.writeFileSync(lockfile, originalLockfile);

  const serverEntry = path.join(fixture.target, "server", "src", "index.ts");
  const originalServerEntry = fs.readFileSync(serverEntry, "utf8");
  fs.appendFileSync(serverEntry, "export const changed = true;\n");
  assert.throws(() => verifyPreparedActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
  }), /build proof does not match/);
  assert.equal(fs.readFileSync(path.join(activated.backup, "proof.txt"), "utf8"), backupProof);
  fs.writeFileSync(serverEntry, originalServerEntry);

  const index = path.join(fixture.target, "web", "dist", "index.html");
  fs.appendFileSync(index, "<!-- changed after preparation -->\n");
  const changedBuild = fs.readFileSync(index, "utf8");

  assert.throws(() => verifyPreparedActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
  }), /build proof does not match/);
  assert.equal(fs.readFileSync(path.join(activated.backup, "proof.txt"), "utf8"), backupProof);
  assert.equal(fs.readFileSync(index, "utf8"), changedBuild);

  fs.rmSync(path.join(fixture.target, ".agenthost-prepared.json"));
  assert.throws(() => verifyPreparedActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
  }), /proof is missing or invalid/);
  assert.equal(fs.readFileSync(path.join(activated.backup, "proof.txt"), "utf8"), backupProof);
  assert.equal(fs.readFileSync(index, "utf8"), changedBuild);
});

test("successful health finalization removes the single bounded backup", (t) => {
  const fixture = createFixture(t);
  materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
  });

  const first = materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  assert.equal(path.basename(first.backup), "agentglass.backup");

  const second = materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  assert.equal(second.backup, first.backup);
  assert.deepEqual(
    fs.readdirSync(path.dirname(fixture.target)).filter((name) => name.startsWith("agentglass.backup")),
    ["agentglass.backup"],
  );

  const finalized = finalizeActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  assert.equal(finalized.removed, true);
  assert.equal(finalized.cleanupPending, false);
  assert.equal(fs.existsSync(second.backup), false);
});

test("finalization never exposes a partially deleted rollback copy", (t) => {
  const fixture = createFixture(t);
  materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  fs.writeFileSync(path.join(fixture.target, "proof.txt"), "exact rollback\n");
  const activated = materialize({
    source: fixture.source,
    target: fixture.target,
    fresh: true,
    controlPlaneDir: fixture.controlPlaneDir,
    prepare(staging) {
      createPreparedFixtureRuntime(staging, fixture.controlPlaneDir);
    },
  });

  const finalized = finalizeActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
    remove(directory) {
      fs.rmSync(path.join(directory, "proof.txt"));
      throw Object.assign(
        new Error("injected partial cleanup failure"),
        { code: "EACCES" },
      );
    },
  });
  assert.equal(finalized.removed, true);
  assert.equal(finalized.cleanupPending, true);
  assert.equal(finalized.cleanupErrorCode, "EACCES");
  assert.equal(fs.existsSync(activated.backup), false);
  assert.equal(fs.existsSync(finalized.retired), true);
  assert.equal(fs.existsSync(path.join(finalized.retired, "proof.txt")), false);
  assert.equal(
    fs.readFileSync(path.join(fixture.target, "surface.txt"), "utf8").trim(),
    "interactive",
  );
  const rollbackAfterFinalize = rollbackActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
  });
  assert.equal(rollbackAfterFinalize.restored, false);
  assert.equal(rollbackAfterFinalize.removed, false);
  assert.equal(rollbackAfterFinalize.finalized, true);
  assert.equal(
    fs.readFileSync(path.join(fixture.target, "surface.txt"), "utf8").trim(),
    "interactive",
  );
  const cleanupRetry = finalizeActivation({
    target: fixture.target,
    controlPlaneDir: fixture.controlPlaneDir,
    remove() {
      throw Object.assign(
        new Error("injected retained cleanup failure"),
        { code: "EACCES" },
      );
    },
  });
  assert.equal(cleanupRetry.removed, false);
  assert.equal(cleanupRetry.cleanupPending, true);
  assert.equal(cleanupRetry.cleanupErrorCode, "EACCES");
  assert.equal(
    fs.readFileSync(path.join(fixture.target, "surface.txt"), "utf8").trim(),
    "interactive",
  );

  const renameFailure = createFixture(t);
  materialize({
    source: renameFailure.source,
    target: renameFailure.target,
    fresh: true,
    controlPlaneDir: renameFailure.controlPlaneDir,
  });
  fs.writeFileSync(path.join(renameFailure.target, "proof.txt"), "exact rollback\n");
  const secondActivation = materialize({
    source: renameFailure.source,
    target: renameFailure.target,
    fresh: true,
    controlPlaneDir: renameFailure.controlPlaneDir,
    prepare(staging) {
      createPreparedFixtureRuntime(staging, renameFailure.controlPlaneDir);
    },
  });
  assert.throws(() => finalizeActivation({
    target: renameFailure.target,
    controlPlaneDir: renameFailure.controlPlaneDir,
    rename() {
      throw Object.assign(
        new Error("injected atomic rename failure"),
        { code: "EIO" },
      );
    },
  }), /injected atomic rename failure/);
  assert.equal(
    fs.readFileSync(path.join(secondActivation.backup, "proof.txt"), "utf8"),
    "exact rollback\n",
  );
  assert.equal(
    fs.readFileSync(path.join(renameFailure.target, "surface.txt"), "utf8").trim(),
    "interactive",
  );
});

test("materializer retries only transient Windows directory locks", () => {
  let attempts = 0;
  renameWithRetry("from", "to", () => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
  });
  assert.equal(attempts, 3);

  assert.throws(() => renameWithRetry("from", "to", () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }), /missing/);
});
