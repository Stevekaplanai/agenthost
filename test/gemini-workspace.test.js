// Gemini workspace provisioning stays a boot-only isolation change. These tests
// exercise the exact start.sh function body on Linux and keep Gemini out of
// unattended execution until its later capability packages pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { commandCenterEngineStates, geminiWorkspaceReadiness } from "../container/gate.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const startPath = path.join(repoRoot, "container", "start.sh");
const startSh = fs.readFileSync(startPath, "utf8");
const hasBash = process.platform !== "win32" && spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\\"'\\\"'")}'`;
}

test("Gemini is provisioned through the existing isolated-worktree path and terminal", () => {
  assert.match(startSh, /make_worktree gemini\s+gemini\/work/, "Gemini uses the shared provisioner on its own branch");
  assert.match(startSh, /\[ "\$engine" = "codex" \] \|\| \[ "\$engine" = "gemini" \][\s\S]*make_independent_workspace/, "Gemini uses the jail-compatible independent clone path");
  assert.match(startSh, /make_independent_workspace\(\)/, "the independent workspace helper is shared instead of duplicated");
  const workspaceFunctions = startSh.slice(startSh.indexOf("make_independent_workspace() {"), startSh.indexOf("make_worktree() {"));
  assert.match(workspaceFunctions, /independent_workspace_is_safe "\$workspace_root" "\$tmp" ""/, "Gemini's .git directory stays inside its workspace");
  assert.match(workspaceFunctions, /exec 9< \/opt\/agenthost\/workspace-provision\.lock[\s\S]*flock -x 9/, "concurrent boots use the image-owned no-truncate lock");
  assert.match(workspaceFunctions, /independent_workspace_is_safe/, "existing workspaces are verified without host-side Git inspection");
  assert.match(startSh, /\[ ! -e "\$git_dir\/config\.worktree" \] && \[ ! -L "\$git_dir\/config\.worktree" \]/, "worktree-scoped Git configuration is rejected before checkout");
  assert.doesNotMatch(workspaceFunctions, /(^|\n)\s*git -C/m, "every boot-time workspace Git call uses the hostile-config guard");
  const dockerfile = fs.readFileSync(path.join(repoRoot, "container", "Dockerfile"), "utf8");
  assert.match(dockerfile, /workspace-provision\.lock/, "the provisioning lock is baked into the root-owned image layer");

  const geminiBlock = startSh.slice(
    startSh.indexOf("if command -v gemini >/dev/null 2>&1; then"),
    startSh.indexOf("#     Ollama (cloud proxy)"),
  );
  assert.match(geminiBlock, /gemini_cwd="\$HOME"/, "a missing workspace opens outside shared ~/work");
  assert.match(geminiBlock, /gemini_root="\$HOME\/workspaces\/gemini"/, "Gemini searches only its own workspace root");
  assert.doesNotMatch(geminiBlock, /git_isolation -C "\$candidate"/, "Gemini does not run Git against a candidate workspace before opening its terminal");
  assert.match(geminiBlock, /for repo in "\$\{REPO_LIST\[@\]\}"/, "the first valid Gemini workspace is selected, not merely the first configured repo");
  assert.match(geminiBlock, /independent_workspace_is_safe "\$gemini_root" "\$candidate" "gemini\/work"/, "Gemini rejects unsafe or wrong-branch workspaces before opening a terminal");
  assert.match(geminiBlock, /WARN: Gemini workspace unavailable; opening Gemini outside shared ~\/work/, "workspace failure is honest");
  assert.match(geminiBlock, /tmux new-window -t agent -n gemini -c "\$gemini_cwd"/, "Gemini's terminal starts in the selected private directory");

  const gate = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");
  const sourceSet = (name) => {
    const match = gate.match(new RegExp(`const ${name} = new Set\\((\\[[^\\]]*\\])\\)`));
    assert.ok(match, `${name} is defined`);
    return JSON.parse(match[1]).sort();
  };
  assert.deepEqual(sourceSet("AUTONOMOUS_EXEC_ENGINES"), ["claude", "codex", "deepseek", "gemini", "hermes", "kimi"], "DeepSeek and Kimi are in contained unattended execution");
  assert.deepEqual(sourceSet("REVIEW_ENGINES"), ["claude", "codex", "gemini", "kimi"], "Kimi is now in unattended review");
  assert.deepEqual(sourceSet("GIT_CHANGE_ENGINES"), ["claude", "codex", "deepseek", "gemini", "hermes", "kimi"], "All 6 exec engines have bounded Git-write authority");
});

