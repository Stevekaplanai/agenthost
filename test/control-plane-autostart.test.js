import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manager = path.join(repositoryRoot, "control-plane", "AgentHost-Dashboard.ps1");
const launcher = path.join(repositoryRoot, "control-plane", "start-local.ps1");
const privateStateHelper = path.join(
  repositoryRoot,
  "control-plane",
  "Protect-AgentHostPrivateState.ps1",
);
const bundleVerifier = path.join(
  repositoryRoot,
  "control-plane",
  "Invoke-AgentHostDashboardBundle.ps1",
);
const runtimeLinkFlattener = path.join(
  repositoryRoot,
  "control-plane",
  "Flatten-AgentHostRuntimeLinks.mjs",
);
const nodeBundleVerifier = path.join(
  repositoryRoot,
  "control-plane",
  "Verify-AgentHostDashboardBundle.mjs",
);
const readme = path.join(repositoryRoot, "control-plane", "README.md");
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function source(file) {
  assert.ok(fs.existsSync(file), `required committed file is missing: ${file}`);
  return fs.readFileSync(file, "utf8");
}

function powershellFunction(script, name) {
  const start = script.indexOf(`function ${name}`);
  assert.ok(start >= 0, `missing PowerShell function: ${name}`);
  const next = script.indexOf("\nfunction ", start + 1);
  return script.slice(start, next < 0 ? undefined : next);
}

function parseWithWindowsPowerShell(file) {
  return spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    [
      "& {",
      "param($file);",
      "$tokens = $null;",
      "$errors = $null;",
      "[System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors) | Out-Null;",
      "if ($errors.Count -gt 0) {",
      "  $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) };",
      "  exit 1;",
      "}",
      "}",
    ].join(" "),
    file,
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function invokeManager(args, environment = {}) {
  return spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", manager,
    ...args,
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
}

test("the committed manager and launcher parse under Windows PowerShell 5.1", {
  skip: process.platform !== "win32",
}, () => {
  source(manager);
  source(privateStateHelper);
  source(nodeBundleVerifier);
  for (const script of [manager, launcher, privateStateHelper, bundleVerifier]) {
    const parsed = parseWithWindowsPowerShell(script);
    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
  }
});

test("private service directories can be protected twice without admin-only ACL privileges", {
  skip: process.platform !== "win32",
}, (t) => {
  const helper = source(privateStateHelper);
  assert.match(helper, /\[System\.IO\.Directory\]::SetAccessControl/i);
  assert.doesNotMatch(helper, /\bSet-Acl\b/i);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-private-acl-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localAppData = path.join(root, "local");
  const target = path.join(localAppData, "AgentHost", "control-plane");
  const probe = path.join(root, "probe.ps1");
  fs.writeFileSync(probe, [
    "param($Helper, $Target)",
    '$ErrorActionPreference = "Stop"',
    ". $Helper",
    "$first = Set-AgentHostPrivateDirectoryAcl -Path $Target",
    "$second = Set-AgentHostPrivateDirectoryAcl -Path $Target",
    "if ($first -cne $second) { throw 'private path changed' }",
    "Write-Output 'private-acl-pass'",
    "",
  ].join("\r\n"));
  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", probe,
    privateStateHelper,
    target,
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /private-acl-pass/);
});

