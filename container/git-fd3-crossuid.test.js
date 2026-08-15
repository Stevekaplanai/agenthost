"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LINUX_ROOT = process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0;

function identity(name) {
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
  const uid = Number(cp.execFileSync("/usr/bin/id", ["-u", name], options).trim());
  const gid = Number(cp.execFileSync("/usr/bin/id", ["-g", name], options).trim());
  return { uid, gid };
}

function isGateIdentity() {
  if (process.platform !== "linux" || typeof process.getuid !== "function") return false;
  try { return process.getuid() === identity("gate").uid; }
  catch { return false; }
}

function waitFor(check, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      try {
        const value = check();
        if (value) { resolve(value); return; }
      } catch {}
      if (Date.now() - started >= timeoutMs) { reject(new Error("timed out waiting for credentialed Git child")); return; }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function descriptorExists(pid, fd = 3) {
  try { fs.lstatSync(`/proc/${pid}/fd/${fd}`); return true; }
  catch { return false; }
}

function credentialHelperPid(gateUid) {
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let cmdline = "";
    try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "); } catch { continue; }
    if (!cmdline.includes("/usr/local/bin/agenthost-git-credential")) continue;
    try {
      if (fs.statSync(`/proc/${pid}`).uid === gateUid && descriptorExists(pid)) return pid;
    } catch {}
  }
  return 0;
}

function probeAs(user, script, args) {
  return cp.spawnSync("/usr/bin/setpriv", [
    `--reuid=${user}`,
    `--regid=${user}`,
    "--clear-groups",
    "--no-new-privs",
    "--",
    process.execPath,
    "-e",
    script,
    ...args,
  ], { encoding: "utf8", timeout: 3000 });
}

test("gate Hermes reads agent board data without executing agent startup files", { skip: !LINUX_ROOT, timeout: 30000 }, (t) => {
  const gate = identity("gate");
  const agent = identity("agent");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-hermes-gate-"));
  const agentHermes = path.join(base, "agent-hermes");
  const gateHermes = path.join(base, "gate-hermes");
  const markerDir = path.join(base, "gate-marker");
  const marker = path.join(markerDir, "agent-code-ran");
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });

  fs.chmodSync(base, 0o755);
  fs.mkdirSync(path.join(agentHermes, "bin"), { recursive: true });
  fs.mkdirSync(gateHermes, { mode: 0o700 });
  fs.mkdirSync(markerDir, { mode: 0o700 });
  fs.writeFileSync(path.join(agentHermes, ".env"), "BWS_ACCESS_TOKEN=synthetic-attacker-token\n");
  fs.writeFileSync(path.join(agentHermes, "config.yaml"), [
    "secrets:",
    "  sources:",
    "    - bitwarden",
    "  bitwarden:",
    "    enabled: true",
    "    project_id: synthetic-attacker-project",
    "    auto_install: false",
    "    cache_ttl_seconds: 0",
    "",
  ].join("\n"));
  const plantedBws = path.join(agentHermes, "bin", "bws");
  fs.writeFileSync(plantedBws, `#!/bin/sh\nprintf executed > '${marker}'\nprintf '[]\\n'\n`);

  cp.execFileSync("/usr/bin/chown", ["-R", `${agent.uid}:${gate.gid}`, agentHermes]);
  fs.chmodSync(agentHermes, 0o770);
  fs.chmodSync(path.join(agentHermes, "bin"), 0o770);
  fs.chmodSync(path.join(agentHermes, ".env"), 0o660);
  fs.chmodSync(path.join(agentHermes, "config.yaml"), 0o660);
  fs.chmodSync(plantedBws, 0o770);
  fs.chownSync(gateHermes, gate.uid, gate.gid);
  fs.chownSync(markerDir, gate.uid, gate.gid);

  const { hermesKanbanEnv } = require("./gate.js");
  const runAsGate = (env) => cp.spawnSync("/usr/bin/setpriv", [
    `--reuid=${gate.uid}`,
    `--regid=${gate.gid}`,
    "--clear-groups",
    "--no-new-privs",
    "--",
    "/usr/local/bin/hermes",
    "kanban",
    "list",
    "--json",
  ], { cwd: base, env, encoding: "utf8", timeout: 20000 });

  // Prove the attack fixture is live: the old agent-owned HERMES_HOME executes
  // the planted binary as gate even though no BWS token came from the parent.
  const vulnerable = runAsGate(hermesKanbanEnv({}, {
    runtimeHome: agentHermes,
    kanbanHome: agentHermes,
  }));
  assert.equal(vulnerable.status, 0, vulnerable.stderr);
  assert.equal(fs.readFileSync(marker, "utf8"), "executed");
  fs.rmSync(marker);
  for (const suffix of ["", "-shm", "-wal"]) {
    fs.rmSync(path.join(agentHermes, `kanban.db${suffix}`), { force: true });
  }

  // Production wiring separates trusted runtime/config from shared board data.
  const safeEnv = hermesKanbanEnv({}, { runtimeHome: gateHermes, kanbanHome: agentHermes });
  assert.equal(safeEnv.HERMES_HOME, gateHermes);
  assert.equal(safeEnv.HERMES_KANBAN_HOME, agentHermes);
  const safe = runAsGate(safeEnv);
  assert.equal(safe.status, 0, safe.stderr);
  assert.equal(fs.existsSync(marker), false, "agent-planted bws must never execute in the gate identity");
  assert.equal(fs.existsSync(path.join(agentHermes, "kanban.db")), true,
    "the gate must still read and write the real shared board");
});

