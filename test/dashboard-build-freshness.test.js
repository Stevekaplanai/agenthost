import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DASHBOARD_SOURCE_FINGERPRINT,
  computeDashboardSourceFingerprint as buildDashboardSourceFingerprint,
  stampDashboardExportSource,
  stageDashboardExport,
  verifyDashboardFreshness,
} from "../scripts/build-dashboard.mjs";
import { computeDashboardSourceFingerprint } from "../scripts/dashboard-source-fingerprint.mjs";

test("dashboard build script preserves its source fingerprint export", () => {
  assert.equal(buildDashboardSourceFingerprint, computeDashboardSourceFingerprint);
});

test("dashboard source fingerprint preserves its exact ignore and CRLF contract", (t) => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-dashboard-source-fingerprint-"));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(appDir, "app", "out"), { recursive: true });
  fs.mkdirSync(path.join(appDir, "node_modules", "ignored"), { recursive: true });
  fs.mkdirSync(path.join(appDir, ".next"), { recursive: true });
  fs.mkdirSync(path.join(appDir, "out"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "app", "page.tsx"), "line one\r\nline two\r\n");
  fs.writeFileSync(path.join(appDir, "app", "out", "nested.ts"), "nested out stays\n");
  fs.writeFileSync(path.join(appDir, "package.json"), "package fixture\r\n");
  fs.writeFileSync(path.join(appDir, "next-env.d.ts"), "ignored generated types\n");
  fs.writeFileSync(path.join(appDir, "tsconfig.tsbuildinfo"), "ignored build state\n");
  fs.writeFileSync(path.join(appDir, "node_modules", "ignored", "index.js"), "ignored dependency\n");
  fs.writeFileSync(path.join(appDir, ".next", "cache"), "ignored cache\n");
  fs.writeFileSync(path.join(appDir, "out", "index.html"), "ignored export\n");

  const expected = "2e3446b522f74c0c2882c7f8920f12edcf76d5a22507150258d7498e67518869";
  assert.equal(computeDashboardSourceFingerprint(appDir), expected);

  fs.writeFileSync(path.join(appDir, "app", "page.tsx"), "line one\nline two\n");
  fs.writeFileSync(path.join(appDir, "package.json"), "package fixture\n");
  fs.writeFileSync(path.join(appDir, "next-env.d.ts"), "changed ignored generated types\n");
  fs.writeFileSync(path.join(appDir, "tsconfig.tsbuildinfo"), "changed ignored build state\n");
  fs.writeFileSync(path.join(appDir, "node_modules", "ignored", "index.js"), "changed ignored dependency\n");
  fs.writeFileSync(path.join(appDir, ".next", "cache"), "changed ignored cache\n");
  fs.writeFileSync(path.join(appDir, "out", "index.html"), "changed ignored export\n");
  assert.equal(computeDashboardSourceFingerprint(appDir), expected);

  fs.writeFileSync(path.join(appDir, "app", "out", "nested.ts"), "nested out changed\n");
  assert.notEqual(computeDashboardSourceFingerprint(appDir), expected);
});

