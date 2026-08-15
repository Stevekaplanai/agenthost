import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = path.join(import.meta.dirname, "..");
const CONTAINER = path.join(ROOT, "container");
const FAILSAFE = path.join(CONTAINER, "memory-failsafe.sh");

function readRequired(file, label) {
  assert.ok(fs.existsSync(file), `${label} must be committed at ${file}`);
  return fs.readFileSync(file, "utf8");
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
}

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function waitForFile(file, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (fs.existsSync(file)) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`file ${file} was not created within ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function writeCheckpointingMain(dir, name = "main") {
  const executable = path.join(dir, `${name}.sh`);
  const ready = path.join(dir, `${name}.ready`);
  const checkpoint = path.join(dir, `${name}.checkpoint`);
  writeExecutable(executable, `#!/bin/sh
ready="$1"
checkpoint="$2"
trap 'printf checkpoint > "$checkpoint"; exit 1' USR2
printf ready > "$ready"
while :; do sleep 1; done
`);
  return {
    ready,
    checkpoint,
    child: spawn(executable, [ready, checkpoint], { stdio: "ignore" }),
  };
}

test("the image starts the committed memory failsafe against the process Fly must restart", () => {
  const source = readRequired(FAILSAFE, "memory failsafe");
  const dockerfile = fs.readFileSync(path.join(CONTAINER, "Dockerfile"), "utf8");
  const entrypoint = fs.readFileSync(path.join(CONTAINER, "entrypoint.sh"), "utf8");

  assert.match(source, /MemAvailable:/, "the guard must make decisions from Linux MemAvailable");
  assert.doesNotMatch(source, /\beval\b/, "test seams must never become a command-injection seam");
  assert.match(
    source,
    /ps[\s\S]{0,120}pid=[\s,]+rss=[\s,]+comm=/,
    "diagnostics must ask ps for only pid, rss, and comm",
  );
  assert.doesNotMatch(
    source,
    /\bps\b[^\n]*(?:args|command|cmd|environ)/,
    "diagnostics must never read process arguments or environment",
  );
  assert.doesNotMatch(source, /\/proc\/[^\n]*(?:cmdline|environ)/, "the guard must not read secret-bearing proc files");
  assert.match(source, /AGENTHOST_MEMORY_FAILSAFE:-on}" != "off"/, "the operator must retain a boot-loop escape hatch");
  assert.match(source, /MIN_AVAILABLE_KB[^=]*=.*393216/, "the sustained default must remain 384 MiB");
  assert.match(source, /MIN_SWAP_FREE_KB[^=]*=.*262144/, "the sustained default must preserve 256 MiB of swap runway");
  assert.match(source, /EMERGENCY_AVAILABLE_KB[^=]*=.*131072/, "the emergency default must remain 128 MiB");
  assert.match(source, /EMERGENCY_SWAP_FREE_KB[^=]*=.*65536/, "the emergency default must preserve 64 MiB of swap runway");
  assert.match(source, /LOW_SAMPLES_REQUIRED[^=]*=.*\b4\b/, "the guard must require four low samples by default");
  assert.match(source, /BOOT_GRACE_SECONDS[^=]*=.*\b600\b/, "the guard must allow ten minutes for boot");
  assert.match(source, /CHECKPOINT_GRACE_SECONDS[^=]*=.*\b3\b/, "the guard must allow three seconds for checkpointing");
  assert.match(source, /INTERVAL_SECONDS[^=]*=.*\b15\b/, "the guard must sample every 15 seconds by default");
  assert.match(source, /HISTORY_LIMIT[^=]*=.*\b168\b/, "the persistent trend must remain bounded to seven days");
  assert.match(source, /kill -USR2 -- "\$MAIN_PID"/, "the guard must request a checkpoint before a hard stop");

  assert.match(
    dockerfile,
    /^COPY memory-failsafe\.sh \/opt\/agenthost\/memory-failsafe\.sh$/m,
    "the deployed image must contain the guard",
  );
  assert.match(
    dockerfile,
    /chmod \+x[^\n]*\/opt\/agenthost\/memory-failsafe\.sh/,
    "the deployed guard must be executable",
  );
  assert.match(
    dockerfile,
    /^ENTRYPOINT \["\/opt\/agenthost\/entrypoint-launcher"\]$/m,
    "the release must enter through the static environment scrubber before any dynamic loader",
  );

  const launch = entrypoint.indexOf("/opt/agenthost/memory-failsafe.sh");
  const firstExternalCommand = entrypoint.indexOf("mountpoint -q /data");
  const tokenUnset = entrypoint.indexOf("unset GIT_PUSH_TOKEN");
  const firstMainExec = entrypoint.indexOf("exec /opt/agenthost/entrypoint-launcher foundation");
  const defaultMainExec = entrypoint.indexOf("exec setpriv --reuid=agent");
  assert.ok(launch >= 0, "entrypoint must start the memory guard on every boot");
  assert.match(
    entrypoint.slice(launch, launch + 180),
    /memory-failsafe\.sh\s+["']?\$\$["']?\s*&/,
    "the guard must record the entrypoint PID that becomes the long-lived main process after exec",
  );
  assert.doesNotMatch(
    entrypoint.slice(launch, launch + 180),
    /--test/,
    "the root command-execution test seams must be unreachable from production startup",
  );
  assert.ok(launch < firstMainExec && launch < defaultMainExec, "the guard must start before either main-process exec path");
  assert.ok(tokenUnset > 0 && tokenUnset < firstExternalCommand,
    "the push credential must leave the boot environment before the first external helper starts");
  assert.match(entrypoint, /GIT_PUSH_TOKEN="\$gate_push_token_value" exec \/opt\/agenthost\/entrypoint-launcher foundation/,
    "only the static Foundation-B handoff receives the captured credential");
});

test("entrypoint removes the push credential before its first boot helper", {
  skip: spawnSync("bash", ["--version"], { stdio: "ignore" }).status !== 0,
}, () => {
  const entrypoint = fs.readFileSync(path.join(CONTAINER, "entrypoint.sh"), "utf8");
  assert.equal(entrypoint.split(/\r?\n/, 1)[0], "#!/bin/bash -p",
    "the root entrypoint must ignore inherited shell startup hooks before line one");
  const firstExternalCommand = entrypoint.indexOf("mountpoint -q /data");
  assert.ok(firstExternalCommand > 0, "located the first boot helper");
  const prelude = entrypoint.slice(0, firstExternalCommand);
  assert.match(prelude, /export PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/,
    "root boot must replace any inherited executable search path before using helpers");
  const probe = spawnSync("bash", ["-p", "-c", prelude + "\n/usr/bin/env\n"], {
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      GIT_PUSH_TOKEN: "FAKE-PUSH-TOKEN-DO-NOT-USE",
      SHELLOPTS: "allexport:xtrace",
      PS4: "${GIT_PUSH_TOKEN}",
      NODE_OPTIONS: "synthetic-loader-hook",
      NODE_PATH: "synthetic-loader-path",
      NODE_INSPECT_RESUME_ON_START: "1",
      BASH_ENV: "synthetic-bash-hook",
      ENV: "synthetic-shell-hook",
      PYTHONPATH: "synthetic-python-hook",
      LD_LIBRARY_PATH: "synthetic-native-loader-path",
      gate_push_token_present: "ambient-export-marker",
      gate_push_token_value: "ambient-export-marker",
    },
    encoding: "utf8",
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.doesNotMatch(probe.stdout, /^(?:GIT_PUSH_TOKEN|gate_push_token_present|gate_push_token_value)=/m,
    "no boot helper may inherit the push credential or either shell-local alias");
  assert.doesNotMatch(probe.stdout, /^(?:NODE_OPTIONS|NODE_PATH|NODE_INSPECT_RESUME_ON_START|BASH_ENV|ENV|PYTHONPATH|LD_PRELOAD|LD_LIBRARY_PATH)=/m,
    "root boot helpers must not inherit executable loader hooks");
  assert.match(prelude, /unset[^\n]*LD_PRELOAD[^\n]*LD_LIBRARY_PATH/,
    "the root Node launch must not inherit native loader hooks");
  assert.doesNotMatch(probe.stdout, /FAKE-PUSH-TOKEN-DO-NOT-USE|ambient-export-marker/,
    "no token value or attacker-planted export marker may reach a boot helper");
  assert.doesNotMatch(probe.stderr, /FAKE-PUSH-TOKEN-DO-NOT-USE|ambient-export-marker/,
    "shell tracing must be disabled before any token value is read");
  assert.match(entrypoint, /GIT_PUSH_TOKEN="\$gate_push_token_value" exec \/opt\/agenthost\/entrypoint-launcher foundation/,
    "only the static Foundation-B handoff receives the captured credential");
});

test("the Linux failsafe requires real exhaustion, bounds history, emits safe diagnostics, and checkpoints main", {
  skip: process.platform !== "linux",
}, async (t) => {
  readRequired(FAILSAFE, "memory failsafe");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-memory-failsafe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const state = path.join(dir, "sample-count");
  const psArgs = path.join(dir, "ps-args");
  const history = path.join(dir, "history.log");
  const meminfo = path.join(dir, "meminfo-fixture.sh");
  const ps = path.join(dir, "ps-fixture.sh");
  const checkpointingMain = writeCheckpointingMain(dir);
  await waitForFile(checkpointingMain.ready);

  writeExecutable(meminfo, `#!/bin/sh
n=0
[ ! -f "$AGENTHOST_MEMORY_FAILSAFE_TEST_STATE" ] || n="$(cat "$AGENTHOST_MEMORY_FAILSAFE_TEST_STATE")"
n=$((n + 1))
printf '%s\\n' "$n" > "$AGENTHOST_MEMORY_FAILSAFE_TEST_STATE"
case "$n" in
  1)
    printf 'MemTotal:       8192 kB\\nSwapFree:       4096 kB\\n'
    exit 0
    ;;
  2)
    printf 'MemTotal:       8192 kB\\nMemAvailable:   100 kB\\n'
    exit 0
    ;;
  3)
    printf 'MemTotal:       8192 kB\\nMemAvailable:   100 kB\\nSwapFree:       nope kB\\n'
    exit 0
    ;;
  4) available=100 ;;
  5) available=5000 ;;
  *) available=100 ;;
