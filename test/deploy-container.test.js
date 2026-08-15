import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { stageDeployFiles, cleanupDeployFiles } from "../src/deploy-container.js";

function fixtureContainerDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-container-"));
  fs.writeFileSync(path.join(dir, "fly.toml"), 'app = "AGENTHOST_APP_NAME"\n\n[build]\n  dockerfile = "Dockerfile"\n');
  fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM node:22-bookworm-slim\n");
  return dir;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("stageDeployFiles stamps the app name into fly.toml.deploy and points it at Dockerfile.deploy", () => {
  const dir = fixtureContainerDir();
  const staged = stageDeployFiles({ containerDir: dir, app: "my-cool-app" });
  const toml = fs.readFileSync(staged.flyTomlDeploy, "utf8");
  assert.match(toml, /app = "my-cool-app"/);
  assert.match(toml, /dockerfile = "Dockerfile\.deploy"/);
  assert.equal(staged.harnessAttached, false);
  cleanupDeployFiles(staged);
});

test("stageDeployFiles bakes the harness tarball in as an image layer when one is given", () => {
  const dir = fixtureContainerDir();
  const tarball = path.join(dir, "harness-src.tar.gz");
  const bytes = "fake tar bytes";
  fs.writeFileSync(tarball, bytes);
  const staged = stageDeployFiles({
    containerDir: dir,
    app: "my-cool-app",
    harnessTarball: tarball,
    harnessSha256: sha256(bytes),
  });
  const dockerfile = fs.readFileSync(staged.dockerfileDeploy, "utf8");
  assert.match(dockerfile, /COPY harness\.tar\.gz \/opt\/agenthost\/harness\.tar\.gz/);
  assert.match(
    dockerfile,
    new RegExp(`RUN echo "${sha256(bytes)}  /opt/agenthost/harness\\.tar\\.gz" \\| sha256sum -c -`),
  );
  assert.equal(staged.harnessAttached, true);
  assert.ok(fs.existsSync(staged.harnessCopy));
  assert.deepEqual(
    fs.readdirSync(staged.buildContextDir).filter((name) => /^harness.*\.tar\.gz$/i.test(name)),
    ["harness.tar.gz"],
    "stale/source harness archives are excluded from the isolated build context",
  );
  cleanupDeployFiles(staged);
  assert.ok(!fs.existsSync(staged.harnessCopy));
});

test("stageDeployFiles rejects and removes a harness copy that does not match the audited hash", () => {
  const dir = fixtureContainerDir();
  const tarball = path.join(dir, "harness-src.tar.gz");
  fs.writeFileSync(tarball, "changed bytes");
  assert.throws(
    () => stageDeployFiles({
      containerDir: dir,
      app: "my-cool-app",
      harnessTarball: tarball,
      harnessSha256: sha256("audited bytes"),
    }),
    /does not match its audited SHA-256/i,
  );
  assert.deepEqual(fs.readdirSync(dir).sort(), ["Dockerfile", "fly.toml", "harness-src.tar.gz"]);
});

test("concurrent deploy staging uses isolated filenames and cleanup cannot delete another run", () => {
  const dir = fixtureContainerDir();
  const tarballA = path.join(dir, "harness-a.tar.gz");
  const tarballB = path.join(dir, "harness-b.tar.gz");
  fs.writeFileSync(tarballA, "harness a");
  fs.writeFileSync(tarballB, "harness b");
  const stagedA = stageDeployFiles({
    containerDir: dir,
    app: "app-a",
    harnessTarball: tarballA,
    harnessSha256: sha256("harness a"),
  });
  const stagedB = stageDeployFiles({
    containerDir: dir,
    app: "app-b",
    harnessTarball: tarballB,
    harnessSha256: sha256("harness b"),
  });
  assert.notEqual(stagedA.flyTomlDeploy, stagedB.flyTomlDeploy);
  assert.notEqual(stagedA.dockerfileDeploy, stagedB.dockerfileDeploy);
  assert.notEqual(stagedA.harnessCopy, stagedB.harnessCopy);
  assert.notEqual(stagedA.buildContextDir, stagedB.buildContextDir);
  cleanupDeployFiles(stagedA);
  assert.ok(fs.existsSync(stagedB.flyTomlDeploy));
  assert.ok(fs.existsSync(stagedB.dockerfileDeploy));
  assert.ok(fs.existsSync(stagedB.harnessCopy));
  cleanupDeployFiles(stagedB);
});

