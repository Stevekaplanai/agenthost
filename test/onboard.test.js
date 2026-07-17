// Unit tests for `agenthost onboard`'s pure pieces: the Obsidian vault-registry
// parser (src/detect.js) and the include-proposal builder / command formatter
// (src/commands/onboard.js). Fixture-driven, no network, no real sync -- disk
// checks in the builder go through an injected statPath.
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseObsidianVaults, obsidianRegistryCandidates, detectObsidianVaults,
} from "../src/detect.js";
import {
  hookScriptRefs, buildIncludeProposals, formatSyncCommand, onboardCommand,
} from "../src/commands/onboard.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const obsidianFixture = fs.readFileSync(path.join(FIXTURES, "obsidian.json"), "utf8");
const settingsFixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, "onboard-settings.json"), "utf8"));

// ---- vault-registry parser -----------------------------------------------------

test("parseObsidianVaults reads every vault path from the registry's vaults object", () => {
  const paths = parseObsidianVaults(obsidianFixture);
  assert.deepEqual(paths, [
    "C:\\Users\\Steve\\Obsidian\\SecondBrain",
    "C:\\Users\\Steve\\Documents\\work-vault",
    "D:\\Vaults\\archive",
  ]);
});

test("parseObsidianVaults skips entries without a path instead of crashing", () => {
  // the fixture's "brokenentry" has ts but no path -- 3 of 4 survive
  assert.equal(parseObsidianVaults(obsidianFixture).length, 3);
});

test("parseObsidianVaults returns [] on malformed JSON (mid-write registry)", () => {
  assert.deepEqual(parseObsidianVaults('{"vaults": {'), []);
});

test("parseObsidianVaults returns [] when vaults is missing or the wrong shape", () => {
  assert.deepEqual(parseObsidianVaults("{}"), []);
  assert.deepEqual(parseObsidianVaults('{"vaults": null}'), []);
  assert.deepEqual(parseObsidianVaults('{"vaults": ["not-a-map"]}'), []);
});

test("obsidianRegistryCandidates: %APPDATA% first on Windows, ~/.config elsewhere", () => {
  const win = obsidianRegistryCandidates({ home: "C:\\Users\\Steve", platform: "win32", appData: "C:\\Users\\Steve\\AppData\\Roaming" });
  assert.equal(win[0], path.join("C:\\Users\\Steve\\AppData\\Roaming", "obsidian", "obsidian.json"));
  const linux = obsidianRegistryCandidates({ home: "/home/steve", platform: "linux", appData: undefined });
  assert.deepEqual(linux, [path.join("/home/steve", ".config", "obsidian", "obsidian.json")]);
  const mac = obsidianRegistryCandidates({ home: "/Users/steve", platform: "darwin", appData: undefined });
  assert.ok(mac.some((p) => p.includes(path.join("Library", "Application Support", "obsidian"))));
});

test("detectObsidianVaults reads the first existing registry; null when none", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-reg-"));
  assert.deepEqual(detectObsidianVaults({ home, platform: "linux" }), { registry: null, vaults: [] });
  const regDir = path.join(home, ".config", "obsidian");
  fs.mkdirSync(regDir, { recursive: true });
  fs.writeFileSync(path.join(regDir, "obsidian.json"), JSON.stringify({ vaults: { a: { path: path.join(home, "Vault") } } }));
  const got = detectObsidianVaults({ home, platform: "linux" });
  assert.equal(got.registry, path.join(regDir, "obsidian.json"));
  assert.deepEqual(got.vaults, [path.join(home, "Vault")]);
});

// ---- hook scan (reuses pack-lib's extractor) ------------------------------------

test("hookScriptRefs finds hook paths outside ~/.claude, deduped and home-relative", () => {
  const refs = hookScriptRefs(settingsFixture, "/home/steve");
  assert.deepEqual(refs.sort(), [
    "Projects/operator-brain/capture.py",
    "tools/lint-on-write.mjs",
  ]);
});

test("hookScriptRefs excludes paths under .claude/ (those migrate wholesale)", () => {
  const refs = hookScriptRefs(settingsFixture, "/home/steve");
  assert.ok(!refs.some((r) => r.startsWith(".claude/")));
});

test("hookScriptRefs handles Windows backslash homes and commands", () => {
  const settings = { hooks: { Stop: [{ hooks: [
    { type: "command", command: "python C:\\Users\\Steve\\Projects\\brain\\capture.py" },
    { type: "command", command: "bash C:\\Users\\Steve\\.claude\\hooks\\x.sh" },
  ] }] } };
  assert.deepEqual(hookScriptRefs(settings, "C:\\Users\\Steve"), ["Projects/brain/capture.py"]);
});

test("hookScriptRefs tolerates settings without hooks", () => {
  assert.deepEqual(hookScriptRefs({}, "/home/steve"), []);
  assert.deepEqual(hookScriptRefs({ hooks: {} }, "/home/steve"), []);
});

// ---- include-proposal builder ----------------------------------------------------

const statFrom = (map) => (abs) => map[abs] ?? null;

test("buildIncludeProposals proposes home-relative vaults and hook-script parent dirs", () => {
  const home = "/home/steve";
  const { proposals, skipped } = buildIncludeProposals({
    home,
    vaultPaths: ["/home/steve/Obsidian/SecondBrain"],
    hookRefs: ["Projects/operator-brain/capture.py"],
    statPath: statFrom({
      "/home/steve/Obsidian/SecondBrain": "dir",
      "/home/steve/Projects/operator-brain/capture.py": "file",
    }),
  });
  assert.deepEqual(proposals.map((p) => p.include), ["Obsidian/SecondBrain", "Projects/operator-brain"]);
  assert.match(proposals[0].reason, /vault/i);
  assert.match(proposals[1].reason, /hook/i);
  assert.deepEqual(skipped, []);
});

