import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlags } from "../src/argv.js";

test("parseFlags reads simple string flags", () => {
  const out = parseFlags(["--app", "myapp", "--region", "iad"]);
  assert.equal(out.app, "myapp");
  assert.equal(out.region, "iad");
});

test("parseFlags treats boolean-listed flags as switches, not value-consumers", () => {
  const out = parseFlags(["--dry-run", "--app", "myapp"], { boolean: ["dry-run"] });
  assert.equal(out["dry-run"], true);
  assert.equal(out.app, "myapp");
});

test("parseFlags accumulates array-listed flags across repeats", () => {
  const out = parseFlags(["--env", "a:K=1", "--env", "b:K=2"], { array: ["env"] });
  assert.deepEqual(out.env, ["a:K=1", "b:K=2"]);
});

test("parseFlags collects bare positionals separately from flags", () => {
  const out = parseFlags(["deploy", "--app", "x"]);
  assert.deepEqual(out._, ["deploy"]);
  assert.equal(out.app, "x");
});
