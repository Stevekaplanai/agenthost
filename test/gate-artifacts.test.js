// The Artifacts surface (GET /artifacts, GET /artifacts/view) renders
// AGENT-AUTHORED documents to a logged-in human. Its two security jobs:
// (1) never let a crafted name escape ~/artifacts (same posture as /files),
// (2) never let an artifact run with Steve's session -- every rendered
// document must carry the CSP `sandbox` header (opaque origin: no cookie-
// bearing API calls, no forms), and markdown must never become raw HTML.
// These tests boot the REAL gate and attack both properties.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const require = createRequire(import.meta.url);
const { publishGraphifyRun } = require(path.join(import.meta.dirname, "..", "container", "graphify-store.js"));
const KEY = "gate-artifacts-test-key";
let box = {};

function bootGate(home, graphifyStateRoot) {
  const archiveDir = path.join(home, "gate-state", "artifact-archive");
  const child = spawn("node", [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: "/bin/true",
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      AGENTHOST_CODE_MAP_STATE_DIR: graphifyStateRoot,
      AGENTHOST_ARTIFACT_ARCHIVE_DIR: archiveDir,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = new Promise((resolve, reject) => {
    let out = "";
    const to = setTimeout(() => reject(new Error("gate did not report its port; got: " + out)), 5000);
    child.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/listening on (\d+)/);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
    child.on("exit", () => { clearTimeout(to); reject(new Error("gate exited before listening; got: " + out)); });
  });
  return { child, port, archiveDir };
}

before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateart-"));
  const graphifyStateRoot = path.join(home, ".agenthost", "graphify");
  fs.mkdirSync(path.join(home, "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(home, "gate-state"), { recursive: true });
  fs.mkdirSync(graphifyStateRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "artifacts", "launch-plan.html"),
    "<!doctype html><html><head><title>Launch Plan Q3</title></head><body><h1>Plan</h1><script>fetch('/mail/send')</script></body></html>");
  fs.writeFileSync(path.join(home, "artifacts", "calendar.md"),
    "# 30-Day Calendar\n\nDay 1: **post**\n\n<script>alert('xss-via-md')</script>\n");
  fs.writeFileSync(path.join(home, "artifacts", ".draft.html"), "<title>never listed</title>");
  fs.writeFileSync(path.join(home, "artifacts", "notes.txt"), "not an artifact type");
  // The secret the surface must never reach.
  fs.mkdirSync(path.join(home, ".agenthost"), { recursive: true });
  fs.writeFileSync(path.join(home, ".agenthost", "secrets.env"), "POSTIZ_API_KEY=supersecret");
  // A symlink INSIDE artifacts pointing at the secret -- must not resolve.
  try { fs.symlinkSync(path.join(home, ".agenthost", "secrets.env"), path.join(home, "artifacts", "leak.html")); } catch {}
  fs.mkdirSync(path.join(home, "work"), { recursive: true });

  const committed = publishGraphifyRun({
    stateRoot: graphifyStateRoot,
    artifactsRoot: path.join(home, "artifacts"),
    target: { id: "harness", label: "Agent harness", kind: "harness" },
    folder: { id: "h_all", label: "All" },
    snapshot: {
      kind: "folder",
      value: "2026-08-14T12:00:00.000Z",
      manifestSha256: "a".repeat(64),
      builtAt: "2026-08-14T12:01:00.000Z",
      derived: true,
    },
    report: "# Committed Graphify report\n",
    graphRaw: "{\"nodes\":[],\"links\":[]}",
    html: "<!doctype html><html><head><title>Committed Graphify</title></head><body>graph</body></html>",
    counts: { files: 1, inputBytes: 10, nodes: 0, links: 0 },
  });
  const orphanRunId = "f".repeat(32);
  const orphanHtml = `graphify-orphan-all-${orphanRunId}.html`;
  const orphanMarkdown = `graphify-orphan-all-${orphanRunId}.md`;
  fs.writeFileSync(path.join(home, "artifacts", orphanHtml), "<!doctype html><title>Orphan Graphify</title>");
  fs.writeFileSync(path.join(home, "artifacts", orphanMarkdown), "# Orphan Graphify\n");
  fs.writeFileSync(path.join(home, "artifacts", `graphify-orphan-all-${orphanRunId}.json`), "{\"private\":true}");

  const { child, port, archiveDir } = bootGate(home, graphifyStateRoot);
  box.home = home;
  box.graphifyStateRoot = graphifyStateRoot;
  box.committed = committed;
  box.orphanHtml = orphanHtml;
  box.orphanMarkdown = orphanMarkdown;
  box.gate = child;
  box.archiveDir = archiveDir;
  box.base = `http://127.0.0.1:${await port}`;
  box.cookie = (await mintOperatorSession(box.base, KEY)).cookie;
});