test("buildIncludeProposals skips vaults outside home with the reason (never silently)", () => {
  const { proposals, skipped } = buildIncludeProposals({
    home: "/home/steve",
    vaultPaths: ["/mnt/d/Vaults/archive"],
    statPath: statFrom({ "/mnt/d/Vaults/archive": "dir" }),
  });
  assert.deepEqual(proposals, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /outside your home directory/);
});

test("buildIncludeProposals skips registry entries missing on disk", () => {
  const { proposals, skipped } = buildIncludeProposals({
    home: "/home/steve",
    vaultPaths: ["/home/steve/Gone"],
    statPath: statFrom({}),
  });
  assert.deepEqual(proposals, []);
  assert.match(skipped[0].reason, /missing on disk/);
});

test("buildIncludeProposals: hook file directly in home proposes the file, not home", () => {
  const { proposals } = buildIncludeProposals({
    home: "/home/steve",
    hookRefs: ["capture.py"],
    statPath: statFrom({ "/home/steve/capture.py": "file" }),
  });
  assert.deepEqual(proposals.map((p) => p.include), ["capture.py"]);
});

test("buildIncludeProposals: hook path that IS a directory is proposed as-is", () => {
  const { proposals } = buildIncludeProposals({
    home: "/home/steve",
    hookRefs: ["brain-scripts"],
    statPath: statFrom({ "/home/steve/brain-scripts": "dir" }),
  });
  assert.deepEqual(proposals.map((p) => p.include), ["brain-scripts"]);
});

test("buildIncludeProposals flags hook refs missing on disk instead of proposing them", () => {
  const { proposals, skipped } = buildIncludeProposals({
    home: "/home/steve",
    hookRefs: ["Projects/gone/x.py"],
    statPath: statFrom({}),
  });
  assert.deepEqual(proposals, []);
  assert.match(skipped[0].reason, /hook/);
});

test("buildIncludeProposals dedupes: two scripts in one dir yield one include", () => {
  const { proposals } = buildIncludeProposals({
    home: "/home/steve",
    hookRefs: ["Projects/brain/a.py", "Projects/brain/b.py"],
    statPath: statFrom({
      "/home/steve/Projects/brain/a.py": "file",
      "/home/steve/Projects/brain/b.py": "file",
    }),
  });
  assert.deepEqual(proposals.map((p) => p.include), ["Projects/brain"]);
});

test("buildIncludeProposals drops a proposal nested inside another (vault covers its hook script)", () => {
  const { proposals } = buildIncludeProposals({
    home: "/home/steve",
    vaultPaths: ["/home/steve/Vault"],
    hookRefs: ["Vault/scripts/capture.py"],
    statPath: statFrom({
      "/home/steve/Vault": "dir",
      "/home/steve/Vault/scripts/capture.py": "file",
    }),
  });
  assert.deepEqual(proposals.map((p) => p.include), ["Vault"]);
});

test("buildIncludeProposals refuses a vault that IS the home directory", () => {
  const { proposals, skipped } = buildIncludeProposals({
    home: "/home/steve",
    vaultPaths: ["/home/steve"],
    statPath: statFrom({ "/home/steve": "dir" }),
  });
  assert.deepEqual(proposals, []);
  assert.match(skipped[0].reason, /entire home directory/);
});

// ---- command formatter -----------------------------------------------------------

test("formatSyncCommand emits the exact pasteable command, includes quoted", () => {
  assert.equal(
    formatSyncCommand({ app: "agenthost-steve", includes: ["Obsidian/Second Brain", "Projects/brain"] }),
    'agenthost sync --app agenthost-steve --include "Obsidian/Second Brain" --include "Projects/brain"'
  );
  assert.equal(formatSyncCommand({ app: null, includes: [] }), "agenthost sync");
});

// ---- wizard smoke test (dry-run: prints the plan, deploys nothing) ----------------

test("onboardCommand --dry-run prints the proposed command from a fabricated home", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-home-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, "Vault"), { recursive: true });
  fs.mkdirSync(path.join(home, "Projects", "brain"), { recursive: true });
  fs.writeFileSync(path.join(home, "Projects", "brain", "capture.py"), "# hook script\n");
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: `python ${path.join(home, "Projects", "brain", "capture.py")}` }] }] },
  }));
  const regDir = path.join(home, ".config", "obsidian");
  fs.mkdirSync(regDir, { recursive: true });
  fs.writeFileSync(path.join(regDir, "obsidian.json"), JSON.stringify({ vaults: { v: { path: path.join(home, "Vault"), open: true } } }));

  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const code = await onboardCommand({ "dry-run": true, app: "fixture-box" }, { home, platform: "linux" });
    assert.equal(code, 0);
  } finally {
    console.log = origLog;
  }
  const out = lines.join("\n");
  assert.match(out, /agenthost sync --app fixture-box --include "Vault" --include "Projects\/brain"/);
  assert.match(out, /\[dry-run\] plan only/);
  assert.match(out, /Obsidian registry:/);
});

test("onboardCommand fails cleanly when no Claude harness exists in the given home", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-nohar-"));
  const noop = () => {};
  const origLog = console.log, origErr = console.error;
  console.log = noop; console.error = noop;
  try {
    const code = await onboardCommand({ "dry-run": true }, { home, platform: "linux" });
    assert.equal(code, 1);
  } finally {
    console.log = origLog; console.error = origErr;
  }
});
