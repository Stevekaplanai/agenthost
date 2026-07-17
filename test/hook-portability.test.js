// Hook portability: unportable settings.json hooks (Windows paths, PowerShell,
// %VAR% env syntax, unmigrated script targets) are REMOVED from the CLOUD copy
// at pack time, with a report line naming the hook, why, and the fix. The
// user's LOCAL settings.json is never touched. This is the 2026-07-10 incident:
// every sync re-delivered C:/Program Files hooks that flooded every agent turn
// with Stop-hook errors.
//
// Unit tests cover the pure functions (scripts/pack-lib.mjs); the end-to-end
// test drives scripts/pack.mjs against a throwaway HOME like plugins-pack does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyHookCommand, pruneUnportableHooks } from "../scripts/pack-lib.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK_MJS = path.join(REPO_ROOT, "scripts", "pack.mjs");
const CLOUD = "/data/home/agent";
const nothingStaged = () => false;
const everythingStaged = () => true;

// ---- classifyHookCommand: Windows-only shapes ---------------------------------

test("classifyHookCommand passes a portable relative command", () => {
  assert.equal(classifyHookCommand("echo done", CLOUD, nothingStaged), null);
  assert.equal(classifyHookCommand("bash .claude/hooks/lint.sh", CLOUD, nothingStaged), null);
});

test("classifyHookCommand rejects drive-letter paths, both slash flavors", () => {
  const fwd = classifyHookCommand('node "C:/Program Files/nodejs/node.exe"', CLOUD, everythingStaged);
  assert.match(fwd.reason, /drive-letter/);
  const back = classifyHookCommand("C:\\Users\\Steve\\tools\\hook.cmd", CLOUD, everythingStaged);
  assert.match(back.reason, /drive-letter/);
  assert.equal(fwd.missingRel, undefined, "Windows-only verdicts carry no --include target");
});

test("classifyHookCommand rejects WSL /mnt/<drive> mounts", () => {
  const v = classifyHookCommand("bash /mnt/c/Users/Steve/hook.sh", CLOUD, everythingStaged);
  assert.match(v.reason, /WSL/);
});

test("classifyHookCommand rejects powershell/pwsh invocations in any form", () => {
  assert.match(classifyHookCommand("powershell.exe -File sync.ps1", CLOUD, everythingStaged).reason, /PowerShell/);
  assert.match(classifyHookCommand("pwsh -NoProfile -c gci", CLOUD, everythingStaged).reason, /PowerShell/);
  assert.match(classifyHookCommand("/usr/bin/pwsh script.ps1", CLOUD, everythingStaged).reason, /PowerShell/);
});

test("classifyHookCommand does not false-positive on pwsh/powershell substrings", () => {
  // Leading binary must itself be portable so only the POWERSHELL_RE behavior
  // is under test here, not the separate unknown-binary rule below.
  assert.equal(classifyHookCommand("bash run-my-pwsh-tool.sh", CLOUD, nothingStaged), null);
  assert.equal(classifyHookCommand("node powershell-docs.js", CLOUD, nothingStaged), null);
});

test("classifyHookCommand rejects %APPDATA%-style Windows env syntax", () => {
  const v = classifyHookCommand("node %APPDATA%\\npm\\hook.js", CLOUD, everythingStaged);
  assert.match(v.reason, /%VAR%/);
  assert.match(classifyHookCommand("%ProgramFiles(x86)%\\tool.exe", CLOUD, everythingStaged).reason, /%VAR%/);
});

test("classifyHookCommand leaves strftime tokens alone (not Windows env syntax)", () => {
  assert.equal(classifyHookCommand("date +%Y%m%d >> .claude/log", CLOUD, nothingStaged), null);
  assert.equal(classifyHookCommand("date +%H%M%S", CLOUD, nothingStaged), null);
});

// ---- classifyHookCommand: bare binary not installed on the box ----------------
// 2026-07-13 incident: "edgee statusline claude doctor --warn-only" isn't a
// Windows path, PowerShell, or %VAR% -- none of the regexes above catch it. It
// re-clobbered the box on every sync because it just isn't installed there.

test("classifyHookCommand rejects a bare command that is not in the container", () => {
  const v = classifyHookCommand("edgee statusline claude doctor --warn-only", CLOUD, nothingStaged);
  assert.match(v.reason, /invokes `edgee`/);
  assert.match(v.reason, /not installed on the box/);
  assert.equal(v.missingRel, undefined);
});

test("classifyHookCommand passes every binary container/Dockerfile actually installs", () => {
  for (const cmd of ["git status", "curl -s x", "jq .", "gh pr list", "rg foo", "node x.js",
    "npm run build", "npx thing", "claude -p hi", "tmux ls", "python3 x.py"]) {
    assert.equal(classifyHookCommand(cmd, CLOUD, nothingStaged), null, cmd);
  }
});

test("classifyHookCommand skips a leading VAR=value env-assignment before checking the binary", () => {
  const v = classifyHookCommand("FOO=bar edgee run", CLOUD, nothingStaged);
  assert.match(v.reason, /invokes `edgee`/);
  assert.equal(classifyHookCommand("FOO=bar echo hi", CLOUD, nothingStaged), null);
});

