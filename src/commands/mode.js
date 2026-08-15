import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as fly from "../fly.js";
import { appOrigin, loadOriginState } from "../state.js";
import { resolveApp } from "./resolve-app.js";

// `agenthost mode <growth|revert|status>` -- the operator's switch for Growth
// Mode (ARD Wave 0, T0.1). Switching is deliberately a THREE-step consequence,
// not a live toggle:
//   1. write /data/mode.json on EVERY machine's volume, as root, over `fly ssh
//      console --machine <machine-id>` -- confirmed by parsing STDOUT (exit codes from ssh
//      console are unreliable on Windows, see src/fly.js's header). Fly volumes
//      are 1:1 with a machine, so an untargeted write reaches exactly one of them;
//   2. restart the machine (the same primitive `agenthost restart` uses) so the
//      gate re-reads the file at boot -- mode is boot-fixed by design;
//   3. poll the box's own GET /mode.json until it reports the new mode.
// No Fly secret participates, which is what makes step 2 sufficient: staged
// secrets are NOT applied by a restart (found live on the dogfood box), but
// volume state survives restarts, `agenthost sync`, and full redeploys.
//
// The pure interpreters below are exported so this logic is unit-tested without
// a live Fly account (test/mode-command.test.js).

const require = createRequire(import.meta.url);
// One source of truth for the mode names and the on-disk shape: the very module
// the gate reads on the box (container/ ships in this package).
const modeLib = require("../../container/mode-lib.js");
// ...and one source of truth for the pack contract: the same validator the gate
// re-runs at boot (T0.3). Checking here is what makes a bad pack a REFUSED
// SWITCH instead of a box that quietly boots back to default an hour later.
const modeValidate = require("../../container/mode-validate.js");

export const MODE_FILE = "/data/mode.json";
const POLL_TRIES = 24;
const POLL_INTERVAL_MS = 5000;
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function packDirFor(mode) { return path.join(REPO_ROOT, "packs", mode); }

// The pre-switch gate. Default mode has no pack (it IS the box as shipped), so
// there is nothing to validate; every other mode must have a pack in this
// install that satisfies the whole contract, checked against the operator's own
// harness so a collision is caught before it silently eats a critical hat (H3).
// The taxonomy defaults to the pack's own snapshot; point AGENTHOST_CHANNEL_TAXONOMY
// at GTMVP-GTM-AGENTS/data/channel-taxonomy.json to check against the source.
// `opts` exists for the tests: rules f and h read state OUTSIDE the repo (the
// taxonomy path, and the operator's own ~/.claude), so a test that does not pin
// them is asserting about the developer's machine, not about the pack.
export function validateModeSwitch(mode, opts = {}) {
  // Only a name this CLI knows ever becomes a filesystem path: `status` feeds
  // this whatever the BOX reported, and a remote string is not something to join
  // into a path.
  if (mode === modeLib.DEFAULT_MODE || !modeLib.MODES.includes(mode)) return { ok: true, errors: [], checked: false };
  const dir = packDirFor(mode);
  const res = modeValidate.validatePack(dir, {
    taxonomyFile: process.env.AGENTHOST_CHANNEL_TAXONOMY || undefined,
    harnessDir: path.join(os.homedir(), ".claude"),
    ...opts,
  });
  return { ...res, checked: true, dir };
}

function modePackRequirements(mode) {
  const meta = JSON.parse(fs.readFileSync(path.join(packDirFor(mode), "pack.json"), "utf8"));
  return {
    criticalSkills: meta.criticalSkills || [],
    criticalAgents: meta.criticalAgents || [],
  };
}