after(async () => {
  await stopChild(box.gate);
  if (box.home) fs.rmSync(box.home, { recursive: true, force: true });
});

const auth = (p) => fetch(box.base + p, { headers: { cookie: box.cookie }, redirect: "manual" });
const authPost = (p, body) => fetch(box.base + p, {
  method: "POST",
  headers: { cookie: box.cookie, origin: box.base, "content-type": "application/json" },
  body: JSON.stringify(body),
  redirect: "manual",
});
const noauth = (p) => fetch(box.base + p, { redirect: "manual" });

test("both routes require auth", async () => {
  assert.equal((await noauth("/artifacts")).status, 401);
  assert.equal((await noauth("/artifacts/view?p=launch-plan.html")).status, 401);
});

test("GET /artifacts lists html+md with extracted titles; dotfiles, symlinks and other types excluded", async () => {
  const r = await auth("/artifacts");
  assert.equal(r.status, 200);
  const { files } = await r.json();
  const names = files.map((f) => f.name).sort();
  // leak.html is a symlink; statSync follows it to a real file, but view must
  // refuse it (tested below). The list may include it only if stat succeeds --
  // assert the important exclusions instead of the exact set.
  assert.ok(names.includes("launch-plan.html"), "html listed");
  assert.ok(names.includes("calendar.md"), "md listed");
  assert.ok(names.includes(box.committed.artifacts.html.name), "committed Graphify html listed");
  assert.ok(names.includes(box.committed.artifacts.markdown.name), "committed Graphify markdown listed");
  assert.ok(!names.includes(box.orphanHtml), "Graphify html without a committed private manifest is hidden");
  assert.ok(!names.includes(box.orphanMarkdown), "Graphify markdown without a committed private manifest is hidden");
  assert.ok(!names.includes(".draft.html"), "dotfiles never listed");
  assert.ok(!names.includes("notes.txt"), "non-artifact types never listed");
  const plan = files.find((f) => f.name === "launch-plan.html");
  assert.equal(plan.title, "Launch Plan Q3", "title extracted from <title>");
  assert.equal(plan.kind, "html");
  const cal = files.find((f) => f.name === "calendar.md");
  assert.equal(cal.title, "30-Day Calendar", "title extracted from # heading");
});