esac
printf 'MemTotal:       8192 kB\\nMemAvailable:   %s kB\\nSwapFree:       4096 kB\\n' "$available"
`);
  writeExecutable(ps, `#!/bin/sh
printf '%s\\n' "$*" >> "$AGENTHOST_MEMORY_FAILSAFE_TEST_PS_ARGS"
printf '11 4096 worker\\n'
`);

  const main = checkpointingMain.child;
  t.after(() => {
    if (main.exitCode === null && main.signalCode === null) main.kill("SIGKILL");
  });
  const mainExit = waitForExit(main);

  const guard = spawn("bash", [FAILSAFE, String(main.pid), "--test"], {
    env: {
      ...process.env,
      AGENTHOST_MEMORY_FAILSAFE_MEMINFO_CMD: meminfo,
      AGENTHOST_MEMORY_FAILSAFE_PS_CMD: ps,
      AGENTHOST_MEMORY_FAILSAFE_TEST_STATE: state,
      AGENTHOST_MEMORY_FAILSAFE_TEST_PS_ARGS: psArgs,
      AGENTHOST_MEMORY_FAILSAFE_MIN_AVAILABLE_KB: "1000",
      AGENTHOST_MEMORY_FAILSAFE_MIN_SWAP_FREE_KB: "5000",
      AGENTHOST_MEMORY_FAILSAFE_EMERGENCY_AVAILABLE_KB: "50",
      AGENTHOST_MEMORY_FAILSAFE_EMERGENCY_SWAP_FREE_KB: "1000",
      AGENTHOST_MEMORY_FAILSAFE_CONSECUTIVE_LOW_SAMPLES: "3",
      AGENTHOST_MEMORY_FAILSAFE_BOOT_GRACE_SECONDS: "0",
      AGENTHOST_MEMORY_FAILSAFE_CHECKPOINT_GRACE_SECONDS: "2",
      AGENTHOST_MEMORY_FAILSAFE_INTERVAL_SECONDS: "0",
      AGENTHOST_MEMORY_FAILSAFE_HISTORY_INTERVAL_SECONDS: "0",
      AGENTHOST_MEMORY_FAILSAFE_HISTORY_FILE: history,
      AGENTHOST_MEMORY_FAILSAFE_HISTORY_LIMIT: "3",
      AGENTHOST_MEMORY_FAILSAFE_TEST_SECRET: "never-print-this",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  guard.stdout.setEncoding("utf8");
  guard.stderr.setEncoding("utf8");
  guard.stdout.on("data", (chunk) => { output += chunk; });
  guard.stderr.on("data", (chunk) => { output += chunk; });

  const [guardResult, mainResult] = await Promise.all([waitForExit(guard), mainExit]);
  assert.equal(guardResult.code, 0, `guard should exit cleanly after asking Fly to restart; output:\n${output}`);
  assert.equal(mainResult.code, 1, "the main process must checkpoint and exit non-zero so Fly restarts it");
  assert.equal(mainResult.signal, null, "the normal memory-pressure path must not hard-kill a checkpointing main process");
  assert.equal(fs.readFileSync(checkpointingMain.checkpoint, "utf8"), "checkpoint");
  assert.equal(
    Number(fs.readFileSync(state, "utf8").trim()),
    8,
    "missing or malformed RAM/swap data must be ignored and recovery must reset the streak before three consecutive lows trigger",
  );

  const lines = fs.readFileSync(history, "utf8").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 3, "sample history must retain exactly the configured number of newest entries");
  assert.ok(lines.some((line) => line.includes("event=sample")), "the history must retain periodic trend samples");
  assert.match(lines.at(-1), /event=trip-sustained/, "the final history entry must identify the sustained trip");
  const requestedColumns = fs.readFileSync(psArgs, "utf8");
  const psCalls = requestedColumns.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(psCalls.length > 0, "the ps fixture must be called");
  assert.ok(
    psCalls.every((call) => call === "-eo pid=,rss=,comm= --sort=-rss"),
    `every ps call must request the exact safe columns; got:\n${requestedColumns}`,
  );
  assert.match(output, /\b11\s+4096\s+worker\b/, "the final diagnostic should contain pid, rss, and comm");
  assert.doesNotMatch(output, /never-print-this/, "the guard must never print its environment");
});

test("the Linux failsafe takes the emergency path after one critically low sample", {
  skip: process.platform !== "linux",
}, async (t) => {
  readRequired(FAILSAFE, "memory failsafe");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-memory-emergency-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const meminfo = path.join(dir, "meminfo-fixture.sh");
  const history = path.join(dir, "history.log");
  const checkpointingMain = writeCheckpointingMain(dir);
  await waitForFile(checkpointingMain.ready);
  writeExecutable(meminfo, `#!/bin/sh
