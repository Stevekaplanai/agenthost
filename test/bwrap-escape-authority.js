"use strict";

// Real-Linux adversarial harness (BUILD-PLAN Phase 1e; Foundation B gate proof
// #8; ROOT-SERVICE-STATE-MACHINES §9). It closes the one containment assumption
// Foundation B *inherits* rather than builds: that the agent uid cannot turn the
// setuid /usr/bin/bwrap (Dockerfile:36) into an escape under the exact
// production privilege drop (entrypoint.sh:48
//   setpriv --reuid=agent --regid=agent --init-groups --no-new-privs ...).
//
// It has two groups:
//
//   GROUP K — kernel mechanism (runs anywhere with a compiler + root). Resolves
//   the load-bearing recon contradiction: setuid at Dockerfile:36 vs
//   --no-new-privs at entrypoint.sh:48. It builds a throwaway setuid-root probe
//   (stand-in for "a setuid binary" — which bwrap is), proves the probe DOES
//   elevate as the agent WITHOUT the drop (so the test is not vacuous), then
//   proves the production drop NEUTRALIZES setuid (euid stays agent, the
//   root-only file is unreadable). If no_new_privs strips setuid, setuid bwrap
//   cannot self-elevate to host-capable root regardless of its internals.
//
//   GROUP B — bwrap-internal escape (needs the release-image setuid bwrap). It
//   builds the EXACT production jail via chains.buildBwrapReadJail() (no copy),
//   runs the escape payload inside it as the agent under the production drop,
//   and parses the per-sub-claim CLAIM lines. When /usr/bin/bwrap is not a
//   setuid-root binary (as in the build sandbox), each case SKIPs cleanly with a
//   reason — it must be run on a Fly machine built from the exact release image.
//
// Driven only by scripts/bwrap-escape-verify.sh. Wires NOTHING into any boot
// path; activates no Foundation B piece; deploys nothing. On any FAIL the
// pre-decided §9 fallback applies (Steve, 2026-07-22): neutralize the setuid
// entry, have the root launcher create all containment, re-prove — under
// independent review, no operator gate.

import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER = path.resolve(HERE, "..", "container");
const PAYLOAD = path.join(HERE, "bwrap-escape-payload.sh");

function skip(reason) { process.stdout.write(`SKIP ${reason}\n`); process.exit(0); }
if (process.getuid() !== 0) skip("harness requires root (setuid setup + uid drop)");

const PROBE_BIN = process.env.AH_PROBE_BIN || "";
const ROOT_SECRET = process.env.AH_ROOT_SECRET || "";
const AGENT_UID = Number(cp.execSync("id -u agent").toString().trim());
const DROP = ["--reuid=agent", "--regid=agent", "--init-groups"];

let failures = 0, passed = 0, skipped = 0;
function ok(label, detail) { passed += 1; process.stdout.write(`  PASS ${label}${detail ? " — " + detail : ""}\n`); }
function bad(label, detail) { failures += 1; process.stdout.write(`  FAIL ${label}${detail ? " — " + detail : ""}\n`); }
function skp(label, detail) { skipped += 1; process.stdout.write(`  SKIP ${label}${detail ? " — " + detail : ""}\n`); }
function assertPass(cond, label, detail) { cond ? ok(label, detail) : bad(label, detail); }

// Run argv (no shell) and capture. Never throws on non-zero exit.
function run(argv, opts = {}) {
  const r = cp.spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 15000, ...opts });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", signal: r.signal };
}
const asAgent = (argv, { noNewPrivs = false } = {}) =>
  run(["setpriv", ...DROP, ...(noNewPrivs ? ["--no-new-privs"] : []), ...argv]);
const parseProbe = (out) => {
  const line = out.split("\n").find((l) => l.startsWith("PROBE "));
  if (!line) return null;
  const o = {};
  for (const tok of line.slice(6).trim().split(/\s+/)) { const i = tok.indexOf("="); if (i > 0) o[tok.slice(0, i)] = tok.slice(i + 1); }
  return o;
};

// ---------------------------------------------------------------- GROUP K
function group_kernel_mechanism() {
  process.stdout.write("GROUP K — kernel mechanism (recon contradiction: setuid vs --no-new-privs)\n");
  if (!PROBE_BIN || !fs.existsSync(PROBE_BIN)) { skp("kernel_mechanism", "AH_PROBE_BIN not built (run via scripts/bwrap-escape-verify.sh)"); return; }
  if (!ROOT_SECRET || !fs.existsSync(ROOT_SECRET)) { skp("kernel_mechanism", "AH_ROOT_SECRET not seeded"); return; }

  // The probe must genuinely be a setuid-root binary (as /usr/bin/bwrap is).
  const st = fs.statSync(PROBE_BIN);
  assertPass(st.uid === 0 && (st.mode & 0o4000) !== 0, "probe_is_setuid_root",
    `owner uid=${st.uid} mode=${(st.mode & 0o7777).toString(8)}`);

  // Baseline: as the agent WITHOUT the drop, setuid elevates (euid->0, reads the
  // root-only file). If this fails the sub-proof is inconclusive HERE, not a pass.
  const base = parseProbe(asAgent([PROBE_BIN, ROOT_SECRET]).stdout);
  if (!base) { skp("baseline_setuid_elevates", "probe produced no PROBE line (compiler/fs?)"); return; }
  const baseElevated = base.euid === "0" && String(base.read_root_file).startsWith("OK");
  if (!baseElevated) { skp("baseline_setuid_elevates", `setuid did not elevate even without the drop (euid=${base.euid}, read=${base.read_root_file}); kernel-mechanism proof must run on the release image`); return; }
  ok("baseline_setuid_elevates", `without --no-new-privs: euid=${base.euid}, ${base.read_root_file} (probe genuinely elevates)`);

  // The load-bearing claim: the production drop NEUTRALIZES setuid.
  const drop = parseProbe(asAgent([PROBE_BIN, ROOT_SECRET], { noNewPrivs: true }).stdout);
  assertPass(!!drop, "drop_produces_probe_line", drop ? "" : "no PROBE line under the drop");
  if (drop) {
    assertPass(drop.euid === String(AGENT_UID), "drop_neutralizes_setuid.euid",
      `under --no-new-privs: euid=${drop.euid} (agent=${AGENT_UID}); setuid did NOT elevate`);
    assertPass(String(drop.read_root_file).startsWith("DENIED"), "drop_neutralizes_setuid.read",
      `root-only file: ${drop.read_root_file}`);
  }

  // no_new_privs is inherited across the fork+exec chain (entrypoint setpriv ->
  // start.sh -> gate.js -> bwrap): an intermediate exec cannot clear it.
  const inh = asAgent(["/bin/sh", "-c", "exec /bin/sh -c 'grep NoNewPrivs /proc/self/status'"], { noNewPrivs: true });
  const nnp = (inh.stdout.match(/NoNewPrivs:\s*(\d)/) || [])[1];
  assertPass(nnp === "1", "no_new_privs_inherited", `after two execs NoNewPrivs=${nnp} (drop survives every bwrap exec path)`);
}