test("dashboard source fingerprint module import has no observable side effects", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-dashboard-source-import-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "scripts",
    "dashboard-source-fingerprint.mjs",
  )).href;
  const imported = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(moduleUrl)})`,
  ], { cwd, encoding: "utf8" });

  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test("dashboard build and browser journeys use the local-font Next wrapper", () => {
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dashboardPackage = JSON.parse(fs.readFileSync(
    path.join(repo, "dashboard", "package.json"),
    "utf8",
  ));
  const buildRunner = fs.readFileSync(path.join(repo, "dashboard", "scripts", "run-next.mjs"), "utf8");
  const completeJourneys = fs.readFileSync(path.join(repo, "test", "ui", "dashboard-complete-journeys.test.mjs"), "utf8");
  assert.equal(dashboardPackage.scripts.build, "node scripts/run-next.mjs build");
  assert.equal(dashboardPackage.scripts.dev, "node scripts/run-next.mjs dev");
  assert.match(buildRunner, /spawnSync\(process\.execPath, \[nextCli, "build", "--webpack"\]/);
  assert.match(buildRunner, /spawn\(process\.execPath, \[nextCli, "dev", \.\.\.args\]/);
  assert.match(buildRunner, /parseDevArgs\(process\.argv\.slice\(3\)\)/);
  assert.match(completeJourneys, /NEXT_RUNNER = path\.join\(DASHBOARD, "scripts", "run-next\.mjs"\)/);
  assert.doesNotMatch(completeJourneys, /node_modules["'], "next", "dist", "bin", "next"/);
});

test("dashboard build wrapper removes only an empty exact build-id directory", async (t) => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const runnerPath = path.join(repo, "dashboard", "scripts", "run-next.mjs");
  const buildRunner = fs.readFileSync(runnerPath, "utf8");
  assert.match(
    buildRunner,
    /if \(result\.status === 0\) removeEmptyBuildIdDirectory\(buildId\);\s*else process\.exitCode/,
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-dashboard-empty-build-id-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outDir = path.join(root, "out");
  const exactBuildId = "exact-build-id";
  const exactBuildDir = path.join(outDir, "_next", exactBuildId);
  const otherBuildDir = path.join(outDir, "_next", "other-build-id");
  fs.mkdirSync(exactBuildDir, { recursive: true });
  fs.mkdirSync(otherBuildDir, { recursive: true });

  const runnerUrl = `${pathToFileURL(runnerPath).href}?test=${Date.now()}`;
  const { removeEmptyBuildIdDirectory } = await import(runnerUrl);

  assert.equal(removeEmptyBuildIdDirectory(exactBuildId, outDir), true);
  assert.equal(fs.existsSync(exactBuildDir), false);
  assert.equal(fs.existsSync(otherBuildDir), true);
  assert.equal(removeEmptyBuildIdDirectory(exactBuildId, outDir), false);

  fs.mkdirSync(exactBuildDir, { recursive: true });
  fs.writeFileSync(path.join(exactBuildDir, "keep.txt"), "tracked content\n");
  assert.equal(removeEmptyBuildIdDirectory(exactBuildId, outDir), false);
  assert.equal(fs.readFileSync(path.join(exactBuildDir, "keep.txt"), "utf8"), "tracked content\n");

  fs.rmSync(exactBuildDir, { recursive: true, force: true });
  fs.writeFileSync(exactBuildDir, "not a directory\n");
  assert.throws(
    () => removeEmptyBuildIdDirectory(exactBuildId, outDir),
    /could not inspect dashboard build ID directory .*exact-build-id/i,
  );
});

test("dashboard build ids are the exact source fingerprint", async () => {
  const dashboardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dashboard");
  const fingerprint = computeDashboardSourceFingerprint(dashboardDir);
  const configUrl = `${pathToFileURL(path.join(dashboardDir, "next.config.mjs")).href}?test=${Date.now()}`;
  const prior = process.env.AGENTHOST_DASHBOARD_BUILD_ID;
  process.env.AGENTHOST_DASHBOARD_BUILD_ID = fingerprint;
  try {
    const nextConfig = (await import(configUrl)).default;
    assert.equal(typeof nextConfig.generateBuildId, "function");
    assert.equal(await nextConfig.generateBuildId(), fingerprint);
    assert.equal(nextConfig.experimental.cpus, 1);
  } finally {
    if (prior === undefined) delete process.env.AGENTHOST_DASHBOARD_BUILD_ID;
    else process.env.AGENTHOST_DASHBOARD_BUILD_ID = prior;
  }
});

test("dashboard fonts are vendored for network-free reproducible builds", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const layout = fs.readFileSync(path.join(repo, "dashboard", "app", "layout.tsx"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(repo, "dashboard", "package.json"), "utf8"));

  assert.match(layout, /from ['"]next\/font\/local['"]/);
  assert.doesNotMatch(layout, /next\/font\/google/);
  assert.match(layout, /src: ['"]\.\.\/\.font-build\/inter-latin\.woff2['"]/);
  assert.match(layout, /src: ['"]\.\.\/\.font-build\/jetbrains-mono-latin\.woff2['"]/);
  assert.match(layout, /variable: ['"]--font-inter['"][\s\S]*weight: ['"]100 900['"]/);
  assert.match(layout, /variable: ['"]--font-jetbrains['"][\s\S]*weight: ['"]100 800['"]/);
  assert.equal(packageJson.scripts.build, "node scripts/run-next.mjs build");
  assert.equal(packageJson.scripts.dev, "node scripts/run-next.mjs dev");
  for (const [filename, expectedHash] of [
    ["inter-latin.woff2", "c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4"],
    ["jetbrains-mono-latin.woff2", "1e06740a02a443fb7f3eeda8fcaa685a0f6c620e3f01e6666e847295469ce3ad"],
  ]) {
    assert.equal(fs.existsSync(path.join(repo, "dashboard", "app", "fonts", filename)), false);
    const source = fs.readFileSync(path.join(repo, "dashboard", "app", "fonts", `${filename}.base64`), "utf8");
    assert.ok(source.trim().split(/\r?\n/).every((line) => line.length > 0 && line.length <= 76));
    const font = Buffer.from(source.replace(/\s/g, ""), "base64");
    assert.equal(font.subarray(0, 4).toString("ascii"), "wOF2", `${filename} must be WOFF2`);
    assert.ok(font.length > 10_000, `${filename} must contain a nontrivial font payload`);
    assert.equal(createHash("sha256").update(font).digest("hex"), expectedHash);
  }
  const verifier = spawnSync(process.execPath, [path.join(repo, "dashboard", "scripts", "run-next.mjs"), "--verify-fonts"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(verifier.status, 0, verifier.stderr);
  assert.equal(fs.existsSync(path.join(repo, "dashboard", ".font-build")), false);
  assert.match(
    fs.readFileSync(path.join(repo, "dashboard", "app", "fonts", "OFL-Inter.txt"), "utf8"),
    /Copyright 2020 The Inter Project Authors[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/,
  );
  assert.match(
    fs.readFileSync(path.join(repo, "dashboard", "app", "fonts", "OFL-JetBrains-Mono.txt"), "utf8"),
    /Copyright 2020 The JetBrains Mono Project Authors[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/,
  );
});

test("dashboard export manifest never names files hidden by repository ignore rules", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(fs.readFileSync(
    path.join(repo, "container", "dashboard-ui", ".export-manifest.json"),
    "utf8",
  ));
  const paths = manifest.files.map((file) => `container/dashboard-ui/${file.path}`);
  const ignored = spawnSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
    cwd: repo,
    encoding: "utf8",
    input: `${paths.join("\0")}\0`,
  });

  assert.ok(ignored.status === 0 || ignored.status === 1, ignored.stderr);
  assert.deepEqual(
    ignored.stdout.split("\0").filter(Boolean),
    [],
    "manifest-listed dashboard files must remain committable",
  );
});

test("dashboard freshness fingerprint ignores build output and catches source drift", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-dashboard-freshness-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const appDir = path.join(root, "dashboard");
  const outDir = path.join(appDir, "out");
  const target = path.join(root, "container", "dashboard-ui");
  fs.mkdirSync(path.join(appDir, "app", "out"), { recursive: true });
  const installedDependencies = path.join(root, "installed-dependencies");
  fs.mkdirSync(path.join(installedDependencies, "ignored"), { recursive: true });
  fs.symlinkSync(installedDependencies, path.join(appDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  fs.mkdirSync(path.join(appDir, ".next"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "_next", "static"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "app", "page.tsx"), "export default function Page() {}\n");
  fs.writeFileSync(path.join(appDir, "app", "out", "page.tsx"), "export const nestedOutSource = true;\n");
  fs.writeFileSync(path.join(appDir, "package.json"), '{"scripts":{"build":"next build"}}\n');
  fs.writeFileSync(path.join(appDir, "next-env.d.ts"), 'import "./.next/types/routes.d.ts";\n');
  fs.writeFileSync(path.join(appDir, "tsconfig.tsbuildinfo"), "ignored build state\n");
  fs.writeFileSync(path.join(appDir, "node_modules", "ignored", "index.js"), "ignored\n");
  fs.writeFileSync(path.join(appDir, ".next", "cache"), "ignored\n");
  fs.writeFileSync(path.join(outDir, "_next", "static", "app.css"), '@font-face{src:url("/fonts/workspace.woff2")}body{}\n');
  fs.writeFileSync(path.join(outDir, "_next", "static", "app.js"), "console.log('workspace');\n");
  fs.mkdirSync(path.join(outDir, "fonts"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "fonts", "workspace.woff2"), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(
    path.join(outDir, "index.html"),
    '<!doctype html><link rel="stylesheet" href="/_next/static/app.css"><script src="/_next/static/app.js"></script><title>Workspace</title>\n',
  );

  assert.throws(
    () => stageDashboardExport({ appDir, outDir, target }),
    /missing build fingerprint/i,
  );
  stampDashboardExportSource({ appDir, outDir });
  stageDashboardExport({ appDir, outDir, target });
  const expected = computeDashboardSourceFingerprint(appDir);
  assert.equal(fs.readFileSync(path.join(target, DASHBOARD_SOURCE_FINGERPRINT), "utf8").trim(), expected);
  assert.deepEqual(verifyDashboardFreshness({ appDir, target }), { fresh: true, fingerprint: expected });

  fs.writeFileSync(path.join(target, "_next", "static", "app.js"), "throw new Error('broken');\n");
  const tampered = verifyDashboardFreshness({ appDir, target });
  assert.equal(tampered.fresh, false);
  assert.match(tampered.reason, /content changed.*app\.js|app\.js.*content changed/i);
  fs.copyFileSync(
    path.join(outDir, "_next", "static", "app.js"),
    path.join(target, "_next", "static", "app.js"),
  );

  fs.rmSync(path.join(target, "_next", "static", "app.js"));
  const incomplete = verifyDashboardFreshness({ appDir, target });
  assert.equal(incomplete.fresh, false);
  assert.match(incomplete.reason, /app\.js.*missing|missing.*app\.js/i);
  fs.copyFileSync(
    path.join(outDir, "_next", "static", "app.js"),
    path.join(target, "_next", "static", "app.js"),
  );

  fs.rmSync(path.join(target, "fonts", "workspace.woff2"));
  const missingTransitiveAsset = verifyDashboardFreshness({ appDir, target });
  assert.equal(missingTransitiveAsset.fresh, false);
  assert.match(missingTransitiveAsset.reason, /workspace\.woff2.*missing|missing.*workspace\.woff2/i);
  fs.copyFileSync(
    path.join(outDir, "fonts", "workspace.woff2"),
    path.join(target, "fonts", "workspace.woff2"),
  );

  fs.writeFileSync(path.join(appDir, "app", "page.tsx"), "export default function Page() {}\r\n");
  assert.deepEqual(verifyDashboardFreshness({ appDir, target }), { fresh: true, fingerprint: expected });

  fs.writeFileSync(path.join(appDir, "node_modules", "ignored", "index.js"), "still ignored\n");
  fs.writeFileSync(path.join(appDir, ".next", "cache"), "still ignored\n");
  fs.writeFileSync(path.join(appDir, "next-env.d.ts"), 'import "./.next/dev/types/routes.d.ts";\n');
  fs.writeFileSync(path.join(appDir, "tsconfig.tsbuildinfo"), "changed ignored build state\n");
  fs.writeFileSync(path.join(outDir, "index.html"), "changed build output\n");
  assert.deepEqual(verifyDashboardFreshness({ appDir, target }), { fresh: true, fingerprint: expected });

  fs.writeFileSync(path.join(appDir, "app", "out", "page.tsx"), "export const nestedOutSource = false;\n");
  const nestedOutStale = verifyDashboardFreshness({ appDir, target });
  assert.equal(nestedOutStale.fresh, false);
  assert.match(nestedOutStale.reason, /source fingerprint changed/i);
  fs.writeFileSync(path.join(appDir, "app", "out", "page.tsx"), "export const nestedOutSource = true;\n");

  fs.writeFileSync(path.join(appDir, "app", "page.tsx"), "export default function UpdatedPage() {}\n");
  const stale = verifyDashboardFreshness({ appDir, target });
  assert.equal(stale.fresh, false);
  assert.match(stale.reason, /source fingerprint changed/i);
  assert.throws(
    () => stageDashboardExport({ appDir, outDir, target }),
    /was not built from current dashboard source/i,
  );
});