test("Gemini reports a verified workspace without advertising unattended capability", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-gemini-capability-"));
  const workspace = path.join(home, "workspaces", "gemini", "repo");
  const gitDir = path.join(workspace, ".git");
  try {
    const missing = geminiWorkspaceReadiness(["owner/repo"], home);
    assert.equal(missing.ready, false);
    const down = commandCenterEngineStates({
      inventory: [{ id: "gemini", installed: true }],
      configured: { gemini: true },
      geminiWorkspace: missing,
      geminiAuthenticated: true,
    }).gemini;
    assert.equal(down.state, "down", "an installed Gemini is not reported ready without its private workspace");
    assert.equal(down.workspaceReady, false);
    assert.equal(down.capability.available, false, "workspace readiness does not grant unattended authority");
    assert.equal(down.capability.status, "unavailable");
    assert.equal(down.capability.nextActions[0].id, "restart-box");

    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/gemini/work\n");
    fs.writeFileSync(path.join(gitDir, "config"), "[core]\nrepositoryformatversion = 0\n");
    assert.equal(geminiWorkspaceReadiness("owner/repo", home).ready, false,
      "a branch ref without an index is not a materialized workspace");
    fs.writeFileSync(path.join(gitDir, "index"), "");
    const ready = geminiWorkspaceReadiness("owner/repo", home);
    assert.equal(ready.ready, true);
    assert.deepEqual(ready.artifacts, [{ repo: "repo", branch: "gemini/work" }]);
    const state = commandCenterEngineStates({
      inventory: [{ id: "gemini", installed: true }],
      configured: { gemini: true },
      geminiWorkspace: ready,
      geminiAuthenticated: true,
    }).gemini;
    assert.equal(state.state, "ready");
    assert.equal(state.workspaceReady, true);
    assert.equal(state.capability.available, false, "Package 1 never enables unattended Gemini");
    assert.equal(state.capability.checks.jailReady, false);
    assert.equal(state.capability.checks.credentialBrokerReady, false);

    fs.appendFileSync(path.join(gitDir, "config"), '[filter "hostile"]\nclean = /tmp/hostile\n');
    assert.equal(geminiWorkspaceReadiness("owner/repo", home).ready, false, "workspace status rejects executable Git filter configuration");
    fs.writeFileSync(path.join(gitDir, "config"), "[filter.hostile]\nclean = /tmp/hostile\n");
    assert.equal(geminiWorkspaceReadiness("owner/repo", home).ready, false, "workspace status rejects dotted Git filter sections too");
    fs.writeFileSync(path.join(gitDir, "config"), "[include.hidden]\npath = /tmp/hostile-config\n");
    assert.equal(geminiWorkspaceReadiness("owner/repo", home).ready, false, "workspace status rejects dotted Git include sections too");
    fs.writeFileSync(path.join(gitDir, "config"), "[includeif.hidden]\npath = /tmp/hostile-config\n");
    assert.equal(geminiWorkspaceReadiness("owner/repo", home).ready, false, "workspace status rejects dotted Git conditional include sections too");
    fs.writeFileSync(path.join(gitDir, "config"), "[include]\npath = /tmp/hostile-config\n");
    assert.equal(geminiWorkspaceReadiness("owner/repo", home).ready, false, "workspace status rejects Git config includes it cannot verify");
    fs.writeFileSync(path.join(gitDir, "config"), "[core]\nrepositoryformatversion = 0\n");
    fs.writeFileSync(path.join(gitDir, "config.worktree"), '[filter "hostile"]\nclean = /tmp/hostile\n');
    assert.equal(geminiWorkspaceReadiness("owner/repo", home).ready, false, "workspace status rejects worktree-scoped Git configuration before it can hide a filter");
    fs.unlinkSync(path.join(gitDir, "config.worktree"));
    fs.writeFileSync(path.join(gitDir, "commondir"), "/tmp/other-git-dir\n");
    assert.equal(geminiWorkspaceReadiness("owner/repo", home).ready, false, "workspace status rejects linked-worktree metadata");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Gemini provisioner creates one private gemini/work worktree and reuses it after restart", {
  skip: hasBash ? false : "requires the Linux container shell",
}, () => {
  const functionsStart = startSh.indexOf("git_isolation() {");
  const functionsEnd = startSh.indexOf("# Disk guard:");
  assert.ok(functionsStart >= 0 && functionsEnd > functionsStart, "workspace functions are available in start.sh");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-gemini-workspace-"));
  const home = path.join(root, "home");
  const source = path.join(home, "work", "repo");
  const worktree = path.join(home, "workspaces", "gemini", "repo");
  const scriptPath = path.join(root, "exercise-worktree.sh");
  const provisionLock = path.join(root, "workspace-provision.lock");
  const functions = startSh.slice(functionsStart, functionsEnd)
    .replaceAll("/opt/agenthost/workspace-provision.lock", provisionLock);
  const selectionStart = startSh.indexOf('    gemini_cwd="$HOME"');
  const selectionEnd = startSh.indexOf("    tmux new-window -t agent -n gemini", selectionStart);
  const selection = startSh.slice(selectionStart, selectionEnd);
  const diskStart = startSh.indexOf("# Disk guard:");
  const diskEnd = startSh.indexOf("# 4b. Bridge", diskStart);
  const diskGuard = startSh.slice(diskStart, diskEnd);
  assert.ok(selectionStart >= 0 && selectionEnd > selectionStart, "Gemini workspace selection is available in start.sh");
  assert.ok(diskStart >= 0 && diskEnd > diskStart, "the workspace disk guard is available in start.sh");
  const script = `#!/usr/bin/env bash
set -euo pipefail
export HOME=${shellQuote(home)}
export REPOS='owner/repo'
REPO_LIST=('owner/repo')
mkdir -p ${shellQuote(source)}
git -C ${shellQuote(source)} init -q
git -C ${shellQuote(source)} config user.name test
git -C ${shellQuote(source)} config user.email test@example.invalid
printf 'seed\\n' > ${shellQuote(path.join(source, "README.md"))}
printf '*.payload filter=hostile\\n' > ${shellQuote(path.join(source, ".gitattributes"))}
printf 'payload\\n' > ${shellQuote(path.join(source, "payload.payload"))}
git -C ${shellQuote(source)} add README.md .gitattributes payload.payload
git -C ${shellQuote(source)} commit -qm seed
initial_branch="$(git -C ${shellQuote(source)} branch --show-current)"
: > ${shellQuote(provisionLock)}
chmod 444 ${shellQuote(provisionLock)}
printf '#!/usr/bin/env bash\\ntouch ${shellQuote(path.join(root, "HOST_FSMONITOR_EXECUTED"))}\\n' > ${shellQuote(path.join(root, "hostile-fsmonitor"))}
chmod +x ${shellQuote(path.join(root, "hostile-fsmonitor"))}
printf '#!/usr/bin/env bash\\ntouch ${shellQuote(path.join(root, "HOST_FILTER_EXECUTED"))}\\ncat\\n' > ${shellQuote(path.join(root, "hostile-git-command"))}
chmod +x ${shellQuote(path.join(root, "hostile-git-command"))}
git -C ${shellQuote(source)} config core.fsmonitor ${shellQuote(path.join(root, "hostile-fsmonitor"))}
mkdir -p ${shellQuote(path.join(root, "hostile-hooks"))}
printf '#!/usr/bin/env bash\\ntouch ${shellQuote(path.join(root, "HOST_HOOK_EXECUTED"))}\\n' > ${shellQuote(path.join(root, "hostile-hooks", "post-checkout"))}
chmod +x ${shellQuote(path.join(root, "hostile-hooks", "post-checkout"))}
git -C ${shellQuote(source)} config core.hooksPath ${shellQuote(path.join(root, "hostile-hooks"))}
${functions}
git -C ${shellQuote(source)} status --porcelain >/dev/null || true
test -e ${shellQuote(path.join(root, "HOST_FSMONITOR_EXECUTED"))}
rm -f ${shellQuote(path.join(root, "HOST_FSMONITOR_EXECUTED"))}
rm -f ${shellQuote(path.join(root, "HOST_FILTER_EXECUTED"))}
git_isolation -C ${shellQuote(source)} status --porcelain >/dev/null
test ! -e ${shellQuote(path.join(root, "HOST_FSMONITOR_EXECUTED"))}
git_isolation -C ${shellQuote(source)} checkout -q -b hostile-hook-probe
test ! -e ${shellQuote(path.join(root, "HOST_HOOK_EXECUTED"))}
git_isolation -C ${shellQuote(source)} checkout -q "$initial_branch"
git -C ${shellQuote(source)} config core.sshCommand ${shellQuote(path.join(root, "hostile-git-command"))}
git -C ${shellQuote(source)} config filter.hostile.clean ${shellQuote(path.join(root, "hostile-git-command"))}
git -C ${shellQuote(source)} config filter.hostile.smudge ${shellQuote(path.join(root, "hostile-git-command"))}
rm -f ${shellQuote(path.join(root, "HOST_FILTER_EXECUTED"))}
if git_config_is_safe ${shellQuote(path.join(source, ".git", "config"))}; then exit 1; fi
printf '[filter.hostile]\\nclean = %s\\n' ${shellQuote(path.join(root, "hostile-git-command"))} > ${shellQuote(path.join(root, "dotted-filter-config"))}
test "$(git -C ${shellQuote(root)} config --file ${shellQuote(path.join(root, "dotted-filter-config"))} --get filter.hostile.clean)" = ${shellQuote(path.join(root, "hostile-git-command"))}
if git_config_is_safe ${shellQuote(path.join(root, "dotted-filter-config"))}; then exit 1; fi
test ! -e ${shellQuote(path.join(root, "HOST_FILTER_EXECUTED"))}
git -C ${shellQuote(source)} config --unset-all core.fsmonitor
git -C ${shellQuote(source)} config --unset-all core.hooksPath
git -C ${shellQuote(source)} config --unset-all core.sshCommand
git -C ${shellQuote(source)} config --unset-all filter.hostile.clean
git -C ${shellQuote(source)} config --unset-all filter.hostile.smudge
mkdir -p ${shellQuote(path.join(home, "workspaces", "gemini"))}
printf 'LOCK_SENTINEL\\n' > ${shellQuote(path.join(root, "LOCK_SYMLINK_TARGET"))}
ln -s ${shellQuote(path.join(root, "LOCK_SYMLINK_TARGET"))} ${shellQuote(path.join(home, "workspaces", "gemini", ".repo.lock"))}
make_worktree gemini gemini/work
test "$(cat ${shellQuote(path.join(root, "LOCK_SYMLINK_TARGET"))})" = 'LOCK_SENTINEL'
test -d ${shellQuote(path.join(worktree, ".git"))}
test ! -L ${shellQuote(path.join(worktree, ".git"))}
test "$(git_isolation -C ${shellQuote(worktree)} branch --show-current)" = 'gemini/work'
test -f ${shellQuote(path.join(worktree, "README.md"))}
test -z "$(git_isolation -C ${shellQuote(worktree)} status --porcelain)"
test ! -e ${shellQuote(path.join(root, "HOST_FSMONITOR_EXECUTED"))}
test ! -e ${shellQuote(path.join(root, "HOST_FILTER_EXECUTED"))}
printf 'preserve hollow workspace\n' > ${shellQuote(path.join(worktree, "HOLLOW_SENTINEL"))}
rm -f ${shellQuote(path.join(worktree, ".git", "index"))}
hollow_output="$(make_worktree gemini gemini/work 2>&1)"
case "$hollow_output" in *"workspace was unsafe; preserved"*) ;; *) exit 1;; esac
test -f ${shellQuote(path.join(worktree, ".git", "index"))}
test -f ${shellQuote(path.join(worktree, "README.md"))}
test -z "$(git_isolation -C ${shellQuote(worktree)} status --porcelain)"
test -n "$(find ${shellQuote(path.dirname(worktree))} -maxdepth 2 -type f -name 'HOLLOW_SENTINEL' -print -quit)"
printf '[filter "hostile"]\\nclean = %s\\n' ${shellQuote(path.join(root, "hostile-git-command"))} > ${shellQuote(path.join(worktree, ".git", "config.worktree"))}
touch ${shellQuote(path.join(worktree, "payload.payload"))}
rm -f ${shellQuote(path.join(root, "HOST_FILTER_EXECUTED"))}
worktree_config_output="$(make_worktree gemini gemini/work 2>&1)"
test ! -e ${shellQuote(path.join(root, "HOST_FILTER_EXECUTED"))}
case "$worktree_config_output" in *"workspace was unsafe; preserved"*) ;; *) exit 1;; esac
test -d ${shellQuote(path.join(worktree, ".git"))}
test ! -e ${shellQuote(path.join(worktree, ".git", "config.worktree"))}
mv ${shellQuote(worktree)} ${shellQuote(worktree + ".saved")}
ln -s ${shellQuote(worktree + ".saved")} ${shellQuote(worktree)}
rm -f ${shellQuote(path.join(root, "HOST_FILTER_EXECUTED"))}
symlink_output="$(make_worktree gemini gemini/work 2>&1)"
test ! -e ${shellQuote(path.join(root, "HOST_FILTER_EXECUTED"))}
case "$symlink_output" in *"workspace was unsafe; preserved"*) ;; *) exit 1;; esac
test -d ${shellQuote(path.join(worktree, ".git"))}
test ! -L ${shellQuote(worktree)}
test -d ${shellQuote(path.join(worktree + ".saved", ".git"))}
mv ${shellQuote(worktree)} ${shellQuote(worktree + ".independent")}
git -C ${shellQuote(source)} worktree add -q -b gemini/work ${shellQuote(worktree)}
git -C ${shellQuote(worktree)} config extensions.worktreeConfig true
git -C ${shellQuote(worktree)} config --worktree filter.hostile.clean ${shellQuote(path.join(root, "hostile-git-command"))}
touch ${shellQuote(path.join(worktree, "payload.payload"))}
rm -f ${shellQuote(path.join(root, "HOST_FILTER_EXECUTED"))}
linked_output="$(make_worktree gemini gemini/work 2>&1)"
test ! -e ${shellQuote(path.join(root, "HOST_FILTER_EXECUTED"))}
case "$linked_output" in *"workspace was unsafe; preserved"*) ;; *) exit 1;; esac
test -d ${shellQuote(path.join(worktree, ".git"))}
test ! -L ${shellQuote(worktree)}
test -f ${shellQuote(path.join(worktree, "README.md"))}
test -z "$(git_isolation -C ${shellQuote(worktree)} status --porcelain)"
test -d ${shellQuote(path.join(worktree + ".independent", ".git"))}
REPO_LIST=('missing/first' 'owner/repo')
${selection}
test "$gemini_cwd" = ${shellQuote(worktree)}
ln -s ${shellQuote(source)} ${shellQuote(path.join(home, "workspaces", "gemini", "shared-link"))}
REPO_LIST=('owner/shared-link')
${selection}
test "$gemini_cwd" = "$HOME"
rm -f ${shellQuote(path.join(home, "workspaces", "gemini", "shared-link"))}
git_isolation -C ${shellQuote(worktree)} checkout -qb wrong/work
REPO_LIST=('owner/repo')
${selection}
test "$gemini_cwd" = "$HOME"
printf 'preserve this branch\\n' > ${shellQuote(path.join(worktree, "WRONG_BRANCH_SENTINEL"))}
quarantine_before="$(find ${shellQuote(path.dirname(worktree))} -maxdepth 1 -type d -name '.repo.quarantined-*' | wc -l | tr -d ' ')"
wrong_branch_output="$(make_worktree gemini gemini/work 2>&1)"
test -f ${shellQuote(path.join(worktree, "WRONG_BRANCH_SENTINEL"))}
test "$(find ${shellQuote(path.dirname(worktree))} -maxdepth 1 -type d -name '.repo.quarantined-*' | wc -l | tr -d ' ')" = "$quarantine_before"
case "$wrong_branch_output" in *"workspace is not on gemini/work"*"preserving it"*) ;; *) exit 1;; esac
git_isolation -C ${shellQuote(worktree)} checkout -q gemini/work
printf 'private\\n' > ${shellQuote(path.join(worktree, "private.txt"))}
test ! -e ${shellQuote(path.join(source, "private.txt"))}
make_worktree gemini gemini/work
test "$(git_isolation -C ${shellQuote(worktree)} branch --show-current)" = 'gemini/work'
test -z "$(find ${shellQuote(path.dirname(worktree))} -maxdepth 1 -type d -name 'repo.clone-*' -print -quit)"
rm -rf ${shellQuote(worktree)}
pids=()
for _ in {1..8}; do
    ( make_worktree gemini gemini/work ) & pids+=("$!")
done
for pid in "\${pids[@]}"; do wait "$pid"; done
test -d ${shellQuote(path.join(worktree, ".git"))}
test "$(git_isolation -C ${shellQuote(worktree)} branch --show-current)" = 'gemini/work'
test -z "$(find ${shellQuote(path.dirname(worktree))} -maxdepth 1 -type d -name 'repo.clone-*' -print -quit)"
test ! -e ${shellQuote(path.join(root, "HOST_FSMONITOR_EXECUTED"))}
test ! -e ${shellQuote(path.join(root, "HOST_FILTER_EXECUTED"))}
REPO_LIST=('owner/absent')
missing_output="$(make_worktree gemini gemini/work 2>&1)"
test ! -e ${shellQuote(path.join(home, "workspaces", "gemini", "absent"))}
case "$missing_output" in *"not a safe git repo under ~/work; skipping"*) ;; *) exit 1;; esac
REPO_LIST=('owner/repo')
rm -rf ${shellQuote(worktree)}
mkdir -p ${shellQuote(worktree)}
printf 'preserve me\\n' > ${shellQuote(path.join(worktree, "DAMAGE_SENTINEL"))}
damaged_output="$(make_worktree gemini gemini/work 2>&1)"
test -d ${shellQuote(path.join(worktree, ".git"))}
test -n "$(find ${shellQuote(path.dirname(worktree))} -maxdepth 2 -type f -name 'DAMAGE_SENTINEL' -print -quit)"
case "$damaged_output" in *"workspace was unsafe; preserved"*) ;; *) exit 1;; esac
${selection}
test "$gemini_cwd" = ${shellQuote(worktree)}
rm -rf ${shellQuote(path.join(home, "workspaces", "gemini"))}
df() { printf 'Filesystem 1K-blocks Used Available Use%% Mounted on\\n/dev/test 100 99 1 99%% /data\\n'; }
disk_output="$(
${diskGuard}
)"
test ! -e ${shellQuote(worktree)}
case "$disk_output" in *"Gemini stays outside shared ~/work"*) ;; *) exit 1;; esac
`;

  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  try {
    assert.doesNotThrow(() => execFileSync("bash", [scriptPath], { stdio: "pipe" }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
