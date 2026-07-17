import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageDeployFiles, cleanupDeployFiles } from "../src/deploy-container.js";

function fixtureContainerDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-container-"));
  fs.writeFileSync(path.join(dir, "fly.toml"), 'app = "AGENTHOST_APP_NAME"\n\n[build]\n  dockerfile = "Dockerfile"\n');
  fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM node:22-bookworm-slim\n");
  return dir;
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
  fs.writeFileSync(tarball, "fake tar bytes");
  const staged = stageDeployFiles({ containerDir: dir, app: "my-cool-app", harnessTarball: tarball });
  const dockerfile = fs.readFileSync(staged.dockerfileDeploy, "utf8");
  assert.match(dockerfile, /COPY harness\.tar\.gz \/opt\/agenthost\/harness\.tar\.gz/);
  assert.equal(staged.harnessAttached, true);
  assert.ok(fs.existsSync(staged.harnessCopy));
  cleanupDeployFiles(staged);
  assert.ok(!fs.existsSync(staged.harnessCopy));
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

// Guard against the "gate.js serves an asset the image never COPYs" trap: the
// Command Center shipped with a 404 on /cc because cc.html had a runtime
// reader in gate.js but no COPY line in the Dockerfile (chat.html/cron.html
// are each listed explicitly, so a new page is silently missed). The unit +
// UI tests can't catch this -- they read the source files directly, never the
// built image. This test cross-checks the two lists.
test("every ASSET_DIR file gate.js reads at runtime is COPY'd into the image", () => {
  const root = path.join(import.meta.dirname, "..", "container");
  const gate = fs.readFileSync(path.join(root, "gate.js"), "utf8");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

  // Filenames from readFileSync(path.join(ASSET_DIR, "<name>"[, ...])) calls.
  // The optional trailing arg (a subdir like "icons") is ignored -- the icons
  // dir is COPY'd wholesale, checked separately below.
  const readAssets = new Set();
  const re = /readFileSync\(path\.join\(ASSET_DIR,\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(gate)) !== null) readAssets.add(m[1]);
  // gate.js reads the icons dir per-file (icons/icon-192.png); the Dockerfile
  // COPYs the dir. Normalize those to the dir so the check matches reality.
  // gate.js reads the icons dir per-file (icons/icon-192.png); the Dockerfile
  // COPYs the dir ("icons/"). Normalize both to "icons" so they match.
  const needed = new Set();
  for (const a of readAssets) needed.add(a.startsWith("icons/") ? "icons" : a);

  assert.ok(needed.has("cc.html"), "sanity: gate.js reads cc.html (regen this test if the reader was removed)");

  const copied = new Set();
  const cre = /^COPY\s+(\S+)\s/gm;
  while ((m = cre.exec(dockerfile)) !== null) copied.add(m[1].replace(/\/$/, ""));

  const missing = [...needed].filter((f) => !copied.has(f));
  assert.deepEqual(missing, [], `Dockerfile is missing COPY line(s) for asset(s) gate.js serves: ${missing.join(", ")}`);
});