// A non-default state is written only after the physical pack is confirmed on
// every machine volume. Boot fails closed when the directory is absent; probing
// first turns that from a two-minute poll into an immediate, useful sync command.
export function modePackProbeCommand(mode, marker, requirements) {
  const safeMode = String(mode);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(safeMode)) throw new Error("invalid mode name");
  const root = "/data/home/agent/.claude";
  const checks = [
    `node -e "const r=require(\\"/opt/agenthost/mode-validate.js\\").validateModeDir(\\"${root}/modes/${safeMode}\\");if(!r.ok){console.error(r.errors.join(\\"\\\\n\\"));process.exit(1)}"`,
    `[ -f ${root}/modes/${safeMode}/mode.toml ]`,
    `[ -f ${root}/modes/${safeMode}/MODE.md ]`,
  ];
  for (const raw of requirements?.criticalSkills || []) {
    const name = String(raw);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error("invalid critical skill name");
    checks.push(`[ -f ${root}/skills/${name}/SKILL.md ]`);
  }
  for (const raw of requirements?.criticalAgents || []) {
    const name = String(raw).replace(/\.md$/, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error("invalid critical agent name");
    checks.push(`node -e "process.exit(require(\\"/opt/agenthost/mode-validate.js\\").hasAgentDefinition(\\"${root}/agents\\",\\"${name}\\")?0:1)"`);
  }
  const compatibleValidator = `node -e "const v=require(\\"/opt/agenthost/mode-validate.js\\");process.exit(typeof v.validateModeDir===\\"function\\"&&typeof v.hasAgentDefinition===\\"function\\"?0:1)"`;
  return `sh -c 'if ! ${compatibleValidator}; then echo AGENTHOST-MODE-VALIDATOR-MISSING; elif ${checks.join(" && ")}; then echo ${marker}; else echo AGENTHOST-MODE-PACK-MISSING; fi'`;
}

export function confirmModePackProbe(stdout, marker) {
  return String(stdout || "").split(/\r?\n/).some((line) => line.trim() === marker);
}

export function verifyModePackOnFleet(app, ids, mode, marker, requirements, sshOutput = fly.sshConsoleOutput) {
  const probes = [];
  const command = modePackProbeCommand(mode, marker, requirements);
  for (const id of ids) {
    let output = "";
    try { output = sshOutput(app, command, id); } catch { /* failed below */ }
    probes.push({ id, output, ok: confirmModePackProbe(output, marker) });
  }
  const isStale = (probe) => String(probe.output || "").split(/\r?\n/)
    .some((line) => line.trim() === "AGENTHOST-MODE-VALIDATOR-MISSING");
  const stale = probes.filter(isStale).map((probe) => probe.id);
  const missing = probes.filter((probe) => !probe.ok && !isStale(probe)).map((probe) => probe.id);
  return { ok: stale.length === 0 && missing.length === 0, probes, stale, missing };
}

export function runningModeProbeCommand(origin) {
  const host = new URL(appOrigin("mode probe", { origin })).host;
  return `sh -c 'curl -fsS --max-time 5 -H "Host: ${host}" http://127.0.0.1:8080/mode.json | jq -r .mode'`;
}

export function confirmRunningModeProbe(stdout, mode) {
  return String(stdout || "").split(/\r?\n/).some((line) => line.trim() === mode);
}

export function verifyRunningModeOnFleet(app, ids, mode, sshOutput = fly.sshConsoleOutput, origin) {
  const probes = [];
  const command = runningModeProbeCommand(origin);
  for (const id of ids) {
    let output = "";
    try { output = sshOutput(app, command, id); } catch { /* failed below */ }
    probes.push({ id, output, ok: confirmRunningModeProbe(output, mode) });
  }
  const mismatched = probes.filter((probe) => !probe.ok).map((probe) => probe.id);
  return { ok: mismatched.length === 0, probes, mismatched };
}

export function parseModeAction(arg) {
  const a = String(arg ?? "").trim();
  const known = modeLib.MODES.join("|");
  if (!a) throw new Error(`usage: agenthost mode <${known}|revert|status>`);
  if (a === "status") return { action: "status" };
  // revert is just "back to the engineering box" spelled the way an operator
  // thinks about it under pressure.
  if (a === "revert") return { action: "set", mode: modeLib.DEFAULT_MODE };
  if (modeLib.MODES.includes(a)) return { action: "set", mode: a };
  throw new Error(`unknown mode '${a}'. Known: ${modeLib.MODES.join(", ")} (or 'revert', 'status')`);
}

