// Unit tests for the pure interpreters in `agenthost mode` -- no live Fly
// account needed; the flyctl/HTTP calls are orchestration around these.
// The load-bearing one is confirmModeWrite: `fly ssh console` exit codes are
// unreliable on Windows, so a mode switch is confirmed from STDOUT or not at
// all -- and an unconfirmed write must never lead to a restart.
// Run: node --test test/mode-command.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MODE_FILE, parseModeAction, modeWriteCommand, confirmModeWrite, parseBoxMode,
  modeRollbackCommand, confirmModeRollback, applyModeStateToFleet,
  modePackProbeCommand, confirmModePackProbe, verifyModePackOnFleet,
  runningModeProbeCommand, confirmRunningModeProbe, verifyRunningModeOnFleet,
  appCommand, httpBody, staleImageStatus, packDirFor, validateModeSwitch,
} from "../src/commands/mode.js";
import { sshConsoleOutput } from "../src/fly.js";
const require = createRequire(import.meta.url);
const modeLib = require("../container/mode-lib.js");

test("parseModeAction routes a known mode name to a switch", () => {
  assert.deepEqual(parseModeAction("growth"), { action: "set", mode: "growth" });
});

test("parseModeAction routes revert to the default mode", () => {
  assert.deepEqual(parseModeAction("revert"), { action: "set", mode: "default" });
});

test("parseModeAction routes status to a read", () => {
  assert.deepEqual(parseModeAction("status"), { action: "status" });
});

test("parseModeAction rejects an unknown mode and names the known ones", () => {
  assert.throws(() => parseModeAction("chaos"), /chaos[\s\S]*growth/);
});

test("parseModeAction with no argument prints the usage", () => {
  assert.throws(() => parseModeAction(undefined), /usage: agenthost mode/);
});

// ---- the pre-switch pack check (T0.3) --------------------------------------
// `agenthost mode <name>` validates the pack BEFORE it writes anything, so a
// pack that would fail at boot fails here instead -- with nothing written and
// nothing restarted.

test("the pack the switch validates is the one shipped in this install", () => {
  const dir = packDirFor("growth");
  assert.equal(path.basename(dir), "growth");
  assert.ok(fs.existsSync(path.join(dir, "pack.json")), `no pack at ${dir}`);
});

test("switching to growth validates the growth pack and it passes", () => {
  // PINNED, not ambient: rule f reads a taxonomy path (overridable by
  // AGENTHOST_CHANNEL_TAXONOMY) and rule h reads the operator's own ~/.claude.
  // Left to the machine, this test asserts about the developer's harness -- and
  // it goes red the day anyone authors a local media-auditor agent, which is
  // exactly the H3 collision rule h exists to catch, not a broken pack.
  const emptyHarness = fs.mkdtempSync(path.join(os.tmpdir(), "modeswitch-harness-"));
  try {
    const res = validateModeSwitch("growth", {
      taxonomyFile: path.join(packDirFor("growth"), "channel-taxonomy.json"),
      harnessDir: emptyHarness,
    });
    assert.equal(res.checked, true);
    assert.equal(res.ok, true, res.errors.join("\n"));
  } finally {
    fs.rmSync(emptyHarness, { recursive: true, force: true });
  }
});

test("the growth pack ships in the published package, or the switch is impossible", () => {
  // The validator runs against <install root>/packs/<mode>, so a `files` list
  // without "packs" turns `agenthost mode growth` into a guaranteed hard fail
  // for everyone who installed the documented way (npm i -g agenthost-cli).
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.ok(pkg.files.includes("packs"), "package.json files[] must ship packs/ -- see docs/pack-contract.md");
});

test("reverting to default validates nothing -- default IS the box as shipped", () => {
  const res = validateModeSwitch(modeLib.DEFAULT_MODE);
  assert.deepEqual(res, { ok: true, errors: [], checked: false });
});

test("a non-default switch probes for its deployed mode files and critical hat first", () => {
  const cmd = modePackProbeCommand("growth", "PACK-MARKER", {
    criticalSkills: [], criticalAgents: ["media-auditor"],
  });
  assert.match(cmd, /modes\/growth\/mode\.toml/);
  assert.match(cmd, /modes\/growth\/MODE\.md/);
  assert.match(cmd, /\.claude\/agents/);
  assert.match(cmd, /media-auditor/);
  assert.match(cmd, /mode-validate\.js/);
  assert.match(cmd, /validateModeDir/);
  assert.match(cmd, /hasAgentDefinition/);
  assert.match(cmd, /PACK-MARKER/);
});