printf 'MemTotal:       8192 kB\\nMemAvailable:   40 kB\\nSwapFree:       0 kB\\n'
`);

  const main = checkpointingMain.child;
  t.after(() => {
    if (main.exitCode === null && main.signalCode === null) main.kill("SIGKILL");
  });
  const mainExit = waitForExit(main);
  const guard = spawn("bash", [FAILSAFE, String(main.pid), "--test"], {
    env: {
      ...process.env,
      AGENTHOST_MEMORY_FAILSAFE_MEMINFO_CMD: meminfo,
      AGENTHOST_MEMORY_FAILSAFE_MIN_AVAILABLE_KB: "1000",
      AGENTHOST_MEMORY_FAILSAFE_MIN_SWAP_FREE_KB: "5000",
      AGENTHOST_MEMORY_FAILSAFE_EMERGENCY_AVAILABLE_KB: "50",
      AGENTHOST_MEMORY_FAILSAFE_EMERGENCY_SWAP_FREE_KB: "10",
      AGENTHOST_MEMORY_FAILSAFE_CONSECUTIVE_LOW_SAMPLES: "99",
      AGENTHOST_MEMORY_FAILSAFE_BOOT_GRACE_SECONDS: "0",
      AGENTHOST_MEMORY_FAILSAFE_CHECKPOINT_GRACE_SECONDS: "2",
      AGENTHOST_MEMORY_FAILSAFE_INTERVAL_SECONDS: "0",
      AGENTHOST_MEMORY_FAILSAFE_HISTORY_FILE: history,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  guard.stderr.setEncoding("utf8");
  guard.stderr.on("data", (chunk) => { output += chunk; });

  const [guardResult, mainResult] = await Promise.all([waitForExit(guard), mainExit]);
  assert.equal(guardResult.code, 0, `guard should exit after the emergency trip; output:\n${output}`);
  assert.equal(mainResult.code, 1);
  assert.equal(mainResult.signal, null);
  assert.equal(fs.readFileSync(checkpointingMain.checkpoint, "utf8"), "checkpoint");
  assert.match(output, /reason=emergency/);
});

test("the Linux failsafe preserves a live process while swap still provides safe runway", {
  skip: process.platform !== "linux",
}, async (t) => {
  readRequired(FAILSAFE, "memory failsafe");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-memory-swap-runway-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const meminfo = path.join(dir, "meminfo-fixture.sh");
  writeExecutable(meminfo, `#!/bin/sh
