import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  listGraphifyTargets,
  resolveGraphifyCorpus,
} = require("../container/graphify-corpora.js");

const TARGET_KEYS = ["defaultFolderId", "folders", "id", "kind", "label"];
const PLAN_KEYS = [
  "allowedBasenames",
  "extensions",
  "folder",
  "includeRoots",
  "maxDepth",
  "redactInputs",
  "snapshotKind",
  "sourceRoot",
  "target",
];
const SAFE_DYNAMIC_FOLDER_ID_RE = /^f_[a-f0-9]{24}$/;

function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-graphify-corpora-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const write = (relative, body = "fixture\n") => {
    const file = path.join(home, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };
  const dir = (relative) => {
    const target = path.join(home, ...relative.split("/"));
    fs.mkdirSync(target, { recursive: true });
    return target;
  };

  write(".claude/skills/agenthost-box/SKILL.md", "# AgentHost box\n");
  write(".claude/skills/agenthost-box/references/runtime.md", "# Runtime\n");
  write(".claude/plugins/installed_plugins.json", '{"plugins":["fixture"]}\n');
  write(".claude/plugins/fixture/plugin.json", '{"name":"fixture"}\n');
  write(".claude/plugins/cache/never-index/session.json", '{"token":"never"}\n');
  write(".claude/mcp.json", '{"mcpServers":{"fixture":{"command":"npx"}}}\n');
  write(".claude/settings.json", '{"mcpServers":{"fixture":{}}}\n');
  write(".codex/auth.json", '{"access_token":"never"}\n');
  write(".codex/config.toml", '[mcp_servers.fixture]\ncommand="npx"\n');

  write("OneDrive/Documents/Obsidian Vault/README.md", "# Vault\n");
  write("OneDrive/Documents/Obsidian Vault/Projects/Alpha/note.md", "# Alpha\n");
  write("OneDrive/Documents/Obsidian Vault/Projects/Alpha/third/deep.md", "# Deep\n");
  write("OneDrive/Documents/Obsidian Vault/Clients/Beta.md", "# Beta\n");

  write("work/agenthost-internal/README.md", "# AgentHost\n");
  write("work/agenthost-internal/src/components/app.js", "export const app = true;\n");
  write("work/agenthost-internal/docs/guide.md", "# Guide\n");
  write("work/not-configured/README.md", "# Invisible\n");

  write("corpora/clients/acme/briefs/offer.md", "# Offer\n");

  const corpora = options.corpora ?? [
    { id: "acme", label: "Acme client", path: "clients/acme" },
  ];
  const ctx = {
    homeDir: home,
    reposEnv: options.reposEnv ?? "Stevekaplanai/agenthost-internal",
    corporaJson: JSON.stringify(corpora),
  };
  return { home, write, dir, ctx };
}

function targetById(targets, id) {
  const target = targets.find((entry) => entry.id === id);
  assert.ok(target, `missing target ${id}`);
  return target;
}

function folderByLabel(target, label) {
  const folder = target.folders.find((entry) => entry.label === label);
  assert.ok(folder, `missing ${target.id} folder ${label}`);
  return folder;
}

function assertBrowserTarget(target, home) {
  assert.deepEqual(Object.keys(target).sort(), TARGET_KEYS);
  assert.equal(typeof target.id, "string");
  assert.equal(typeof target.label, "string");
  assert.equal(typeof target.kind, "string");
  assert.ok(Array.isArray(target.folders));
  assert.ok(target.folders.length > 0);
  assert.ok(target.folders.some((folder) => folder.id === target.defaultFolderId));
  assert.equal(JSON.stringify(target).includes(home), false, "browser target leaked HOME");
  for (const folder of target.folders) {
    assert.deepEqual(Object.keys(folder).sort(), ["id", "label"]);
    assert.equal(/[\\/]/.test(folder.id), false, "folder id exposed a path separator");
    assert.equal(folder.id.includes(".."), false);
    assert.equal(folder.label.includes(home), false, "folder label exposed HOME");
  }
}

function assertCorpusPlan(plan) {
  assert.deepEqual(Object.keys(plan).sort(), PLAN_KEYS);
  assert.deepEqual(Object.keys(plan.target).sort(), ["id", "kind", "label"]);
  assert.deepEqual(Object.keys(plan.folder).sort(), ["id", "label"]);
  assert.equal(path.isAbsolute(plan.sourceRoot), true);
  assert.ok(Array.isArray(plan.includeRoots) && plan.includeRoots.length > 0);
  for (const relative of plan.includeRoots) {
    assert.equal(typeof relative, "string");
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative.includes("\\"), false);
    assert.equal(relative === ".." || relative.startsWith("../"), false);
  }
  assert.ok(Array.isArray(plan.extensions));
  assert.ok(Array.isArray(plan.allowedBasenames));
  assert.equal(Number.isSafeInteger(plan.maxDepth), true);
  assert.equal(typeof plan.redactInputs, "boolean");
  assert.match(plan.snapshotKind, /^(?:git|folder)$/);
}

