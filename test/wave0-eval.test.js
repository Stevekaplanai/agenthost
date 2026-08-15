import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assessWave0Tap, EXPECTED_CHECKS } from "../scripts/wave0-eval-tap.mjs";

function tap(lines, summary = {}) {
  const values = { tests: lines.length, pass: lines.length, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...summary };
  return `${lines.join("\n")}\n${Object.entries(values).map(([key, value]) => `# ${key} ${value}`).join("\n")}\n# duration_ms 10\n`;
}

test("wave0 eval inventory accepts the exact unskipped green checks", () => {
  const result = assessWave0Tap(tap(["ok 1 - alpha"]), 0, ["alpha"]);
  assert.equal(result.inventoryOk, true, result.errors.join("\n"));
  assert.equal(result.allGreen, true);
});

test("wave0 eval rejects a skipped check instead of printing PASS", () => {
  const result = assessWave0Tap(
    tap(["ok 1 - alpha # SKIP not available"], { pass: 0, skipped: 1 }),
    0,
    ["alpha"],
  );
  assert.equal(result.inventoryOk, false);
  assert.match(result.errors.join("\n"), /skip/i);
});

test("wave0 eval rejects missing, duplicate, and unexpected checks", () => {
  const result = assessWave0Tap(
    tap(["ok 1 - alpha", "ok 2 - alpha", "ok 3 - surprise"]),
    0,
    ["alpha", "beta"],
  );
  assert.equal(result.inventoryOk, false);
  assert.match(result.errors.join("\n"), /missing.*beta/i);
  assert.match(result.errors.join("\n"), /duplicate.*alpha/i);
  assert.match(result.errors.join("\n"), /unexpected.*surprise/i);
});

test("wave0 eval cannot be ALL GREEN when the runner exits nonzero", () => {
  const result = assessWave0Tap(tap(["ok 1 - alpha"]), 1, ["alpha"]);
  assert.equal(result.inventoryOk, true);
  assert.equal(result.allGreen, false);
});

test("the release inventory pins every current T0.6 check", () => {
  assert.equal(EXPECTED_CHECKS.length, 17);
  assert.equal(new Set(EXPECTED_CHECKS).size, 17);
});

test("the real report generator refuses to publish when a required check disappears", (t) => {
  const root = fs.mkdtempSync(path.join(import.meta.dirname, ".gate-wave0eval-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, "..", "scripts", "wave0-eval.mjs"), path.join(root, "scripts", "wave0-eval.mjs"));
  fs.copyFileSync(path.join(import.meta.dirname, "..", "scripts", "wave0-eval-tap.mjs"), path.join(root, "scripts", "wave0-eval-tap.mjs"));
  fs.writeFileSync(path.join(root, "test", "mode-regression.test.js"), `
    import { test } from "node:test";
    test(${JSON.stringify(EXPECTED_CHECKS[0])}, () => {});
  `);

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "wave0-eval.mjs")], { cwd: root, encoding: "utf8", env });
  assert.notEqual(run.status, 0, "a shortened suite must make the real release command fail");
  assert.match(`${run.stdout}\n${run.stderr}`, /missing expected check/i);
  assert.equal(fs.existsSync(path.join(root, "docs", "wave0-eval-report.md")), false, "no misleading report may be written");
});