printf 'MemTotal:       8192 kB\\nMemAvailable:   100 kB\\nSwapFree:       9000 kB\\n'
`);

  const main = spawn("sleep", ["60"], { stdio: "ignore" });
  const mainExit = waitForExit(main);
  t.after(() => {
    if (main.exitCode === null && main.signalCode === null) main.kill("SIGKILL");
  });

  const guard = spawn("bash", [FAILSAFE, String(main.pid), "--test"], {
    env: {
      ...process.env,
      AGENTHOST_MEMORY_FAILSAFE_MEMINFO_CMD: meminfo,
      AGENTHOST_MEMORY_FAILSAFE_MIN_AVAILABLE_KB: "1000",
      AGENTHOST_MEMORY_FAILSAFE_MIN_SWAP_FREE_KB: "5000",
      AGENTHOST_MEMORY_FAILSAFE_EMERGENCY_AVAILABLE_KB: "50",
      AGENTHOST_MEMORY_FAILSAFE_EMERGENCY_SWAP_FREE_KB: "10",
      AGENTHOST_MEMORY_FAILSAFE_CONSECUTIVE_LOW_SAMPLES: "2",
      AGENTHOST_MEMORY_FAILSAFE_BOOT_GRACE_SECONDS: "0",
      AGENTHOST_MEMORY_FAILSAFE_INTERVAL_SECONDS: "0",
      AGENTHOST_MEMORY_FAILSAFE_TEST_MAX_SAMPLES: "5",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  guard.stderr.setEncoding("utf8");
  guard.stderr.on("data", (chunk) => { output += chunk; });

  const guardResult = await waitForExit(guard);
  assert.equal(guardResult.code, 0, `guard should stop after its bounded test run; output:\n${output}`);
  assert.equal(main.exitCode, null);
  assert.equal(main.signalCode, null);
  assert.equal(main.kill(0), true, "low RAM alone must not restart while swap remains healthy");
  assert.doesNotMatch(output, /restarting before OOM/);

  main.kill("SIGKILL");
  const mainResult = await mainExit;
  assert.equal(mainResult.signal, "SIGKILL");
});

test("the Linux failsafe hard-kills only when a main process ignores the checkpoint request", {
  skip: process.platform !== "linux",
}, async (t) => {
  readRequired(FAILSAFE, "memory failsafe");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-memory-checkpoint-fallback-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const meminfo = path.join(dir, "meminfo-fixture.sh");
  const stubbornMain = path.join(dir, "stubborn-main.sh");
  const ready = path.join(dir, "stubborn.ready");
  writeExecutable(meminfo, `#!/bin/sh
