// The generated shell owns navigation now. Parse the exact JavaScript shipped
// in its static bundle, and fail if the deleted handwritten navigation returns.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const gateSource = fs.readFileSync(path.join(root, "container", "gate.js"), "utf8");
const shellIndex = fs.readFileSync(path.join(root, "container", "dashboard-ui", "index.html"), "utf8");
const chunksDir = path.join(root, "container", "dashboard-ui", "_next", "static", "chunks");

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? jsFiles(file) : entry.name.endsWith(".js") ? [file] : [];
  });
}

test("every generated shell JavaScript chunk parses", () => {
  const chunks = jsFiles(chunksDir).sort();
  assert.ok(chunks.length > 0, "the generated shell emitted no JavaScript chunks");

  for (const file of chunks) {
    const js = fs.readFileSync(file, "utf8");
    assert.ok(js.length > 0, `${path.relative(chunksDir, file)} is empty`);
    assert.doesNotThrow(
      () => new Function(js),
      (error) => new Error(`${path.relative(chunksDir, file)} does not parse: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
});
test("the removed handwritten nav cannot be served or loaded", () => {
  const generatedJs = jsFiles(chunksDir).map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(gateSource, /const NAV_JS\s*=|const APPS_JSON\s*=/);
  assert.doesNotMatch(gateSource, /["']\/(?:agenthost-nav\.js|agenthost-appshell\.js|apps\.json)["']/);
  assert.doesNotMatch(shellIndex, /agenthost-(?:nav|appshell)\.js|\/apps\.json/);
  assert.doesNotMatch(generatedJs, /Chat tools|href:["']\/chat["']|agent-profile\.tsx/,
    "the exact shipped JavaScript must not retain a door into the retired app");
  assert.match(shellIndex, /aria-label="Primary navigation"/);
});