test("the switch refuses a split fleet when one machine's deployed mode fails its real validator", () => {
  const fakeSsh = (_app, command, id) => {
    if (id === "machine-a") return "PACK-MARKER\n";
    return command.includes("validateModeDir")
      ? "mode 'growth': mode.toml declares [gates] (rule d)\nAGENTHOST-MODE-PACK-MISSING\n"
      : "PACK-MARKER\n";
  };
  const result = verifyModePackOnFleet(
    "agenthost-steve", ["machine-a", "machine-b"], "growth", "PACK-MARKER",
    { criticalSkills: [], criticalAgents: ["media-auditor"] }, fakeSsh,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["machine-b"]);
});

test("the switch refuses a critical directory hat with no loadable definition", () => {
  const fakeSsh = (_app, command, id) => id === "machine-b" && command.includes("hasAgentDefinition")
    ? "AGENTHOST-MODE-PACK-MISSING\n"
    : "PACK-MARKER\n";
  const result = verifyModePackOnFleet(
    "agenthost-steve", ["machine-a", "machine-b"], "growth", "PACK-MARKER",
    { criticalSkills: [], criticalAgents: ["media-auditor"] }, fakeSsh,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["machine-b"]);
});

test("every printed remediation command preserves the selected app", () => {
  assert.equal(appCommand("box-b", "sync --pack growth"), "agenthost sync --pack growth --app box-b");
  assert.equal(appCommand("box-b", "mode growth"), "agenthost mode growth --app box-b");
  assert.equal(appCommand("box-b", "mode revert"), "agenthost mode revert --app box-b");
  assert.equal(appCommand("box-b", "restart"), "agenthost restart --app box-b");
  assert.equal(appCommand("box-b", "doctor"), "agenthost doctor --app box-b");
});

test("the switch refuses to write state when any machine is missing the deployed pack", () => {
  const calls = [];
  const fakeSsh = (_app, command, id) => {
    calls.push({ id, command });
    return id === "machine-b" ? "AGENTHOST-MODE-PACK-MISSING\n" : "PACK-MARKER\n";
  };
  const result = verifyModePackOnFleet(
    "agenthost-steve", ["machine-a", "machine-b"], "growth", "PACK-MARKER",
    { criticalSkills: [], criticalAgents: ["media-auditor"] }, fakeSsh,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["machine-b"]);
  assert.deepEqual(calls.map((call) => call.id), ["machine-a", "machine-b"]);
  assert.equal(confirmModePackProbe("noise\nPACK-MARKER\n", "PACK-MARKER"), true);
  assert.equal(confirmModePackProbe("AGENTHOST-MODE-PACK-MISSING\n", "PACK-MARKER"), false);
});

test("pack probing distinguishes a stale pre-Wave-0 image from a missing pack", () => {
  const fakeSsh = (_app, _command, id) => id === "machine-b"
    ? "AGENTHOST-MODE-VALIDATOR-MISSING\n"
    : "PACK-MARKER\n";
  const result = verifyModePackOnFleet(
    "agenthost-steve", ["machine-a", "machine-b"], "growth", "PACK-MARKER",
    { criticalSkills: [], criticalAgents: ["media-auditor"] }, fakeSsh,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.stale, ["machine-b"]);
  assert.deepEqual(result.missing, []);
  assert.match(modePackProbeCommand("growth", "PACK-MARKER", {}), /AGENTHOST-MODE-VALIDATOR-MISSING/);
});

test("post-restart verification targets every machine and refuses a mixed-mode fleet", () => {
  const calls = [];
  const fakeSsh = (_app, command, id) => {
    calls.push({ command, id });
    return id === "machine-a" ? "growth\n" : "default\n";
  };
  const result = verifyRunningModeOnFleet(
    "agenthost-steve", ["machine-a", "machine-b"], "growth", fakeSsh,
    "https://app.agenthost.space",
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatched, ["machine-b"]);
  assert.deepEqual(calls.map((call) => call.id), ["machine-a", "machine-b"]);
  assert.ok(calls.every((call) => call.command === runningModeProbeCommand("https://app.agenthost.space")));
  assert.ok(calls.every((call) => call.command.includes('-H "Host: app.agenthost.space"')));
  assert.match(calls[0].command, /127\.0\.0\.1:8080\/mode\.json/);
  assert.equal(confirmRunningModeProbe("connection noise\ngrowth\n", "growth"), true);
  assert.equal(confirmRunningModeProbe("default\n", "growth"), false);
});