test("lists harness, vault, configured repo, and named corpus without browser-visible paths", (t) => {
  const { home, ctx } = fixture(t);
  const targets = listGraphifyTargets(ctx);

  assert.deepEqual(targets.map((target) => target.id), [
    "harness",
    "vault",
    "repo:Stevekaplanai/agenthost-internal",
    "folder:acme",
  ]);
  targets.forEach((target) => assertBrowserTarget(target, home));

  const harness = targetById(targets, "harness");
  assert.deepEqual(harness.folders.map((folder) => folder.label), [
    "All",
    "Skills",
    "Plugins",
    "MCP configs",
  ]);

  for (const target of [
    targetById(targets, "vault"),
    targetById(targets, "repo:Stevekaplanai/agenthost-internal"),
  ]) {
    assert.equal(target.folders[0].label, "All");
    assert.ok(target.folders.every((folder) => SAFE_DYNAMIC_FOLDER_ID_RE.test(folder.id)));
  }
  const repo = targetById(targets, "repo:Stevekaplanai/agenthost-internal");
  assert.ok(repo.folders.some((folder) => folder.label === "src"));
  assert.ok(repo.folders.some((folder) => folder.label === "src — components"));
  assert.equal(repo.folders.some((folder) => /third|deep/.test(folder.label)), false);

  const serialized = JSON.stringify(targets);
  for (const forbidden of [home, "sourceRoot", "includeRoots", "clients/acme", "src/components"]) {
    assert.equal(serialized.includes(forbidden), false, `browser response leaked ${forbidden}`);
  }
});

test("all corpus kinds resolve through the same private plan shape", (t) => {
  const { home, ctx } = fixture(t);
  const targets = listGraphifyTargets(ctx);
  const cases = [
    ["harness", "All"],
    ["vault", "Projects — Alpha"],
    ["repo:Stevekaplanai/agenthost-internal", "src — components"],
    ["folder:acme", "All"],
  ];

  const plans = cases.map(([targetId, label]) => {
    const target = targetById(targets, targetId);
    const folder = folderByLabel(target, label);
    const plan = resolveGraphifyCorpus(ctx, { targetId, folderId: folder.id });
    assertCorpusPlan(plan);
    assert.deepEqual(plan.target, { id: target.id, label: target.label, kind: target.kind });
    assert.deepEqual(plan.folder, folder);
    return plan;
  });

  assert.equal(plans[0].sourceRoot, home);
  assert.equal(plans[1].sourceRoot, path.join(home, "OneDrive", "Documents", "Obsidian Vault"));
  assert.deepEqual(plans[1].includeRoots, ["Projects/Alpha"]);
  assert.equal(plans[2].sourceRoot, path.join(home, "work", "agenthost-internal"));
  assert.deepEqual(plans[2].includeRoots, ["src/components"]);
  assert.equal(plans[2].snapshotKind, "git");
  assert.equal(plans[3].sourceRoot, path.join(home, "corpora", "clients", "acme"));
  assert.deepEqual(plans[3].includeRoots, ["."]);
});

test("harness plans expose only configured structure roots and never credential, session, or cache files", (t) => {
  const { ctx } = fixture(t);
  const harness = targetById(listGraphifyTargets(ctx), "harness");
  const planFor = (label) => resolveGraphifyCorpus(ctx, {
    targetId: harness.id,
    folderId: folderByLabel(harness, label).id,
  });

  const skills = planFor("Skills");
  assert.ok(skills.includeRoots.includes(".claude/skills"));
  assert.ok(skills.allowedBasenames.includes("SKILL.md"));

  const plugins = planFor("Plugins");
  assert.ok(plugins.includeRoots.some((relative) => relative.startsWith(".claude/plugins")));
  assert.ok(plugins.allowedBasenames.includes("plugin.json"));

  const mcp = planFor("MCP configs");
  assert.ok(mcp.includeRoots.includes(".claude/mcp.json"));
  assert.ok(mcp.includeRoots.includes(".claude/settings.json"));
  assert.equal(mcp.includeRoots.some((relative) => relative.includes("auth.json")), false);
  assert.equal(mcp.includeRoots.some((relative) => relative.includes("config.toml")), false);

  const all = planFor("All");
  assert.equal(all.redactInputs, true);
  for (const relative of all.includeRoots) {
    assert.equal(/(?:^|\/)(?:cache|sessions?|history|logs?)(?:\/|$)/i.test(relative), false, relative);
    assert.equal(/(?:auth\.json|\.credentials\.json|config\.toml)$/i.test(relative), false, relative);
  }
});

