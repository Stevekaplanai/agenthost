"use strict";

// Real-Linux PID-1 harness for the dormant Phase-1d worker containment
// (container/maintenance-containment.js). Runs as root PID 1 inside a private
// PID + mount namespace and proves the service-created PID namespace collapses
// the entire worker tree on teardown — including a double-fork+setsid escapee
// that survives a plain process-group kill — and that the worker runs as
// `agent`. Driven only by scripts/maintenance-containment-verify.sh. Wires
// nothing into any boot path.

import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER = path.resolve(HERE, "..", "container");

function skip(reason) { process.stdout.write(`SKIP ${reason}\n`); process.exit(0); }
if (process.getuid() !== 0) skip("harness requires root");
if (process.pid !== 1) skip("harness requires PID 1 (run under scripts/maintenance-containment-verify.sh)");

const { launchContained, launchProcessTreeContained, launchContainedWithWorktree, teardown, countByToken } = require(path.join(CONTAINER, "maintenance-containment.js"));
const { createAgentLaneArbiter } = require(path.join(CONTAINER, "maintenance-agent-lane.js"));
const { createChatRunner } = require(path.join(CONTAINER, "maintenance-chat-runner.js"));

let failures = 0, passed = 0;
function check(label, fn) {
  try { fn(); passed += 1; process.stdout.write(`  ok   ${label}\n`); }
  catch (error) { failures += 1; process.stdout.write(`  FAIL ${label}: ${error && error.message}\n`); }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = (name) => ({ uid: Number(cp.execSync(`id -u ${name}`).toString().trim()), gid: Number(cp.execSync(`id -g ${name}`).toString().trim()) });

async function waitFor(fn, ms = 3000) {
  for (let i = 0; i < ms / 25; i += 1) { if (fn()) return true; await delay(25); }
  return fn();
}
function killByToken(token) {
  const needle = Buffer.from(token, "utf8");
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try { if (fs.readFileSync(`/proc/${entry}/cmdline`).includes(needle)) process.kill(Number(entry), "SIGKILL"); } catch { /* gone */ }
  }
}

// A unique sleep DURATION tags every process in the tree: it survives dash's
// exec-optimization (which would strip an argv[0] rename or a comment), and is
// findable in /proc cmdline. The tree has a normal child and a
// double-fork+setsid escapee (its own session -> escapes a process-group kill,
// but never the PID namespace).
function uniqueToken() {
  return String(500000 + (crypto.randomBytes(3).readUIntBE(0, 3) % 400000));
}
function treeScript(token) {
  return `setsid sleep ${token} & sleep ${token} & sleep ${token}`;
}