function modeTransactionPaths(marker) {
  const base = `/data/.agenthost-mode-${marker}`;
  return { backup: `${base}.bak`, missing: `${base}.missing`, temp: `${base}.new` };
}

// The remote one-liner. The JSON rides as base64 so shell quoting cannot change
// it. Before replacing the live file, keep enough evidence to restore the exact
// prior state if a later machine cannot be written.
export function modeWriteCommand(state, marker) {
  const b64 = Buffer.from(JSON.stringify(state), "utf8").toString("base64");
  const p = modeTransactionPaths(marker);
  return `sh -c 'set -e; rm -f ${p.backup} ${p.missing} ${p.temp}; if [ -f ${MODE_FILE} ]; then cp ${MODE_FILE} ${p.backup}; else : > ${p.missing}; fi; echo ${b64} | base64 -d > ${p.temp}; chmod 0644 ${p.temp}; mv ${p.temp} ${MODE_FILE}; echo ${marker}; cat ${MODE_FILE}'`;
}

export function modeRollbackCommand(marker) {
  const p = modeTransactionPaths(marker);
  return `sh -c 'set -e; if [ -f ${p.backup} ]; then mv ${p.backup} ${MODE_FILE}; elif [ -f ${p.missing} ]; then rm -f ${MODE_FILE}; fi; rm -f ${p.missing} ${p.temp}; echo ${marker}-ROLLBACK-OK'`;
}

function modeCleanupCommand(marker) {
  const p = modeTransactionPaths(marker);
  return `sh -c 'rm -f ${p.backup} ${p.missing} ${p.temp} && echo ${marker}-CLEANUP-OK'`;
}

// STDOUT is the only trustworthy signal. The box must have echoed our one-shot
// marker AND printed back a file that parses to the mode we asked for -- a
// half-written or shell-mangled file fails here, before anything restarts.
export function confirmModeWrite(stdout, marker, mode) {
  const out = String(stdout || "");
  const at = out.indexOf(marker);
  if (at < 0) return false;
  const tail = out.slice(at + marker.length);
  const start = tail.indexOf("{");
  const end = tail.lastIndexOf("}");
  if (start < 0 || end <= start) return false;
  let parsed;
  try { parsed = JSON.parse(tail.slice(start, end + 1)); }
  catch { return false; }
  return Boolean(parsed) && parsed.mode === mode && parsed.schema_version === modeLib.SCHEMA_VERSION;
}

export function confirmModeRollback(stdout, marker) {
  return String(stdout || "").includes(`${marker}-ROLLBACK-OK`);
}

// Apply the durable state as one fleet operation. A write failure stops the
// sequence and restores every volume already touched before modeCommand can
// restart anything. The injected SSH function makes the failure paths real unit
// tests instead of source-code pattern checks.
export function applyModeStateToFleet(app, ids, state, marker, sshOutput = fly.sshConsoleOutput) {
  const writes = [];
  for (const id of ids) {
    let output = "";
    try { output = sshOutput(app, modeWriteCommand(state, marker), id); } catch { /* failed below */ }
    const ok = confirmModeWrite(output, marker, state.mode);
    writes.push({ id, output, ok });
    if (!ok) break;
  }

  const unwritten = writes.filter((entry) => !entry.ok).map((entry) => entry.id);
  if (unwritten.length) {
    const rollbackFailed = [];
    for (const { id } of writes) {
      let output = "";
      try { output = sshOutput(app, modeRollbackCommand(marker), id); } catch { /* failed below */ }
      if (!confirmModeRollback(output, marker)) rollbackFailed.push(id);
    }
    return { ok: false, writes, unwritten, rollbackFailed, cleanupFailed: [] };
  }

  const cleanupFailed = [];
  for (const { id } of writes) {
    let output = "";
    try { output = sshOutput(app, modeCleanupCommand(marker), id); } catch { /* failed below */ }
    if (!String(output).includes(`${marker}-CLEANUP-OK`)) cleanupFailed.push(id);
  }
  return { ok: true, writes, unwritten: [], rollbackFailed: [], cleanupFailed };
}

