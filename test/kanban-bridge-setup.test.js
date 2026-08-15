import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "configure-kanban-bridge.sh");
const gitBash = String.raw`C:\Program Files\Git\usr\bin\bash.exe`;

function bashPath(value) {
  if (process.platform !== "win32") return value;
  return value.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
}

function quoted(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runBash(args, options = {}) {
  if (process.platform !== "win32") return spawnSync(args[0], args.slice(1), options);
  if (!fs.existsSync(gitBash)) return { error: Object.assign(new Error("bash is not installed"), { code: "ENOENT" }) };
  const command = args.map((arg) => quoted(bashPath(arg))).join(" ");
  return spawnSync(gitBash, ["-lc", command], options);
}

test("the bridge setup script is valid shell and dry-run has no side effects", (t) => {
  const syntax = runBash(["bash", "-n", script], { encoding: "utf8" });
  if (syntax.error && syntax.error.code === "ENOENT") {
    t.skip("bash is not installed");
    return;
  }
  assert.equal(syntax.status, 0, syntax.stderr);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-kanban-dry-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = runBash(["bash",
    script,
    "--app", "agenthost-test",
    "--user", "operator@example.com",
    "--dry-run",
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /DRY RUN/);
  assert.match(run.stdout, /non-mutating 3x3 auth matrix/);
  assert.equal(fs.existsSync(path.join(home, ".config")), false);
});

test("the bridge setup never passes scoped token values on flyctl argv", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.match(source, /\|\s*flyctl secrets import --stage/);
  assert.doesNotMatch(source, /flyctl secrets (?:set|import)[^\n]*KANBAN_BRIDGE_(?:READ|WRITE|LIFECYCLE)_TOKEN=/);
  assert.match(source, /127\\?\.0\\?\.0\\?\.1:\$PORT/);
  assert.match(source, /write token blocked from lifecycle/);
  assert.match(source, /lifecycle token blocked from writes/);
});

test("the runtime image includes the listener-inspection tool used by bridge setup", () => {
  const source = fs.readFileSync(script, "utf8");
  const dockerfile = fs.readFileSync(path.join(root, "container", "Dockerfile"), "utf8");
  assert.match(source, /\bss -ltnH\b/);
  assert.match(
    dockerfile,
    /apt-get install -y --no-install-recommends[\s\S]*\biproute2\b[\s\S]*&& rm -rf \/var\/lib\/apt\/lists\//,
  );
});

test("a custom token file cannot resolve inside the repository", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-kanban-path-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const target of [
    "bridge.env",
    path.join(root, "nested", "..", "bridge.env"),
  ]) {
    const run = runBash(["bash",
      script,
      "--app", "agenthost-test",
      "--user", "operator@example.com",
      "--secret-file", target,
      "--dry-run",
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
    });
    if (run.error && run.error.code === "ENOENT") {
      t.skip("bash is not installed");
      return;
    }
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /must live outside the repository/);
    assert.equal(fs.existsSync(path.join(root, "bridge.env")), false);
  }
});

test("Windows path containment rejects mixed-case aliases of the repository", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows case-folding regression");
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-kanban-case-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mixedCaseInsideRepo = path.join(
    root.toUpperCase(),
    "MiXeD",
    "..",
    "KaNbAn-SeCrEtS.EnV",
  );
  const run = runBash(["bash",
    script,
    "--app", "agenthost-test",
    "--user", "operator@example.com",
    "--secret-file", mixedCaseInsideRepo,
    "--dry-run",
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
  });
  if (run.error && run.error.code === "ENOENT") {
    t.skip("bash is not installed");
    return;
  }
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /must live outside the repository/);
});