const cases = {
  async chat_cancel_proves_gone_and_reopens_lane() {
    const agent = ids("agent");
    const token = uniqueToken();
    const workspace = `/tmp/chat-cancel-${token}`;
    fs.mkdirSync(workspace, { recursive: true });
    fs.chownSync(workspace, agent.uid, agent.gid);
    const arbiter = createAgentLaneArbiter();
    const exits = [];
    const runner = createChatRunner({
      profiles: Object.freeze({
        probe: Object.freeze({
          bin: "sh",
          argvTemplate: Object.freeze(["-c", "{prompt}"]),
          cwd: workspace,
          envAllowlist: Object.freeze(["HOME", "PATH"]),
          credentialNames: Object.freeze([]),
          stdin: "ignore",
        }),
      }),
      secretsPath: "/missing",
      withCharter: (prompt) => prompt,
      uid: agent.uid,
      gid: agent.gid,
      rootEnv: { HOME: workspace, PATH: process.env.PATH },
      agentLaneArbiter: arbiter,
      onExit: (runId, info) => exits.push([runId, info]),
      hardMs: 10_000,
    });

    runner.run({ runId: "cancelled_tree", engineId: "probe", prompt: treeScript(token) });
    const started = await waitFor(() => countByToken(token) >= 3);
    check("chat cancellation probe starts a detached descendant tree", () => {
      assert.ok(started, `expected >=3 tagged processes, saw ${countByToken(token)}`);
    });
    runner.kill("cancelled_tree", "SIGKILL");
    const cancelledClosed = await waitFor(
      () => exits.some(([runId]) => runId === "cancelled_tree"),
      4000,
    );
    const gone = await waitFor(() => countByToken(token) === 0, 4000);
    check("chat cancellation proves namespace init gone without false quarantine", () => {
      assert.ok(cancelledClosed, "the cancelled containment never produced a proven close");
      assert.ok(gone, `expected 0 tagged processes, ${countByToken(token)} survived`);
      assert.equal(arbiter.isQuarantined(), false);
      assert.equal(arbiter.isBusy(), false);
    });

    const second = runner.run({
      runId: "after_cancel",
      engineId: "probe",
      // Stay alive long enough for the root launcher to observe namespace init;
      // an immediate `exit 0` can legitimately vanish inside the 25ms probe.
      prompt: "sleep 0.2",
    });
    const secondClosed = await waitFor(
      () => exits.some(([runId]) => runId === "after_cancel"),
      4000,
    );
    check("a proven cancellation reopens the shared root lane", () => {
      assert.equal(second.accepted, true);
      assert.ok(secondClosed, "the replacement run never completed");
      assert.equal(arbiter.isQuarantined(), false);
      assert.equal(arbiter.isBusy(), false);
    });
    killByToken(token);
    fs.rmSync(workspace, { recursive: true, force: true });
  },
  async chat_process_tree_reaps_setsid_descendant() {
    const agent = ids("agent");
    const token = uniqueToken();
    const workspace = `/tmp/chat-tree-${token}`;
    fs.mkdirSync(workspace, { recursive: true });
    fs.chownSync(workspace, agent.uid, agent.gid);
    const marker = path.join(workspace, "identity.txt");
    const script = `printf '%s|%s' "$HOME" "$PWD" > ${marker}; ${treeScript(token)}`;
    const handle = launchProcessTreeContained({
      argv: ["sh", "-c", script],
      uid: agent.uid,
      gid: agent.gid,
      cwd: workspace,
      env: { HOME: workspace, PATH: process.env.PATH },
      stdin: "ignore",
    });
    const started = await waitFor(() => countByToken(token) >= 3);
    check("chat tree uses the real workspace and includes a setsid descendant", () => {
      assert.ok(started, `expected >=3 tagged processes, saw ${countByToken(token)}`);
      assert.equal(fs.readFileSync(marker, "utf8"), `${workspace}|${workspace}`);
    });
    teardown(handle);
    const gone = await waitFor(() => countByToken(token) === 0, 4000);
    check("chat containment reaps every detached descendant", () => {
      assert.ok(gone, `expected 0 tagged processes, ${countByToken(token)} survived`);
    });
    fs.rmSync(workspace, { recursive: true, force: true });
  },
  // The PID namespace collapses the whole tree — escapee included — on teardown.
  async containment_reaps_tree() {
    const agent = ids("agent");
    const token = uniqueToken();
    const handle = launchContained({ argv: ["sh", "-c", treeScript(token)], uid: agent.uid, gid: agent.gid });
    const started = await waitFor(() => countByToken(token) >= 3);
    check("contained worker tree (init + child + setsid escapee) is running", () => assert.ok(started, `expected >=3 tagged processes, saw ${countByToken(token)}`));
    teardown(handle);
    const gone = await waitFor(() => countByToken(token) === 0, 4000);
    check("teardown reaps every descendant, including the setsid escapee", () => assert.ok(gone, `expected 0 tagged processes, ${countByToken(token)} survived`));
  },

  // Contrast: without a PID namespace, a setsid escapee survives a process-group
  // kill — proving the containment is doing real work.
  async escapee_survives_without_containment() {
    const token = uniqueToken();
    const child = cp.spawn("sh", ["-c", treeScript(token)], { detached: true, stdio: "ignore" });
    const started = await waitFor(() => countByToken(token) >= 3);
    check("uncontained tree is running", () => assert.ok(started, `saw ${countByToken(token)}`));
    // TERM the original process group; the setsid escapee is in its own session.
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* group may already be partial */ }
    await delay(300);
    const survivors = countByToken(token);
    check("a setsid escapee survives a process-group kill (containment is necessary)", () => assert.ok(survivors >= 1, "expected the escapee to survive the group kill"));
    killByToken(token); // clean up the survivor(s)
    await waitFor(() => countByToken(token) === 0, 3000);
  },

  // The contained worker runs as the agent uid, not root.
  async runs_as_agent() {
    const agent = ids("agent");
    const token = uniqueToken();
    const handle = launchContained({ argv: ["sh", "-c", treeScript(token)], uid: agent.uid, gid: agent.gid });
    await waitFor(() => countByToken(token) >= 3); // wait until the sleep workers (not just the wrapper) are up
    // The root-owned unshare/setpriv wrapper also carries the token in its argv;
    // collect the uids of the tagged worker `sh` processes and assert the actual
    // worker runs as agent, never root.
    const workerUids = new Set();
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if (!fs.readFileSync(`/proc/${entry}/cmdline`).includes(Buffer.from(token))) continue;
        if (fs.readFileSync(`/proc/${entry}/comm`, "utf8").trim() !== "sleep") continue; // the worker leaf, not the unshare/setpriv/sh wrapper
        const m = fs.readFileSync(`/proc/${entry}/status`, "utf8").match(/^Uid:\s*(\d+)/m);
        if (m) workerUids.add(Number(m[1]));
      } catch { /* gone */ }
    }
    teardown(handle);
    check("the contained worker runs as the agent uid (never root)", () => {
      assert.ok(workerUids.has(agent.uid), `expected an agent-uid worker, saw uids ${[...workerUids].join(",") || "none"}`);
      assert.ok(!workerUids.has(0), "a worker process is running as root");
    });
    await waitFor(() => countByToken(token) === 0, 3000);
  },

  // The worker's writable worktree lives only in its mount namespace: content
  // never appears on the host, and it is gone after teardown (no leak).
  async worktree_isolated_and_revoked() {
    const agent = ids("agent");
    const token = uniqueToken();
    const worktree = `/wt_${token}`;
    const marker = `${worktree}/marker`;
    // The worker (agent) writes a marker into its private worktree, then sleeps.
    const script = `printf ns-only > ${marker}; sleep ${token}`;
    const handle = launchContainedWithWorktree({ argv: ["sh", "-c", script], uid: agent.uid, gid: agent.gid, worktree });
    const up = await waitFor(() => countByToken(token) >= 1, 3000);
    check("contained worktree worker is running", () => assert.ok(up));
    await delay(150); // let the worker write its marker inside the ns
    check("worktree CONTENT is not visible on the host (mount-ns private)", () => {
      assert.ok(!fs.existsSync(marker), "the worker's worktree marker leaked to the host");
    });
    teardown(handle);
    await waitFor(() => countByToken(token) === 0, 3000);
    check("worktree content is gone after teardown, with no host leak", () => {
      assert.ok(!fs.existsSync(marker), "worktree content leaked to the host after teardown");
    });
    // Clean up the empty host mountpoint dir the in-ns mkdir created on the shared fs.
    try { fs.rmdirSync(worktree); } catch { /* fine if absent */ }
  },
};

async function main() {
  const name = process.argv[2] || process.env.MAINT_CASE;
  if (!name || !cases[name]) { process.stdout.write(`unknown case: ${name}\navailable: ${Object.keys(cases).join(", ")}\n`); process.exit(2); }
  process.stdout.write(`CASE ${name}\n`);
  await cases[name]();
  process.stdout.write(`CASE ${name}: ${failures === 0 ? "PASS" : "FAIL"} (${passed} ok, ${failures} failed)\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((error) => { process.stdout.write(`HARNESS ERROR: ${error && error.stack}\n`); process.exit(3); });
