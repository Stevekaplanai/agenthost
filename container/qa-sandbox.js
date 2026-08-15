"use strict";

// Trusted outer launcher for Visual QA.
//
// The gate holds credentials and can read gate-only state. Chromium must not run
// with that view of the host, even though the QA render credential itself is
// read-only. This launcher therefore puts the ENTIRE pass (route config, hashes,
// mask extension, browser profile and Chromium) inside the same allowlist
// Bubblewrap filesystem/PID jail used by unattended engines.
//
// The screenshot tree is shared with the less-trusted agent. A pathname bind is
// unsafe there: the agent could replace the final directory after validation but
// before Bubblewrap resolves it. Open it once with O_NOFOLLOW, verify that the
// opened inode is the one inspected, and give Bubblewrap only /proc/self/fd/3.
// The descriptor is closed before the inner runner starts. Symlinks within the
// mounted tree cannot escape because their host destinations are absent from the
// jail root.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const chains = require("./chains-lib.js");

const IMAGE_DIR = "/opt/agenthost";
const GATE_OUTPUT_ROOT = "/data/agenthost-gate-state/qa/evidence";
const STAGED_FILES = Object.freeze([
  { source: path.join(IMAGE_DIR, "qa-agent.js"), name: "qa-agent.js", maxBytes: 1024 * 1024 },
  { source: path.join(IMAGE_DIR, "qa-routes.json"), name: "qa-routes.json", maxBytes: 128 * 1024 },
  { source: path.join(IMAGE_DIR, "qa-runner.sh"), name: "qa-runner.sh", maxBytes: 128 * 1024, mode: 0o500 },
]);

function pinOutputDirectory(source, io = fs) {
  if (typeof source !== "string" || !path.isAbsolute(source)) {
    throw new Error("the QA screenshot root must be an absolute path");
  }
  let fd = null;
  try {
    const before = io.lstatSync(source);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error("the QA screenshot root is not a real directory: " + source);
    }
    const flags = io.constants.O_RDONLY
      | (io.constants.O_DIRECTORY || 0)
      | (io.constants.O_NOFOLLOW || 0);
    fd = io.openSync(source, flags);
    const after = io.fstatSync(fd);
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("the QA screenshot root changed while it was being pinned: " + source);
    }
    return { fd, source };
  } catch (error) {
    if (fd !== null) { try { io.closeSync(fd); } catch {} }
    throw error;
  }
}

function readTrustedFile(source, maxBytes, { io = fs, requireRootOwner = true } = {}) {
  let fd = null;
  try {
    fd = io.openSync(source, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW || 0));
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) {
      throw new Error("refusing unsafe QA input " + source);
    }
    if (requireRootOwner && process.platform !== "win32"
      && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) {
      throw new Error("QA input is not root-owned and non-writable by other users: " + source);
    }
    // Read at most max+1 from the already-open descriptor. A size check followed
    // by readFileSync is still a race if the inode grows between those calls.
    const buffer = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = io.readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used > maxBytes) throw new Error("refusing oversized QA input " + source);
    return buffer.subarray(0, used);
  } finally {
    if (fd !== null) { try { io.closeSync(fd); } catch {} }
  }
}