// ---------------------------------------------------------------- GROUP B
function setuidBwrapPresent() {
  try { const st = fs.statSync("/usr/bin/bwrap"); return st.uid === 0 && (st.mode & 0o4000) !== 0; }
  catch { return false; }
}
// The EXACT production jail construction — the real function, not a copy.
// Production only ever binds DIRECTORIES via roBindsAt (buildBwrapReadJail does
// `--dir <dest>` then `--ro-bind-try` — a file bound onto a fresh dir mountpoint
// would fail), so bind the staged payload DIRECTORY read-only and run the payload
// from inside it. The task worktree remains the only writable bind in production
// (the gate.js engine read-jail call buildBwrapReadJail(jailBin, jailArgs,
// {requiredRwBindAt=JAIL_WORKTREE}); its line drifts with gate.js churn — ~5007
// here, ~5180 on main post-CONT-03 — so identify it by signature, not line).
function jailReadArgs(mode) {
  const chains = require(path.join(CONTAINER, "chains-lib.js"));
  const payloadDir = process.env.AH_PAYLOAD_DIR || path.dirname(PAYLOAD);
  const payloadName = path.basename(process.env.AH_PAYLOAD_FILE || PAYLOAD);
  return chains.buildBwrapReadJail("/bin/sh", [`/opt/ah/${payloadName}`, mode], {
    roBindsAt: [{ src: payloadDir, dest: "/opt/ah" }],
  });
}
const buildJail = (mode) => jailReadArgs(mode);
// The git-jail path (gate.js:1298 buildBwrapReadJail("git", …) + gate.js:1314
// prepending "--unshare-net"): a second production bwrap exec surface. Used to
// prove the git jail has NO outbound network (defense-in-depth; Hermes flag 1).
function buildGitJail(mode) {
  const jail = jailReadArgs(mode);
  return { bin: jail.bin, args: jail.bin === "/usr/bin/bwrap" ? ["--unshare-net", ...jail.args] : jail.args };
}

// Run the payload inside a built jail as agent under the drop; PASS the case iff
// every CLAIM line is PASS (PASS = escape denied). Records bad()/ok() directly.
function runJailCase(label, jail) {
  if (jail.bin !== "/usr/bin/bwrap") { bad(label, `buildBwrapReadJail refused to build a jail (bin=${jail.bin})`); return; }
  const r = asAgent([jail.bin, ...jail.args], { noNewPrivs: true });
  const claims = r.stdout.split("\n").filter((l) => l.startsWith("CLAIM "));
  if (!claims.length) { bad(label, `no CLAIM output (bwrap exit=${r.code} stderr=${(r.stderr || "").slice(0, 200)})`); return; }
  const fails = claims.filter((l) => l.split(/\s+/)[2] === "FAIL");
  if (fails.length) { for (const f of fails) bad(label, f.slice(6)); }
  else ok(label, `${claims.length} sub-claims denied`);
}
function group_bwrap_escape() {
  process.stdout.write("GROUP B — bwrap-internal escape (needs release-image setuid bwrap)\n");
  const CASES = ["host_root", "reach_stores", "jail_breakout", "writable_mount"];
  if (!setuidBwrapPresent()) {
    for (const c of [...CASES, "git_jail_network"]) skp(`escape_${c}`, "no setuid /usr/bin/bwrap in this environment (baked only into the release image at Dockerfile:36) — run on a Fly machine from the exact release image");
    return;
  }
  for (const mode of CASES) {
    let jail;
    try { jail = buildJail(mode); } catch (e) { skp(`escape_${mode}`, `could not load chains.buildBwrapReadJail: ${e && e.message}`); continue; }
    runJailCase(`escape_${mode}`, jail);
  }
  // git-jail path: prove --unshare-net leaves no outbound network in the jail.
  try { runJailCase("escape_git_jail_network", buildGitJail("net_isolated")); }
  catch (e) { skp("escape_git_jail_network", `could not build git jail: ${e && e.message}`); }
}

function main() {
  const only = process.argv[2] || "all";
  process.stdout.write(`bwrap-escape-authority: kernel=${cp.execSync("uname -r").toString().trim()} agent_uid=${AGENT_UID}\n`);
  if (only === "all" || only === "kernel") group_kernel_mechanism();
  if (only === "all" || only === "bwrap") group_bwrap_escape();
  process.stdout.write(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"} (${passed} pass, ${failures} fail, ${skipped} skip)\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
