import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIVE_PLUGIN = path.join(ROOT, "container", "openclaw-channel-broker");
const TEXT_EXTENSIONS = new Set([".html", ".js", ".json", ".md", ".mjs", ".sh"]);
const TEXT_FILENAMES = new Set(["Dockerfile"]);

function textFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return textFiles(fullPath);
    return TEXT_EXTENSIONS.has(path.extname(entry.name)) || TEXT_FILENAMES.has(entry.name)
      ? [fullPath]
      : [];
  });
}

test("only the packaged OpenClaw channel broker is referenced", () => {
  const abandonedNames = [
    ["openclaw", "harness", "plugin.DRAFT.js"].join("-"),
    ["openclaw", "hook", "plugin.DRAFT.js"].join("-"),
    ["openclaw", "channel", "broker", "plugin.js"].join("-"),
    ["container", "openclaw-harness-adapter.js"].join("/"),
    ["test", "openclaw-hook-plugin.test.js"].join("/"),
  ];
  const matches = [];

  const files = [
    path.join(ROOT, "README.md"),
    ...["container", "docs", "scripts"].flatMap((area) => textFiles(path.join(ROOT, area))),
  ];
  // If textFiles() ever returns nothing -- a renamed directory, a changed
  // filter -- `matches` stays empty and this test passes while reading zero
  // bytes. That is not a hypothetical: test/dashboard-phone-reachability.test.js
  // did exactly this for its entire life, comparing an empty set to an empty
  // set. An empty scan is a failure, not a pass.
  assert.ok(files.length > 20, `only ${files.length} files scanned -- the walk is broken, so this test proves nothing`);
  for (const file of files) {
    const contents = fs.readFileSync(file, "utf8");
    for (const abandonedName of abandonedNames) {
      if (contents.includes(abandonedName)) {
        matches.push(`${path.relative(ROOT, file)} -> ${abandonedName}`);
      }
    }
  }

  assert.deepEqual(matches, [], "runtime and documentation must not point at removed prototypes");
  assert.equal(fs.existsSync(path.join(LIVE_PLUGIN, "index.js")), true);
  assert.equal(fs.existsSync(path.join(LIVE_PLUGIN, "openclaw.plugin.json")), true);
  assert.equal(fs.existsSync(path.join(LIVE_PLUGIN, "package.json")), true);
});
