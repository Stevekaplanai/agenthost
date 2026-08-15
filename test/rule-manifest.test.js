// The Rule Constitution's R0/R6 lint: every rule in container/rule-manifest.json
// must point at real, present enforcement code and a real, present red test —
// or carry an explicit acknowledgedGap. If someone unwires a rail (renames the
// function, deletes the test), the matching marker vanishes and THIS test goes
// red. That is the whole point: a rule that fails this lint does not exist.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "container", "rule-manifest.json"), "utf8"));

test("rule manifest: every rule is enforced-and-red-tested, or carries an explicit acknowledged gap", () => {
  assert.ok(Array.isArray(manifest.rules) && manifest.rules.length >= 1, "manifest has rules");
  const ids = new Set();
  for (const r of manifest.rules) {
    assert.ok(r.id && r.rule && r.source, "rule entries need id, rule, source: " + JSON.stringify(r).slice(0, 80));
    assert.ok(!ids.has(r.id), "duplicate rule id (Constitution R2 — one rule per intent): " + r.id);
    ids.add(r.id);
    const gap = typeof r.acknowledgedGap === "string" && r.acknowledgedGap.trim().length > 20;
    if (r.enforcedBy) {
      const src = fs.readFileSync(path.join(root, r.enforcedBy.file), "utf8");
      assert.ok(src.includes(r.enforcedBy.mustContain),
        r.id + ": enforcement marker missing from " + r.enforcedBy.file + " — the rail was unwired or renamed without updating the manifest");
    }
    if (r.redTest) {
      const src = fs.readFileSync(path.join(root, r.redTest.file), "utf8");
      assert.ok(src.includes(r.redTest.mustContain),
        r.id + ": red-test marker missing from " + r.redTest.file + " — the rule lost the test that goes red when it is bypassed");
    }
    // R0: constraint + enforcement + red test — or a named, visible debt.
    assert.ok((r.enforcedBy && r.redTest) || gap,
      r.id + ": has neither (enforcedBy + redTest) nor a substantive acknowledgedGap — that is theatre (Constitution R0)");
  }
});