test("production gate identity passes fd 3 through Bubblewrap to the real credential helper", {
  skip: !isGateIdentity() ? "exact gate identity release-image probe" : false,
  timeout: 10000,
}, async (t) => {
  const gate = identity("gate");
  assert.equal(process.getuid(), gate.uid);
  assert.equal(process.getgid(), gate.gid);
  assert.match(fs.readFileSync("/proc/self/status", "utf8"), /^NoNewPrivs:\s+1$/m,
    "the proof must inherit the production no-new-privileges boundary");
  assert.equal(fs.existsSync("/usr/bin/bwrap"), true);
  assert.equal(fs.existsSync("/usr/local/bin/agenthost-git-credential"), true);

  const transport = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-gate-bwrap-fd3-"));
  const token = "synthetic-gate-nnp-fd3-token";
  const credentialPath = "agenthost/gate-nnp-proof.git";
  const outputPath = path.join(transport, "credential.out");
  t.after(() => { try { fs.rmSync(transport, { recursive: true, force: true }); } catch {} });

  const { buildCredentialedGitCommand, gitCommandResult } = require("./gate.js");
  const alias = [
    "!printf 'protocol=https\\nhost=github.com\\npath=" + credentialPath + "\\n\\n'",
    "| /usr/local/bin/agenthost-git-credential get",
    "> /workspace/credential.out",
  ].join(" ");
  const command = buildCredentialedGitCommand(transport, [
    "-c", "alias.credential-probe=" + alias,
    "credential-probe",
  ], credentialPath);
  const result = await gitCommandResult(command, token, { timeoutMs: 3000 });

  assert.equal(result.ok, true, result.error);
  assert.equal(fs.readFileSync(outputPath, "utf8"),
    "username=x-access-token\npassword=" + token + "\n");
});

test("uid agent cannot read a live gate-uid Git credential fd or transport", { skip: !LINUX_ROOT, timeout: 15000 }, async (t) => {
  const gate = identity("gate");
  const transport = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-git-fd3-"));
  fs.chownSync(transport, gate.uid, gate.gid);
  fs.chmodSync(transport, 0o700);

  let stderr = "";
  const git = cp.spawn("/usr/bin/setpriv", [
    "--reuid=gate",
    "--regid=gate",
    "--clear-groups",
    "--no-new-privs",
    "--",
    "/usr/bin/git",
    "-c", "credential.helper=/usr/local/bin/agenthost-git-credential",
    "-c", "credential.useHttpPath=true",
    "credential", "fill",
  ], {
    cwd: transport,
    detached: true,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp",
      LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      AGENTHOST_GIT_CREDENTIAL_PATH: "agenthost/isolation-proof.git",
    },
    stdio: ["pipe", "ignore", "pipe", "pipe"],
  });
  git.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-1000); });
  t.after(() => {
    try { if (git.exitCode === null) process.kill(-git.pid, "SIGKILL"); }
    catch { try { if (git.exitCode === null) git.kill("SIGKILL"); } catch {} }
    try { fs.rmSync(transport, { recursive: true, force: true }); } catch {}
  });
  git.stdin.end([
    "protocol=https",
    "host=github.com",
    "path=agenthost/isolation-proof.git",
    "",
    "",
  ].join("\n"));

  // Git may close its own copy of fd 3 after launching the credential helper.
  // Probe the live helper descendant that actually reads the token, not the
  // short-lived parent descriptor (which made the old positive control racy).
  const helperPid = await waitFor(() => credentialHelperPid(gate.uid));
  const fdPath = `/proc/${helperPid}/fd/3`;

  const inspectProbe = [
    'const fs=require("node:fs");',
    'try { if (!fs.readlinkSync(process.argv[1])) process.exit(20); process.exit(10); }',
    'catch (e) { process.stderr.write(String(e&&e.code||"UNKNOWN")); process.exit(e && (e.code === "EACCES" || e.code === "EPERM") ? 0 : 20); }',
  ].join("");
  const listProbe = [
    'const fs=require("node:fs");',
    'try { fs.readdirSync(process.argv[1]); process.exit(10); }',
    'catch (e) { process.exit(e && (e.code === "EACCES" || e.code === "EPERM") ? 0 : 20); }',
  ].join("");

  // Positive control: this container does not globally hide /proc descriptors.
  // A normal dumpable gate-uid process exposes its fd 3 to a gate-uid sibling,
  // so the agent denial below is an identity boundary rather than a vacuous
  // "nothing can open any descriptor here" result.
  const baseline = cp.spawn("/usr/bin/setpriv", [
    "--reuid=gate", "--regid=gate", "--clear-groups", "--no-new-privs", "--",
    process.execPath, "-e", "setInterval(() => {}, 1000)",
  ], { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] });
  t.after(() => {
    try { if (baseline.exitCode === null) process.kill(-baseline.pid, "SIGKILL"); }
    catch { try { if (baseline.exitCode === null) baseline.kill("SIGKILL"); } catch {} }
  });
  await waitFor(() => descriptorExists(baseline.pid));
  const sameUidControl = probeAs("gate", inspectProbe, [`/proc/${baseline.pid}/fd/3`]);
  assert.equal(sameUidControl.status, 10,
    `control failed (${sameUidControl.stderr || "no error"}): an ordinary live descriptor must be openable by a same-uid process for this proof to be meaningful`);
  const agentFd = probeAs("agent", inspectProbe, [fdPath]);
  assert.equal(agentFd.status, 0, "the agent uid must receive EACCES/EPERM for the live credential fd");
  const agentTransport = probeAs("agent", listProbe, [transport]);
  assert.equal(agentTransport.status, 0, "the agent uid must receive EACCES/EPERM for the gate transport");

  git.stdio[3].end("synthetic-isolation-proof-token\n");
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { git.kill("SIGKILL"); } catch {} reject(new Error("credentialed Git child did not exit")); }, 3000);
    git.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(result, { code: 0, signal: null }, `credential helper failed: ${stderr}`);
});