test("install contract is current-user, least-privilege, and crash-restarting", () => {
  const script = source(manager);

  for (const action of [
    "Install",
    "Start",
    "Open",
    "CopyLink",
    "Status",
    "Stop",
    "Restart",
    "Uninstall",
    "Run",
  ]) {
    assert.match(
      script,
      new RegExp(String.raw`\[switch\]\s*\$${action}\b`, "i"),
      `manager must expose -${action}`,
    );
  }
  assert.match(
    script,
    /\[string\]\s*\$StateDirectory\b/i,
    "manager must allow an explicit operational-state directory without accepting token values",
  );
  assert.match(script, /New-ScheduledTaskTrigger[\s\S]{0,240}-AtLogOn/i);
  assert.match(
    script,
    /New-ScheduledTaskTrigger[\s\S]{0,240}-AtLogOn[\s\S]{0,240}-User/i,
    "the logon trigger must be scoped to the current Windows user",
  );
  assert.match(script, /New-ScheduledTaskPrincipal[\s\S]{0,320}-UserId/i);
  assert.match(
    script,
    /New-ScheduledTaskPrincipal[\s\S]{0,320}-LogonType\s+["']?Interactive/i,
  );
  assert.match(script, /New-ScheduledTaskPrincipal[\s\S]{0,320}-RunLevel\s+["']?Limited/i);
  assert.match(script, /New-ScheduledTaskSettingsSet[\s\S]{0,500}-StartWhenAvailable/i);
  assert.match(script, /New-ScheduledTaskSettingsSet[\s\S]{0,500}-RestartCount\s+[1-9]/i);
  assert.match(script, /New-ScheduledTaskSettingsSet[\s\S]{0,500}-RestartInterval/i);
  assert.match(script, /Register-ScheduledTask/i);
  assert.match(
    script,
    /\$taskPath\s*=\s*["']\\AgentHost\\["']/i,
    "the dashboard must own a dedicated Task Scheduler folder",
  );
  assert.match(
    script,
    /-WindowStyle["']?\s*,?\s*["']?Hidden|-WindowStyle\s+Hidden/i,
    "the startup task must not leave a PowerShell window open",
  );
  assert.doesNotMatch(
    script,
    /-RunLevel\s+["']?Highest/i,
    "the dashboard must not request administrator privileges",
  );
});

test("crash recovery registers logon and indefinite one-minute triggers", {
  skip: process.platform !== "win32",
}, (t) => {
  const registration = powershellFunction(
    source(manager),
    "Register-AgentHostDashboardTask",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-task-triggers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = path.join(root, "probe.ps1");
  fs.writeFileSync(probe, [
    '$ErrorActionPreference = "Stop"',
    '$taskPath = "\\AgentHost\\"',
    '$taskName = "AgentHost Dashboard"',
    "$previousConfig = $null",
    "$script:registered = $null",
    "function Ensure-AgentHostTaskFolder {}",
    "function Get-AgentHostTask { return $null }",
    'function Assert-AgentHostOwnedTask { throw "Ownership check must not run without an existing task." }',
    "function New-ScheduledTaskAction {",
    "  param($Execute, $Argument, $WorkingDirectory)",
    "  return [pscustomobject]@{ Execute = $Execute; Argument = $Argument; WorkingDirectory = $WorkingDirectory }",
    "}",
    "function New-ScheduledTaskTrigger {",
    "  param(",
    "    [switch]$AtLogOn,",
    "    [string]$User,",
    "    [switch]$Once,",
    "    [datetime]$At,",
    "    [timespan]$RepetitionInterval,",
    "    [timespan]$RepetitionDuration",
    "  )",
    '  $kind = if ($AtLogOn) { "Logon" } elseif ($Once) { "Once" } else { "Unknown" }',
    "  return [pscustomobject]@{",
    "    Kind = $kind",
    "    User = $User",
    "    At = $At",
    "    RepetitionInterval = $RepetitionInterval",
    '    DurationBound = $PSBoundParameters.ContainsKey("RepetitionDuration")',
    "    Repetition = [pscustomobject]@{ StopAtDurationEnd = $true }",
    "  }",
    "}",
    "function New-ScheduledTaskPrincipal {",
    "  param($UserId, $LogonType, $RunLevel)",
    "  return [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }",
    "}",
    "function New-ScheduledTaskSettingsSet {",
    "  param(",
    "    [switch]$Disable,",
    "    [switch]$StartWhenAvailable,",
    "    [int]$RestartCount,",
    "    [timespan]$RestartInterval,",
    "    [timespan]$ExecutionTimeLimit,",
    "    [string]$MultipleInstances,",
    "    [switch]$AllowStartIfOnBatteries,",
    "    [switch]$DontStopIfGoingOnBatteries",
    "  )",
    "  return [pscustomobject]@{",
    "    StartWhenAvailable = [bool]$StartWhenAvailable",
    "    MultipleInstances = $MultipleInstances",
    "  }",
    "}",
    "function Register-ScheduledTask {",
    "  param(",
    "    $TaskPath, $TaskName, $Action, [object[]]$Trigger,",
    "    $Principal, $Settings, $Description, [switch]$Force",
    "  )",
    "  $script:registered = [pscustomobject]@{",
    "    Triggers = @($Trigger)",
    "    Settings = $Settings",
    "  }",
    "}",
    registration,
    "$started = Get-Date",
    "$plan = [pscustomobject]@{ execute = 'powershell.exe'; arguments = '-File sealed.ps1' }",
    "Register-AgentHostDashboardTask -Plan $plan -BundleRoot 'C:\\AgentHost\\sealed'",
    'if ($null -eq $script:registered) { throw "Task registration was not attempted." }',
    "$triggers = @($script:registered.Triggers)",
    'if ($triggers.Count -ne 2) { throw "Task registration must receive exactly two triggers." }',
    '$logon = @($triggers | Where-Object Kind -eq "Logon")',
    '$recovery = @($triggers | Where-Object Kind -eq "Once")',
    'if ($logon.Count -ne 1 -or $recovery.Count -ne 1) { throw "Expected one logon and one recovery trigger." }',
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
    'if ($logon[0].User -cne $identity.Name) { throw "Logon trigger is not scoped to the current user." }',
    '$latestRecovery = (Get-Date).AddSeconds(90)',
    'if ($recovery[0].At -lt $started.AddSeconds(45) -or $recovery[0].At -gt $latestRecovery) {',
    '  throw "Recovery trigger must begin about one minute after registration."',
    "}",
    'if ($recovery[0].RepetitionInterval.TotalSeconds -ne 60) { throw "Recovery trigger must repeat every minute." }',
    'if ($recovery[0].DurationBound) { throw "Recovery trigger must not have a finite repetition duration." }',
    'if ($recovery[0].Repetition.StopAtDurationEnd) { throw "Recovery repetition must remain indefinite." }',
    'if (-not $script:registered.Settings.StartWhenAvailable) { throw "StartWhenAvailable was lost." }',
    'if ($script:registered.Settings.MultipleInstances -cne "IgnoreNew") { throw "IgnoreNew overlap protection was lost." }',
    'Write-Output "task-trigger-contract-pass"',
    "",
  ].join("\r\n"));

  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", probe,
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /task-trigger-contract-pass/);
});

test("task ownership resolves Scheduler-normalized usernames to the current SID", {
  skip: process.platform !== "win32",
}, () => {
  const script = source(manager);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-task-principal-"));
  const probe = path.join(root, "probe.ps1");
  try {
    fs.writeFileSync(probe, [
      '$ErrorActionPreference = "Stop"',
      '$taskPath = "\\AgentHost\\"',
      powershellFunction(script, "Test-AgentHostSamePath"),
      powershellFunction(script, "Test-AgentHostTaskPrincipalIsCurrentUser"),
      powershellFunction(script, "Assert-AgentHostOwnedTask"),
      '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
      '$leafUser = ($identity.Name -split "\\\\")[-1]',
      '$execute = Join-Path $PSHOME "powershell.exe"',
      '$bundle = "C:\\AgentHost\\sealed-bundle"',
      '$task = [pscustomobject]@{',
      '  TaskPath = $taskPath',
      '  Actions = @([pscustomobject]@{ Execute = $execute; Arguments = "sealed"; WorkingDirectory = $bundle })',
      '  Principal = [pscustomobject]@{ UserId = $leafUser; RunLevel = "Limited"; LogonType = "Interactive" }',
      '}',
      '$config = [pscustomobject]@{',
      '  taskExecute = $execute',
      '  taskArguments = "sealed"',
      '  bundleRoot = $bundle',
      '  taskUserId = $identity.Name',
      '  taskUserSid = $identity.User.Value',
      '}',
      'Assert-AgentHostOwnedTask -Task $task -Config $config',
      '$config.taskUserSid = "S-1-5-18"',
      '$rejectedConfig = $false',
      'try { Assert-AgentHostOwnedTask -Task $task -Config $config } catch { $rejectedConfig = $true }',
      'if (-not $rejectedConfig) { throw "A mismatched sealed config SID was accepted." }',
      '$config.taskUserSid = $identity.User.Value',
      '$task.Principal.UserId = "S-1-5-18"',
      '$rejected = $false',
      'try { Assert-AgentHostOwnedTask -Task $task -Config $config } catch { $rejected = $true }',
      'if (-not $rejected) { throw "A different principal SID was accepted." }',
      "",
    ].join("\r\n"));

    const result = spawnSync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", probe,
    ], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled action seals and verifies a private bundle, never secret values", {
  skip: process.platform !== "win32",
}, () => {
  const script = source(manager);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-autostart-plan-"));
  const localAppData = path.join(root, "local-app-data");
  const controlRoot = path.join(root, "room-state");
  const secretFile = path.join(root, "kanban-bridge.env");
  const secretCanary = "AUTOSTART_MUST_NOT_READ_OR_PRINT_THIS_SECRET";
  fs.mkdirSync(localAppData, { recursive: true });
  fs.writeFileSync(secretFile, [
    "AGENTHOST_KANBAN_URL=https://box.example.ts.net/kanban/tasks",
    `AGENTHOST_KANBAN_READ_TOKEN=${secretCanary}`,
    `AGENTHOST_KANBAN_WRITE_TOKEN=${"b".repeat(64)}`,
    "",
  ].join("\n"));

  try {
    assert.match(script, /\$PSScriptRoot/i);
    assert.match(script, /start-local\.ps1/i);
    assert.match(script, /bundle-manifest\.json/i);
    assert.match(script, /Get-FileHash/i);
    assert.match(script, /Invoke-AgentHostDashboardBundle\.ps1/i);
    assert.match(script, /Verify-AgentHostDashboardBundle\.mjs/i);
    assert.match(
      script,
      /service[\\\/]versions/i,
      "install must copy the startup chain into a private versioned bundle",
    );
    assert.match(script, /New-ScheduledTaskAction/i);
    assert.match(script, /EncodedCommand/i);
    for (const flag of [
      "Run",
      "UsePreparedRuntime",
      "Port",
      "AllowedOrigin",
      "KanbanSecretFile",
      "ControlRoot",
      "RuntimeStateDirectory",
      "WorkspaceRoot",
      "DataDirectory",
      "NodePath",
      "BunPath",
      "NoBrowser",
    ]) {
      assert.match(script, new RegExp(`-${flag}\\b`, "i"), `scheduled action must pass -${flag}`);
    }
    assert.doesNotMatch(
      script,
      /Get-Content[\s\S]{0,160}KanbanSecretFile|ReadAllText[\s\S]{0,160}KanbanSecretFile/i,
      "the task manager passes the secret-file path; it must never read token values",
    );

    const planned = invokeManager([
      "-Install",
      "-Port", "4999",
      "-AllowedOrigin", "https://desktop-test.example.ts.net:4443",
      "-KanbanSecretFile", secretFile,
      "-ControlRoot", controlRoot,
      "-WhatIf",
    ], { LOCALAPPDATA: localAppData });
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    assert.doesNotMatch(
      `${planned.stdout}\n${planned.stderr}`,
      new RegExp(secretCanary),
      "install planning must not disclose the content of a credential file",
    );
    assert.equal(
      fs.existsSync(path.join(localAppData, "AgentHost", "control-plane", "dashboard.pid.json")),
      false,
      "-WhatIf must not pretend the dashboard is running",
    );
    assert.doesNotMatch(
      `${planned.stdout}\n${planned.stderr}`,
      /\bOpened\b|\bCopied\b/i,
      "-WhatIf must not claim that an action occurred",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sealed launch, service, task, and bundle artifacts never copy Kanban token values", {
  skip: process.platform !== "win32",
}, (t) => {
  const script = source(manager);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-kanban-artifacts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "committed-source");
  const sourceControlPlane = path.join(sourceRoot, "control-plane");
  const stateDirectory = path.join(root, "service-state");
  const artifactRoot = path.join(root, "artifacts");
  const buildProfileRoot = path.join(root, "build-profile");
  const secretFile = path.join(root, "credentials", "kanban.env");
  const probe = path.join(root, "probe.ps1");
  const readCanary = `KANBAN_READ_CANARY_${createHash("sha256")
    .update(`read:${root}`)
    .digest("hex")
    .slice(0, 24)}`;
  const writeCanary = `KANBAN_WRITE_CANARY_${createHash("sha256")
    .update(`write:${root}`)
    .digest("hex")
    .slice(0, 24)}`;
  const controlFiles = [
    "AgentHost.bunfig.toml",
    "AgentHost-Dashboard.ps1",
    "Confirm-AgentHostReadiness.ps1",
    "Flatten-AgentHostRuntimeLinks.mjs",
    "Invoke-AgentHostDashboardBundle.ps1",
    "LICENSE.agentglass",
    "materialize.mjs",
    "New-AgentHostToken.ps1",
    "Protect-AgentHostPrivateState.ps1",
    "Read-AgentHostKanbanConfig.ps1",
    "start-local.ps1",
    "upstream.json",
    "Verify-AgentHostDashboardBundle.mjs",
  ];

  fs.mkdirSync(path.join(sourceControlPlane, ".runtime", "agentglass"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(sourceControlPlane, "overlay"), { recursive: true });
  fs.mkdirSync(path.join(sourceControlPlane, "patches"), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "scripts"), { recursive: true });
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  fs.mkdirSync(buildProfileRoot, { recursive: true });
  for (const name of controlFiles) {
    fs.writeFileSync(path.join(sourceControlPlane, name), `${name}\n`);
  }
  fs.writeFileSync(path.join(sourceRoot, "scripts", "room-state-root.ps1"), "\n");
  fs.writeFileSync(secretFile, [
    "AGENTHOST_KANBAN_URL=https://box.example.ts.net/kanban/tasks",
    `AGENTHOST_KANBAN_READ_TOKEN=${readCanary}`,
    `AGENTHOST_KANBAN_WRITE_TOKEN=${writeCanary}`,
    "",
  ].join("\n"));

  fs.writeFileSync(probe, [
    "param($SourceRoot, $StateRoot, $BuildProfileRoot, $SecretFile, $ArtifactRoot)",
    '$ErrorActionPreference = "Stop"',
    "function Assert-AgentHostPrivatePath {",
    "  param([string]$Path, [switch]$RequireDirectory, [switch]$RequireFile)",
    "  return [IO.Path]::GetFullPath($Path)",
    "}",
    "function Set-AgentHostPrivateDirectoryAcl {",
    "  param([string]$Path)",
    "  $null = [IO.Directory]::CreateDirectory($Path)",
    "  return [IO.Path]::GetFullPath($Path)",
    "}",
    powershellFunction(script, "Copy-AgentHostRegularTree"),
    "function Invoke-AgentHostSterileBuildProcess {",
    "  param($ExecutablePath, $Arguments, $ProfileRoot, $ToolPaths, $WorkingDirectory)",
    "  return [pscustomobject]@{ exitCode = 0 }",
    "}",
    powershellFunction(script, "New-AgentHostSealedBundle"),
    powershellFunction(script, "ConvertTo-AgentHostPowerShellLiteral"),
    powershellFunction(script, "New-AgentHostTaskPlan"),
    powershellFunction(script, "New-AgentHostServiceConfiguration"),
    '$bundleVerifierName = "Invoke-AgentHostDashboardBundle.ps1"',
    '$nodeBundleVerifierName = "Verify-AgentHostDashboardBundle.mjs"',
    "$StateDirectory = $StateRoot",
    "$Port = 4001",
    '$AllowedOrigin = "https://desktop-test.example.ts.net:4443"',
    "$KanbanSecretFile = $SecretFile",
    "$ControlRoot = Join-Path $StateRoot 'room-state'",
    "$WorkspaceRoot = $SourceRoot",
    "$dataDirectory = Join-Path $StateRoot 'data'",
    "$script:sourceCommit = 'c' * 40",
    "$node = [pscustomobject]@{ path = 'C:\\tools\\node.exe'; sha256 = ('1' * 64); length = 123 }",
    "$bun = [pscustomobject]@{ path = 'C:\\tools\\bun.exe'; sha256 = ('2' * 64); length = 456 }",
    "$git = [pscustomobject]@{ path = 'C:\\tools\\git.exe'; sha256 = ('3' * 64); length = 789 }",
    "$bundle = New-AgentHostSealedBundle -Node $node -Bun $bun -Git $git -CommittedSourceRoot $SourceRoot -BuildProfileRoot $BuildProfileRoot",
    "$plan = New-AgentHostTaskPlan -Bundle $bundle -RuntimeStateDirectory $StateDirectory",
    "$service = New-AgentHostServiceConfiguration -Bundle $bundle -Plan $plan -Node $node -Bun $bun",
    "$null = [IO.Directory]::CreateDirectory($ArtifactRoot)",
    "$encoding = [Text.UTF8Encoding]::new($false)",
    "[IO.File]::WriteAllText((Join-Path $ArtifactRoot 'dashboard-service.json'), (($service | ConvertTo-Json -Depth 8) + [Environment]::NewLine), $encoding)",
    "[IO.File]::WriteAllText((Join-Path $ArtifactRoot 'task-plan.json'), (($plan | ConvertTo-Json -Depth 8) + [Environment]::NewLine), $encoding)",
    "[IO.File]::WriteAllText((Join-Path $ArtifactRoot 'bundle.json'), (($bundle | ConvertTo-Json -Depth 8) + [Environment]::NewLine), $encoding)",
    'Write-Output "kanban-artifact-probe-pass"',
    "",
  ].join("\r\n"));

  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", probe,
    sourceRoot,
    stateDirectory,
    buildProfileRoot,
    secretFile,
    artifactRoot,
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /kanban-artifact-probe-pass/);

  const bundle = JSON.parse(
    fs.readFileSync(path.join(artifactRoot, "bundle.json"), "utf8"),
  );
  const launchConfig = JSON.parse(
    fs.readFileSync(path.join(bundle.root, "launch-config.json"), "utf8"),
  );
  const serviceConfig = JSON.parse(
    fs.readFileSync(path.join(artifactRoot, "dashboard-service.json"), "utf8"),
  );
  const taskPlan = JSON.parse(
    fs.readFileSync(path.join(artifactRoot, "task-plan.json"), "utf8"),
  );
  const encodedTaskCommand = taskPlan.arguments.match(
    /-EncodedCommand\s+([A-Za-z0-9+/=]+)/,
  );
  assert.equal(launchConfig.kanbanSecretFile, secretFile);
  assert.equal(serviceConfig.kanbanSecretFile, secretFile);
  assert.ok(encodedTaskCommand, "the temporary task plan must contain its encoded command");

  const artifactFiles = [];
  const pending = [bundle.root, artifactRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else artifactFiles.push(entryPath);
    }
  }
  const surfaces = [
    result.stdout,
    result.stderr,
    Buffer.from(encodedTaskCommand[1], "base64").toString("utf16le"),
    ...artifactFiles.map((file) => fs.readFileSync(file, "utf8")),
  ].join("\n");
  for (const canary of [readCanary, writeCanary]) {
    assert.equal(
      surfaces.includes(canary),
      false,
      `sealed artifacts and task arguments must not contain ${canary}`,
    );
  }
});

test("reinstall preserves the sealed Kanban credential path for reboot without storing tokens", {
  skip: process.platform !== "win32",
}, (t) => {
  const script = source(manager);
  const initializerEnd = script.indexOf("\nfunction Test-AgentHostSamePath");
  assert.ok(initializerEnd > 0, "manager initialization boundary is missing");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-kanban-reinstall-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probeControlPlane = path.join(root, "control-plane");
  const localAppData = path.join(root, "local-app-data");
  const stateDirectory = path.join(localAppData, "AgentHost", "control-plane");
  const bundleRoot = path.join(stateDirectory, "service", "versions", "prior");
  const secretFile = path.join(root, "kanban-bridge.env");
  const launchConfigPath = path.join(bundleRoot, "launch-config.json");
  const serviceConfigPath = path.join(stateDirectory, "dashboard-service.json");
  const probe = path.join(probeControlPlane, "AgentHost-Dashboard.ps1");
  const serviceProbe = path.join(root, "service-run-probe.ps1");
  const serviceLauncher = path.join(bundleRoot, "control-plane", "start-local.ps1");
  const launcherCapture = path.join(root, "launcher-kanban-path.txt");

  fs.mkdirSync(probeControlPlane, { recursive: true });
  fs.mkdirSync(path.dirname(serviceLauncher), { recursive: true });
  fs.copyFileSync(
    privateStateHelper,
    path.join(probeControlPlane, "Protect-AgentHostPrivateState.ps1"),
  );
  fs.writeFileSync(path.join(probeControlPlane, "start-local.ps1"), "\n");
  fs.writeFileSync(serviceLauncher, [
    "param(",
    "  [switch]$UsePreparedRuntime,",
    "  [int]$Port,",
    "  [string]$AllowedOrigin,",
    "  [string]$KanbanSecretFile,",
    "  [string]$ControlRoot,",
    "  [string]$WorkspaceRoot,",
    "  [string]$DataDirectory,",
    "  [string]$RuntimeStateDirectory,",
    "  [string]$NodePath,",
    "  [string]$NodeSha256,",
    "  [string]$BunPath,",
    "  [string]$BunSha256,",
    "  [string]$ServiceActionSha256,",
    "  [switch]$NoBrowser",
    ")",
    "[System.IO.File]::WriteAllText($env:AGENTHOST_LAUNCHER_CAPTURE, $KanbanSecretFile)",
    "",
  ].join("\r\n"));

  const launchConfig = {
    schemaVersion: 1,
    port: 4001,
    allowedOrigin: "https://desktop-test.example.ts.net:4443",
    kanbanSecretFile: secretFile,
    controlRoot: path.join(root, "room-state"),
    stateDirectory,
    workspaceRoot: root,
    dataDirectory: path.join(root, "control-plane", ".runtime", "data"),
    sourceCommit: "a".repeat(40),
  };
  const serializedLaunchConfig = `${JSON.stringify(launchConfig)}\n`;
  fs.writeFileSync(launchConfigPath, serializedLaunchConfig);
  const launchConfigSha256 = createHash("sha256")
    .update(serializedLaunchConfig)
    .digest("hex")
    .toUpperCase();
  fs.writeFileSync(serviceConfigPath, `${JSON.stringify({
    schemaVersion: 2,
    bundleRoot,
    kanbanSecretFile: secretFile,
    bundleManifestSha256: "b".repeat(64).toUpperCase(),
    launchConfigSha256,
    nodePath: "node.exe",
    nodeSha256: "n".repeat(64),
    bunPath: "bun.exe",
    bunSha256: "u".repeat(64),
    taskActionSha256: "a".repeat(64),
  })}\n`);
  fs.writeFileSync(probe, [
    script.slice(0, initializerEnd),
    'Write-Output "effective-kanban:$KanbanSecretFile"',
    "",
  ].join("\r\n"));

  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", probe,
    "-Install",
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    result.stdout.split(/\r?\n/).find((line) => line.startsWith("effective-kanban:")),
    `effective-kanban:${secretFile}`,
    "a committed reinstall must retain the trusted credential-file path when the operator omits the flag",
  );

  const sealedBundle = powershellFunction(script, "New-AgentHostSealedBundle");
  const serviceConfig = powershellFunction(script, "New-AgentHostServiceConfiguration");
  const serviceRun = powershellFunction(script, "Invoke-AgentHostServiceRun");
  assert.match(sealedBundle, /kanbanSecretFile\s*=\s*\$KanbanSecretFile/i);
  assert.match(
    serviceRun,
    /-KanbanSecretFile\s+["']?\$\(\$launchConfig\.kanbanSecretFile\)["']?/i,
  );
  assert.doesNotMatch(
    `${sealedBundle}\n${serviceConfig}`,
    /AGENTHOST_KANBAN_(?:READ|WRITE)_TOKEN/i,
    "sealed service state may store the credential-file path, never token values",
  );

  const serviceRunStart = script.indexOf("function Invoke-AgentHostServiceRun");
  const serviceRunEnd = script.indexOf("\nif ($Run)", serviceRunStart);
  assert.ok(
    serviceRunStart >= 0 && serviceRunEnd > serviceRunStart,
    "service-run function boundary is missing",
  );
  fs.writeFileSync(serviceProbe, [
    "param($BundleRoot, $Launcher, $StateDirectory, $Capture)",
    '$ErrorActionPreference = "Stop"',
    "$savedConfig = Get-Content -LiteralPath (Join-Path $StateDirectory 'dashboard-service.json') -Raw | ConvertFrom-Json",
    "$controlPlane = Join-Path $BundleRoot 'control-plane'",
    "$launcher = $Launcher",
    "$BundleManifestSha256 = $savedConfig.bundleManifestSha256",
    "$LaunchConfigSha256 = $savedConfig.launchConfigSha256",
    "$NodePath = $savedConfig.nodePath",
    "$NodeSha256 = $savedConfig.nodeSha256",
    "$BunPath = $savedConfig.bunPath",
    "$BunSha256 = $savedConfig.bunSha256",
    "$errorStatePath = Join-Path $StateDirectory 'dashboard-error.json'",
    "function Test-AgentHostSamePath { param($Left, $Right) return [IO.Path]::GetFullPath($Left) -ieq [IO.Path]::GetFullPath($Right) }",
    "function Read-AgentHostPrivateJson { param($Path) return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }",
    "function Set-AgentHostPrivateDirectoryAcl { param($Path) return $Path }",
    "function Stop-AgentHostValidatedProcesses { param($Config) }",
    "function Write-AgentHostPrivateJson { param($Path, $Value) }",
    script.slice(serviceRunStart, serviceRunEnd),
    "$env:AGENTHOST_LAUNCHER_CAPTURE = $Capture",
    "try { Invoke-AgentHostServiceRun } catch {",
    "  if ($_.Exception.Message -notmatch 'stopped unexpectedly') { throw }",
    "}",
    "",
  ].join("\r\n"));
  const serviceResult = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", serviceProbe,
    bundleRoot,
    serviceLauncher,
    stateDirectory,
    launcherCapture,
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(serviceResult.status, 0, serviceResult.stderr || serviceResult.stdout);
  assert.equal(
    fs.readFileSync(launcherCapture, "utf8"),
    secretFile,
    "the sealed Kanban credential-file path must reach the service launcher",
  );
});

test("corrupt-config reinstall recovers the sealed Kanban path before building or starting replacement", () => {
  const script = source(manager);
  const recovery = powershellFunction(
    script,
    "Get-AgentHostRecoverableInstallationConfig",
  );
  const install = script.slice(script.indexOf("if ($Install)"));
  const recover = install.indexOf(
    "Get-AgentHostRecoverableInstallationConfig",
  );
  const bundle = install.indexOf("$bundle = New-AgentHostSealedBundle");
  const runtime = install.indexOf("Start-AgentHostRuntime", bundle);
  assert.ok(
    recover >= 0 && bundle > recover && runtime > bundle,
    "corrupt-config install must verify and recover the old sealed task before replacement bundle creation and runtime",
  );
  assert.match(
    recovery,
    /Get-AgentHostRecoverableTaskLaunchConfig\s+-Task\s+\$task/i,
    "pre-build recovery must derive configuration from the verified sealed task",
  );
  assert.match(
    recovery,
    /Assert-AgentHostOwnedTask\s+-Task\s+\$task\s+-Config\s+\$recoveredConfig/i,
    "pre-build recovery must validate the scheduled task against its recovered sealed configuration",
  );
  assert.match(
    install.slice(recover, bundle),
    /kanbanSecretFile[\s\S]{0,240}\$KanbanSecretFile|(?:\$KanbanSecretFile[\s\S]{0,240}kanbanSecretFile)/i,
    "the recovered canonical Kanban path must become replacement build input",
  );
  assert.doesNotMatch(
    install.slice(0, bundle),
    /AGENTHOST_KANBAN_(?:READ|WRITE)_TOKEN/i,
    "pre-build recovery may recover only the credential-file path, never token values",
  );
});

test("sealed dashboard manifests stay compact and share a 32 MiB safety bound", {
  skip: process.platform !== "win32",
}, () => {
  const managerSource = source(manager);
  const launcherSource = source(bundleVerifier);
  const nodeVerifierSource = source(nodeBundleVerifier);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-manifest-bound-"));
  const localAppData = path.join(root, "local-app-data");
  const jsonPath = path.join(localAppData, "AgentHost", "probe.json");

  try {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, '{"ok":true}\n');
    assert.match(
      managerSource,
      /ConvertTo-Json\s+-Depth\s+8\s+-Compress/i,
      "the production-size per-file manifest must not spend megabytes on formatting",
    );
    assert.match(
      managerSource,
      /-MaximumBytes\s+33554432\b/i,
      "service inspection must accept the same bounded manifest size as startup",
    );
    assert.match(
      launcherSource,
      /\$manifestItem\.Length\s+-gt\s+33554432\b/i,
      "the sealed PowerShell launcher must enforce the 32 MiB manifest bound",
    );
    assert.match(
      nodeVerifierSource,
      /MAX_MANIFEST_BYTES\s*=\s*32\s*\*\s*1024\s*\*\s*1024\b/i,
      "the pinned Node verifier must enforce the same 32 MiB manifest bound",
    );

    const boundedRead = spawnSync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      "& { param($helper, $json); . $helper; $value = Read-AgentHostPrivateJson -Path $json -MaximumBytes 33554432; if (-not $value.ok) { exit 1 } }",
      privateStateHelper,
      jsonPath,
    ], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, LOCALAPPDATA: localAppData },
    });
    assert.equal(
      boundedRead.status,
      0,
      boundedRead.stderr || boundedRead.stdout,
    );

    const overBoundRead = spawnSync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      "& { param($helper, $json); $ErrorActionPreference = 'Stop'; . $helper; Read-AgentHostPrivateJson -Path $json -MaximumBytes 33554433 | Out-Null }",
      privateStateHelper,
      jsonPath,
    ], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, LOCALAPPDATA: localAppData },
    });
    assert.notEqual(
      overBoundRead.status,
      0,
      "the shared JSON reader must reject any limit above 32 MiB",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pinned Node verifier checks a sealed bundle in one pass and rejects drift", {
  skip: process.platform !== "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-bundle-verifier-"));
  const copiedVerifier = path.join(
    root,
    "control-plane",
    "Verify-AgentHostDashboardBundle.mjs",
  );
  const launchConfig = path.join(root, "launch-config.json");
  const payload = path.join(root, "payload.txt");
  const sealedManager = path.join(
    root,
    "control-plane",
    "AgentHost-Dashboard.ps1",
  );
  const manifestPath = path.join(root, "bundle-manifest.json");
  const sha256 = (file) => createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
  try {
    fs.mkdirSync(path.dirname(copiedVerifier), { recursive: true });
    fs.copyFileSync(nodeBundleVerifier, copiedVerifier);
    fs.writeFileSync(launchConfig, '{"schemaVersion":1}\n');
    fs.writeFileSync(payload, "sealed\n");
    fs.writeFileSync(sealedManager, [
      "param(",
      "  [switch]$Run,",
      "  [string]$StateDirectory,",
      "  [string]$BundleManifestSha256,",
      "  [string]$LaunchConfigSha256,",
      "  [string]$NodePath,",
      "  [string]$NodeSha256,",
      "  [string]$BunPath,",
      "  [string]$BunSha256",
      ")",
      "[IO.File]::WriteAllText($env:AGENTHOST_TEST_MANAGER_MARKER, 'ran')",
      "",
    ].join("\r\n"));
    const files = [
      copiedVerifier,
      launchConfig,
      payload,
      sealedManager,
    ].map((file) => ({
      path: path.relative(root, file).split(path.sep).join("/"),
      length: fs.statSync(file).size,
      sha256: sha256(file),
    }));
    const canonicalNode = fs.realpathSync(process.execPath);
    const nodeTool = {
      path: canonicalNode,
      length: fs.statSync(canonicalNode).size,
      sha256: sha256(canonicalNode),
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      bundleId: "test",
      files,
      tools: { node: nodeTool, bun: nodeTool },
    })}\n`);
    const expectedManifestSha256 = sha256(manifestPath);
    const verify = () => spawnSync(canonicalNode, [
      copiedVerifier,
      "--bundle-root", root,
      "--expected-manifest-sha256", expectedManifestSha256,
    ], {
      encoding: "utf8",
      windowsHide: true,
    });

    const clean = verify();
    assert.equal(clean.status, 0, clean.stderr || clean.stdout);

    fs.appendFileSync(payload, "changed\n");
    const changed = verify();
    assert.notEqual(changed.status, 0, "changed content must fail verification");

    fs.writeFileSync(payload, "sealed\n");
    fs.writeFileSync(path.join(root, "unlisted.txt"), "extra\n");
    const extra = verify();
    assert.notEqual(extra.status, 0, "an unlisted file must fail verification");

    const preload = path.join(root, "malicious-preload.cjs");
    const managerMarker = path.join(root, "manager-ran.txt");
    fs.writeFileSync(preload, "process.exit(0);\n");
    const wrapped = spawnSync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", bundleVerifier,
      "-BundleRoot", root,
      "-ExpectedManifestSha256", expectedManifestSha256,
      "-StateDirectory", path.join(root, "state"),
      "-NodePath", canonicalNode,
      "-ExpectedNodeLength", String(nodeTool.length),
      "-ExpectedNodeSha256", nodeTool.sha256,
      "-ExpectedNodeVerifierLength", String(fs.statSync(copiedVerifier).size),
      "-ExpectedNodeVerifierSha256", sha256(copiedVerifier),
    ], {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        AGENTHOST_TEST_MANAGER_MARKER: managerMarker,
        NODE_OPTIONS: `--require=${preload.split(path.sep).join("/")}`,
        NODE_PATH: root,
      },
    });
    assert.notEqual(
      wrapped.status,
      0,
      "inherited NODE_OPTIONS must not bypass rejection of an unlisted file",
    );
    assert.equal(
      fs.existsSync(managerMarker),
      false,
      "the sealed manager must not run after verification fails",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("install-side Node probes ignore inherited preload settings", {
  skip: process.platform !== "win32",
}, () => {
  const script = source(manager);
  const cleanNode = powershellFunction(
    script,
    "Invoke-AgentHostNodeWithoutOverrides",
  );
  const pinnedTool = powershellFunction(script, "Get-AgentHostPinnedTool");
  const sealedBundle = powershellFunction(script, "New-AgentHostSealedBundle");
  const launcherSource = source(launcher);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-clean-node-"));
  const probe = path.join(root, "probe.ps1");
  const preload = path.join(root, "preload.cjs");
  const canonicalNode = fs.realpathSync(process.execPath);
  try {
    fs.writeFileSync(preload, "process.exit(91);\n");
    fs.writeFileSync(probe, [
      "param([string]$NodePath)",
      cleanNode,
      '$result = Invoke-AgentHostNodeWithoutOverrides -ExecutablePath $NodePath -Arguments @("-p", "1+1")',
      '[pscustomobject]@{ ExitCode = $result.exitCode; Output = (@($result.output) -join "`n") } | ConvertTo-Json -Compress',
      "",
    ].join("\r\n"));
    const result = spawnSync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", probe,
      canonicalNode,
    ], {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${preload.split(path.sep).join("/")}`,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      ExitCode: 0,
      Output: "2",
    });
    assert.match(
      pinnedTool,
      /Invoke-AgentHostNodeWithoutOverrides[\s\S]{0,360}realpathSync/i,
    );
    assert.match(
      sealedBundle,
      /Invoke-AgentHostSterileBuildProcess[\s\S]{0,360}Flatten-AgentHostRuntimeLinks\.mjs/i,
    );
    assert.match(
      launcherSource,
      /UsePreparedRuntime[\s\S]{0,900}Invoke-AgentHostNodeWithoutOverrides[\s\S]{0,280}--verify-prepared/i,
      "manual prepared-runtime verification must scrub NODE_* before its first Node call",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("status is harmless and defaults all operational state to protected LOCALAPPDATA", {
  skip: process.platform !== "win32",
}, () => {
  const script = source(manager);
  const privateState = source(privateStateHelper);
  assert.match(script, /\$env:LOCALAPPDATA/i);
  assert.match(script, /AgentHost[\\\/]control-plane/i);
  assert.match(script, /dashboard\.pid\.json/i);
  assert.match(script, /dashboard-access\.json/i);
  assert.match(script, /dashboard-service\.json/i);
  assert.match(script, /Protect-AgentHostPrivateState\.ps1/i);
  assert.match(
    privateState,
    /SetAccessRuleProtection\s*\(\s*\$true\s*,\s*\$false\s*\)|icacls(?:\.exe)?[\s\S]{0,240}\/inheritance:r/i,
    "the state directory must not inherit broad filesystem permissions",
  );
  assert.match(
    privateState,
    /WriteAllText/i,
    "private state must be written through the shared bounded helper",
  );
  assert.match(
    privateState,
    /FileShare\]::Read|FileShare\.Read/i,
    "private state reads must hold a file handle while validating and parsing",
  );
  assert.match(
    privateState,
    /ReparsePoint/i,
    "private state reads and writes must reject links and junctions",
  );
  assert.match(
    privateState,
    /\[IO\.File\]::(?:Move|Replace)\s*\(|Move-Item\b/i,
    "private JSON must be atomically promoted from a temporary file",
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-autostart-status-"));
  try {
    const result = invokeManager(["-Status"], { LOCALAPPDATA: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /not installed|not running|stopped|absent|unverified/i,
      "status should explain a clean or externally installed task in plain language",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt-config uninstall WhatIf preserves the protected access credential", {
  skip: process.platform !== "win32",
}, (t) => {
  const script = source(manager);
  const uninstallStart = script.indexOf(
    "if ($configurationRecoveryNeeded -and $Uninstall)",
  );
  const uninstallEnd = script.indexOf("if ($Install)", uninstallStart);
  assert.ok(
    uninstallStart >= 0 && uninstallEnd > uninstallStart,
    "corrupt-config uninstall boundary is missing",
  );
  const uninstall = script.slice(uninstallStart, uninstallEnd);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-uninstall-whatif-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "custom-state");
  const accessState = path.join(stateDirectory, "dashboard-access.json");
  const probe = path.join(root, "probe.ps1");
  const credentialCanary = createHash("sha256")
    .update(`whatif-access:${root}`)
    .digest("hex");
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.writeFileSync(accessState, `${JSON.stringify({
    schemaVersion: 1,
    token: credentialCanary,
    localOrigin: "http://127.0.0.1:4001",
    remoteOrigin: "https://desktop-test.example.ts.net:4443",
  })}\n`);
  const before = fs.readFileSync(accessState);
  fs.writeFileSync(probe, [
    "[CmdletBinding(SupportsShouldProcess = $true)]",
    "param([switch]$Uninstall)",
    '$ErrorActionPreference = "Stop"',
    "$configurationRecoveryNeeded = $true",
    "function Repair-AgentHostUntrustedInstallation { throw 'WhatIf called destructive repair.' }",
    "function Remove-AgentHostPrivateFile { throw 'WhatIf removed protected state.' }",
    "function Get-AgentHostDashboardStatus {}",
    uninstall,
    "",
  ].join("\r\n"));

  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", probe,
    "-Uninstall",
    "-WhatIf",
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(accessState), true);
  assert.deepEqual(
    fs.readFileSync(accessState),
    before,
    "a dry-run uninstall must not rotate or rewrite browser authentication",
  );
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(credentialCanary, "i"),
    "a dry-run uninstall must not disclose the protected token",
  );
});

test("readable-config uninstall WhatIf preserves the protected access credential", {
  skip: process.platform !== "win32",
}, (t) => {
  const script = source(manager);
  const initializerEnd = script.indexOf("\nfunction Test-AgentHostSamePath");
  const uninstallStart = script.lastIndexOf("if ($Uninstall)");
  const uninstallEnd = script.indexOf(
    "\nGet-AgentHostDashboardStatus -Config $savedConfig",
    uninstallStart,
  );
  assert.ok(
    initializerEnd > 0 && uninstallStart >= 0 && uninstallEnd > uninstallStart,
    "readable-config initialization or uninstall boundary is missing",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-readable-whatif-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probeControlPlane = path.join(root, "control-plane");
  const localAppData = path.join(root, "local-app-data");
  const stateDirectory = path.join(localAppData, "AgentHost", "control-plane");
  const bundleRoot = path.join(stateDirectory, "service", "versions", "installed");
  const accessState = path.join(stateDirectory, "dashboard-access.json");
  const serviceState = path.join(stateDirectory, "dashboard-service.json");
  const launchConfigPath = path.join(bundleRoot, "launch-config.json");
  const probe = path.join(probeControlPlane, "AgentHost-Dashboard.ps1");
  const credentialCanary = createHash("sha256")
    .update(`readable-whatif-access:${root}`)
    .digest("hex");
  fs.mkdirSync(probeControlPlane, { recursive: true });
  fs.mkdirSync(bundleRoot, { recursive: true });
  fs.copyFileSync(
    privateStateHelper,
    path.join(probeControlPlane, "Protect-AgentHostPrivateState.ps1"),
  );
  fs.writeFileSync(path.join(probeControlPlane, "start-local.ps1"), "\n");
  fs.writeFileSync(accessState, `${JSON.stringify({
    schemaVersion: 1,
    token: credentialCanary,
    localOrigin: "http://127.0.0.1:4001",
    remoteOrigin: "https://desktop-test.example.ts.net:4443",
  })}\n`);
  const launchConfig = `${JSON.stringify({
    schemaVersion: 1,
    port: 4001,
    allowedOrigin: "https://desktop-test.example.ts.net:4443",
    kanbanSecretFile: path.join(root, "credentials", "kanban.env"),
    controlRoot: path.join(root, "room-state"),
    stateDirectory,
    workspaceRoot: root,
    dataDirectory: path.join(root, "control-plane", ".runtime", "data"),
    sourceCommit: "d".repeat(40),
  })}\n`;
  fs.writeFileSync(launchConfigPath, launchConfig);
  fs.writeFileSync(serviceState, `${JSON.stringify({
    schemaVersion: 2,
    bundleRoot,
    launchConfigSha256: createHash("sha256")
      .update(launchConfig)
      .digest("hex")
      .toUpperCase(),
  })}\n`);
  const before = fs.readFileSync(accessState);
  fs.writeFileSync(probe, [
    script.slice(0, initializerEnd),
    "function Stop-AgentHostRuntime { throw 'WhatIf stopped the service.' }",
    "function Unregister-ScheduledTask { throw 'WhatIf removed the task.' }",
    "function Remove-AgentHostPrivateFile { throw 'WhatIf removed protected state.' }",
    "function Get-AgentHostDashboardStatus { param($Config) }",
    script.slice(uninstallStart, uninstallEnd),
    "",
  ].join("\r\n"));

  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", probe,
    "-Uninstall",
    "-WhatIf",
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(accessState), true);
  assert.deepEqual(
    fs.readFileSync(accessState),
    before,
    "a normal dry-run uninstall must not rotate or rewrite browser authentication",
  );
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(credentialCanary, "i"),
    "a normal dry-run uninstall must not disclose the protected token",
  );
});

test("corrupt-config uninstall rotates the recovered custom-state credential only after repair succeeds", () => {
  const script = source(manager);
  const start = script.indexOf(
    "if ($configurationRecoveryNeeded -and $Uninstall)",
  );
  const end = script.indexOf("if ($Install)", start);
  assert.ok(start >= 0 && end > start, "corrupt-config uninstall boundary is missing");
  const uninstall = script.slice(start, end);
  const repair = uninstall.indexOf("Repair-AgentHostUntrustedInstallation");
  const recoveredState = uninstall.search(
    /\$uninstallRecoveryState\.config\.stateDirectory/i,
  );
  const accessCredential = uninstall.indexOf("dashboard-access.json");
  const removal = uninstall.indexOf("Remove-AgentHostPrivateFile");
  assert.ok(
    repair >= 0
      && removal > repair
      && recoveredState > removal
      && accessCredential > recoveredState,
    "explicit uninstall must repair first, then remove access from the recovered custom state directory",
  );
  const whatIf = uninstall.slice(
    uninstall.indexOf("if ($WhatIfPreference)"),
    uninstall.indexOf("} else {"),
  );
  assert.doesNotMatch(
    whatIf,
    /dashboard-access\.json|Remove-AgentHostPrivateFile/i,
    "WhatIf must not rotate the recovered credential",
  );
});

test("service startup waits for authenticated state and supports orphan-server recovery", () => {
  const script = source(manager);
  const readiness = powershellFunction(
    script,
    "Wait-AgentHostDashboardReady",
  );
  const runtimeStart = powershellFunction(
    script,
    "Start-AgentHostRuntime",
  );
  const readinessBudget = readiness.match(
    /\[int\]\s*\$TimeoutSeconds\s*=\s*(\d+)/i,
  );
  assert.ok(
    readinessBudget && Number(readinessBudget[1]) >= 900,
    "sealed verification can take nearly 13 minutes; service readiness must allow at least 15 minutes",
  );
  assert.match(
    runtimeStart,
    /Wait-AgentHostDashboardReady\s+-Config\s+\$Config/i,
    "the committed service start path must use the long readiness budget",
  );
  assert.doesNotMatch(
    runtimeStart,
    /Wait-AgentHostDashboardReady[\s\S]{0,120}-TimeoutSeconds/i,
    "service startup must not override the long readiness default with a shorter budget",
  );
  assert.match(
    script,
    /Wait-AgentHostDashboardReady[\s\S]{0,4200}Get-AgentHostValidatedAccess/i,
    "startup must wait for the private access record, not only /health",
  );
  assert.match(
    script,
    /Authorization\s*=\s*["']Bearer\s+\$\(?/i,
    "startup must prove an authenticated endpoint works",
  );
  assert.match(
    script,
    /serverStartTimeUtc/i,
    "shutdown must validate the recorded server even if its supervisor disappeared",
  );
  assert.match(
    script,
    /Get-NetTCPConnection[\s\S]{0,900}(?:serverPid|OwningProcess)/i,
    "orphan recovery must bind the recorded server PID to the listening port",
  );
});

test("prepared service gives Bun enough time to start inside the manager deadline", () => {
  const launcherSource = source(launcher);
  const managerReadiness = powershellFunction(
    source(manager),
    "Wait-AgentHostDashboardReady",
  );
  const bunStartup = launcherSource.slice(
    launcherSource.indexOf("$serverProcess = Start-Process -FilePath $bunExe"),
    launcherSource.indexOf("Confirm-AgentHostReadiness.ps1"),
  );
  const selectedDeadline = bunStartup.match(
    /\$healthTimeoutSeconds\s*=\s*if\s*\(\s*\$UsePreparedRuntime\s*\)\s*\{\s*(\d+)\s*\}\s*else\s*\{\s*(\d+)\s*\}/i,
  );
  const outerDeadline = managerReadiness.match(
    /\[int\]\s*\$TimeoutSeconds\s*=\s*(\d+)/i,
  );

  assert.ok(
    selectedDeadline,
    "prepared Bun startup must get 300 seconds while interactive startup stays at 30",
  );
  assert.ok(outerDeadline, "manager startup must have a bounded outer deadline");
  assert.equal(Number(selectedDeadline[1]), 300);
  assert.equal(Number(selectedDeadline[2]), 30);
  assert.match(
    bunStartup,
    /\$healthDeadline\s*=\s*\[DateTime\]::UtcNow\.AddSeconds\(\s*\$healthTimeoutSeconds\s*\)/i,
    "the Bun health deadline must use the selected timeout",
  );
  assert.match(
    bunStartup,
    /did not become healthy within\s+\$(?:healthTimeoutSeconds|\(\s*\$healthTimeoutSeconds\s*\))\s+seconds/i,
    "the startup error must report the selected timeout",
  );
  assert.ok(
    Number(outerDeadline[1]) >= 900 + Number(selectedDeadline[1]),
    "the manager must allow 900 seconds for sealed verification plus Bun's prepared-start timeout",
  );
});

test("service readiness fails promptly when the scheduled task stops running", {
  skip: process.platform !== "win32",
}, (t) => {
  const script = source(manager);
  const readiness = powershellFunction(
    script,
    "Wait-AgentHostDashboardReady",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-readiness-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = path.join(root, "probe.ps1");
  fs.writeFileSync(probe, [
    '$ErrorActionPreference = "Stop"',
    "$script:taskChecks = 0",
    "function Test-AgentHostDashboardHealth { param($DashboardPort) return $false }",
    "function Get-AgentHostTask {",
    "  $script:taskChecks += 1",
    '  $state = if ($script:taskChecks -eq 1) { "Running" } else { "Ready" }',
    "  return [pscustomobject]@{ State = $state }",
    "}",
    "function Start-Sleep { param($Milliseconds) }",
    readiness,
    "$config = [pscustomobject]@{ port = 4001 }",
    "$stopwatch = [Diagnostics.Stopwatch]::StartNew()",
    "$failedPromptly = $false",
    "try {",
    "  Wait-AgentHostDashboardReady -Config $config -TimeoutSeconds 60",
    "} catch {",
    "  if ($_.Exception.Message -match 'within 60 seconds') { throw }",
    "  $failedPromptly = $true",
    "}",
    "$stopwatch.Stop()",
    'if (-not $failedPromptly) { throw "Readiness unexpectedly succeeded." }',
    'if ($script:taskChecks -lt 2) { throw "Readiness did not observe the task leave Running state." }',
    'if ($stopwatch.Elapsed.TotalSeconds -ge 2) { throw "Readiness did not fail promptly." }',
    'Write-Output "failed-task-detected"',
    "",
  ].join("\r\n"));

  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", probe,
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /failed-task-detected/);
});

test("service installation builds and seals one private exact-commit snapshot", () => {
  const script = source(manager);
  const start = source(launcher);
  const bundle = powershellFunction(script, "New-AgentHostSealedBundle");
  const snapshot = powershellFunction(
    script,
    "New-AgentHostCommittedBuildSnapshot",
  );
  const sterileBuild = powershellFunction(
    script,
    "Invoke-AgentHostSterileBuildProcess",
  );

  assert.match(
    script,
    /Join-Path\s+\$env:LOCALAPPDATA\s+["']AgentHost\\b["'][\s\S]{0,500}Set-AgentHostPrivateDirectoryAcl/i,
    "the disposable build must use AgentHost's protected short path",
  );
  assert.doesNotMatch(script, /Join-Path\s+\$StateDirectory\s+["']service\\builds["']/i);
  assert.match(script, /b-\$\(\[Guid\][\s\S]{0,100}Substring\(0,\s*12\)/i);
  assert.match(script, /\^b-\[a-f0-9\]\{12\}\$/i);
  const longestKnownBuildExecutable = path.join(
    "C:\\Users",
    "u".repeat(20),
    "AppData",
    "Local",
    "AgentHost",
    "b",
    `b-${"a".repeat(12)}`,
    "source",
    "control-plane",
    ".runtime",
    "agentglass.staging-2147483647-aaaaaaaaaaaa",
    "node_modules",
    ".bun",
    "update-browserslist-db@1.2.3+707eeb21872f2b43",
    "node_modules",
    ".bin",
    "update-browserslist-db.exe",
  );
  assert.ok(
    longestKnownBuildExecutable.length < 260,
    `private build executable exceeds the Windows path budget: ${longestKnownBuildExecutable.length}`,
  );
  assert.match(snapshot, /\barchive\b[\s\S]{0,300}--format=zip/i);
  assert.match(snapshot, /\$SourceCommit\b/);
  assert.match(snapshot, /Assert-AgentHostPrivatePath/i);
  assert.match(snapshot, /ReparsePoint/i);
  assert.match(
    script,
    /Join-Path\s+\$snapshot\.sourceRoot[\s\S]{0,80}["']control-plane\\start-local\.ps1["']/i,
    "preparation must execute the launcher exported from the exact commit",
  );
  assert.doesNotMatch(
    script,
    /&\s+\$launcher[\s\S]{0,220}-PrepareRuntimeOnly/i,
    "installation must never build through the mutable workspace launcher",
  );
  assert.match(bundle, /\[string\]\s*\$CommittedSourceRoot\b/i);
  assert.match(
    bundle,
    /\$sourceRoot\s*=\s*Assert-AgentHostPrivatePath[\s\S]{0,140}-Path\s+\$CommittedSourceRoot[\s\S]{0,140}\$sourceControlPlane\s*=\s*Join-Path\s+\$sourceRoot\s+["']control-plane["']/i,
  );
  assert.match(bundle, /-Source\s+\$preparedRuntimeItem\.FullName/i);
  assert.doesNotMatch(
    bundle,
    /-Source\s+\(\s*Join-Path\s+\$controlPlane\b/i,
    "sealing must never return to the mutable workspace",
  );
  assert.match(
    script,
    /try\s*\{[\s\S]{0,5000}New-AgentHostSealedBundle[\s\S]{0,5000}finally\s*\{[\s\S]{0,700}Remove-AgentHostPrivateBuildSnapshot/i,
    "the exact build snapshot must be cleaned on every exit path",
  );
  assert.match(
    bundle,
    /Verify-AgentHostDashboardBundle\.mjs[\s\S]{0,1000}expected-manifest-sha256/i,
    "the sealed bundle must pass the fast verifier before publication",
  );
  assert.match(
    bundle,
    /"install"[\s\S]{0,320}"--linker"\s*,[\s\r\n]*"hoisted"/i,
    "the sealed runtime must use a self-contained dependency layout",
  );
  assert.match(
    bundle,
    /"build"\s*,[\s\r\n]*"src\\index\.ts"\s*,[\s\r\n]*"--target"\s*,[\s\r\n]*"bun"[\s\S]{0,220}"--outdir"/i,
    "the complete server dependency graph must resolve before publication",
  );
  assert.match(
    bundle,
    /\$materializePath\s*=\s*Join-Path\s+\$stagingControlPlane\s+["']materialize\.mjs["']/i,
    "proof refresh must run through the staged module whose default runtime was flattened",
  );
  const flattenGuard = bundle.match(
    /if\s*\(\s*\$flattenResult\.exitCode\s+-ne\s+0\s*\)\s*\{\s*throw\b[\s\S]{0,240}?\}/i,
  );
  const workspaceDirectories = bundle.match(
    /foreach\s*\(\s*\$relativePath\s+in\s+@\(\s*["']server\\node_modules["']\s*,\s*["']web\\node_modules["']\s*\)\s*\)\s*\{\s*\$workspaceNodeModules\s*=\s*Join-Path\s+\$stagingRuntime\s+\$relativePath[\s\S]{0,160}Directory\]::CreateDirectory\(\$workspaceNodeModules\)[\s\S]{0,240}\$workspaceNodeModulesItem\s*=\s*Get-Item[\s\S]{0,160}-LiteralPath\s+\$workspaceNodeModules[\s\S]{0,240}if\s*\(\s*-not\s+\$workspaceNodeModulesItem\.PSIsContainer\s+-or\s*\(\s*\$workspaceNodeModulesItem\.Attributes\s+-band[\s\S]{0,120}ReparsePoint\s*\)\s*\)\s*\{\s*throw\b[^\r\n]*\r?\n\s*\}\s*\}/i,
  );
  const refreshStart = bundle.indexOf("$refreshPreparedResult =");
  assert.ok(
    workspaceDirectories,
    "both hoisted workspaces must receive and validate real dependency directories inside one complete loop",
  );
  const verifyStart = bundle.indexOf(
    "$verifyPreparedResult =",
    refreshStart,
  );
  const refreshGuard = bundle.match(
    /if\s*\(\s*\$refreshPreparedResult\.exitCode\s+-ne\s+0\s*\)\s*\{\s*throw\b/i,
  );
  const verifyGuard = bundle.match(
    /if\s*\(\s*\$verifyPreparedResult\.exitCode\s+-ne\s+0\s*\)\s*\{\s*throw\b/i,
  );
  const graphStart = bundle.indexOf("$graphOutput =", verifyStart);
  const refreshInvocation = bundle.slice(refreshStart, verifyStart);
  const verifyInvocation = bundle.slice(verifyStart, graphStart);
  assert.match(
    refreshInvocation,
    /-Arguments\s+@\(\s*\$materializePath\s*,[\s\S]{0,120}["']--refresh-prepared["']/i,
    "proof refresh must invoke the staged materializer",
  );
  assert.match(
    verifyInvocation,
    /-Arguments\s+@\(\s*\$materializePath\s*,[\s\S]{0,160}["']--verify-prepared["']/i,
    "proof verification must invoke the same staged materializer",
  );
  const graphCheck = bundle.indexOf('"build"');
  const bundleManifestEnumeration = bundle.indexOf(
    "Get-ChildItem -LiteralPath $stagingRoot -Recurse -File",
  );
  assert.ok(
    flattenGuard
      && workspaceDirectories
      && workspaceDirectories.index
        >= flattenGuard.index + flattenGuard[0].length
      && refreshStart
        >= workspaceDirectories.index + workspaceDirectories[0].length
      && refreshGuard
      && refreshGuard.index > refreshStart
      && verifyStart > refreshGuard.index
      && verifyGuard
      && verifyGuard.index > verifyStart
      && graphStart > verifyGuard.index
      && graphCheck > graphStart
      && bundleManifestEnumeration > graphCheck,
    "flattened runtime proof must refresh and pass, verify and pass, then enter graph validation and the manifest",
  );
  assert.doesNotMatch(
    refreshInvocation,
    /["']--target["']/i,
    "marker refresh must use only the staged module's default runtime",
  );
  assert.match(bundle, /Collections\.Generic\.List\[object\]/i);
  assert.match(bundle, /\$entries\.Add\(/i);
  assert.doesNotMatch(
    bundle,
    /\$entries\s*\+=/i,
    "manifest construction must not recopy the entire growing array per file",
  );
  assert.ok(
    bundle.indexOf("Sort-Object FullName") < bundle.indexOf("$entries.Add("),
    "the linear manifest list must preserve deterministic path order",
  );
  assert.match(bundle, /files\s*=\s*\$entries/i);
  assert.ok(
    bundle.indexOf('"--expected-manifest-sha256"')
      < bundle.indexOf("[System.IO.Directory]::Move($stagingRoot, $finalRoot)"),
    "an unverified staging bundle must never be published under service versions",
  );
  assert.match(sterileBuild, /Get-ChildItem\s+Env:/i);
  assert.match(sterileBuild, /Remove-Item\s+-LiteralPath\s+["']Env:/i);
  assert.match(sterileBuild, /GIT_CONFIG_NOSYSTEM/i);
  assert.match(sterileBuild, /GIT_CONFIG_GLOBAL/i);
  assert.match(sterileBuild, /GIT_TERMINAL_PROMPT/i);
  assert.match(sterileBuild, /NPM_CONFIG_USERCONFIG/i);
  assert.match(
    sterileBuild,
    /HOME[\s\S]{0,500}USERPROFILE[\s\S]{0,500}APPDATA[\s\S]{0,500}LOCALAPPDATA/i,
    "build children must receive only a fresh private profile",
  );
  assert.match(
    start,
    /\$expectedRuntime[\s\S]{0,1500}\[System\.StringComparison\]::OrdinalIgnoreCase[\s\S]{0,900}--verify-prepared["']?\s*,?[\s\S]{0,120}["']--target["']\s*,\s*\$expectedRuntime/i,
    "the launcher must verify its own exact default runtime, not a child-reported path",
  );

  const bundleIndex = script.indexOf("$bundle = New-AgentHostSealedBundle");
  const cleanupIndex = script.indexOf(
    "Remove-AgentHostPrivateBuildSnapshot",
    bundleIndex,
  );
  const stopIndex = script.indexOf("Stop-AgentHostRuntime", cleanupIndex);
  assert.ok(
    bundleIndex >= 0
      && cleanupIndex > bundleIndex
      && stopIndex > cleanupIndex,
    "verified publication and build cleanup must finish before the live dashboard stops",
  );

  const earlyRecovery = script.slice(
    script.indexOf("if ($configurationRecoveryNeeded"),
    script.indexOf("if ($Install)"),
  );
  assert.doesNotMatch(
    earlyRecovery,
    /\$Install[\s\S]{0,500}Repair-AgentHostUntrustedInstallation/i,
    "repair installs must not stop an old task before the replacement is ready",
  );
});

test("private build children receive a fresh profile and no parent secrets", {
  skip: process.platform !== "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-sterile-build-"));
  const localAppData = path.join(root, "local");
  const profileRoot = path.join(
    localAppData,
    "AgentHost",
    "control-plane",
    "service",
    "builds",
    `build-${"a".repeat(32)}`,
    "profile",
  );
  const probe = path.join(root, "probe.ps1");
  const sterileBuild = powershellFunction(
    source(manager),
    "Invoke-AgentHostSterileBuildProcess",
  );
  try {
    fs.writeFileSync(probe, [
      "param($PrivateHelper, $ProfileRoot, $NodePath, $NodeScript)",
      '$ErrorActionPreference = "Stop"',
      ". $PrivateHelper",
      sterileBuild,
      "$null = Set-AgentHostPrivateDirectoryAcl -Path $ProfileRoot",
      '$env:AGENTHOST_TEST_PARENT_SECRET = "must-not-leak"',
      '$env:NODE_OPTIONS = "--require=C:\\must-not-run.cjs"',
      '$env:GIT_CONFIG_GLOBAL = "C:\\must-not-be-read.gitconfig"',
      '$env:PATH = "$env:PATH;C:\\parent-path-sentinel"',
      "$result = Invoke-AgentHostSterileBuildProcess -ExecutablePath $NodePath -Arguments @('-e', $NodeScript) -ProfileRoot $ProfileRoot -ToolPaths @($NodePath)",
      "$stderrResult = Invoke-AgentHostSterileBuildProcess -ExecutablePath $NodePath -Arguments @('-e', \"process.stderr.write('expected progress');\") -ProfileRoot $ProfileRoot -ToolPaths @($NodePath)",
      "$child = (@($result.output) -join \"`n\") | ConvertFrom-Json",
      "[pscustomobject]@{ ExitCode = $result.exitCode; StderrExitCode = $stderrResult.exitCode; Child = $child; RestoredSecret = $env:AGENTHOST_TEST_PARENT_SECRET } | ConvertTo-Json -Depth 6 -Compress",
      "",
    ].join("\r\n"));
    const nodeScript = [
      "process.stdout.write(JSON.stringify({",
      "secret: process.env.AGENTHOST_TEST_PARENT_SECRET || null,",
      "nodeOptions: process.env.NODE_OPTIONS || null,",
      "home: process.env.HOME,",
      "userProfile: process.env.USERPROFILE,",
      "appData: process.env.APPDATA,",
      "localAppData: process.env.LOCALAPPDATA,",
      "gitGlobal: process.env.GIT_CONFIG_GLOBAL,",
      "npmConfig: process.env.NPM_CONFIG_USERCONFIG,",
      "path: process.env.PATH",
      "}));",
    ].join("");
    const result = spawnSync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", probe,
      privateStateHelper,
      profileRoot,
      fs.realpathSync(process.execPath),
      nodeScript,
    ], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, LOCALAPPDATA: localAppData },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ExitCode, 0);
    assert.equal(parsed.StderrExitCode, 0);
    assert.equal(parsed.RestoredSecret, "must-not-leak");
    assert.equal(parsed.Child.secret, null);
    assert.equal(parsed.Child.nodeOptions, null);
    assert.equal(parsed.Child.gitGlobal, "NUL");
    assert.equal(
      parsed.Child.home.toLowerCase(),
      path.join(profileRoot, "home").toLowerCase(),
    );
    assert.equal(parsed.Child.userProfile.toLowerCase(), parsed.Child.home.toLowerCase());
    assert.ok(parsed.Child.appData.toLowerCase().startsWith(profileRoot.toLowerCase()));
    assert.ok(parsed.Child.localAppData.toLowerCase().startsWith(profileRoot.toLowerCase()));
    assert.ok(parsed.Child.npmConfig.toLowerCase().startsWith(profileRoot.toLowerCase()));
    assert.doesNotMatch(parsed.Child.path, /parent-path-sentinel/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("private snapshot exports committed bytes and deletes only its GUID root", {
  skip: process.platform !== "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-commit-snapshot-"));
  const repository = path.join(root, "repository");
  const localAppData = path.join(root, "local");
  const gitPath = spawnSync("where.exe", ["git.exe"], { encoding: "utf8" })
    .stdout.trim().split(/\r?\n/)[0];
  const runGit = (...args) => {
    const result = spawnSync(gitPath, args, {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  try {
    fs.mkdirSync(path.join(repository, "control-plane"), { recursive: true });
    fs.mkdirSync(path.join(repository, "scripts"), { recursive: true });
    for (const [relative, value] of [
      ["control-plane/AgentHost-Dashboard.ps1", "committed-manager\n"],
      ["control-plane/start-local.ps1", "committed-launcher\n"],
      ["control-plane/materialize.mjs", "export default true;\n"],
      ["scripts/room-state-root.ps1", "function Resolve-RoomState { }\n"],
    ]) {
      fs.writeFileSync(path.join(repository, ...relative.split("/")), value);
    }
    runGit("init");
    runGit("add", ".");
    runGit(
      "-c", "user.name=AgentHost Test",
      "-c", "user.email=agenthost@example.invalid",
      "commit", "-m", "fixture",
    );
    const commit = runGit("rev-parse", "HEAD");
    fs.writeFileSync(
      path.join(repository, "control-plane", "AgentHost-Dashboard.ps1"),
      "mutated-worktree\n",
    );

    const buildRoot = path.join(
      localAppData,
      "AgentHost",
      "b",
      `b-${"b".repeat(12)}`,
    );
    const buildsRoot = path.dirname(buildRoot);
    const profileRoot = path.join(buildRoot, "profile");
    const externalRoot = path.join(root, "must-survive");
    const probe = path.join(root, "snapshot-probe.ps1");
    fs.writeFileSync(probe, [
      "param($PrivateHelper, $RepositoryRoot, $GitPath, $NodePath, $Commit, $BuildsRoot, $BuildRoot, $ProfileRoot, $ExternalRoot)",
      ". $PrivateHelper",
      powershellFunction(source(manager), "Invoke-AgentHostSterileBuildProcess"),
      powershellFunction(source(manager), "New-AgentHostCommittedBuildSnapshot"),
      powershellFunction(source(manager), "Remove-AgentHostPrivateBuildSnapshot"),
      "$repositoryRoot = $RepositoryRoot",
      "$null = Set-AgentHostPrivateDirectoryAcl -Path $BuildsRoot",
      "$null = Set-AgentHostPrivateDirectoryAcl -Path $BuildRoot",
      "$null = Set-AgentHostPrivateDirectoryAcl -Path $ProfileRoot",
      "$git = [pscustomobject]@{ path = $GitPath }",
      "$snapshot = New-AgentHostCommittedBuildSnapshot -Git $git -SourceCommit $Commit -BuildRoot $BuildRoot -ProfileRoot $ProfileRoot -ToolPaths @($GitPath, $NodePath)",
      "$value = Get-Content -LiteralPath (Join-Path $snapshot.sourceRoot 'control-plane\\AgentHost-Dashboard.ps1') -Raw",
      "[System.IO.Directory]::CreateDirectory($ExternalRoot) | Out-Null",
      "[System.IO.File]::WriteAllText((Join-Path $ExternalRoot 'sentinel.txt'), 'keep')",
      "$null = New-Item -ItemType Junction -Path (Join-Path $BuildRoot 'escape-link') -Target $ExternalRoot",
      "Remove-AgentHostPrivateBuildSnapshot -BuildRoot $BuildRoot -BuildsRoot $BuildsRoot",
      "[pscustomobject]@{ Value = $value.Trim(); Removed = -not (Test-Path -LiteralPath $BuildRoot); ExternalPreserved = Test-Path -LiteralPath (Join-Path $ExternalRoot 'sentinel.txt') } | ConvertTo-Json -Compress",
      "",
    ].join("\r\n"));
    const result = spawnSync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", probe,
      privateStateHelper,
      repository,
      gitPath,
      fs.realpathSync(process.execPath),
      commit,
      buildsRoot,
      buildRoot,
      profileRoot,
      externalRoot,
    ], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, LOCALAPPDATA: localAppData },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      Value: "committed-manager",
      Removed: true,
      ExternalPreserved: true,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("service diagnostics are bounded and do not persist native output", () => {
  const managerSource = source(manager);
  const launcherSource = source(launcher);
  assert.doesNotMatch(managerSource, /Start-Transcript/i);
  assert.doesNotMatch(launcherSource, /RedirectStandard(?:Output|Error)/i);
  assert.match(managerSource, /dashboard-error\.json/i);
  assert.match(
    managerSource,
    /Substring\s*\(|\[\s*0\s*\.\./i,
    "the persisted error message must have a hard size limit",
  );
});

test("sealed runtime replaces internal workspace junctions with real directories", {
  skip: process.platform !== "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-sealed-links-"));
  const runtime = path.join(root, "runtime");
  const workspace = path.join(runtime, "workspace-package");
  const modules = path.join(runtime, "node_modules");
  const linkedPackage = path.join(modules, "workspace-package");
  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(modules, { recursive: true });
    fs.writeFileSync(path.join(workspace, "index.js"), "export default 'sealed';\n");
    fs.symlinkSync(workspace, linkedPackage, "junction");
    const result = spawnSync(process.execPath, [
      runtimeLinkFlattener,
      runtime,
    ], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.lstatSync(linkedPackage).isSymbolicLink(), false);
    assert.equal(
      fs.readFileSync(path.join(linkedPackage, "index.js"), "utf8"),
      "export default 'sealed';\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("start-local writes private PID/access state only by explicit opt-in and cleans transient PID state on exit", () => {
  const script = source(launcher);
  const privateState = source(privateStateHelper);
  assert.match(script, /\[string\]\s*\$RuntimeStateDirectory\s*=\s*["']{2}/i);
  assert.match(
    script,
    /\$PSBoundParameters\.ContainsKey\(\s*["']RuntimeStateDirectory["']\s*\)|IsNullOrWhiteSpace\(\s*\$RuntimeStateDirectory\s*\)/i,
    "state writing must be guarded by an explicit RuntimeStateDirectory request",
  );
  assert.match(script, /dashboard\.pid\.json/i);
  assert.match(script, /dashboard-access\.json/i);
  assert.match(script, /Protect-AgentHostPrivateState\.ps1/i);
  assert.match(
    privateState,
    /SetAccessRuleProtection\s*\(\s*\$true\s*,\s*\$false\s*\)|icacls(?:\.exe)?[\s\S]{0,240}\/inheritance:r/i,
    "runtime/access state must be private to the current user",
  );
  assert.match(privateState, /WriteAllText/i);

  const readiness = script.indexOf("Confirm-AgentHostReadiness.ps1");
  const privateStatePublish = script.search(
    /(?:Write|Set)-AgentHostPrivate(?:Json|State|File)\b/i,
  );
  assert.ok(readiness >= 0, "launcher must retain authenticated readiness");
  assert.ok(
    privateStatePublish > readiness,
    "the launcher may call the private-state writer only after authenticated readiness passes",
  );

  const laterFinallyOffset = script
    .slice(privateStatePublish)
    .search(/\bfinally\s*\{/i);
  assert.ok(
    laterFinallyOffset >= 0,
    "private state publication must be followed by an owned-state finally block",
  );
  const ownedStateCleanup = script.slice(privateStatePublish + laterFinallyOffset);
  assert.match(
    ownedStateCleanup,
    /Remove-(?:Item|AgentHostPrivateFile)[\s\S]{0,240}(?:dashboard\.pid\.json|\$runtimeState|\$pidState)/i,
    "PID state must be removed from a later finally path",
  );
  assert.doesNotMatch(
    ownedStateCleanup,
    /Remove-(?:Item|AgentHostPrivateFile)[\s\S]{0,240}(?:dashboard-access\.json|\$accessState)/i,
    "normal supervisor exit must retain the protected service credential for browser reauthentication",
  );
});

test("service authentication survives restart and reinstall, then rotates on explicit uninstall", {
  skip: process.platform !== "win32",
}, (t) => {
  const launcherSource = source(launcher);
  const managerSource = source(manager);
  const serviceToken = powershellFunction(
    launcherSource,
    "Get-AgentHostDashboardServiceToken",
  );
  const runtimeCleanup = powershellFunction(
    managerSource,
    "Remove-AgentHostRuntimeState",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-service-token-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localAppData = path.join(root, "local-app-data");
  const stateDirectory = path.join(localAppData, "AgentHost", "control-plane");
  const probe = path.join(root, "probe.ps1");
  const credentialCanary = createHash("sha256")
    .update(`service-access:${root}`)
    .digest("hex");

  fs.writeFileSync(probe, [
    "param($PrivateStateHelper, $TokenGenerator, $StateDirectory, $CredentialCanary)",
    '$ErrorActionPreference = "Stop"',
    ". $PrivateStateHelper",
    serviceToken,
    runtimeCleanup,
    "$null = Set-AgentHostPrivateDirectoryAcl -Path $StateDirectory",
    '$access = Join-Path $StateDirectory "dashboard-access.json"',
    '$pidState = Join-Path $StateDirectory "dashboard.pid.json"',
    "Write-AgentHostPrivateJson -Path $access -Value ([ordered]@{",
    "  schemaVersion = 1",
    "  token = $CredentialCanary",
    '  localOrigin = "http://127.0.0.1:4001"',
    '  remoteOrigin = "https://desktop-test.example.ts.net:4443"',
    '  updatedAtUtc = [DateTime]::UtcNow.ToString("o")',
    "})",
    "$first = Get-AgentHostDashboardServiceToken -AccessStatePath $access -TokenGeneratorPath $TokenGenerator",
    'if ($first -cne $CredentialCanary) { throw "Protected token canary was not reused." }',
    "$second = Get-AgentHostDashboardServiceToken -AccessStatePath $access -TokenGeneratorPath $TokenGenerator",
    'if ($second -cne $first) { throw "Normal service restart rotated browser authentication." }',
    "Write-AgentHostPrivateJson -Path $pidState -Value ([ordered]@{ schemaVersion = 1; supervisorPid = 1 })",
    "Remove-AgentHostRuntimeState -RuntimeStateDirectory $StateDirectory",
    'if (Test-Path -LiteralPath $pidState) { throw "Transient PID state survived cleanup." }',
    'if (-not (Test-Path -LiteralPath $access)) { throw "Protected service authentication was deleted by normal cleanup." }',
    "Remove-AgentHostPrivateFile -Path $access -Confirm:$false",
    "$third = Get-AgentHostDashboardServiceToken -AccessStatePath $access -TokenGeneratorPath $TokenGenerator",
    'if ($third -notmatch "^[a-f0-9]{64}$" -or $third -ceq $first) { throw "Explicit credential removal did not rotate authentication." }',
    "Write-AgentHostPrivateJson -Path $access -Value ([ordered]@{ schemaVersion = 1; token = 'malformed' })",
    "$invalidRejected = $false",
    "try { Get-AgentHostDashboardServiceToken -AccessStatePath $access -TokenGeneratorPath $TokenGenerator | Out-Null } catch { $invalidRejected = $true }",
    'if (-not $invalidRejected) { throw "Malformed protected authentication state was silently accepted or rotated." }',
    'Write-Output "service-token-lifecycle-pass"',
    "",
  ].join("\r\n"));

  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", probe,
    privateStateHelper,
    path.join(repositoryRoot, "control-plane", "New-AgentHostToken.ps1"),
    stateDirectory,
    credentialCanary,
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /service-token-lifecycle-pass/);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(credentialCanary, "i"),
    "the protected token canary must not reach stdout or stderr",
  );
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /\b[a-f0-9]{64}\b/i,
    "the raw service token must not reach stdout or stderr",
  );

  const launchConfigStart = managerSource.indexOf(
    '$launchConfigPath = Join-Path $stagingRoot "launch-config.json"',
  );
  const launchConfigEnd = managerSource.indexOf(
    "Get-ChildItem -LiteralPath $stagingRoot -Recurse -File",
    launchConfigStart,
  );
  assert.ok(
    launchConfigStart >= 0 && launchConfigEnd > launchConfigStart,
    "sealed launch-config boundary is missing",
  );
  const secretBearingSurfaces = [
    managerSource.slice(launchConfigStart, launchConfigEnd),
    powershellFunction(managerSource, "New-AgentHostServiceConfiguration"),
    powershellFunction(managerSource, "New-AgentHostTaskPlan"),
  ].join("\n");
  assert.doesNotMatch(
    secretBearingSurfaces,
    /(?:AGENTGLASS_TOKEN|dashboard-access\.json|[?&]token=|\btoken\s*=)/i,
    "launch config, service config, and scheduled-task arguments must never contain the raw token",
  );
  assert.match(
    serviceToken,
    /Read-AgentHostPrivateJson[\s\S]{0,160}-MaximumBytes\s+4096/i,
    "persistent authentication reads must stay tightly bounded",
  );
  const accessPublish = launcherSource.indexOf(
    "Write-AgentHostPrivateJson -Path $accessState",
  );
  const readyMessage = launcherSource.indexOf(
    "AgentHost Control Plane is ready.",
    accessPublish,
  );
  assert.ok(
    accessPublish >= 0 && readyMessage > accessPublish,
    "runtime-state publication boundary is missing",
  );
  assert.doesNotMatch(
    launcherSource.slice(accessPublish, readyMessage),
    /Remove-AgentHostPrivateFile\s+-Path\s+\$accessState/i,
    "a transient PID-state failure must not rotate persistent browser authentication",
  );

  const uninstallStart = managerSource.indexOf("if ($Uninstall)");
  const uninstallEnd = managerSource.indexOf(
    "Get-AgentHostDashboardStatus",
    uninstallStart,
  );
  assert.ok(
    uninstallStart >= 0 && uninstallEnd > uninstallStart,
    "explicit uninstall boundary is missing",
  );
  assert.match(
    managerSource.slice(uninstallStart, uninstallEnd),
    /Remove-AgentHostPrivateFile\s+-Path\s+\$accessStatePath/i,
    "explicit uninstall must remove the protected credential so a fresh install rotates it",
  );
  assert.match(
    managerSource,
    /Start-AgentHostRuntime\s+-Config\s+\$savedConfig[\s\S]{0,1000}-not\s*\(\s*Test-AgentHostSamePath[\s\S]{0,500}dashboard-access\.json/i,
    "a successful state-directory move must retire the old protected credential only after the replacement is live",
  );
  assert.match(
    managerSource,
    /Start-AgentHostRuntime\s+-Config\s+\$savedConfig[\s\S]{0,1200}\$recoveryRollbackState\.config[\s\S]{0,800}-not\s*\(\s*Test-AgentHostSamePath[\s\S]{0,500}dashboard-access\.json/i,
    "corrupt-config replacement must compare its recovered old state directory before retiring that credential",
  );
});

test("service runtime uses the direct Bun entry and a kill-on-close Windows Job Object", () => {
  const script = source(launcher);
  const bunConfig = source(path.join(
    repositoryRoot,
    "control-plane",
    "AgentHost.bunfig.toml",
  ));
  const jobFunction = powershellFunction(script, "Enable-AgentHostKillOnSupervisorExit");
  const processTreeFunction = powershellFunction(
    source(manager),
    "Get-AgentHostProcessTree",
  );
  const serverStartIndex = script.indexOf(
    "$serverProcess = Start-Process -FilePath $bunExe",
  );
  const serverStartBlock = script.slice(
    serverStartIndex,
    script.indexOf("-PassThru", serverStartIndex) + "-PassThru".length,
  );

  assert.match(
    serverStartBlock,
    /-ArgumentList\s+@\(\s*["']--config=\.\.\\\.\.\\\.\.\\AgentHost\.bunfig\.toml["']\s*,\s*["']run["']\s*,\s*["']--no-env-file["']\s*,\s*["']src\\index\.ts["']\s*\)/i,
    "Bun requires its config flag and path in one joined argument",
  );
  assert.doesNotMatch(
    script,
    /Start-Process\s+-FilePath\s+\$bunExe[\s\S]{0,240}-ArgumentList\s+@\(\s*["']run["']\s*,\s*["']start["']/i,
    "the installed service must not rely on a mutable package.json start script",
  );
  assert.match(bunConfig, /^env\s*=\s*false$/m);
  assert.match(bunConfig, /^telemetry\s*=\s*false$/m);
  assert.match(bunConfig, /^auto\s*=\s*["']disable["']$/m);
  assert.match(
    processTreeFunction,
    /StartTimeUtc\s+-lt\s+\$parentStartedAt\.AddSeconds\(\s*-2\s*\)/i,
    "PID reuse defense must reject an apparent child created before its live parent",
  );

  for (const nativeCall of [
    "CreateJobObject",
    "SetInformationJobObject",
    "AssignProcessToJobObject",
  ]) {
    assert.match(jobFunction, new RegExp(String.raw`\b${nativeCall}\b`));
  }
  assert.match(
    jobFunction,
    /LimitFlags\s*=\s*0x2000\b/i,
    "0x2000 is JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
  );
  assert.match(jobFunction, /\$script:agentHostJobHandle\s*=\s*\$job/i);

  const definition = script.indexOf("function Enable-AgentHostKillOnSupervisorExit");
  const invocation = script.lastIndexOf("Enable-AgentHostKillOnSupervisorExit");
  const serverStart = script.indexOf("$serverProcess = Start-Process", invocation);
  assert.ok(invocation > definition && serverStart > invocation);
  assert.match(
    script.slice(Math.max(0, invocation - 180), invocation),
    /IsNullOrWhiteSpace\(\s*\$RuntimeStateDirectory\s*\)/i,
    "Job Object containment is enabled for the explicitly managed service path",
  );
});

test("trusted Bun command line accepts only the joined config argument", {
  skip: process.platform !== "win32",
}, (t) => {
  const validatedTree = powershellFunction(
    source(manager),
    "Get-AgentHostValidatedProcessTree",
  );
  const patternStart = validatedTree.indexOf("$serverPattern = if");
  const patternEnd = validatedTree.indexOf(
    "if ($server.CommandLine -notmatch $serverPattern)",
    patternStart,
  );
  assert.ok(
    patternStart >= 0 && patternEnd > patternStart,
    "validated process trust must define one bounded Bun command-line pattern",
  );
  const patternAssignment = validatedTree.slice(patternStart, patternEnd);
  assert.ok(
    patternAssignment.includes(
      "--config=\\.\\.[\\\\/]\\.\\.[\\\\/]\\.\\.[\\\\/]AgentHost\\.bunfig\\.toml",
    ),
    "trusted process identity must use Bun's joined config argument",
  );
  assert.doesNotMatch(patternAssignment, /--config\\s\+/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-bun-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = path.join(root, "probe.ps1");
  fs.writeFileSync(probe, [
    '$ErrorActionPreference = "Stop"',
    '$expectedBun = "C:\\tools\\bun.exe"',
    "$escapedBun = [Regex]::Escape([System.IO.Path]::GetFullPath($expectedBun))",
    "$legacyPublishedStart = $false",
    patternAssignment,
    '$joined = \'"C:\\tools\\bun.exe" --config=..\\..\\..\\AgentHost.bunfig.toml run --no-env-file "src\\index.ts"\'',
    '$split = \'"C:\\tools\\bun.exe" --config ..\\..\\..\\AgentHost.bunfig.toml run --no-env-file "src\\index.ts"\'',
    'if ($joined -notmatch $serverPattern) { throw "Joined Bun config argument was rejected." }',
    'if ($split -match $serverPattern) { throw "Split Bun config argument was trusted." }',
    "",
  ].join("\r\n"));
  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", probe,
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("install seals committed source and carries immutable launch config through the manifest", () => {
  const script = source(manager);
  const verifier = source(bundleVerifier);
  const nodeVerifier = source(nodeBundleVerifier);
  const committedGate = powershellFunction(script, "Assert-AgentHostCommittedSource");
  const pinnedTool = powershellFunction(script, "Get-AgentHostPinnedTool");

  assert.match(
    pinnedTool,
    /\bGet-Command\s+\$Name[\s\S]{0,160}\|\s*Select-Object\s+-First\s+1/i,
    "duplicate Git locations must resolve to one executable before invocation",
  );
  assert.match(committedGate, /-ExecutablePath\s+\$Git\.path/i);
  assert.match(
    pinnedTool,
    /\bGet-Command\s+\$Name[\s\S]{0,160}\|\s*Select-Object\s+-First\s+1/i,
    "duplicate Node or Bun locations must resolve to one executable before pinning",
  );
  assert.match(
    pinnedTool,
    /realpathSync\s*\(\s*process\.execPath\s*\)/i,
    "Node must resolve its NVM junction before the task pins its executable",
  );
  assert.match(committedGate, /\bstatus\b/i);
  assert.match(committedGate, /--porcelain\b/i);
  assert.match(committedGate, /--untracked-files=all\b/i);
  assert.match(committedGate, /\bcontrol-plane\b/i);
  assert.match(committedGate, /scripts\/room-state-root\.ps1/i);
  assert.match(committedGate, /Commit the AgentHost control-plane startup files/i);
  assert.ok(
    script.indexOf("$script:sourceCommit = Assert-AgentHostCommittedSource") <
      script.indexOf("$bundle = New-AgentHostSealedBundle"),
    "the committed-source gate must run before a service bundle is sealed",
  );

  const launchWrite = script.indexOf(
    '$launchConfigPath = Join-Path $stagingRoot "launch-config.json"',
  );
  const manifestEnumeration = script.indexOf(
    "Get-ChildItem -LiteralPath $stagingRoot -Recurse -File",
  );
  assert.ok(
    launchWrite >= 0 && manifestEnumeration > launchWrite,
    "launch-config.json must exist before the sealed manifest enumerates files",
  );
  assert.match(script, /sourceCommit\s*=\s*\$script:sourceCommit/i);
  assert.match(script, /launchConfigSha256\s*=\s*\(/i);
  assert.match(script, /\$Bundle\.launchConfigSha256/i);

  assert.match(verifier, /["']launch-config\.json["']/i);
  assert.match(verifier, /Assert-RegularFile[\s\S]{0,160}-Path\s+\$NodePath/i);
  assert.match(
    verifier,
    /\$nodeVerifier\s*=\s*Join-Path[\s\S]{0,240}Verify-AgentHostDashboardBundle\.mjs[\s\S]{0,240}Assert-RegularFile/i,
  );
  assert.match(
    verifier,
    /&\s+\$NodePath[\s\S]{0,320}\$nodeVerifier[\s\S]{0,320}--expected-manifest-sha256/i,
    "the pinned Node executable must synchronously verify the anchored manifest",
  );
  assert.doesNotMatch(
    verifier,
    /foreach\s*\(\s*\$entry\s+in[\s\S]{0,1200}Get-FileHash/i,
    "PowerShell must not hash thousands of bundle files one cmdlet at a time",
  );
  assert.match(nodeVerifier, /availableParallelism\(\)/i);
  assert.match(nodeVerifier, /sealed bundle contains an unlisted file/i);
  assert.match(nodeVerifier, /sealed file integrity check failed/i);
  assert.match(
    verifier,
    /-LaunchConfigSha256\s+["']?\$\(\$launchEntry\.sha256\)["']?/i,
    "the verified manifest entry—not mutable service input—must supply the launch-config hash",
  );
  const serviceRun = powershellFunction(script, "Invoke-AgentHostServiceRun");
  assert.match(serviceRun, /Get-FileHash[\s\S]{0,240}\$LaunchConfigSha256/i);
  assert.match(serviceRun, /Read-AgentHostPrivateJson\s+-Path\s+\$launchConfigPath/i);
});

test("task folder COM lookup trims the trailing separator before GetFolder", () => {
  const script = source(manager);
  const ensureFolder = powershellFunction(
    script,
    "Ensure-AgentHostTaskFolder",
  );
  const normalizedPath = ensureFolder.match(
    /\$(\w+)\s*=\s*\$taskPath\.TrimEnd\(\s*["']\\["']\s*\)/i,
  );

  assert.ok(
    normalizedPath,
    "Task Scheduler folder lookup must normalize the configured trailing separator",
  );
  const lookup = new RegExp(
    `\\$service\\.GetFolder\\(\\s*\\$${normalizedPath[1]}\\s*\\)`,
    "i",
  );
  assert.match(ensureFolder, lookup);
  assert.ok(
    ensureFolder.search(lookup) > normalizedPath.index,
    "the normalized folder path must be assigned before COM receives it",
  );
  assert.doesNotMatch(
    ensureFolder,
    /\$service\.GetFolder\(\s*\$taskPath\s*\)/i,
    "Schedule.Service.GetFolder rejects the configured trailing separator",
  );
});

test("disabled rollback XML is safe and false before task registration", {
  skip: process.platform !== "win32",
}, (t) => {
  const script = source(manager);
  const safeTaskXml = powershellFunction(
    script,
    "Read-AgentHostTaskXmlDocument",
  );
  const disabledTaskXml = powershellFunction(
    script,
    "ConvertTo-AgentHostDisabledTaskXml",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-task-xml-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = path.join(root, "probe.ps1");
  const entity = path.join(root, "external-entity.txt");
  fs.writeFileSync(entity, "agenthost-xxe-probe");
  const entityUri = pathToFileURL(entity).href;
  fs.writeFileSync(probe, [
    '$ErrorActionPreference = "Stop"',
    safeTaskXml,
    disabledTaskXml,
    "$validFixtures = @(",
    '  \'<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Settings><Enabled>true</Enabled></Settings></Task>\'',
    '  \'<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Settings><AllowStartOnDemand>true</AllowStartOnDemand></Settings></Task>\'',
    ")",
    "foreach ($fixture in $validFixtures) {",
    "  $xmlPassedToRegistration = ConvertTo-AgentHostDisabledTaskXml -TaskXml $fixture",
    "  [xml]$document = $xmlPassedToRegistration",
    "  $namespaces = [System.Xml.XmlNamespaceManager]::new($document.NameTable)",
    '  $namespaces.AddNamespace("task", "http://schemas.microsoft.com/windows/2004/02/mit/task")',
    '  $enabled = @($document.SelectNodes("/task:Task/task:Settings/task:Enabled", $namespaces))',
    '  if ($enabled.Count -ne 1) { throw "Rollback XML must contain exactly one Enabled node before registration." }',
    '  if ($enabled[0].InnerText -cne "false") { throw "Rollback XML must be disabled before registration." }',
    "}",
    "$invalidFixtures = @(",
    `  '<!DOCTYPE Task [<!ENTITY xxe SYSTEM "${entityUri}">]><Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Settings><Enabled>&xxe;</Enabled></Settings></Task>'`,
    '  \'<Task xmlns="https://example.invalid/task"><Settings><Enabled>true</Enabled></Settings></Task>\'',
    '  \'<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Settings /><Settings /></Task>\'',
    '  \'<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Settings><Enabled>true</Enabled><Enabled>false</Enabled></Settings></Task>\'',
    ")",
    "foreach ($fixture in $invalidFixtures) {",
    "  $rejected = $false",
    "  try {",
    "    $null = ConvertTo-AgentHostDisabledTaskXml -TaskXml $fixture",
    "  } catch {",
    "    $rejected = $true",
    "  }",
    '  if (-not $rejected) { throw "Unsafe or malformed rollback XML was accepted." }',
    "}",
    "",
  ].join("\r\n"));

  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", probe,
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("install cutover is transactional and can restore the previous task", () => {
  const script = source(manager);
  const registration = powershellFunction(
    script,
    "Register-AgentHostDashboardTask",
  );
  const rollbackCapture = powershellFunction(
    script,
    "Get-AgentHostTaskRollbackState",
  );
  const installationIdentity = powershellFunction(
    script,
    "Get-AgentHostInstallationIdentity",
  );
  const partialCleanup = powershellFunction(
    script,
    "Remove-AgentHostPartialInstallation",
  );
  const restoration = powershellFunction(
    script,
    "Restore-AgentHostPreviousInstallation",
  );
  const recovery = powershellFunction(
    script,
    "Repair-AgentHostUntrustedInstallation",
  );
  const recoverableIdentity = powershellFunction(
    script,
    "Get-AgentHostRecoverableTaskLaunchConfig",
  );
  const recoverableInstallation = powershellFunction(
    script,
    "Get-AgentHostRecoverableInstallationConfig",
  );
  const recordedStopWait = powershellFunction(
    script,
    "Wait-AgentHostRecordedProcessesStopped",
  );
  const commandPathCheck = powershellFunction(
    script,
    "Test-AgentHostCommandContainsPath",
  );
  const legacyDiscovery = powershellFunction(
    script,
    "Get-AgentHostLegacyManualProcessTree",
  );
  const legacyBootstrap = powershellFunction(
    script,
    "New-AgentHostLegacyRollbackBootstrap",
  );
  const legacyCommand = powershellFunction(
    script,
    "Test-AgentHostLegacyRuntimeCommand",
  );
  const legacyStop = powershellFunction(
    script,
    "Stop-AgentHostLegacyManualRuntime",
  );
  const legacyRuntimeStop = powershellFunction(
    script,
    "Stop-AgentHostLegacyRuntime",
  );
  const verifiedStop = powershellFunction(
    script,
    "Stop-AgentHostValidatedProcesses",
  );
  const databaseOwners = powershellFunction(
    script,
    "Get-AgentHostDatabaseProcessIds",
  );
  const databaseQuiescence = powershellFunction(
    script,
    "Assert-AgentHostDatabaseQuiesced",
  );
  const install = script.slice(script.indexOf("if ($Install)"));
  const cutoverMarker = install.indexOf("$installError = $null");
  const cutoverTry = install.indexOf("try {", cutoverMarker);
  const stopOld = install.indexOf("Unregister-AgentHostOwnedTask");
  const writeConfig = install.indexOf("Write-AgentHostPrivateJson");
  const registerTask = install.indexOf("Register-AgentHostDashboardTask");
  const startTask = install.indexOf("Start-AgentHostRuntime");

  assert.match(
    registration,
    /New-ScheduledTaskSettingsSet[\s\S]{0,240}-Disable/i,
    "a new task must remain disabled until its matching config exists",
  );
  assert.ok(
    cutoverTry >= 0
      && stopOld > cutoverTry
      && writeConfig > stopOld
      && registerTask > writeConfig
      && startTask > registerTask,
    "cutover must stop the old writer, commit config, register the disabled task, then start it",
  );
  assert.match(rollbackCapture, /Export-ScheduledTask/i);
  const identitySafeParse = installationIdentity.indexOf(
    "Read-AgentHostTaskXmlDocument",
  );
  const identityHash = installationIdentity.indexOf(
    "ComputeHash",
    identitySafeParse,
  );
  assert.ok(
    identitySafeParse >= 0 && identityHash > identitySafeParse,
    "task identity must safely parse exported XML before hashing it",
  );
  const rollbackExport = rollbackCapture.indexOf("Export-ScheduledTask");
  const rollbackSafeParse = rollbackCapture.indexOf(
    "Read-AgentHostTaskXmlDocument",
  );
  const rollbackReturn = rollbackCapture.indexOf(
    "return [pscustomobject]",
    rollbackSafeParse,
  );
  assert.ok(
    rollbackExport >= 0
      && rollbackSafeParse > rollbackExport
      && rollbackReturn > rollbackSafeParse,
    "rollback capture must safely parse exported XML before preserving it",
  );
  assert.doesNotMatch(installationIdentity, /\[xml\]|\.LoadXml\s*\(/i);
  assert.doesNotMatch(rollbackCapture, /\[xml\]|\.LoadXml\s*\(/i);
  assert.match(partialCleanup, /Unregister-AgentHostOwnedTask/i);
  assert.match(partialCleanup, /Remove-AgentHostPrivateFile[\s\S]{0,160}\$serviceConfigPath/i);
  assert.ok(
    restoration.indexOf("Write-AgentHostPrivateJson")
      < restoration.indexOf("Register-ScheduledTask"),
    "rollback config must be restored before its task can exist",
  );
  const disableXml = restoration.match(
    /\$restoreTaskXml\s*=\s*ConvertTo-AgentHostDisabledTaskXml[\s\S]{0,120}-TaskXml\s+\$TaskXml/i,
  );
  const restoreTask = restoration.indexOf("Register-ScheduledTask");
  assert.ok(
    disableXml && restoreTask > disableXml.index,
    "rollback task XML must be disabled before it reaches Task Scheduler",
  );
  assert.match(restoration, /-Xml\s+\$restoreTaskXml/i);
  assert.match(recovery, /Get-AgentHostRecoverableInstallationConfig/i);
  assert.match(
    recoverableInstallation,
    /Get-AgentHostRecoverableTaskLaunchConfig\s+-Task\s+\$task/i,
  );
  assert.match(
    recoverableInstallation,
    /Assert-AgentHostOwnedTask\s+-Task\s+\$task\s+-Config\s+\$recoveredConfig/i,
  );
  assert.match(
    recoverableInstallation,
    /if\s*\(\s*\$null\s+-eq\s+\$task\s*\)\s*\{[\s\S]{0,240}cannot safely repair/i,
    "corrupt state without a sealed task identity must stop before deleting state",
  );
  assert.match(recovery, /Stop-AgentHostScheduledTaskAndProve/i);
  assert.match(recovery, /\$recoveredConfig\.port/i);
  assert.match(recoverableIdentity, /\$nodeBundleVerifierName/i);
  assert.match(recoverableIdentity, /expected-manifest-sha256/i);
  assert.match(recoverableIdentity, /dataDirectory/i);
  assert.match(
    recordedStopWait,
    /\[AllowEmptyCollection\(\)\][\s\S]{0,80}\[object\[\]\]\$ProcessTree/i,
    "a never-started disabled task has an empty process tree on PowerShell 5.1",
  );
  assert.match(commandPathCheck, /\[AllowEmptyString\(\)\][\s\S]{0,80}\[string\]\$CommandLine/i);
  assert.match(commandPathCheck, /IsNullOrWhiteSpace\(\$CommandLine\)[\s\S]{0,80}return\s+\$false/i);
  assert.match(legacyBootstrap, /control-plane\\start-local\.ps1/i);
  assert.match(legacyBootstrap, /-UsePreparedRuntime/i);
  assert.match(legacyBootstrap, /\$Config\.allowedOrigin/i);
  assert.match(legacyBootstrap, /\$Config\.kanbanSecretFile/i);
  assert.match(legacyBootstrap, /-ControlRoot\s+\$controlLiteral/i);
  assert.match(legacyBootstrap, /-WorkspaceRoot\s+\$workspaceLiteral/i);
  assert.match(legacyBootstrap, /-DataDirectory\s+\$dataLiteral/i);
  assert.match(legacyBootstrap, /-RuntimeStateDirectory\s+\$stateLiteral/i);
  assert.match(legacyCommand, /New-AgentHostLegacyRollbackBootstrap/i);
  assert.match(legacyCommand, /ToBase64String/i);
  assert.match(legacyCommand, /\$defaultDataDirectory/i);
  assert.match(legacyCommand, /\$Config\.controlRoot/i);
  assert.match(legacyCommand, /\$Config\.legacyRuntimeStateDirectory/i);
  assert.match(
    legacyCommand,
    /\$clearMatch\.Groups\[2\]\.Value\s+-ceq\s+\$expectedClearArguments/i,
    "the one-time clear launcher must match the complete expected command",
  );
  assert.match(
    legacyCommand,
    /\$expectedArguments\s*=\s*["'][^"']*-EncodedCommand\s+\$encoded["']/i,
  );
  assert.match(
    legacyCommand,
    /\$pattern\s*=\s*'\^\\s\*[^']+\\s\*\$'/i,
    "an encoded rollback must match its complete exact command line",
  );
  assert.match(legacyDiscovery, /Test-AgentHostLegacyRuntimeCommand/i);
  assert.match(legacyDiscovery, /\$Config\.bunSha256/i);
  assert.match(legacyDiscovery, /OwningProcess/i);
  assert.match(legacyStop, /Wait-AgentHostRecordedProcessesStopped\s+-ProcessTree\s+\$tree/i);
  assert.match(legacyRuntimeStop, /dashboard\.pid\.json/i);
  assert.match(legacyRuntimeStop, /Stop-AgentHostValidatedProcesses\s+-Config\s+\$Config/i);
  assert.match(legacyRuntimeStop, /Stop-AgentHostLegacyManualRuntime\s+-Config\s+\$Config/i);
  assert.match(verifiedStop, /Wait-AgentHostRecordedProcessesStopped\s+-ProcessTree\s+\$tree/i);
  assert.match(install, /Stop-AgentHostLegacyRuntime\s+-Config\s+\$legacyConfig/i);
  assert.match(databaseOwners, /rstrtmgr\.dll/i);
  assert.match(databaseOwners, /RmRegisterResources/i);
  assert.match(databaseOwners, /agenthost-control-plane\.db/i);
  assert.match(databaseOwners, /\$database-wal/i);
  assert.match(databaseOwners, /\$database-shm/i);
  assert.match(
    databaseQuiescence,
    /Get-AgentHostDatabaseProcessIds\s+-DataDirectory\s+\$DataDirectory/i,
  );
  assert.match(
    databaseQuiescence,
    /every process released its exact dashboard database/i,
  );
  const liveStop = install.indexOf("Stop-AgentHostLegacyRuntime");
  const liveDatabaseProof = install.indexOf(
    "Assert-AgentHostDatabaseQuiesced -DataDirectory $dataDirectory",
  );
  assert.ok(
    liveStop >= 0
      && liveDatabaseProof > liveStop
      && liveDatabaseProof < writeConfig,
    "the old runtime must release the exact database before replacement config and cutover",
  );
});

test("corrupt-config recovery captures rollback state before any destructive handoff", () => {
  const script = source(manager);
  const recovery = powershellFunction(
    script,
    "Repair-AgentHostUntrustedInstallation",
  );
  const recoverableInstallation = powershellFunction(
    script,
    "Get-AgentHostRecoverableInstallationConfig",
  );
  const install = script.slice(script.indexOf("if ($Install)"));

  assert.match(
    recovery,
    /\[ref\]\$RollbackState/i,
    "repair must return a rollback record to the install transaction",
  );
  assert.match(
    recovery,
    /Get-AgentHostRecoverableInstallationConfig[\s\S]{0,240}Get-AgentHostTaskRollbackState\s+-Config\s+\$recoveredConfig/i,
    "the sealed launch config and exact task XML must be captured together",
  );
  assert.match(
    recoverableInstallation,
    /Get-AgentHostRecoverableTaskLaunchConfig\s+-Task\s+\$task/i,
  );
  assert.match(
    recoverableInstallation,
    /Assert-AgentHostOwnedTask\s+-Task\s+\$task\s+-Config\s+\$recoveredConfig/i,
  );
  assert.match(
    recovery,
    /config\s*=\s*\$recoveredConfig[\s\S]{0,180}taskXml\s*=\s*\$capturedRollback\.xml[\s\S]{0,180}wasRunning\s*=\s*\[bool\]\$capturedRollback\.wasRunning[\s\S]{0,180}destructiveStarted\s*=\s*\$false/i,
  );
  assert.match(
    recovery,
    /\$RollbackState\.Value\.destructiveStarted\s*=\s*\$true/i,
  );

  const capture = recovery.indexOf("$capturedRollback =");
  const stop = recovery.indexOf("Stop-AgentHostScheduledTaskAndProve");
  const exactDatabaseProof = recovery.indexOf(
    'Assert-AgentHostDatabaseQuiesced `',
  );
  const recoveredDatabase = recovery.indexOf(
    '-DataDirectory "$($recoveredConfig.dataDirectory)"',
  );
  const unregister = recovery.indexOf("Unregister-ScheduledTask");
  const removeRuntimeState = recovery.indexOf("Remove-AgentHostRuntimeState");
  const removeServiceConfig = recovery.indexOf(
    "Remove-AgentHostPrivateFile -Path $serviceConfigPath",
  );
  assert.ok(
    capture >= 0
      && stop > capture
      && exactDatabaseProof > stop
      && recoveredDatabase > exactDatabaseProof
      && unregister > recoveredDatabase
      && removeRuntimeState > unregister
      && removeServiceConfig > removeRuntimeState,
    "recovery must capture rollback, stop the old task, prove its exact database is free, then remove old state",
  );

  assert.match(
    install,
    /Repair-AgentHostUntrustedInstallation[\s\S]{0,120}-RollbackState\s+\(\[ref\]\$recoveryRollbackState\)/i,
  );
  assert.match(
    install,
    /\$recoveryRollbackState\.destructiveStarted[\s\S]{0,300}Restore-AgentHostPreviousInstallation[\s\S]{0,160}-Config\s+\$recoveryRollbackState\.config[\s\S]{0,160}-TaskXml\s+["']?\$\(\$recoveryRollbackState\.taskXml\)["']?[\s\S]{0,160}-WasRunning\s+\(\[bool\]\$recoveryRollbackState\.wasRunning\)/i,
    "a failed replacement must restore the recovered config and exact task XML",
  );
});

test("corrupt-config repair preserves the recovered custom-state access credential", {
  skip: process.platform !== "win32",
}, (t) => {
  const script = source(manager);
  const repair = powershellFunction(
    script,
    "Repair-AgentHostUntrustedInstallation",
  );
  const runtimeCleanup = powershellFunction(
    script,
    "Remove-AgentHostRuntimeState",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-repair-access-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localAppData = path.join(root, "local-app-data");
  const defaultState = path.join(localAppData, "AgentHost", "control-plane");
  const customState = path.join(localAppData, "AgentHost", "custom-state");
  const accessState = path.join(customState, "dashboard-access.json");
  const probe = path.join(root, "probe.ps1");
  const credentialCanary = createHash("sha256")
    .update(`repair-access:${root}`)
    .digest("hex");
  fs.mkdirSync(defaultState, { recursive: true });
  fs.mkdirSync(customState, { recursive: true });
  fs.writeFileSync(accessState, `${JSON.stringify({
    schemaVersion: 1,
    token: credentialCanary,
    localOrigin: "http://127.0.0.1:4001",
    remoteOrigin: "https://desktop-test.example.ts.net:4443",
  })}\n`);
  const before = fs.readFileSync(accessState);

  fs.writeFileSync(probe, [
    "param($PrivateStateHelper, $DefaultState, $CustomState)",
    '$ErrorActionPreference = "Stop"',
    ". $PrivateStateHelper",
    runtimeCleanup,
    repair,
    '$taskPath = "\\AgentHost\\"',
    '$taskName = "Dashboard"',
    "$defaultStateDirectory = $DefaultState",
    "$Port = 4001",
    '$pidStatePath = Join-Path $DefaultState "dashboard.pid.json"',
    '$accessStatePath = Join-Path $DefaultState "dashboard-access.json"',
    '$errorStatePath = Join-Path $DefaultState "dashboard-error.json"',
    '$serviceConfigPath = Join-Path $DefaultState "dashboard-service.json"',
    '$script:recoveredConfig = [pscustomobject]@{',
    "  port = 4001",
    "  stateDirectory = $CustomState",
    '  dataDirectory = (Join-Path $CustomState "control-plane\\.runtime\\data")',
    '  kanbanSecretFile = "\\\\wsl.localhost\\Ubuntu\\home\\sk777\\.config\\agenthost\\kanban.env"',
    "}",
    "$windowsPowerShell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '$bundleRoot = Join-Path $DefaultState "service\\versions\\verified"',
    '$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("verified"))',
    "$script:taskPresent = $true",
    "$script:task = [pscustomobject]@{",
    "  TaskPath = $taskPath",
    "  Actions = @([pscustomobject]@{",
    "    Execute = $windowsPowerShell",
    "    Arguments = \"-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand $encoded\"",
    "    WorkingDirectory = $bundleRoot",
    "  })",
    '  Principal = [pscustomobject]@{ UserId = "current"; RunLevel = "Limited"; LogonType = "Interactive" }',
    "}",
    "function Get-AgentHostTask { if ($script:taskPresent) { return $script:task } }",
    "function Test-AgentHostSamePath { param($Left, $Right) return $true }",
    "function Test-AgentHostTaskPrincipalIsCurrentUser { param($UserId) return $true }",
    "function Get-AgentHostRecoverableInstallationConfig { param($Task) return $script:recoveredConfig }",
    "function Get-AgentHostRecoverableTaskLaunchConfig { param($Task) return $script:recoveredConfig }",
    "function Get-AgentHostTaskRollbackState { param($Config) return [pscustomobject]@{ xml = '<Task />'; wasRunning = $false } }",
    "function Assert-AgentHostOwnedTask { param($Task, $Config) }",
    "function Stop-AgentHostScheduledTaskAndProve { param($Task) }",
    "function Assert-AgentHostDatabaseQuiesced { param($DataDirectory) }",
    "function Get-NetTCPConnection { param($State, $LocalPort, $ErrorAction) return @() }",
    "function Unregister-ScheduledTask {",
    "  [CmdletBinding(SupportsShouldProcess = $true)]",
    "  param($TaskPath, $TaskName)",
    "  $script:taskPresent = $false",
    "}",
    "$rollback = $null",
    "Repair-AgentHostUntrustedInstallation -RollbackState ([ref]$rollback)",
    '$access = Join-Path $CustomState "dashboard-access.json"',
    'if (-not (Test-Path -LiteralPath $access)) { throw "Repair reinstall rotated the recovered custom-state credential." }',
    'if ($rollback.config.stateDirectory -cne $CustomState) { throw "Repair did not return the recovered custom state." }',
    'Write-Output "repair-access-preserved"',
    "",
  ].join("\r\n"));

  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", probe,
    privateStateHelper,
    defaultState,
    customState,
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /repair-access-preserved/);
  assert.deepEqual(fs.readFileSync(accessState), before);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(credentialCanary, "i"),
  );
});

test("an existing private service config contributes its file hash to installation identity", {
  skip: process.platform !== "win32",
}, (t) => {
  const script = source(manager);
  const identity = powershellFunction(
    script,
    "Get-AgentHostInstallationIdentity",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-install-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localAppData = path.join(root, "local-app-data");
  const configPath = path.join(
    localAppData,
    "AgentHost",
    "control-plane",
    "dashboard-service.json",
  );
  const probe = path.join(root, "probe.ps1");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, '{"schemaVersion":1,"port":4001}\n');
  fs.writeFileSync(probe, [
    "param($PrivateStateHelper, $ConfigPath)",
    '$ErrorActionPreference = "Stop"',
    ". $PrivateStateHelper",
    "$serviceConfigPath = $ConfigPath",
    'function Get-AgentHostTask { return $null }',
    identity,
    "$config = Get-Item -LiteralPath $ConfigPath -Force -ErrorAction Stop",
    '$hash = (Get-FileHash -LiteralPath $config.FullName -Algorithm SHA256).Hash',
    '$expected = "$($config.Length):$hash`nmissing"',
    "$actual = Get-AgentHostInstallationIdentity",
    'if ($actual -cne $expected) { throw "Existing service config identity did not contain its exact length and hash." }',
    "",
  ].join("\r\n"));

  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", probe,
    privateStateHelper,
    configPath,
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("one private install lock serializes build, cutover, and rollback", {
  skip: process.platform !== "win32",
}, (t) => {
  const script = source(manager);
  const identity = powershellFunction(
    script,
    "Get-AgentHostInstallationIdentity",
  );
  const lock = powershellFunction(script, "Enter-AgentHostInstallLock");
  const install = script.slice(script.indexOf("if ($Install)"));

  assert.match(identity, /\$serviceConfigPath[\s\S]{0,500}Get-FileHash/i);
  assert.match(identity, /Export-ScheduledTask/i);
  assert.match(lock, /Set-AgentHostPrivateDirectoryAcl/i);
  assert.match(lock, /FileShare\]::None/i);
  assert.match(lock, /Another AgentHost dashboard installation is already running/i);

  const observed = install.indexOf(
    "$observedInstallationIdentity = Get-AgentHostInstallationIdentity",
  );
  const acquired = install.indexOf(
    "$installLock = Enter-AgentHostInstallLock",
  );
  const revalidated = install.indexOf(
    "if ((Get-AgentHostInstallationIdentity) -cne",
    acquired,
  );
  const build = install.indexOf(
    '$git = Get-AgentHostPinnedTool -Name "git"',
    revalidated,
  );
  const write = install.indexOf("Write-AgentHostPrivateJson", build);
  const start = install.indexOf("Start-AgentHostRuntime", write);
  const released = install.indexOf("$installLock.Dispose()", start);
  assert.ok(
    observed >= 0
      && acquired > observed
      && revalidated > acquired
      && build > revalidated
      && write > build
      && start > write
      && released > start,
    "the same exclusive lock must cover revalidation, build, config write, task registration, startup, and rollback",
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-install-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = path.join(root, "probe.ps1");
  fs.writeFileSync(probe, [
    "param($StateDirectory)",
    '$ErrorActionPreference = "Stop"',
    "function Set-AgentHostPrivateDirectoryAcl {",
    "  param($Path)",
    "  [System.IO.Directory]::CreateDirectory($Path) | Out-Null",
    "  return [System.IO.Path]::GetFullPath($Path)",
    "}",
    `$defaultStateDirectory = $StateDirectory`,
    lock,
    "$first = Enter-AgentHostInstallLock",
    "try {",
    "  try {",
    "    $second = Enter-AgentHostInstallLock",
    "    $second.Dispose()",
    "    throw 'second lock unexpectedly succeeded'",
    "  } catch {",
    "    if ($_.Exception.Message -notmatch 'already running') { throw }",
    "  }",
    "} finally {",
    "  $first.Dispose()",
    "}",
    "$third = Enter-AgentHostInstallLock",
    "$third.Dispose()",
    "Write-Output 'exclusive-lock-pass'",
    "",
  ].join("\r\n"));
  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", probe,
    root,
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /exclusive-lock-pass/);
});

test("every build Git execution is pinned by path, length, and hash", () => {
  const script = source(manager);
  const start = source(launcher);
  const materializer = source(path.join(
    repositoryRoot,
    "control-plane",
    "materialize.mjs",
  ));
  const pinCheck = powershellFunction(script, "Assert-AgentHostPinnedTool");
  const gitChecks = script.match(
    /Assert-AgentHostPinnedTool\s+-Name\s+["']Git["']\s+-Tool\s+\$Git/gi,
  ) || [];

  assert.match(pinCheck, /\$Tool\.length/i);
  assert.match(pinCheck, /\$Tool\.sha256/i);
  assert.ok(gitChecks.length >= 3, "status, commit identity, and archive must each recheck Git");
  assert.match(start, /\[string\]\s*\$GitPath\b/i);
  assert.match(start, /\[long\]\s*\$GitLength\b/i);
  assert.match(start, /\[string\]\s*\$GitSha256\b/i);
  assert.match(start, /"--git-path"[\s\S]{0,180}"--git-length"[\s\S]{0,180}"--git-sha256"/i);
  assert.match(materializer, /function assertPinnedExecutable\b/i);
  assert.match(materializer, /const runGit\s*=/i);
  assert.doesNotMatch(materializer, /\brun\(\s*["']git["']/i);

  const buildStart = start.indexOf("$materializeArgs = @(");
  const buildEnd = start.indexOf("$materializedResult =", buildStart);
  const buildBoundary = start.slice(buildStart, buildEnd);
  const invokeMaterializer = buildBoundary.indexOf(
    "$materialized = & $nodeExe @materializeArgs",
  );
  const cleanup = buildBoundary.indexOf("} finally {", invokeMaterializer);
  assert.ok(
    buildStart >= 0 && buildEnd > buildStart
      && invokeMaterializer >= 0 && cleanup > invokeMaterializer,
    "the materializer must run inside a cleanup boundary",
  );
  for (const [name, value] of [
    ["GIT_CONFIG_NOSYSTEM", '"1"'],
    ["GIT_CONFIG_GLOBAL", '"NUL"'],
    ["GIT_TERMINAL_PROMPT", '"0"'],
    ["GIT_ASKPASS", '""'],
    ["GCM_INTERACTIVE", '"Never"'],
  ]) {
    const assignment = buildBoundary.indexOf(`$env:${name} = ${value}`);
    const cleanupName = buildBoundary.indexOf(`"${name}"`, cleanup);
    assert.ok(
      assignment >= 0
        && assignment < invokeMaterializer
        && cleanupName > cleanup,
      `${name} must be fixed before pinned Git runs and removed afterward`,
    );
  }
  assert.match(
    buildBoundary.slice(cleanup),
    /Remove-Item\s+-LiteralPath\s+["']Env:\$name["']/i,
  );
});

test("the exact dashboard database remains under WorkspaceRoot, never LOCALAPPDATA", () => {
  const script = source(manager);
  const start = source(launcher);

  assert.match(
    script,
    /\$dataDirectory\s*=\s*Join-Path\s+\$WorkspaceRoot\s+["']control-plane\\\.runtime\\data["']/i,
  );
  assert.doesNotMatch(
    script,
    /Join-Path\s+\$(?:StateDirectory|defaultStateDirectory)\s+["'][^"']*(?:\.runtime|data)[^"']*["']/i,
    "LOCALAPPDATA is for service state, not the AgentGlass database",
  );
  assert.match(
    script,
    /workspaceRoot\s*=\s*\$WorkspaceRoot[\s\S]{0,120}dataDirectory\s*=\s*\$dataDirectory/i,
    "both exact paths must be captured in immutable launch configuration",
  );
  const serviceRun = powershellFunction(script, "Invoke-AgentHostServiceRun");
  assert.match(serviceRun, /-WorkspaceRoot\s+["']?\$\(\$launchConfig\.workspaceRoot\)["']?/i);
  assert.match(serviceRun, /-DataDirectory\s+["']?\$\(\$launchConfig\.dataDirectory\)["']?/i);
  assert.match(start, /\[string\]\s*\$DataDirectory\s*=\s*["']{2}/i);
  assert.match(
    start,
    /\$env:AGENTGLASS_DB\s*=\s*Join-Path\s+\$dataDir\s+["']agenthost-control-plane\.db["']/i,
  );
});

test("README gives one-line install and daily-use commands", () => {
  const documentation = source(readme);
  for (const action of [
    "Install",
    "Start",
    "Open",
    "CopyLink",
    "Status",
    "Stop",
    "Restart",
    "Uninstall",
  ]) {
    assert.match(
      documentation,
      new RegExp(
        String.raw`^\.\\control-plane\\AgentHost-Dashboard\.ps1 -${action}\s*$`,
        "im",
      ),
      `README must include a copy-pasteable one-line -${action} command`,
    );
  }
  assert.match(documentation, /sign[- ]?in|logon|log on/i);
  assert.match(documentation, /starts? automatically|auto[- ]?start/i);
  assert.match(documentation, /Most days, use only `-Open`/i);
  assert.match(
    documentation,
    /existing installed service or exact manually launched[\s\S]{0,240}restores that previous\s+dashboard automatically/i,
  );
  assert.match(
    documentation,
    /neither a readable config nor a trusted sealed task identity[\s\S]{0,160}fails closed/i,
  );
});