// The gate's GET /mode.json, or null for anything else (login HTML, a 502 from
// a booting box, an empty socket).
export function parseBoxMode(body) {
  try {
    const parsed = JSON.parse(String(body));
    return parsed && typeof parsed.mode === "string" ? parsed.mode : null;
  } catch { return null; }
}

// A box that ANSWERS /mode.json with an auth page or a 404 is not down: the gate
// only started serving that route with Growth Mode, so an older image falls
// through to the login gate (401) or has no route at all (404). Telling that
// operator "is the box up?" sends them to `agenthost doctor`, which confirms it
// IS up -- a loop. The one thing that unblocks them is a redeploy.
export function staleImageStatus(status) { return status === 401 || status === 404; }

// Fetch a small text body. Returns { status, body } -- the STATUS matters: it is
// the only way to tell a pre-Growth-Mode image (it answers) from a box that is
// down (it doesn't).
//
// Every settle path here is load-bearing. This is polled while the machine is
// REBOOTING, which is exactly when fly-proxy will accept the connection, relay
// headers from a dying upstream, and then drop the socket mid-body. Node routes
// that reset to the RESPONSE object, so neither req's "error" nor its "timeout"
// (a socket-inactivity timer that cannot fire on an already-destroyed socket)
// ever sees it -- reproduced locally: the old promise was still pending long
// past its 8s timeout, hanging `agenthost mode growth` with no output and no way
// out but Ctrl-C. Hence res-level handlers AND a hard deadline that can settle
// from outside both objects.
export function httpBody(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    const finish = (status, body) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      try { req?.destroy(); } catch { /* already gone */ }
      resolve({ status, body });
    };
    const deadline = setTimeout(() => finish(0, ""), timeoutMs);
    try {
      const get = url.startsWith("http://") ? http.get : https.get;
      req = get(url, { timeout: timeoutMs }, (res) => {
        let out = "";
        res.on("data", (c) => { out += c; });
        res.on("end", () => finish(res.statusCode || 0, out));
        res.on("aborted", () => finish(0, ""));
        res.on("error", () => finish(0, ""));
      });
      req.on("timeout", () => { req.destroy(); finish(0, ""); });
      req.on("error", () => finish(0, ""));
    } catch { finish(0, ""); }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function appCommand(app, command) {
  return `agenthost ${command} --app ${app}`;
}