test("classifyHookCommand does not apply the bare-binary rule to a path (handled by other rules)", () => {
  assert.equal(classifyHookCommand(".claude/hooks/lint.sh", CLOUD, nothingStaged), null);
});

// ---- classifyHookCommand: missing-target rule (reuses hook-gap detection) -----

test("classifyHookCommand rejects a cloud-home target that is not staged, with the home-relative fix", () => {
  const v = classifyHookCommand(`python ${CLOUD}/Projects/brain/capture.py --from-hook`, CLOUD, nothingStaged);
  assert.match(v.reason, /not being migrated/);
  assert.equal(v.missingRel, "Projects/brain/capture.py");
});

test("classifyHookCommand keeps a hook whose cloud-home target IS staged", () => {
  const seen = [];
  const exists = (rel) => { seen.push(rel); return true; };
  assert.equal(classifyHookCommand(`python ${CLOUD}/Projects/brain/capture.py`, CLOUD, exists), null);
  assert.deepEqual(seen, ["Projects/brain/capture.py"]);
});

test("classifyHookCommand trusts .claude/ paths (migrated wholesale) without a staging check", () => {
  assert.equal(classifyHookCommand(`bash ${CLOUD}/.claude/hooks/x.sh`, CLOUD, nothingStaged), null);
});

test("classifyHookCommand tolerates non-string and empty commands", () => {
  assert.equal(classifyHookCommand(undefined, CLOUD, nothingStaged), null);
  assert.equal(classifyHookCommand("", CLOUD, nothingStaged), null);
  assert.equal(classifyHookCommand(42, CLOUD, nothingStaged), null);
});

// ---- pruneUnportableHooks ------------------------------------------------------

function mixedHooks() {
  return {
    Stop: [{ matcher: "*", hooks: [
      { type: "command", command: "echo done" },
      { type: "command", command: `python ${CLOUD}/Projects/brain/capture.py` },
      { type: "command", command: '"C:/Program Files/nodejs/node.exe" learn.js' },
      { type: "command", command: `bash ${CLOUD}/tools/not-migrated.sh` },
    ]}],
    PreToolUse: [{ matcher: "Bash", hooks: [
      { type: "command", command: "pwsh -File check.ps1" },
    ]}],
  };
}

test("pruneUnportableHooks removes only the unportable hooks and records why", () => {
  const exists = (rel) => rel === "Projects/brain/capture.py";
  const { hooks, removed } = pruneUnportableHooks(mixedHooks(), CLOUD, exists);
  assert.equal(hooks.Stop[0].hooks.length, 2);
  assert.deepEqual(hooks.Stop[0].hooks.map(h => h.command), [
    "echo done",
    `python ${CLOUD}/Projects/brain/capture.py`,
  ]);
  assert.equal(removed.length, 3);
  const reasons = removed.map(r => r.reason).join("\n");
  assert.match(reasons, /drive-letter/);
  assert.match(reasons, /PowerShell/);
  assert.match(reasons, /not being migrated/);
  const missing = removed.find(r => r.missingRel);
  assert.equal(missing.missingRel, "tools/not-migrated.sh");
  assert.equal(missing.event, "Stop");
});

test("pruneUnportableHooks drops a matcher group (and event) it emptied entirely", () => {
  const { hooks } = pruneUnportableHooks(mixedHooks(), CLOUD, everythingStaged);
  assert.equal(hooks.PreToolUse, undefined, "event whose only group was emptied is dropped");
  assert.ok(hooks.Stop, "event with surviving hooks stays");
});

test("pruneUnportableHooks never mutates its input", () => {
  const input = mixedHooks();
  const snapshot = JSON.stringify(input);
  pruneUnportableHooks(input, CLOUD, nothingStaged);
  assert.equal(JSON.stringify(input), snapshot);
});

test("pruneUnportableHooks preserves shapes it did not empty and tolerates odd input", () => {
  const alreadyEmpty = { Stop: [], Notification: [{ matcher: "*", hooks: [] }] };
  const out = pruneUnportableHooks(alreadyEmpty, CLOUD, nothingStaged);
  assert.deepEqual(out.hooks, alreadyEmpty, "user's own empty scaffolding ships as-is");
  assert.deepEqual(pruneUnportableHooks(undefined, CLOUD, nothingStaged), { hooks: undefined, removed: [] });
  assert.deepEqual(pruneUnportableHooks(null, CLOUD, nothingStaged), { hooks: null, removed: [] });
});

test("pruneUnportableHooks removes a hook whose binary is not installed on the box", () => {
  const hooks = {
    SessionStart: [{ matcher: "*", hooks: [
      { type: "command", command: "edgee statusline claude doctor --warn-only" },
      { type: "command", command: "echo session-started" },
    ]}],
  };
  const { hooks: out, removed } = pruneUnportableHooks(hooks, CLOUD, nothingStaged);
  assert.deepEqual(out.SessionStart[0].hooks.map(h => h.command), ["echo session-started"]);
  assert.equal(removed.length, 1);
  assert.match(removed[0].reason, /invokes `edgee`/);
});

