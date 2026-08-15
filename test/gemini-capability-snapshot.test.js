import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  geminiJailReadiness,
  geminiCredentialBrokerReadiness,
  geminiCapabilitySnapshot
} = require("../container/gate.js");

// The whole point of these three functions is that a "no" must carry WHY it is
// a no. The old code answered with `false` literals, which read on the wire
// exactly like a probed no -- so every test below asserts the reason string,
// not just the boolean.

const REGULAR = 0o100644;  // regular file
const SYMLINK_STAT = { mode: 0o120644, isFile: () => false, isSymbolicLink: () => true };

const statOf = (mode, { symlink = false } = {}) => () => ({
  mode,
  isFile: () => (mode & 0o170000) === 0o100000,
  isSymbolicLink: () => symlink
});
const geminiEnabled = new Set(["codex", "gemini"]);

test("jail readiness: reports no_autonomous_profile when gemini is not an exec engine", () => {
  const r = geminiJailReadiness({ execEngines: new Set(["codex"]), binPath: "/usr/local/bin/gemini", bwrapPath: "/usr/bin/bwrap", lstatSync: statOf(REGULAR) });
  assert.equal(r.ready, false);
  assert.equal(r.reason, "no_autonomous_profile");
  assert.match(r.summary, /unattended execution profile/);
});

test("jail readiness: a missing exec-engine set fails closed, never ready-by-default", () => {
  const r = geminiJailReadiness({ execEngines: null, binPath: "/usr/local/bin/gemini", bwrapPath: "/usr/bin/bwrap", lstatSync: statOf(REGULAR) });
  assert.equal(r.ready, false);
  assert.equal(r.reason, "no_autonomous_profile");
});

test("jail readiness: a missing Gemini binary is distinguishable from a missing bwrap", () => {
  const missingGemini = geminiJailReadiness({
    execEngines: geminiEnabled,
    binPath: "/usr/local/bin/gemini",
    bwrapPath: "/usr/bin/bwrap",
    lstatSync: (p) => { if (p === "/usr/local/bin/gemini") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return statOf(REGULAR)(); }
  });
  assert.equal(missingGemini.reason, "sandbox_binary_missing");
  assert.match(missingGemini.summary, /Gemini CLI/);
});

test("jail readiness: a missing bwrap binary fails closed", () => {
  const r = geminiJailReadiness({
    execEngines: geminiEnabled,
    binPath: "/usr/local/bin/gemini",
    bwrapPath: "/usr/bin/bwrap",
    lstatSync: (p) => { if (p === "/usr/bin/bwrap") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return statOf(REGULAR)(); }
  });
  assert.equal(r.ready, false);
  assert.equal(r.reason, "sandbox_binary_missing");
  assert.match(r.summary, /Bubblewrap/);
});

test("jail readiness: a Gemini binary that is a symlink is accepted", () => {
  // npm global installs are symlinks — this is the normal case, not a rejection
  const r = geminiJailReadiness({
    execEngines: geminiEnabled,
    binPath: "/usr/local/bin/gemini",
    bwrapPath: "/usr/bin/bwrap",
    lstatSync: (p) => { if (p === "/usr/local/bin/gemini") return SYMLINK_STAT; return statOf(REGULAR)(); }
  });
  assert.equal(r.ready, true);
  assert.equal(r.reason, null);
});

test("jail readiness: a Gemini binary that is neither file nor symlink is rejected", () => {
  const r = geminiJailReadiness({
    execEngines: geminiEnabled,
    binPath: "/usr/local/bin/gemini",
    bwrapPath: "/usr/bin/bwrap",
    lstatSync: (p) => { if (p === "/usr/local/bin/gemini") return { mode: 0o040644, isFile: () => false, isSymbolicLink: () => false }; return statOf(REGULAR)(); }
  });
  assert.equal(r.ready, false);
  assert.equal(r.reason, "sandbox_binary_unsafe");
});

test("jail readiness: a regular Gemini binary and regular bwrap is ready", () => {
  const r = geminiJailReadiness({ execEngines: geminiEnabled, binPath: "/usr/local/bin/gemini", bwrapPath: "/usr/bin/bwrap", lstatSync: statOf(REGULAR) });
  assert.deepEqual(r, { ready: true, reason: null, summary: "Gemini's read jail is available." });
});

test("credential broker: with no probe and no API key, fails closed", () => {
  // In the test environment, loadBoxSecrets and process.env won't have a key
  const r = geminiCredentialBrokerReadiness();
  assert.equal(r.ready, false);
  // Could be either reason depending on env, but must not be "missing" (old reason)
  assert.notEqual(r.reason, "gemini_inference_broker_missing");
});