test("stageDeployFiles skips the COPY line when no tarball is given (shell-only box)", () => {
  const dir = fixtureContainerDir();
  const staged = stageDeployFiles({ containerDir: dir, app: "my-cool-app" });
  const dockerfile = fs.readFileSync(staged.dockerfileDeploy, "utf8");
  assert.doesNotMatch(dockerfile, /COPY harness\.tar\.gz/);
  cleanupDeployFiles(staged);
});

test("cleanupDeployFiles removes every staged file", () => {
  const dir = fixtureContainerDir();
  const staged = stageDeployFiles({ containerDir: dir, app: "my-cool-app" });
  cleanupDeployFiles(staged);
  assert.ok(!fs.existsSync(staged.flyTomlDeploy));
  assert.ok(!fs.existsSync(staged.dockerfileDeploy));
});

test("cleanupDeployFiles refuses recursive deletion outside its owned temp context", () => {
  const dir = fixtureContainerDir();
  assert.throws(
    () => cleanupDeployFiles({ buildContextRoot: dir }),
    /refusing to remove unowned deploy context/i,
  );
  assert.ok(fs.existsSync(dir), "the unowned directory remains untouched");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("stageDeployFiles removes its temp root when copying the container fails", () => {
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-broken-container-"));
  const before = new Set(
    fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("agenthost-deploy-")),
  );
  assert.throws(
    () => stageDeployFiles({ containerDir: broken, app: "broken-app" }),
    /fly\.toml|ENOENT/i,
  );
  const after = new Set(
    fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("agenthost-deploy-")),
  );
  assert.deepEqual(after, before, "failed staging leaves no agenthost-deploy temp root");
  fs.rmSync(broken, { recursive: true, force: true });
});