// ---- end-to-end through pack.mjs ----------------------------------------------

test("pack.mjs prunes unportable hooks from the CLOUD copy only and reports each one", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-hooks-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const localSettings = {
    model: "claude-fable-5",
    hooks: {
      Stop: [{ matcher: "*", hooks: [
        { type: "command", command: "echo stop-hook-done" },                                        // portable relative
        { type: "command", command: `python ${home}/Projects/brain/capture.py --from-hook` },       // target migrated via --include
        { type: "command", command: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\Steve\\learn.js' }, // Windows-only
        { type: "command", command: `bash ${home}/tools/not-migrated.sh` },                         // missing target
      ]}],
      PreToolUse: [{ matcher: "Bash", hooks: [
        { type: "command", command: "pwsh -NoProfile -File check.ps1" },                            // Windows-only
      ]}],
      SessionStart: [{ matcher: "*", hooks: [
        { type: "command", command: "edgee statusline claude doctor --warn-only" },                 // not installed on the box
      ]}],
    },
  };
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(localSettings, null, 2));
  fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# root\n");
  fs.mkdirSync(path.join(home, "Projects", "brain"), { recursive: true });
  fs.writeFileSync(path.join(home, "Projects", "brain", "capture.py"), "print('hi')\n");
  fs.mkdirSync(path.join(home, "tools"), { recursive: true });
  fs.writeFileSync(path.join(home, "tools", "not-migrated.sh"), "#!/bin/sh\n"); // exists locally, NOT included

  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-hooks-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const res = spawnSync(process.execPath, [PACK_MJS, "--out", out, "--dry-run", "--include", "Projects/brain"], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8",
  });
  assert.equal(res.status, 0, `pack.mjs exited ${res.status}\n${res.stderr}`);

  // Cloud copy: the two portable hooks survive (target hook path-translated),
  // the three unportable ones are gone, the emptied event key is gone.
  const stagedText = fs.readFileSync(path.join(out, "staging", ".claude", "settings.json"), "utf8");
  const staged = JSON.parse(stagedText);
  assert.equal(staged.hooks.Stop.length, 1);
  assert.deepEqual(staged.hooks.Stop[0].hooks.map(h => h.command), [
    "echo stop-hook-done",
    "python /data/home/agent/Projects/brain/capture.py --from-hook",
  ]);
  assert.equal(staged.hooks.PreToolUse, undefined, "emptied PreToolUse event dropped from the cloud copy");
  assert.equal(staged.hooks.SessionStart, undefined, "emptied SessionStart event dropped from the cloud copy");
  assert.ok(!stagedText.includes("C:"), "no drive-letter residue in the cloud settings.json");
  assert.ok(!stagedText.includes("pwsh"), "no PowerShell residue in the cloud settings.json");
  assert.ok(!stagedText.includes("edgee"), "no unresolvable-binary residue in the cloud settings.json");

  // Report lines: one per removed hook -- what, why, fix.
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.removedHooks.length, 4);
  const joined = manifest.removedHooks.join("\n");
  assert.match(joined, /drive-letter/);
  assert.match(joined, /PowerShell/);
  assert.match(joined, /invokes `edgee`, which is not installed on the box/);
  assert.match(joined, /removed from the cloud settings\.json; your local file is untouched/);
  assert.ok(joined.includes(`--include "${path.join(home, "tools", "not-migrated.sh")}"`), "missing-target line carries the exact --include fix");
  assert.equal(manifest.hookGaps.length, 1, "missing-target removal still surfaces as a hook gap for sync/deploy");
  assert.match(manifest.hookGaps[0], /not being migrated/);

  const compat = fs.readFileSync(path.join(out, "compat-report.md"), "utf8");
  assert.ok(compat.includes("## Hooks removed from the cloud settings.json"), "compat report has the removal section");
  assert.match(compat, /invokes `edgee`/);
  assert.match(compat, /--include/);
  assert.ok(res.stdout.includes("4 unportable hook(s) removed"), "pack output warns loudly");

  // The user's LOCAL settings.json is byte-for-byte untouched.
  const localAfter = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(localAfter.hooks.Stop[0].hooks.length, 4);
  assert.equal(localAfter.hooks.PreToolUse[0].hooks[0].command, "pwsh -NoProfile -File check.ps1");
  assert.equal(localAfter.hooks.SessionStart[0].hooks[0].command, "edgee statusline claude doctor --warn-only");
});

test("pack.mjs leaves a fully portable hooks block alone (no removal section noise)", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-hooks-ok-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: "echo ok" }] }] },
  }, null, 2));

  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-hooks-ok-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const res = spawnSync(process.execPath, [PACK_MJS, "--out", out, "--dry-run"], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8",
  });
  assert.equal(res.status, 0, `pack.mjs exited ${res.status}\n${res.stderr}`);

  const staged = JSON.parse(fs.readFileSync(path.join(out, "staging", ".claude", "settings.json"), "utf8"));
  assert.equal(staged.hooks.Stop[0].hooks[0].command, "echo ok");
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.removedHooks, []);
  assert.deepEqual(manifest.hookGaps, []);
});