test("credential broker: a failed or throwing inference handshake fails closed", () => {
  assert.equal(geminiCredentialBrokerReadiness({ probe: () => false }).reason, "gemini_inference_broker_unavailable");
  assert.equal(geminiCredentialBrokerReadiness({ probe: () => { throw new Error("down"); } }).reason, "gemini_inference_broker_unavailable");
});

test("credential broker: only a successful bounded inference handshake is ready", () => {
  const r = geminiCredentialBrokerReadiness({ probe: () => true });
  assert.equal(r.ready, true);
  assert.equal(r.reason, null);
});

// --- snapshot: the shape GET /api/capabilities actually returns -------------

const READY_WORKSPACE = { ready: true, summary: "Workspace verified.", artifacts: [{ id: "worktree" }] };
const readySnapshot = (over = {}) => geminiCapabilitySnapshot({
  installed: true,
  enabled: true,
  authenticated: true,
  gitLadderReady: true,
  workspace: READY_WORKSPACE,
  jail: { ready: true, reason: null, summary: "jail ok" },
  broker: { ready: true, reason: null, summary: "broker ok" },
  ...over
});

test("snapshot: every check true yields available with reasons nulled out", () => {
  const snap = readySnapshot();
  assert.equal(snap.id, "gemini");
  assert.equal(snap.available, true);
  assert.equal(snap.status, "available");
  assert.deepEqual(snap.reasons, { jail: null, credentialBroker: null });
  assert.deepEqual(snap.detail, { workspace: "Workspace verified.", jail: "jail ok", credentialBroker: "broker ok" });
  assert.deepEqual(snap.artifacts, READY_WORKSPACE.artifacts);
});

test("snapshot: unset deps default to NOT ready -- absence never reads as permission", () => {
  const snap = geminiCapabilitySnapshot({
    jail: { ready: false, reason: "no_autonomous_profile", summary: "no profile" },
    broker: { ready: false, reason: "broker_missing", summary: "no broker" }
  });
  assert.equal(snap.available, false);
  assert.equal(snap.checks.installed, false);
  assert.equal(snap.checks.enabled, false);
  assert.equal(snap.checks.authenticated, false);
  assert.equal(snap.checks.workspaceReady, false);
  assert.equal(snap.checks.gitLadderReady, false);
});

test("snapshot: non-boolean truthy inputs do not become capability", () => {
  const snap = geminiCapabilitySnapshot({
    installed: "yes", enabled: 1, authenticated: {}, gitLadderReady: "true",
    workspace: READY_WORKSPACE,
    jail: { ready: true, reason: null, summary: "jail ok" },
    broker: { ready: true, reason: null, summary: "broker ok" }
  });
  assert.equal(snap.checks.installed, false);
  assert.equal(snap.checks.enabled, false);
  assert.equal(snap.checks.authenticated, false);
  assert.equal(snap.checks.gitLadderReady, false);
  assert.equal(snap.available, false);
});

test("snapshot: the blocking probe's own sentence replaces the generic summary", () => {
  const snap = readySnapshot({ jail: { ready: false, reason: "no_autonomous_profile", summary: "Gemini has no unattended execution profile yet." } });
  assert.equal(snap.summary, "Gemini has no unattended execution profile yet.");
  assert.equal(snap.reasons.jail, "no_autonomous_profile");
  assert.deepEqual(snap.nextActions, [], "an unimplemented profile must not offer a fake repair action");
  assert.doesNotMatch(snap.summary, /sandbox is not configured/i);
});

test("snapshot: workspace blocks ahead of jail, jail ahead of broker", () => {
  const bothBad = readySnapshot({
    workspace: { ready: false, summary: "no workspace", artifacts: [] },
    jail: { ready: false, reason: "no_autonomous_profile", summary: "no jail" },
    broker: { ready: false, reason: "broker_missing", summary: "no broker" }
  });
  assert.equal(bothBad.summary, "no workspace");

  const jailBad = readySnapshot({
    jail: { ready: false, reason: "no_autonomous_profile", summary: "no jail" },
    broker: { ready: false, reason: "broker_missing", summary: "no broker" }
  });
  assert.equal(jailBad.summary, "no jail");
});

test("snapshot: an unauthenticated engine keeps the auth summary, not a downstream one", () => {
  const snap = readySnapshot({ authenticated: false, jail: { ready: false, reason: "no_autonomous_profile", summary: "no jail" } });
  assert.match(snap.summary, /not authenticated/i);
});

test("snapshot: no credential value or secret-looking field is ever emitted", () => {
  const serialized = JSON.stringify(readySnapshot({ authenticated: true }));
  for (const forbidden of ["GEMINI_API_KEY", "apiKey", "token", "secret", "password"]) {
    assert.ok(!serialized.includes(forbidden), `snapshot leaked ${forbidden}`);
  }
});