export async function modeCommand(flags) {
  const { action, mode } = parseModeAction(flags._?.[0]);
  const app = resolveApp(flags);
  const url = appOrigin(app, loadOriginState(app));

  if (action === "status") {
    const res = await httpBody(`${url}/mode.json`);
    const live = parseBoxMode(res.body);
    if (!live) {
      if (staleImageStatus(res.status)) {
        console.error(`${url}/mode.json answered ${res.status}, not a mode: this box is running an image from before Growth Mode.`);
        console.error(`It is UP -- it just doesn't know what a mode is yet. Ship the current image: ${appCommand(app, "deploy")}`);
        return 1;
      }
      console.error(`Couldn't read the mode from ${url}/mode.json. Is the box up? Try: ${appCommand(app, "doctor")}`);
      return 1;
    }
    console.log(`${app} is running in ${live} mode.`);
    // The second half of "status": is the pack behind that mode still valid
    // HERE, in this checkout? A pack edited after the switch is the case this
    // catches. Say exactly that and nothing more: this runs all of a-h against
    // YOUR files, while the box's boot check is a/b/d/g against what was deployed
    // to it -- so a failure here means "the next SWITCH is refused", not "the
    // running box is about to fall over".
    const check = validateModeSwitch(live);
    if (check.checked) {
      if (check.ok) console.log(`Its pack (${check.dir}) passes the mode-pack contract.`);
      else {
        console.error(`\nIts pack in THIS checkout (${check.dir}) FAILS the mode-pack contract, so re-switching to ${live} would be refused:`);
        for (const e of check.errors) console.error(`  - ${e}`);
        console.error(`\n(The box keeps running the mode it booted; its own boot check covers only what was deployed to it.)`);
        console.error(`The rules are written down in docs/pack-contract.md.`);
        return 1;
      }
    }
    return 0;
  }

  // 0. The pack has to be valid before anything is written. A mode is only as
  //    trustworthy as the pack behind it, and every failure here is one the box
  //    would otherwise hit at boot -- after a restart the operator watched.
  const check = validateModeSwitch(mode);
  if (!check.ok) {
    console.error(`The ${mode} pack (${check.dir}) does not satisfy the mode-pack contract, so NOTHING was written and the box was not restarted:`);
    for (const e of check.errors) console.error(`  - ${e}`);
    console.error(`\nThe rules are written down in docs/pack-contract.md.`);
    return 1;
  }

  // 1. Write the volume on EVERY machine, as root, confirming each from stdout.
  //    Per machine, not per app: a Fly volume belongs to exactly one machine, so
  //    an untargeted `fly ssh console` writes /data/mode.json on whichever
  //    machine flyctl picked. On a 2-machine app that left machine B booting
  //    default while the load-balanced poll in step 3 happily landed on A and
  //    printed "running in growth mode" -- a split fleet the operator was told
  //    was one box. The restart loop below already addressed machines
  //    individually; the write has the same obligation.
  const ids = fly.machineIds(app);
  if (!ids.length) {
    console.error(`No machines found for '${app}', so there is no volume to write. Nothing was changed.`);
    console.error(`Check the app is up: ${appCommand(app, "doctor")}`);
    return 1;
  }
  if (mode !== modeLib.DEFAULT_MODE) {
    const packMarker = `AGENTHOST-PACK-OK-${crypto.randomBytes(6).toString("hex")}`;
    console.log(`Checking that the ${mode} pack is already installed on every machine...`);
    const deployed = verifyModePackOnFleet(app, ids, mode, packMarker, modePackRequirements(mode));
    for (const probe of deployed.probes) {
      const stale = deployed.stale.includes(probe.id);
      console.log(`  ${probe.id}: ${probe.ok ? "pack confirmed" : stale ? "image needs the Wave 0 validator" : "pack missing or incomplete"}`);
    }
    if (!deployed.ok) {
      if (deployed.stale.length) {
        console.error(`\nThe running image is too old to validate modes on: ${deployed.stale.join(", ")}. Nothing was written and nothing was restarted.`);
        console.error(`Upgrade the image and install the pack: ${appCommand(app, `deploy --pack ${mode}`)}`);
        console.error(`Then run: ${appCommand(app, `mode ${mode}`)}`);
        return 1;
      }
      console.error(`\nThe ${mode} pack is not complete on: ${deployed.missing.join(", ")}. Nothing was written and nothing was restarted.`);
      console.error(`Install it first: ${appCommand(app, `sync --pack ${mode}`)}`);
      console.error(`Then run: ${appCommand(app, `mode ${mode}`)}`);
      return 1;
    }
  }
  const marker = `AGENTHOST-MODE-OK-${crypto.randomBytes(6).toString("hex")}`;
  // ONE state object for the whole fleet: every volume gets byte-identical
  // contents, including set_at.
  const state = modeLib.buildModeState(mode);
  console.log(`Setting ${app} to ${mode} mode (writing ${MODE_FILE} on ${ids.length} machine${ids.length > 1 ? "s" : ""})...`);
  const fleetWrite = applyModeStateToFleet(app, ids, state, marker);
  for (const entry of fleetWrite.writes) {
    if (entry.ok) console.log(`  ${entry.id}: ${MODE_FILE} written and read back`);
    else {
      console.error(`  ${entry.id}: did not confirm the write`);
      if (entry.output.trim()) console.error(entry.output.trim());
    }
  }
  if (!fleetWrite.ok) {
    if (fleetWrite.rollbackFailed.length) {
      console.error(`\nNothing was restarted, but rollback could not be confirmed on: ${fleetWrite.rollbackFailed.join(", ")}.`);
      console.error(`Do NOT restart the box yet. When every machine is reachable, re-run: ${appCommand(app, `mode ${mode}`)}`);
    } else {
      console.error(`\nThe fleet write failed, every touched volume was restored, and NOTHING was restarted. The running mode is unchanged.`);
      console.error(`Check reachability with ${appCommand(app, "doctor")}, then re-run ${appCommand(app, `mode ${mode}`)}.`);
    }
    return 1;
  }
  if (fleetWrite.cleanupFailed.length) console.warn(`  backup cleanup was not confirmed on: ${fleetWrite.cleanupFailed.join(", ")} (the mode write itself is confirmed)`);
  console.log(`  ${MODE_FILE} rides the data volume, so it survives restarts, sync, and redeploys.`);

  // 2. Supervised restart: mode is fixed at boot, so it only takes effect on the
  //    next one. Same primitive as `agenthost restart`; the volume is untouched.
  console.log(`Restarting ${ids.length} machine${ids.length > 1 ? "s" : ""} so the gate re-reads it...`);
  let failed = 0;
  for (const id of ids) {
    const res = fly.restartMachine(app, id);
    if (res.code !== 0) { failed++; console.error(`  ${id}: ${(res.stderr || res.stdout || "restart failed").trim()}`); }
    else console.log(`  ${id}: restarting`);
  }
  // ANY failed restart is a failure, exactly as `agenthost restart` treats it
  // (src/commands/restart.js: `if (failed) return 1`). A partial restart is the
  // worse outcome, not the better one: the fleet is SPLIT, and polling would go
  // through fly-proxy and very likely land on a restarted machine, report
  // success, and hide a machine still serving the old mode.
  if (failed) {
    console.error(`\n${failed} of ${ids.length} machine${ids.length > 1 ? "s" : ""} did not restart, so the fleet is split: some are on ${mode}, some are not.`);
    console.error(`The mode file IS written. Bring the rest over with: ${appCommand(app, "restart")}`);
    return 1;
  }

  // 3. Ask every running gate, not the load balancer. A single public GET can
  //    repeatedly hit machine A and hide machine B failing closed to default.
  console.log(`Waiting for every machine's local /mode.json to report ${mode}...`);
  let lastFleet = { mismatched: [...ids] };
  for (let i = 0; i < POLL_TRIES; i++) {
    await sleep(POLL_INTERVAL_MS);
    lastFleet = verifyRunningModeOnFleet(app, ids, mode, fly.sshConsoleOutput, url);
    if (lastFleet.ok) {
      console.log(`\n${app} is running in ${mode} mode.`);
      if (mode !== modeLib.DEFAULT_MODE) {
        console.log(`Every page now carries the ${mode.toUpperCase()} badge in the tab bar. Revert with: ${appCommand(app, "mode revert")}`);
      }
      console.log(`   ${url}`);
      return 0;
    }
  }
  console.error(`\nThe fleet has not converged on ${mode} after ${(POLL_TRIES * POLL_INTERVAL_MS) / 1000}s. Not confirmed: ${lastFleet.mismatched.join(", ")}.`);
  const publicStatus = await httpBody(`${url}/mode.json`);
  if (staleImageStatus(publicStatus.status)) {
    // Don't promise "it applies on the next boot" here -- it doesn't. An image
    // with no /mode.json route will keep ignoring the file through every reboot.
    console.error(`${url}/mode.json is answering ${publicStatus.status}: this box is running an image from before Growth Mode, so the file will NOT apply on its own.`);
    console.error(`Ship the current image, then check again: ${appCommand(app, "deploy")}   |   ${appCommand(app, "mode status")}`);
    return 1;
  }
  console.error(`The pack and mode file were confirmed on every machine, but the running gate still did not report ${mode}.`);
  console.error(`It may have failed closed to default. Check: ${appCommand(app, "logs")}   |   ${appCommand(app, "mode status")}`);
  return 1;
}
