"use strict";

// Real-Linux PID-1 harness for the dormant Phase-1b migration step actions
// (container/maintenance-migration-actions.js): safe idempotent boot-marker
// relocation (no-follow) and legacy-untrusted labeling. Runs as root PID 1 in a
// private PID + mount namespace against a representative /data marker fixture
// derived from the real boot markers. Driven only by
// scripts/maintenance-migration-verify.sh. Wires nothing into any boot path.

import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER = path.resolve(HERE, "..", "container");

function skip(reason) { process.stdout.write(`SKIP ${reason}\n`); process.exit(0); }
if (process.getuid() !== 0) skip("harness requires root");
if (process.pid !== 1) skip("harness requires PID 1 (run under scripts/maintenance-migration-verify.sh)");

const { createMigrationActions } = require(path.join(CONTAINER, "maintenance-migration-actions.js"));

const DATA = "/data";
const TRUSTED = "/data/maintenance";
const AGENT = "/data/agent-state"; // representative relocation target root

let failures = 0, passed = 0;
function check(label, fn) {
  try { fn(); passed += 1; process.stdout.write(`  ok   ${label}\n`); }
  catch (error) { failures += 1; process.stdout.write(`  FAIL ${label}: ${error && error.message}\n`); }
}
function throwsCode(fn, code, label) {
  check(label, () => {
    let t = null; try { fn(); } catch (e) { t = e; }
    assert.ok(t, `expected throw ${code}, got success`);
    assert.equal(t.code, code, `expected ${code}, got ${t.code} (${t.message})`);
  });
}
const ids = (name) => ({ uid: Number(cp.execSync(`id -u ${name}`).toString().trim()), gid: Number(cp.execSync(`id -g ${name}`).toString().trim()) });

function mountIsolated() {
  cp.execSync(`mount -t tmpfs tmpfs ${DATA}`);
  cp.execSync(`chmod 0755 ${DATA}`);
  fs.mkdirSync(TRUSTED); fs.chmodSync(TRUSTED, 0o700);
  fs.mkdirSync(AGENT); fs.chmodSync(AGENT, 0o755); // root-owned trusted destination parent
}

const cases = {
  // Relocate real boot-marker fixtures into a root-owned target, verify
  // ownership/mode, and prove a second run is an idempotent no-op.
  relocate_markers() {
    mountIsolated();
    // Representative fixture derived from the actual boot markers.
    fs.writeFileSync(`${DATA}/.owned`, "1");
    fs.writeFileSync(`${DATA}/.starter-stack`, "{}");
    fs.mkdirSync(`${DATA}/.hermes-tools`);
    const root = ids("root");
    const entries = [
      { src: `${DATA}/.owned`, dest: `${AGENT}/owned`, uid: root.uid, gid: root.gid, mode: 0o600 },
      { src: `${DATA}/.starter-stack`, dest: `${AGENT}/starter-stack`, uid: root.uid, gid: root.gid, mode: 0o600 },
      { src: `${DATA}/.hermes-tools`, dest: `${AGENT}/hermes-tools`, uid: root.uid, gid: root.gid, mode: 0o700 },
    ];
    const actions = createMigrationActions({ labelsPath: `${TRUSTED}/labels.ndjson` });
    const action = actions.relocateMarkersAction(entries);

    const first = action();
    check("all markers were moved on the first run", () => assert.ok(first.every((r) => r.moved)));
    check("markers now exist at the destination as root with the required mode", () => {
      assert.equal(cp.execSync(`stat -c '%U %a' ${AGENT}/owned`).toString().trim(), "root 600");
      assert.equal(cp.execSync(`stat -c '%U %a' ${AGENT}/hermes-tools`).toString().trim(), "root 700");
    });
    check("sources are gone", () => {
      assert.ok(!fs.existsSync(`${DATA}/.owned`) && !fs.existsSync(`${DATA}/.hermes-tools`));
    });
    const second = action();
    check("second run is an idempotent no-op", () => assert.ok(second.every((r) => !r.moved)));
  },

  // A symlinked marker fails closed (no-follow); the link target is untouched.
  relocate_nofollow() {
    mountIsolated();
    const root = ids("root");
    fs.writeFileSync("/tmp/secret", "sensitive");
    fs.symlinkSync("/tmp/secret", `${DATA}/.owned`); // hostile symlink where a marker is expected
    const actions = createMigrationActions({ labelsPath: `${TRUSTED}/labels.ndjson` });
    const action = actions.relocateMarkersAction([{ src: `${DATA}/.owned`, dest: `${AGENT}/owned`, uid: root.uid, gid: root.gid, mode: 0o600 }]);
    throwsCode(() => action(), "SYMLINK_MARKER", "refuse to relocate a symlinked marker");
    check("the symlink target was not moved or altered", () => {
      assert.equal(fs.readFileSync("/tmp/secret", "utf8"), "sensitive");
      assert.ok(!fs.existsSync(`${AGENT}/owned`));
    });
  },

  // A destination parent that is not a root-owned directory fails closed.
  relocate_untrusted_parent() {
    mountIsolated();
    const root = ids("root");
    const agent = ids("agent");
    fs.writeFileSync(`${DATA}/.owned`, "1");
    fs.mkdirSync(`${DATA}/hostile`); fs.chownSync(`${DATA}/hostile`, agent.uid, agent.gid);
    const actions = createMigrationActions({ labelsPath: `${TRUSTED}/labels.ndjson` });
    const action = actions.relocateMarkersAction([{ src: `${DATA}/.owned`, dest: `${DATA}/hostile/owned`, uid: root.uid, gid: root.gid, mode: 0o600 }]);
    throwsCode(() => action(), "UNTRUSTED_PARENT", "refuse an agent-owned destination parent");
  },

  // Legacy files present are labeled untrusted once; re-running does not
  // duplicate labels.
  legacy_label() {
    mountIsolated();
    fs.writeFileSync(`${DATA}/autonomy.on`, "1");
    fs.writeFileSync(`${DATA}/audit.log`, "x");
    const labelsPath = `${TRUSTED}/labels.ndjson`;
    const actions = createMigrationActions({ labelsPath });
    const action = actions.labelLegacyUntrustedAction([`${DATA}/autonomy.on`, `${DATA}/audit.log`, `${DATA}/not-present`]);
    const first = action();
    check("present legacy files were labeled", () => assert.equal(first.labeled, 2));
    check("absent files are not labeled", () => {
      const lines = fs.readFileSync(labelsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(lines.every((r) => r.label === "untrusted" && r.file !== `${DATA}/not-present`));
      assert.equal(lines.length, 2);
    });
    const second = action();
    check("re-labeling is idempotent", () => {
      assert.equal(second.labeled, 0);
      assert.equal(fs.readFileSync(labelsPath, "utf8").split("\n").filter(Boolean).length, 2);
    });
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