test("folder ids are recomputed from the live directory tree; raw, absolute, and tampered ids fail", (t) => {
  const { ctx } = fixture(t);
  const targets = listGraphifyTargets(ctx);
  const repo = targetById(targets, "repo:Stevekaplanai/agenthost-internal");
  const src = folderByLabel(repo, "src");

  const tamperedId = `${src.id.slice(0, -1)}${src.id.endsWith("0") ? "1" : "0"}`;
  for (const folderId of ["src", "src/components", "C:\\private", tamperedId]) {
    assert.throws(
      () => resolveGraphifyCorpus(ctx, { targetId: repo.id, folderId }),
      /folder (?:id is invalid|choice is unavailable)/i,
    );
  }
  assert.throws(
    () => resolveGraphifyCorpus(ctx, { targetId: "C:\\private", folderId: src.id }),
    /target id is invalid/i,
  );
  assert.throws(
    () => resolveGraphifyCorpus(ctx, { targetId: "repo:Stevekaplanai/not-configured", folderId: src.id }),
    /target .*not configured/i,
  );
});

test("configured repositories are restricted to REPOS and ambiguous basenames fail closed", (t) => {
  const first = fixture(t);
  let targets = listGraphifyTargets(first.ctx);
  assert.equal(targets.some((target) => target.id === "repo:Stevekaplanai/not-configured"), false);

  const ambiguousHome = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-graphify-ambiguous-"));
  t.after(() => fs.rmSync(ambiguousHome, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ambiguousHome, "work", "shared"), { recursive: true });
  const ambiguousCtx = {
    homeDir: ambiguousHome,
    reposEnv: "one/shared,two/shared",
    corporaJson: "[]",
  };
  targets = listGraphifyTargets(ambiguousCtx);
  assert.equal(targets.some((target) => target.id.startsWith("repo:")), false);
  assert.throws(
    () => resolveGraphifyCorpus(ambiguousCtx, { targetId: "repo:one/shared", folderId: "f_000000000000000000000000" }),
    /ambiguous local folder name/i,
  );

  const dotBasenameCtx = { ...first.ctx, reposEnv: "one/." };
  assert.equal(listGraphifyTargets(dotBasenameCtx).some((target) => target.id.startsWith("repo:")), false);
  assert.throws(
    () => resolveGraphifyCorpus(dotBasenameCtx, { targetId: "repo:one/.", folderId: "f_000000000000000000000000" }),
    /target id is invalid/i,
  );
});

test("operator corpus config accepts only safe relative paths beneath HOME/corpora", (t) => {
  const { ctx } = fixture(t);
  const named = targetById(listGraphifyTargets(ctx), "folder:acme");
  const plan = resolveGraphifyCorpus(ctx, { targetId: named.id, folderId: named.defaultFolderId });
  assert.match(plan.sourceRoot, new RegExp(`${path.sep === "\\" ? "\\\\" : "/"}corpora${path.sep === "\\" ? "\\\\" : "/"}clients`));

  for (const badPath of ["../outside", "C:\\outside", "/outside", "clients/*", "clients/[a]"]) {
    const bad = { ...ctx, corporaJson: JSON.stringify([{ id: "bad", label: "Bad", path: badPath }]) };
    assert.throws(() => listGraphifyTargets(bad), /configured corpus 1 has an unsafe relative path/i);
  }
  assert.throws(
    () => listGraphifyTargets({ ...ctx, corporaJson: "not-json" }),
    /configured corpus JSON is invalid/i,
  );
  assert.throws(
    () => listGraphifyTargets({ ...ctx, corporaJson: JSON.stringify([{ id: "bad", label: "Bad/path", path: "clients/acme" }]) }),
    /configured corpus 1 has an unsafe label/i,
  );
});

test("symlinked roots and selected folders fail closed", (t) => {
  const { home, ctx, dir } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-graphify-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  const linkedHome = path.join(outside, "home-link");
  fs.symlinkSync(home, linkedHome, "junction");
  assert.throws(
    () => listGraphifyTargets({ ...ctx, homeDir: linkedHome }),
    /HOME must be a real non-symlink directory/i,
  );

  const repo = targetById(listGraphifyTargets(ctx), "repo:Stevekaplanai/agenthost-internal");
  const docs = folderByLabel(repo, "docs");
  const docsPath = path.join(home, "work", "agenthost-internal", "docs");
  fs.rmSync(docsPath, { recursive: true });
  fs.symlinkSync(dir("replacement-docs"), docsPath, "junction");
  assert.throws(
    () => resolveGraphifyCorpus(ctx, { targetId: repo.id, folderId: docs.id }),
    /folder choice is unavailable/i,
  );

  const realRepo = path.join(home, "work", "agenthost-internal");
  fs.rmSync(realRepo, { recursive: true, force: true });
  fs.symlinkSync(dir("replacement-repo"), realRepo, "junction");
  assert.equal(
    listGraphifyTargets(ctx).some((target) => target.id === repo.id),
    false,
  );
  assert.throws(
    () => resolveGraphifyCorpus(ctx, { targetId: repo.id, folderId: repo.defaultFolderId }),
    /source root must be a real non-symlink directory/i,
  );
});