test("the remote write command carries no quotes or spaces in its payload", () => {
  const cmd = modeWriteCommand(modeLib.buildModeState("growth"), "MARKER123");
  // Base64 exists precisely so the JSON body cannot be mangled by one shell or
  // two; anything quote-shaped in the payload would be the bug.
  const payload = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(cmd);
  assert.ok(payload, `no base64 payload in: ${cmd}`);
  const decoded = JSON.parse(Buffer.from(payload[1], "base64").toString("utf8"));
  assert.equal(decoded.mode, "growth");
  assert.equal(decoded.schema_version, modeLib.SCHEMA_VERSION);
  assert.equal(decoded.set_by, "cli");
  assert.ok(cmd.includes(MODE_FILE));
  assert.ok(cmd.includes("MARKER123"), "the command must echo the confirmation marker");
  assert.ok(cmd.includes(`cat ${MODE_FILE}`), "the command must echo the file back for verification");
});

test("confirmModeWrite accepts a run that echoed both the marker and the new state", () => {
  const out = `Connecting to fdaa:...\nMARKER123\n${JSON.stringify(modeLib.buildModeState("growth"))}\n`;
  assert.equal(confirmModeWrite(out, "MARKER123", "growth"), true);
});

test("confirmModeWrite rejects output with no marker (the shell never ran our script)", () => {
  const out = `sh: 1: Syntax error: Unterminated quoted string\n`;
  assert.equal(confirmModeWrite(out, "MARKER123", "growth"), false);
});

test("confirmModeWrite rejects a marker with no file echoed back", () => {
  assert.equal(confirmModeWrite("MARKER123\n", "MARKER123", "growth"), false);
});

test("confirmModeWrite rejects a file that came back mangled by shell quoting", () => {
  // The exact failure a double-unquoting shell would produce: quotes eaten.
  assert.equal(confirmModeWrite("MARKER123\n{schema_version:1,mode:growth}\n", "MARKER123", "growth"), false);
});

test("confirmModeWrite rejects a file that landed with the wrong mode", () => {
  const out = `MARKER123\n${JSON.stringify(modeLib.buildModeState("default"))}\n`;
  assert.equal(confirmModeWrite(out, "MARKER123", "growth"), false);
});