test("GET /artifacts distinguishes clean pre-Graphify state from public-root failures", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateart-empty-graphify-"));
  const graphifyStateRoot = path.join(home, ".agenthost", "graphify");
  fs.mkdirSync(path.join(home, "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(home, ".agenthost"), { recursive: true });
  fs.mkdirSync(path.join(home, "gate-state"), { recursive: true });
  fs.writeFileSync(path.join(home, "artifacts", "ordinary-report.md"), "# Ordinary report\n");
  const gate = bootGate(home, graphifyStateRoot);
  t.after(async () => {
    await stopChild(gate.child);
    fs.rmSync(home, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${await gate.port}`;
  const cookie = (await mintOperatorSession(base, KEY)).cookie;

  const response = await fetch(base + "/artifacts", { headers: { cookie }, redirect: "manual" });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).files.map((file) => file.name), ["ordinary-report.md"]);
  assert.equal(fs.existsSync(graphifyStateRoot), false, "listing does not create private Graphify state");

  const orphan = `graphify-orphan-all-${"e".repeat(32)}.html`;
  fs.writeFileSync(path.join(home, "artifacts", orphan), "<!doctype html><title>Uncommitted graph</title>");
  const refused = await fetch(base + "/artifacts", { headers: { cookie }, redirect: "manual" });
  assert.equal(refused.status, 503, "a public Graphify name without private state still fails closed");
  const problem = await refused.json();
  assert.equal(problem.code, "GRAPHIFY_ARTIFACT_INTEGRITY_FAILED");
  assert.doesNotMatch(problem.error, /gateart-empty-graphify-|[A-Z]:\\/i);
  fs.rmSync(path.join(home, "artifacts", orphan));

  const artifacts = path.join(home, "artifacts");
  const offline = path.join(home, "artifacts-offline");
  fs.renameSync(artifacts, offline);
  try {
    const missing = await fetch(base + "/artifacts", { headers: { cookie }, redirect: "manual" });
    assert.equal(missing.status, 503, "an unreadable public root is not mistaken for an empty directory");
    const missingProblem = await missing.json();
    assert.equal(missingProblem.code, "GRAPHIFY_ARTIFACT_INTEGRITY_FAILED");
    assert.match(missingProblem.error, /artifacts root is unavailable \(ENOENT\)/i);
    assert.doesNotMatch(missingProblem.error, /gateart-empty-graphify-|artifacts-offline|[A-Z]:\\/i);
  } finally {
    fs.renameSync(offline, artifacts);
  }

  if (process.platform !== "win32" && (!process.getuid || process.getuid() !== 0)) {
    fs.chmodSync(artifacts, 0o000);
    try {
      const unreadable = await fetch(base + "/artifacts", { headers: { cookie }, redirect: "manual" });
      assert.equal(unreadable.status, 503, "a permission-denied public root is not treated as empty");
      const unreadableProblem = await unreadable.json();
      assert.equal(unreadableProblem.code, "GRAPHIFY_ARTIFACT_INTEGRITY_FAILED");
      assert.match(unreadableProblem.error, /artifacts root is unavailable \((?:EACCES|EPERM)\)/i);
      assert.doesNotMatch(unreadableProblem.error, /gateart-empty-graphify-|[A-Z]:\\/i);
    } finally {
      fs.chmodSync(artifacts, 0o700);
    }
  } else {
    t.diagnostic("permission-denied artifacts-root probe requires an unprivileged POSIX runner");
  }

  const audit = fs.readFileSync(path.join(home, ".claude", "agenthost", "audit.log"), "utf8");
  assert.match(audit, /"event":"graphify_artifact_integrity_failed"/);
  assert.match(audit, /Graphify artifacts root is unavailable \(ENOENT\)/);
});

test("only committed Graphify outputs can be viewed, downloaded, or included in the artifacts zip", async () => {
  for (const name of [box.committed.artifacts.html.name, box.committed.artifacts.markdown.name]) {
    const view = await auth(`/artifacts/view?p=${encodeURIComponent(name)}`);
    assert.equal(view.status, 200, `${name} viewable`);
    assert.match(view.headers.get("content-security-policy") || "", /default-src 'none'/,
      "Graphify uses the stricter self-contained artifact policy");
    assert.equal((await auth(`/artifacts/dl?p=${encodeURIComponent(name)}`)).status, 200, `${name} downloadable`);
  }
  for (const name of [box.orphanHtml, box.orphanMarkdown]) {
    assert.equal((await auth(`/artifacts/view?p=${encodeURIComponent(name)}`)).status, 404, `${name} hidden from view`);
    assert.equal((await auth(`/artifacts/dl?p=${encodeURIComponent(name)}`)).status, 404, `${name} hidden from download`);
  }
  const zip = await auth("/artifacts/zip");
  assert.equal(zip.status, 200);
  const bytes = Buffer.from(await zip.arrayBuffer()).toString("latin1");
  assert.match(bytes, new RegExp(box.committed.artifacts.html.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(bytes, new RegExp(box.committed.artifacts.markdown.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(bytes, new RegExp(box.orphanHtml.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(bytes, new RegExp(box.orphanMarkdown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(bytes, /graph\.json|\"private\":true/);
});

test("Graphify serves only descriptor-verified pair bytes and refuses split mutation workflows", async () => {
  const name = box.committed.artifacts.html.name;
  const file = path.join(box.home, "artifacts", name);
  const original = fs.readFileSync(file);
  try {
    fs.writeFileSync(file, "attacker replacement");
    const view = await auth(`/artifacts/view?p=${encodeURIComponent(name)}`);
    assert.equal(view.status, 503);
    assert.equal((await view.json()).code, "GRAPHIFY_ARTIFACT_INTEGRITY_FAILED");
    const download = await auth(`/artifacts/dl?p=${encodeURIComponent(name)}`);
    assert.equal(download.status, 503);
    assert.equal((await download.json()).code, "GRAPHIFY_ARTIFACT_INTEGRITY_FAILED");
    for (const route of ["/artifacts/view", "/artifacts/dl"]) {
      const alias = await auth(`${route}?p=${encodeURIComponent(`ignored-prefix/${name}`)}`);
      assert.equal(alias.status, 400, `${route} rejects a basename alias before Graphify classification`);
      assert.doesNotMatch(await alias.text(), /attacker replacement/);
    }
    const listed = await auth("/artifacts");
    assert.equal(listed.status, 503);
    const listedProblem = await listed.json();
    assert.equal(listedProblem.code, "GRAPHIFY_ARTIFACT_INTEGRITY_FAILED");
    assert.match(listedProblem.error, /does not match its manifest/i);
    assert.doesNotMatch(listedProblem.error, /attacker replacement|gateart-|[A-Z]:\\/i);
    const zip = await auth("/artifacts/zip");
    assert.equal(zip.status, 503);
    assert.equal((await zip.json()).code, "GRAPHIFY_ARTIFACT_INTEGRITY_FAILED");
  } finally {
    fs.writeFileSync(file, original);
  }

  for (const endpoint of ["/artifacts/review", "/artifacts/archive", "/artifacts/delete"]) {
    const response = await authPost(endpoint, { name });
    assert.equal(response.status, 409, `${endpoint} refuses one-sided Graphify mutation`);
    assert.match((await response.json()).error, /Graphify snapshot artifacts/);
  }
  for (const endpoint of ["/artifacts/archive", "/artifacts/delete"]) {
    const response = await authPost(endpoint, { name: `ignored-prefix/${name}` });
    assert.equal(response.status, 409, `${endpoint} checks the resolved artifact basename`);
    assert.match((await response.json()).error, /Graphify snapshot artifacts/);
    assert.equal(fs.existsSync(file), true, `${endpoint} must leave the committed Graphify pair intact`);
  }
  const caseAlias = name.toUpperCase();
  for (const endpoint of ["/artifacts/archive", "/artifacts/delete"]) {
    const response = await authPost(endpoint, { name: caseAlias });
    assert.equal(response.status, 409, `${endpoint} reserves case-only Graphify aliases`);
    assert.match((await response.json()).error, /Graphify snapshot artifacts/);
    assert.equal(fs.existsSync(file), true, `${endpoint} must leave the committed Graphify pair intact`);
  }
});

test("ordinary symlink aliases cannot bypass Graphify artifact verification", async (t) => {
  const target = path.join(box.home, "artifacts", box.committed.artifacts.html.name);
  const aliasName = "alias-to-graph-report.html";
  const alias = path.join(box.home, "artifacts", aliasName);
  const original = fs.readFileSync(target);
  try {
    fs.symlinkSync(target, alias, "file");
  } catch (error) {
    t.skip(`file symlink unavailable: ${error.code || error.message}`);
    return;
  }
  t.after(() => {
    fs.rmSync(alias, { force: true });
    fs.writeFileSync(target, original);
  });

  fs.writeFileSync(target, "attacker replacement through an ordinary alias");
  for (const route of ["/artifacts/view", "/artifacts/dl"]) {
    const response = await auth(`${route}?p=${encodeURIComponent(aliasName)}`);
    assert.equal(response.status, 400, `${route} rejects an ordinary alias to a reserved Graphify artifact`);
    assert.doesNotMatch(await response.text(), /attacker replacement/,
      `${route} never serves unverified Graphify bytes through the alias`);
  }
});

test("artifact archive refuses a pre-existing symlink or junction instead of moving outside its root", async (t) => {
  const artifacts = path.join(box.home, "artifacts");
  const archive = box.archiveDir;
  const outside = path.join(box.home, "outside-archive");
  const source = path.join(artifacts, "archive-boundary.md");
  fs.mkdirSync(outside);
  fs.writeFileSync(source, "# Must stay inside the broker root\n");
  try {
    fs.symlinkSync(outside, archive, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(source, { force: true });
    t.skip(`directory link unavailable: ${error.code || error.message}`);
    return;
  }
  t.after(() => {
    try { fs.unlinkSync(archive); } catch {}
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(source, { force: true });
  });

  const response = await authPost("/artifacts/archive", { name: path.basename(source) });
  assert.equal(response.status, 500);
  const result = await response.json();
  assert.match(result.error, /archive directory.*real directory inside the private gate-state root/i);
  assert.equal(fs.existsSync(source), true, "the source remains in the broker root");
  assert.equal(fs.existsSync(path.join(outside, path.basename(source))), false,
    "the gate never follows the link into the outside directory");
});

test("artifact archive moves an ordinary artifact into gate-private state", async () => {
  const source = path.join(box.home, "artifacts", "archive-success.md");
  fs.writeFileSync(source, "# Archived safely\n");
  const response = await authPost("/artifacts/archive", { name: path.basename(source) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(box.archiveDir, path.basename(source)), "utf8"), "# Archived safely\n");
});

test("an unavailable Graphify artifact root returns a caused 503 without killing the gate", async () => {
  const artifacts = path.join(box.home, "artifacts");
  const offline = path.join(box.home, "artifacts-offline");
  fs.renameSync(artifacts, offline);
  try {
    const response = await auth("/artifacts");
    assert.equal(response.status, 503);
    const problem = await response.json();
    assert.equal(problem.code, "GRAPHIFY_ARTIFACT_INTEGRITY_FAILED");
    assert.match(problem.error, /artifacts root.*unavailable|integrity check failed/i);
    assert.doesNotMatch(problem.error, /gateart-|artifacts-offline|[A-Z]:\\/i);
    for (const route of ["/artifacts/view", "/artifacts/dl"]) {
      const exact = await auth(`${route}?p=${encodeURIComponent(box.committed.artifacts.html.name)}`);
      assert.equal(exact.status, 503, `${route} names the unavailable committed root`);
      assert.equal((await exact.json()).code, "GRAPHIFY_ARTIFACT_INTEGRITY_FAILED");
    }
    const zip = await auth("/artifacts/zip");
    assert.equal(zip.status, 503);
    assert.equal((await zip.json()).code, "GRAPHIFY_ARTIFACT_INTEGRITY_FAILED");
  } finally {
    fs.renameSync(offline, artifacts);
  }
  assert.equal((await auth("/artifacts")).status, 200, "the same gate remains available after the refusal");
});

test("viewing an html artifact serves it SANDBOXED (opaque origin -- the whole security model)", async () => {
  const r = await auth("/artifacts/view?p=launch-plan.html");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/html/);
  const csp = r.headers.get("content-security-policy") || "";
  assert.match(csp, /\bsandbox\b/, "CSP sandbox header present");
  assert.ok(!csp.includes("allow-same-origin"), "sandbox must NOT allow same-origin (cookie isolation)");
  assert.ok(!csp.includes("allow-forms"), "sandbox must NOT allow forms");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.ok((await r.text()).includes("Launch Plan Q3"), "the artifact content streams through");
});

test("viewing an md artifact renders via the shell; raw md never becomes live HTML", async () => {
  const r = await auth("/artifacts/view?p=calendar.md");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy") || "", /\bsandbox\b/, "md shell is sandboxed too");
  const body = await r.text();
  assert.ok(body.includes("30-Day Calendar"), "title in the shell");
  assert.ok(!body.includes("<script>alert"), "md script tag is JSON-escaped, never raw HTML");
  assert.ok(body.includes("xss-via-md"), "the md content itself IS embedded (as data)");
});

test("traversal, symlink escape, wrong type, absolute path, dotfile all refuse", async () => {
  for (const p of [
    "../.agenthost/secrets.env",
    "..%2F.agenthost%2Fsecrets.env",
    "/etc/passwd",
    "secrets.env",          // wrong extension
    "notes.txt",            // listed dir, non-artifact type
    ".draft.html",          // dotfile
    "leak.html",            // symlink out of the root
    "",                     // empty
  ]) {
    const r = await auth("/artifacts/view?p=" + p);
    assert.ok(r.status === 400 || r.status === 404, `"${p}" must refuse, got ${r.status}`);
    const t = await r.text();
    assert.ok(!t.includes("supersecret"), `"${p}" must never leak the secret`);
  }
});