test("an unknown or unavailable target reports its own safe cause", (t) => {
  const { ctx } = fixture(t);
  assert.throws(
    () => resolveGraphifyCorpus(ctx, {
      targetId: "folder:missing",
      folderId: "f_000000000000000000000000",
    }),
    /Graphify target "folder:missing" is not configured/,
  );

  const missingVaultCtx = { ...ctx, homeDir: fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-no-vault-")) };
  t.after(() => fs.rmSync(missingVaultCtx.homeDir, { recursive: true, force: true }));
  assert.throws(
    () => resolveGraphifyCorpus(missingVaultCtx, {
      targetId: "vault",
      folderId: "f_000000000000000000000000",
    }),
    /Graphify target "vault" is unavailable: source root/i,
  );
});

// A folder that cannot be graphed must never be OFFERED. Harness include roots
// are discovered from what is actually on the box, so a box with no skills, no
// plugins, no MCP configs and no harness docs produces empty arrays -- and the
// picker listed them anyway. Choosing one reached the corpus validator and came
// back as "Graphify corpus include roots are invalid": a true statement about
// the data and a useless one for the operator, who reads it as "your request
// was malformed" when the real condition is "there is nothing of that kind
// here". Live 2026-08-15, from Steve's phone, picking Agent harness / All.
test("a box with no harness files does not offer an unmappable harness folder", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-graphify-empty-harness-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // A real vault so SOME target still resolves; the harness side stays bare.
  fs.mkdirSync(path.join(home, "OneDrive", "Documents", "Obsidian Vault"), { recursive: true });
  fs.writeFileSync(path.join(home, "OneDrive", "Documents", "Obsidian Vault", "note.md"), "# note\n");

  const targets = listGraphifyTargets({ homeDir: home, reposEnv: "", corporaJson: "" });
  const harness = targets.find((target) => target.id === "harness");

  assert.equal(harness, undefined,
    "an empty harness must not appear as a selectable target at all");
  // Whatever IS offered must be usable: every folder on every target needs a
  // browser id, and none may be a dead choice that fails on selection.
  for (const target of targets) {
    assert.ok(target.folders.length > 0, `${target.id} must not be offered with zero folders`);
    assert.ok(target.defaultFolderId, `${target.id} must name a default folder`);
  }
});

// The OTHER end of the same defect, and the one that actually bit. A
// well-stocked box overflows the 160-root cap, and "All" -- the union of every
// group -- overflows first. Steve's box: 333 skills, real plugins, All resolved
// to 168. He was told "include roots are invalid" and reasonably concluded his
// harness had never reached the box. It had. The tool called a correct setup
// invalid, which is worse than failing, because it sends the operator to fix
// something that was never broken.
test("a harness folder too broad to graph is not offered either", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-graphify-wide-harness-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // The collector truncates a single group at 160, so no ONE group can exceed
  // the cap -- only the union can, which is exactly the shape that bit Steve:
  // plugins at the ceiling plus skills, MCP configs and docs pushed "All" to
  // 168. Build it the same way rather than a shape that cannot occur.
  for (let index = 0; index < 200; index += 1) {
    const dir = path.join(home, ".claude", "plugins", `plugin-${String(index).padStart(3, "0")}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), "# fixture");
  }
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "skills", "SKILL.md"), "# one");
  fs.writeFileSync(path.join(home, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  fs.writeFileSync(path.join(home, "CLAUDE.md"), "# harness");
  fs.writeFileSync(path.join(home, "AGENTS.md"), "# agents");

  const targets = listGraphifyTargets({ homeDir: home, reposEnv: "", corporaJson: "" });
  const harness = targets.find((target) => target.id === "harness");
  assert.ok(harness, "a harness with usable narrower folders must still be offered");

  const offered = harness.folders.map((folder) => folder.id);
  assert.ok(!offered.includes("h_all"),
    "All is the union of every group, so it overflows the cap first — and it can only fail if offered");
  assert.ok(offered.length > 0,
    "the narrower folders still map fine and must remain selectable");
  assert.equal(harness.defaultFolderId, offered[0],
    "the default must be a folder that can actually be graphed");
});