// Guard against the "gate.js needs a file the image never COPYs" trap. Two ways
// this bit us: (1) a runtime HTML read in gate.js had no matching COPY line,
// so its route 404'd; (2) chains-lib.js was require()'d at gate.js's top level
// but had no COPY line, so a clean image build would 502 the WHOLE box at boot
// (Cannot find module './chains-lib.js'). The unit + UI tests can't catch either
// -- they read the source files directly, never the built image. This test
// cross-checks BOTH the readFileSync assets AND the local require()s against the
// Dockerfile's COPY list. A missing require is worse than a missing asset: an
// asset 404s one route, a missing require crashes the gate before it can listen.
test("every ASSET_DIR file gate.js reads AND every local module it require()s is COPY'd into the image", () => {
  const root = path.join(import.meta.dirname, "..", "container");
  const gate = fs.readFileSync(path.join(root, "gate.js"), "utf8");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

  const needed = new Set();
  let m;

  // (a) Filenames from readFileSync(path.join(ASSET_DIR, "<name>"[, ...])) calls.
  // gate.js reads the icons dir per-file (icons/icon-192.png); the Dockerfile
  // COPYs the dir ("icons/"). Normalize both to "icons" so they match.
  const are = /readFileSync\(path\.join\(ASSET_DIR,\s*"([^"]+)"/g;
  while ((m = are.exec(gate)) !== null) needed.add(m[1].startsWith("icons/") ? "icons" : m[1]);

  // (b) Local modules require()'d by relative path -- require("./x.js"). These
  // must be COPY'd or the gate crashes at module load (chains-lib.js incident).
  // Bare/absolute/node-builtin requires are skipped (only "./"-relative match).
  //
  // Walked TRANSITIVELY, because a module gate.js never names directly still
  // crashes it exactly the same way: measurement-lib.js require()s
  // measurement-credentials.js, and measurement-adapters/index.js require()s
  // meta-ads.js. A one-level scan sees neither, so a missing COPY for either
  // would have passed this test and then thrown "Cannot find module" at boot --
  // the precise failure this guard exists to prevent, one hop out of its reach.
  const localRequires = (src) => {
    const out = [];
    const re = /require\(\s*"(\.\/[^"]+)"\s*\)/g;
    let r;
    while ((r = re.exec(src)) !== null) out.push(r[1]);
    return out;
  };
  const queue = [{ from: "gate.js", src: gate }];
  const walked = new Set(["gate.js"]);
  while (queue.length) {
    const { from, src } = queue.shift();
    for (const spec of localRequires(src)) {
      // Resolve against the REQUIRING file's directory, not the container root,
      // or a nested module's siblings resolve to the wrong path.
      const rel = path.posix.join(path.posix.dirname(from), spec.replace(/^\.\//, ""));
      if (walked.has(rel)) continue;
      walked.add(rel);
      needed.add(rel);
      const abs = path.join(root, rel);
      if (fs.existsSync(abs)) queue.push({ from: rel, src: fs.readFileSync(abs, "utf8") });
    }
  }

  assert.ok(!needed.has("cc.html"), "the generated shell cutover must not retain the handwritten console reader");
  assert.ok(needed.has("chains-lib.js"), "sanity: gate.js require()s chains-lib.js (regen this test if the require was removed)");
  assert.ok(needed.has("run-ledger.js"), "sanity: gate.js require()s the durable run ledger");

  const copied = new Set();
  // Skip COPY flags (--chown=..., --from=...) so a flagged COPY line still
  // registers its source filename — the maintenance modules ship --chown=root:root
  // and were invisible to the old matcher.
  // A trailing slash means the line COPYs a DIRECTORY, which really does carry
  // everything under it -- so "COPY measurement-adapters/" satisfies a require
  // of "measurement-adapters/index.js". Recorded separately rather than
  // stripped, because treating a dir COPY as a file name made the two never
  // match and reported a file that was, in fact, already in the image.
  const copiedDirs = [];
  const cre = /^COPY\s+(?:--\S+\s+)*(\S+)\s/gm;
  while ((m = cre.exec(dockerfile)) !== null) {
    if (m[1].endsWith("/")) copiedDirs.push(m[1]);
    copied.add(m[1].replace(/\/$/, ""));
  }

  const missing = [...needed].filter((f) => !copied.has(f) && !copiedDirs.some((d) => f.startsWith(d)));
  assert.deepEqual(missing, [], `Dockerfile is missing COPY line(s) for file(s) gate.js needs at runtime: ${missing.join(", ")}`);
});

// Product-promise guard: a later container feature must not accidentally put
// chat ownership back on the phone socket. This happened when a newer deploy
// line omitted the durable-chat change even though its focused tests had passed
// elsewhere. Static markers complement the behavioral disconnect suite: this
// fails during the ordinary deploy test run if the durable store, reconnect UI,
// restart reconciliation, or persist-before-execute boundary disappears.
test("the deploy source retains phone-independent durable chat capabilities", () => {
  const root = path.join(import.meta.dirname, "..", "container");
  const gate = fs.readFileSync(path.join(root, "gate.js"), "utf8");
  const live = fs.readFileSync(path.join(import.meta.dirname, "..", "dashboard", "lib", "live.ts"), "utf8");
  const api = fs.readFileSync(path.join(import.meta.dirname, "..", "dashboard", "lib", "api.ts"), "utf8");

  assert.match(gate, /const CHAT_RUNS_DIR\s*=/, "gate must keep a box-owned chat run store");
  assert.match(gate, /run\.subscribers\.delete\(res\)/, "closing a phone connection must only detach that subscriber");
  assert.match(gate, /const accepted = ledgerAccept\(chatLedgerSpec\(meta\)\);/, "a chat run must enter the universal ledger before any agent starts");
  assert.match(gate, /if \(!persistChatRunMeta\(run\)\) \{/, "the replay transcript must also persist before any agent starts");
  assert.match(gate, /restoreDurableChatRuns\(\);/, "gateway boot must reconcile interrupted chat runs");
  assert.match(gate, /\/chat\/runs/, "gate must expose durable run observation and cancel routes");
  assert.match(api, /getJson\("\/chat\/runs"\)/, "the phone must observe box-owned runs after a reload");
  assert.match(live, /usePolled\(fetchChatRuns, 3000\)/, "the generated thread must keep reattaching to box-owned runs");
  assert.match(live, /selectActiveChatRunId\(runData\?\.runs \?\? \[\]\)/,
    "the active run comes from durable server state, not a phone socket");
  assert.match(live, /const persistedIds = new Set\(persisted\.map\(\(m\) => m\.id\)\)/,
    "reloaded transcript rows deduplicate optimistic phone messages by durable id");
});

test("the deploy source retains the universal restart-safe run ledger", () => {
  const root = path.join(import.meta.dirname, "..", "container");
  const gate = fs.readFileSync(path.join(root, "gate.js"), "utf8");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

  assert.match(dockerfile, /^COPY run-ledger\.js \/opt\/agenthost\/run-ledger\.js$/m,
    "the deployed image must contain the module gate.js requires");
  assert.match(gate, /const RUN_LEDGER_DIR\s*=/, "run lifecycle truth must live on the box volume");
  assert.match(gate, /runLedger\.interruptActive\(/, "gateway boot must reconcile unfinished work honestly");
  assert.match(gate, /function startFlightRecorder\(/, "the deployed gateway must start its own flight recorder");
  assert.match(gate, /type: "box_boot"/, "the flight recorder must distinguish a gateway restart from a box reboot");
  assert.match(gate, /type: "deployment"/, "the flight recorder must identify which release was running");
  assert.match(gate, /function handleRuns\(/, "cursor history and run detail must stay reachable");
  assert.match(gate, /`loop:\$\{job\.id\}:\$\{scheduledAtMs\}`/,
    "a Loop must have one deterministic execution id per scheduled minute");
  assert.match(gate, /`multi_loop:\$\{job\.id\}:\$\{scheduledAtMs\}`/,
    "a Multi-Loop must have one deterministic execution id per scheduled minute");
});

// Third way the "needs a file the image never has" trap bit us (2026-07-18):
// team-charter.md HAD a COPY line AND existed on disk, but container/.dockerignore
// had `*.md`, so the build CONTEXT stripped it and `COPY team-charter.md` failed
// ("team-charter.md: not found") at deploy time -- invisible to the COPY-vs-source
// check above. This guard closes it: every file the Dockerfile COPYs by an exact
// name must survive .dockerignore (i.e. not be excluded, or be re-included with a
// `!` negation). Directory COPYs and glob sources are skipped (the simple matcher
// below can't reason about them; the exact-name COPYs are where this bites).
test("every exact-name file the Dockerfile COPYs survives .dockerignore (in the build context)", () => {
  const root = path.join(import.meta.dirname, "..", "container");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  let ignore = "";
  try { ignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8"); } catch { /* no .dockerignore -> nothing excluded */ }

  // .dockerignore rules, in order. A later rule wins; a `!` prefix re-includes.
  const rules = ignore.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  // Does the build context KEEP this exact filename? Walk the rules top-to-bottom;
  // the last matching rule decides. Supports `*.ext` globs and `!negation`.
  function keptInContext(name) {
    let excluded = false;
    for (const raw of rules) {
      const negate = raw.startsWith("!");
      const pat = negate ? raw.slice(1) : raw;
      const matches = pat.includes("*")
        ? new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(name)
        : pat === name;
      if (matches) excluded = !negate;
    }
    return !excluded;
  }

  // Exact-name COPY sources only (skip "icons/"-style dir copies and any glob).
  const cre = /^COPY\s+(\S+)\s/gm;
  const copySources = [];
  let m;
  while ((m = cre.exec(dockerfile)) !== null) {
    const src = m[1];
    if (src.endsWith("/") || src.includes("*")) continue; // dir/glob: not this check
    copySources.push(src);
  }
  assert.ok(copySources.includes("team-charter.md"), "sanity: Dockerfile COPYs team-charter.md (regen if that COPY was removed)");

  const stripped = copySources.filter((f) => !keptInContext(f));
  assert.deepEqual(stripped, [], `.dockerignore strips file(s) the Dockerfile COPYs (build will fail with 'not found'): ${stripped.join(", ")} -- add a '!<name>' negation to container/.dockerignore`);
});

// Fourth trap (2026-07-18, live): bubblewrap was installed at RUNTIME on the
// box, not in the image. A redeploy replaced the machine with a fresh image
// that never had it, and EVERY autonomous Codex run then died instantly with
// "bwrap: No permissions to create a new namespace" -- Codex's own harness
// sandboxes itself with Bubblewrap inside AgentHost's Bubblewrap outer jail.
// The outer jail needs Bubblewrap's setuid mode so it does not consume the
// user namespace Codex needs for that inner sandbox. This guard fails the
// build if the required package or mode ever falls out of the image.
test("both autonomy sandbox primitives (unshare + bubblewrap) are baked into the image", () => {
  const root = path.join(import.meta.dirname, "..", "container");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  // chains-lib is the source of truth that `unshare` is the gate's jail primitive.
  const chains = fs.readFileSync(path.join(root, "chains-lib.js"), "utf8");
  assert.match(chains, /bin:\s*["']unshare["']/, "sanity: chains-lib.js builds the read-jail with unshare");

  // Concatenate each RUN...apt-get install block (they span continuation lines)
  // and check the package is present as an installed token, not just a comment.
  const installBlocks = dockerfile.match(/apt-get\s+install[\s\S]*?(?=\n(?:RUN|FROM|COPY|ENV|WORKDIR|CMD|ENTRYPOINT|$))/g) || [];
  const installed = installBlocks.join("\n");
  // util-linux provides `unshare`; bubblewrap provides `bwrap`.
  assert.match(installed, /\butil-linux\b/, "Dockerfile must install util-linux (provides `unshare`, the gate read-jail)");
  assert.match(installed, /\bbubblewrap\b/, "Dockerfile must install bubblewrap -- codex's inner sandbox needs `bwrap`, and a runtime-only install is erased by the next redeploy (live incident 2026-07-18)");
  assert.match(dockerfile, /chmod 4755 \/usr\/bin\/bwrap/, "the outer Codex jail needs setuid Bubblewrap without consuming Codex's user namespace");
});