printf 'MemTotal:       8192 kB\\nMemAvailable:   40 kB\\nSwapFree:       0 kB\\n'
`);
  writeExecutable(stubbornMain, `#!/bin/sh
trap '' USR2
printf ready > "$1"
while :; do sleep 1; done
`);

  const main = spawn(stubbornMain, [ready], { stdio: "ignore" });
  await waitForFile(ready);
  const mainExit = waitForExit(main);
  t.after(() => {
    if (main.exitCode === null && main.signalCode === null) main.kill("SIGKILL");
  });

  const guard = spawn("bash", [FAILSAFE, String(main.pid), "--test"], {
    env: {
      ...process.env,
      AGENTHOST_MEMORY_FAILSAFE_MEMINFO_CMD: meminfo,
      AGENTHOST_MEMORY_FAILSAFE_MIN_AVAILABLE_KB: "1000",
      AGENTHOST_MEMORY_FAILSAFE_MIN_SWAP_FREE_KB: "5000",
      AGENTHOST_MEMORY_FAILSAFE_EMERGENCY_AVAILABLE_KB: "50",
      AGENTHOST_MEMORY_FAILSAFE_EMERGENCY_SWAP_FREE_KB: "10",
      AGENTHOST_MEMORY_FAILSAFE_BOOT_GRACE_SECONDS: "0",
      AGENTHOST_MEMORY_FAILSAFE_CHECKPOINT_GRACE_SECONDS: "0",
      AGENTHOST_MEMORY_FAILSAFE_INTERVAL_SECONDS: "0",
    },
    stdio: "ignore",
  });

  const [guardResult, mainResult] = await Promise.all([waitForExit(guard), mainExit]);
  assert.equal(guardResult.code, 0);
  assert.equal(mainResult.signal, "SIGKILL", "SIGKILL must remain the last-resort fallback");
});

test("the Linux failsafe off-switch exits without touching the main process", {
  skip: process.platform !== "linux",
}, async (t) => {
  readRequired(FAILSAFE, "memory failsafe");
  const main = spawn("sleep", ["60"], { stdio: "ignore" });
  const mainExit = waitForExit(main);
  t.after(() => {
    if (main.exitCode === null && main.signalCode === null) main.kill("SIGKILL");
  });

  const guard = spawn("bash", [FAILSAFE, String(main.pid)], {
    env: { ...process.env, AGENTHOST_MEMORY_FAILSAFE: "off" },
    stdio: "ignore",
  });
  const guardResult = await waitForExit(guard);
  assert.equal(guardResult.code, 0);
  assert.equal(main.exitCode, null, "the off-switch must leave the box main process untouched");
  assert.equal(main.signalCode, null, "the off-switch must not signal the box main process");
  assert.equal(main.kill(0), true, "the box main process must still be alive after the guard exits");
  main.kill("SIGKILL");
  const mainResult = await mainExit;
  assert.equal(mainResult.signal, "SIGKILL");
});

test("Fly reports a wedged gateway unhealthy and explicitly restarts a crashed machine", () => {
  const fly = fs.readFileSync(path.join(CONTAINER, "fly.toml"), "utf8");
  const gate = fs.readFileSync(path.join(CONTAINER, "gate.js"), "utf8");
  const checks = fly.match(/\[\[http_service\.checks\]\][\s\S]*?(?=\n\[\[|\n\[[^\[]|$)/);

  assert.ok(checks, "fly.toml must define an http_service health check");
  assert.match(checks[0], /^\s*method\s*=\s*"GET"\s*$/m);
  assert.match(checks[0], /^\s*path\s*=\s*"\/brand\.json"\s*$/m);
  assert.match(checks[0], /^\s*grace_period\s*=\s*"1m"\s*$/m);

  const restart = fly.match(/\[\[restart\]\][\s\S]*?(?=\n\[\[|\n\[[^\[]|$)/);
  assert.ok(restart, "fly.toml must explicitly restart a non-zero main-process exit");
  assert.match(restart[0], /^\s*policy\s*=\s*"on-failure"\s*$/m);
  assert.match(restart[0], /^\s*retries\s*=\s*10\s*$/m);

  const brandRoute = gate.indexOf('if (url.pathname === "/brand.json")');
  const cookieWall = gate.indexOf("if (!terminalCapabilityRequest && !authed(req))", brandRoute);
  assert.ok(brandRoute >= 0 && brandRoute < cookieWall, "/brand.json must remain before the login cookie wall");
  assert.match(
    gate.slice(brandRoute, brandRoute + 320),
    /writeHead\(200,/,
    "/brand.json must remain a safe 200 response for Fly",
  );
});

test("Hermes keeps its agent terminal but the retired dashboard daemon and token are gone", () => {
  const start = fs.readFileSync(path.join(CONTAINER, "start.sh"), "utf8");
  assert.match(start, /tmux new-window -t agent -n hermes[\s\S]{0,500}while true; do hermes 2>&1/,
    "the reachable Hermes terminal still runs the Hermes agent CLI");
  assert.doesNotMatch(start, /hermes dashboard|HERMES_DASHBOARD_SESSION_TOKEN|hermes-dashboard\.token|127\.0\.0\.1:9119/,
    "no retired dashboard process, port, or credential remains live");
});