function stageInputs(files = STAGED_FILES, deps = {}) {
  const io = deps.fs || fs;
  const stage = io.mkdtempSync(path.join(deps.tmpDir || os.tmpdir(), "agenthost-qa-input-"));
  try {
    io.chmodSync(stage, 0o700);
    for (const item of files) {
      if (!item || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(String(item.name || ""))) {
        throw new Error("refusing an invalid staged QA filename");
      }
      const bytes = readTrustedFile(item.source, item.maxBytes, {
        io,
        requireRootOwner: deps.requireRootOwner !== false,
      });
      io.writeFileSync(path.join(stage, item.name), bytes, {
        flag: "wx",
        mode: item.mode || 0o400,
      });
    }
    return stage;
  } catch (error) {
    try { io.rmSync(stage, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

function sandboxUser(env = process.env) {
  const announced = String(env.USER || env.LOGNAME || "");
  return announced === "agent" ? "agent" : "gate";
}

function qaSandboxEnv(source = process.env) {
  const user = sandboxUser(source);
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/hm",
    TMPDIR: "/tmp",
    USER: user,
    LOGNAME: user,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    QA_CONFIG_PATH: "/opt/qa/qa-routes.json",
    QA_ROOT: "/qa-output",
    QA_GATE: "http://127.0.0.1:8080",
  };
  // Preserve the existing operator knob byte-for-byte. qa-agent.js owns its
  // validation and deliberately names bad/negative values before using 8000ms.
  if (Object.prototype.hasOwnProperty.call(source, "QA_SETTLE_MS")) {
    env.QA_SETTLE_MS = String(source.QA_SETTLE_MS);
  }
  return env;
}

function outputRootFor(argv) {
  const exactGateInvocation = Array.isArray(argv)
    && argv.length === 3
    && argv[0] === "--force"
    && argv[1] === "--gate-authoritative"
    && argv[2] === "--token-stdin";
  if (!exactGateInvocation) {
    throw new Error("Visual QA must be launched through public POST /qa/run or root-only agenthost-qa so the gate reserves the agent lane");
  }
  return GATE_OUTPUT_ROOT;
}

function buildQaSandboxCommand(stageDir, argv, deps = {}) {
  const builder = deps.buildBwrapReadJail || chains.buildBwrapReadJail;
  const force = Array.isArray(argv) && argv.includes("--force") ? ["--force"] : [];
  const authoritative = Array.isArray(argv) && argv.includes("--gate-authoritative")
    ? ["--gate-authoritative"] : [];
  const tokenStdin = Array.isArray(argv) && argv.includes("--token-stdin") ? ["--token-stdin"] : [];
  const jail = builder("/bin/bash", ["/opt/qa/qa-runner.sh", ...force, ...authoritative, ...tokenStdin], {
    env: qaSandboxEnv(deps.env || process.env),
    roBindsAt: [
      { src: stageDir, dest: "/opt/qa" },
      // /usr/share/fonts is already in the system runtime bind. Fontconfig also
      // needs this small root-owned config tree or Chromium can render fallback
      // glyphs and manufacture visual diffs.
      { src: "/etc/fonts", dest: "/etc/fonts" },
      // Debian's /usr/bin/chromium wrapper sources this directory before it
      // execs the real browser binary. Bind only that package config, not /etc.
      { src: "/etc/chromium.d", dest: "/etc/chromium.d" },
    ],
    requiredRwBindAt: [{ src: "/proc/self/fd/3", dest: "/qa-output" }],
    closeFds: [3],
  });
  // There is deliberately no direct-browser or direct-runner fallback. If the
  // shared jail builder cannot produce the one approved binary, QA is unavailable.
  if (!jail || jail.bin !== "/usr/bin/bwrap") {
    throw new Error("the Bubblewrap QA jail could not be constructed; Chromium was not started");
  }
  return jail;
}

function runQaSandbox(options = {}, deps = {}) {
  const io = deps.fs || fs;
  // The protected root is selected only from the gate's exact fixed invocation,
  // never from inherited env or a caller-supplied pathname.
  const outputRoot = options.outputRoot || outputRootFor(options.argv);
  const files = options.files || STAGED_FILES;
  const run = deps.spawnSync || spawnSync;
  let pin = null;
  let stage = null;
  try {
    pin = pinOutputDirectory(outputRoot, io);
    stage = stageInputs(files, {
      fs: io,
      tmpDir: deps.tmpDir,
      requireRootOwner: deps.requireRootOwner,
    });
    const command = buildQaSandboxCommand(stage, options.argv || [], {
      buildBwrapReadJail: deps.buildBwrapReadJail,
      env: deps.env || process.env,
    });
    const result = run(command.bin, command.args, {
      encoding: "utf8",
      env: {},
      // stdin is the gate's pipe. The short-lived render token travels on that
      // pipe directly into the jail; it never enters this process environment or
      // Bubblewrap's argv. fd 3 is the pinned screenshot root.
      stdio: ["inherit", "pipe", "pipe", pin.fd],
    });
    if (result && result.stdout) process.stdout.write(result.stdout);
    if (result && result.stderr) process.stderr.write(result.stderr);
    if (!result) throw new Error("Bubblewrap returned no process result");
    if (result.error) throw result.error;
    if (Number.isInteger(result.status)) return result.status;
    throw new Error("Bubblewrap ended without an exit code" + (result.signal ? " (signal " + result.signal + ")" : ""));
  } finally {
    if (stage) { try { io.rmSync(stage, { recursive: true, force: true }); } catch {} }
    if (pin) { try { io.closeSync(pin.fd); } catch {} }
  }
}

function main() {
  try {
    process.exitCode = runQaSandbox({ argv: process.argv.slice(2) });
  } catch (error) {
    console.error("error: Visual QA refused to run outside its Bubblewrap jail: "
      + String((error && error.message) || error));
    process.exitCode = 3;
  }
}

if (require.main === module) main();

module.exports = {
  pinOutputDirectory,
  readTrustedFile,
  stageInputs,
  qaSandboxEnv,
  outputRootFor,
  buildQaSandboxCommand,
  runQaSandbox,
  STAGED_FILES,
  GATE_OUTPUT_ROOT,
};
