import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_IDS,
  cleanupOwnedWorktrees,
  createAgentWorktrees,
  reattachAgentWorktrees,
} from "../scripts/local-room.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-room-git-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "AgentHost Test"]);
  git(repo, ["config", "user.email", "agenthost-test@example.invalid"]);
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  git(repo, ["add", "shared.txt"]);
  git(repo, ["commit", "-m", "fixture"]);
  return { root, repo, stateDir: path.join(root, "state") };
}

test("room creates one branch and worktree per writing agent", () => {
  const item = fixture();
  const owned = createAgentWorktrees({
    sourceCwd: item.repo,
    stateDir: item.stateDir,
    roomId: "room-123",
  });
  try {
    assert.deepEqual(Object.keys(owned.workspaces), AGENT_IDS);
    assert.equal(new Set(Object.values(owned.workspaces).map((entry) => entry.path)).size, 4);
    assert.equal(new Set(Object.values(owned.workspaces).map((entry) => entry.branch)).size, 4);
    for (const id of AGENT_IDS) {
      const entry = owned.workspaces[id];
      assert.equal(entry.branch, `agenthost-room/room-123/${id}`);
      assert.equal(git(entry.path, ["branch", "--show-current"]), entry.branch);
      assert.equal(git(entry.path, ["rev-parse", "HEAD"]), owned.startCommit);
    }

    for (const id of AGENT_IDS) {
      fs.writeFileSync(path.join(owned.workspaces[id].path, "shared.txt"), `${id}\n`);
    }
    assert.deepEqual(
      AGENT_IDS.map((id) => fs.readFileSync(path.join(owned.workspaces[id].path, "shared.txt"), "utf8").trim()),
      AGENT_IDS,
    );
    assert.equal(fs.readFileSync(path.join(item.repo, "shared.txt"), "utf8"), "base\n");
  } finally {
    for (const entry of Object.values(owned.workspaces)) {
      try { git(item.repo, ["worktree", "remove", "--force", entry.path]); } catch {}
    }
  }
});

test("cleanup removes only clean room-owned worktrees and preserves dirty work", () => {
  const item = fixture();
  const owned = createAgentWorktrees({
    sourceCwd: item.repo,
    stateDir: item.stateDir,
    roomId: "room-cleanup",
  });
  fs.writeFileSync(path.join(owned.workspaces.kimi.path, "uncommitted.txt"), "keep me\n");

  const result = cleanupOwnedWorktrees(owned.manifestPath);
  assert.deepEqual(result.removed.sort(), ["claude", "codex", "hermes"]);
  assert.deepEqual(result.preserved, [{ engineId: "kimi", reason: "dirty" }]);
  assert.ok(fs.existsSync(path.join(owned.workspaces.kimi.path, "uncommitted.txt")));

  git(item.repo, ["worktree", "remove", "--force", owned.workspaces.kimi.path]);
});

test("branch collision fails instead of reusing somebody else's work", () => {
  const item = fixture();
  git(item.repo, ["branch", "agenthost-room/room-collision/claude"]);
  assert.throws(
    () => createAgentWorktrees({
      sourceCwd: item.repo,
      stateDir: item.stateDir,
      roomId: "room-collision",
    }),
    /branch already exists/i,
  );
});

test("controller restart reattaches the exact room-owned worktrees", () => {
  const item = fixture();
  const owned = createAgentWorktrees({
    sourceCwd: item.repo,
    stateDir: item.stateDir,
    roomId: "room-restart",
  });
  try {
    fs.writeFileSync(path.join(owned.workspaces.codex.path, "in-progress.txt"), "preserve\n");
    const reattached = reattachAgentWorktrees({
      sourceCwd: item.repo,
      stateDir: item.stateDir,
      roomId: "room-restart",
    });
    assert.equal(reattached.ownerNonce, owned.ownerNonce);
    assert.equal(reattached.manifestPath, owned.manifestPath);
    assert.deepEqual(reattached.workspaces, owned.workspaces);
    assert.ok(fs.existsSync(path.join(reattached.workspaces.codex.path, "in-progress.txt")));
  } finally {
    for (const entry of Object.values(owned.workspaces)) {
      try { git(item.repo, ["worktree", "remove", "--force", entry.path]); } catch {}
    }
  }
});

test("reattach fails closed when a worktree identity no longer matches", () => {
  const item = fixture();
  const owned = createAgentWorktrees({
    sourceCwd: item.repo,
    stateDir: item.stateDir,
    roomId: "room-tampered",
  });
  try {
    git(owned.workspaces.hermes.path, ["checkout", "--detach"]);
    assert.throws(
      () => reattachAgentWorktrees({
        sourceCwd: item.repo,
        stateDir: item.stateDir,
        roomId: "room-tampered",
      }),
      /identity changed for hermes/i,
    );
  } finally {
    for (const entry of Object.values(owned.workspaces)) {
      try { git(item.repo, ["worktree", "remove", "--force", entry.path]); } catch {}
    }
  }
});

test("reattach rejects an independent repository impersonating a room worktree", () => {
  const item = fixture();
  const owned = createAgentWorktrees({
    sourceCwd: item.repo,
    stateDir: item.stateDir,
    roomId: "room-impostor",
  });
  const hermes = owned.workspaces.hermes;
  try {
    git(item.repo, ["worktree", "remove", "--force", hermes.path]);
    fs.mkdirSync(hermes.path);
    git(hermes.path, ["init", "-b", hermes.branch]);
    git(hermes.path, ["config", "user.name", "Impostor Test"]);
    git(hermes.path, ["config", "user.email", "impostor@example.invalid"]);
    fs.writeFileSync(path.join(hermes.path, "shared.txt"), "impostor\n");
    git(hermes.path, ["add", "shared.txt"]);
    git(hermes.path, ["commit", "-m", "impostor"]);

    assert.throws(
      () => reattachAgentWorktrees({
        sourceCwd: item.repo,
        stateDir: item.stateDir,
        roomId: "room-impostor",
      }),
      /identity changed for hermes/i,
    );
  } finally {
    for (const [engineId, entry] of Object.entries(owned.workspaces)) {
      if (engineId === "hermes") {
        fs.rmSync(entry.path, { recursive: true, force: true });
      } else {
        try { git(item.repo, ["worktree", "remove", "--force", entry.path]); } catch {}
      }
    }
  }
});