// ---- httpBody: the poll must always settle ---------------------------------
// This is the fetch the switch runs every 5s WHILE THE MACHINE IS REBOOTING, so
// its failure modes are the normal case, not the edge case. Each test below is a
// way the box can answer badly; all of them must resolve, none may hang.
async function withServer(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}/mode.json`); }
  finally { srv.close(); }
}
// Any hang shows up as a failure here rather than a stuck test run.
const settles = (p, ms = 4000) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`httpBody never settled within ${ms}ms`)), ms).unref?.()),
]);

test("httpBody returns the body and the status of a healthy box", async () => {
  const res = await withServer((req, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end('{"mode":"growth"}'); },
    (url) => settles(httpBody(url, 2000)));
  assert.equal(res.status, 200);
  assert.equal(parseBoxMode(res.body), "growth");
});

test("httpBody settles when the socket dies AFTER the headers (the reboot window)", async () => {
  // fly-proxy accepts the connection, relays headers from a dying upstream, then
  // drops it. Node routes that reset to the RESPONSE, so req's error/timeout
  // handlers never fire -- the promise used to hang forever and the operator's
  // only exit was Ctrl-C, with no way to tell whether the switch had landed.
  const res = await withServer((req, r) => {
    r.writeHead(200, { "content-type": "application/json", "content-length": "40" });
    r.write('{"mode":"gro');
    setTimeout(() => r.socket.destroy(), 20);
  }, (url) => settles(httpBody(url, 2000)));
  assert.equal(parseBoxMode(res.body), null, "a half-read body is not a mode");
});

test("httpBody settles when the box accepts the connection and never answers", async () => {
  const started = Date.now();
  const res = await withServer(() => { /* headers never sent */ }, (url) => settles(httpBody(url, 600)));
  assert.equal(res.status, 0);
  assert.ok(Date.now() - started < 3000, "the deadline is the timeout, not the process lifetime");
});

test("httpBody hands back the status so a pre-Growth-Mode image is distinguishable", async () => {
  // An image from before Growth Mode has no /mode.json route: the request falls
  // through to the auth gate and comes back as a 401 login page. The box is UP --
  // telling that operator to run `agenthost doctor` sends them in a circle.
  const res = await withServer((req, r) => { r.writeHead(401, { "content-type": "text/html" }); r.end("<html>login</html>"); },
    (url) => settles(httpBody(url, 2000)));
  assert.equal(res.status, 401);
  assert.equal(parseBoxMode(res.body), null);
  assert.equal(staleImageStatus(res.status), true);
});

test("staleImageStatus only claims a stale image when the box actually answered", () => {
  assert.equal(staleImageStatus(404), true);
  assert.equal(staleImageStatus(401), true);
  assert.equal(staleImageStatus(502), false, "a bad gateway is a box that is down, not an old image");
  assert.equal(staleImageStatus(0), false, "and no answer at all is not an answer");
  assert.equal(staleImageStatus(200), false);
});

test("parseBoxMode reads the gate's /mode.json and never throws", () => {
  assert.equal(parseBoxMode('{"mode":"growth"}'), "growth");
  assert.equal(parseBoxMode('{"mode":"default"}'), "default");
  assert.equal(parseBoxMode("<html>login</html>"), null);
  assert.equal(parseBoxMode('{"brand":"dev"}'), null);
  assert.equal(parseBoxMode(""), null);
});

// ---- the write lands on EVERY machine, not on whichever one flyctl picked ----
// A Fly volume belongs to exactly one machine, and /data/mode.json is per-volume
// state. An untargeted `fly ssh console` writes it on ONE machine; the restart
// loop then reboots them all and the load-balanced poll of /mode.json can land
// on the machine that did switch -- a green "running in growth mode" over a
// fleet where the other machine still serves the full default surface.

test("sshConsoleOutput targets one machine when given an id, and stays app-wide when not", () => {
  const calls = [];
  const fake = (args) => { calls.push(args); return { code: 0, stdout: "ok", stderr: "" }; };
  sshConsoleOutput("agenthost-steve", "echo hi", "148ed123f4e089", fake);
  sshConsoleOutput("agenthost-steve", "echo hi", null, fake);
  assert.deepEqual(calls[0], ["ssh", "console", "--machine", "148ed123f4e089", "-a", "agenthost-steve", "-C", "echo hi"]);
  assert.deepEqual(calls[1], ["ssh", "console", "-a", "agenthost-steve", "-C", "echo hi"],
    "reads like `df -h` keep the old app-wide form");
});

test("a partial fleet write rolls every touched volume back before returning", () => {
  const state = modeLib.buildModeState("growth");
  const calls = [];
  const fakeSsh = (_app, command, id) => {
    calls.push({ id, command });
    if (command.includes("ROLLBACK-OK")) return `MARKER123-ROLLBACK-OK\n`;
    if (id === "machine-b") return "ssh failed";
    return `MARKER123\n${JSON.stringify(state)}\n`;
  };

  const result = applyModeStateToFleet("agenthost-steve", ["machine-a", "machine-b", "machine-c"], state, "MARKER123", fakeSsh);

  assert.equal(result.ok, false);
  assert.deepEqual(result.unwritten, ["machine-b"]);
  assert.deepEqual(result.rollbackFailed, []);
  assert.deepEqual(calls.map((c) => c.id), ["machine-a", "machine-b", "machine-a", "machine-b"],
    "stop at the first failed write, then roll back every machine the command touched");
  assert.ok(calls.slice(2).every((c) => c.command.includes("ROLLBACK-OK")));
});

test("a failed rollback is reported as durable split-state risk", () => {
  const state = modeLib.buildModeState("growth");
  const fakeSsh = (_app, command, id) => {
    if (command.includes("ROLLBACK-OK")) return id === "machine-a" ? "rollback connection lost" : `MARKER123-ROLLBACK-OK\n`;
    if (id === "machine-b") return "write connection lost";
    return `MARKER123\n${JSON.stringify(state)}\n`;
  };

  const result = applyModeStateToFleet("agenthost-steve", ["machine-a", "machine-b"], state, "MARKER123", fakeSsh);
  assert.equal(result.ok, false);
  assert.deepEqual(result.rollbackFailed, ["machine-a"]);
});

test("the rollback command restores a backup or removes a newly-created mode file", () => {
  const cmd = modeRollbackCommand("MARKER123");
  assert.match(cmd, /\.bak/);
  assert.match(cmd, /\.missing/);
  assert.match(cmd, new RegExp(MODE_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(confirmModeRollback("noise\nMARKER123-ROLLBACK-OK\n", "MARKER123"), true);
  assert.equal(confirmModeRollback("noise only", "MARKER123"), false);
});

test("cleanup failure is reported instead of echoing a false success marker", () => {
  const state = modeLib.buildModeState("growth");
  const fakeSsh = (_app, command) => {
    if (command.includes("CLEANUP-OK")) {
      return command.includes("&& echo") ? "rm: permission denied\n" : "MARKER123-CLEANUP-OK\n";
    }
    return `MARKER123\n${JSON.stringify(state)}\n`;
  };
  const result = applyModeStateToFleet("agenthost-steve", ["machine-a"], state, "MARKER123", fakeSsh);
  assert.equal(result.ok, true, "the already-confirmed mode write remains successful");
  assert.deepEqual(result.cleanupFailed, ["machine-a"]);
});
