import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const root = process.cwd();

test("dashboard consumes the normalized inventory truth contract", () => {
  const source = fs.readFileSync(path.join(root, "dashboard", "lib", "agenthost-data.ts"), "utf8");
  assert.match(source, /items\?:\s*NormalizedInventoryItemish\[\]/);
  assert.match(source, /if \(Array\.isArray\(inv\.items\)\)/);
  assert.match(source, /configured:\s*item\.configured/);
  assert.match(source, /available:\s*item\.available/);
  assert.match(source, /runtimeConnected:\s*item\.runtimeConnected/);
  assert.match(source, /sources:\s*item\.sources/);
});

test("inventory cards name unknown runtime state instead of implying a connection", () => {
  const source = fs.readFileSync(path.join(root, "dashboard", "components", "agenthost", "inventory.tsx"), "utf8");
  assert.match(source, /Configured/);
  assert.match(source, /Available/);
  assert.match(source, /Runtime/);
  assert.match(source, /not verified/);
});

// Steve, 2026-08-14: the Graphify builder was reachable only from Artifacts --
// "it's just a small spot in the artifacts. Doesn't really belong there."
// Inventory is the surface that owns the harness corpus, and its header renders
// the exact flat count he objected to ("689 skills, 37 plugins, 2 MCPs"), so the
// graph belongs beside it: same corpus, with a shape instead of a number.
test("Inventory can graph its own corpus without leaving for Artifacts", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "dashboard/components/agenthost/inventory.tsx"), "utf8");
  assert.match(source, /import \{ GraphifyPanel \} from "\.\/graphify-panel"/,
    "Inventory does not import the shared Graphify panel");
  assert.match(source, /<GraphifyPanel\b/,
    "Inventory imports the panel but never mounts it -- logic present, surface unreachable");
  // No onGenerated: Inventory has no artifact list to refresh. Passing one would
  // be a coupling it does not need.
  assert.doesNotMatch(source, /<GraphifyPanel[^>]*onGenerated=/,
    "Inventory has no artifact list, so it must not ask the panel to refresh one");
});
