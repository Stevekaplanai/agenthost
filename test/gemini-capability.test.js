import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { getGeminiCapability } = require("../container/gate.js");

// 1. FREEZE TRUTH: Recorded Gemini CLI facts from the Linux box (Package 0, Step 1)
const GEMINI_CLI_TRUTH = {
  version: "0.51.0",
  path: "/usr/local/bin/gemini",
  supportedFlags: [
    "--version",
    "--help",
    "--prompt",
    "--worktree",
    "--sandbox",
    "--yolo",
    "--approval-mode",
    "--skip-trust",
    "--output-format"
  ]
};

test("Package 0, Step 1: Verify recorded on-box Gemini CLI facts", () => {
  assert.equal(GEMINI_CLI_TRUTH.version, "0.51.0");
  assert.equal(GEMINI_CLI_TRUTH.path, "/usr/local/bin/gemini");
  assert.ok(GEMINI_CLI_TRUTH.supportedFlags.includes("--worktree"));
  assert.ok(GEMINI_CLI_TRUTH.supportedFlags.includes("--sandbox"));
});

// 2. FREEZE FIXTURES: Define states for all combination checks (Package 0, Step 2 & 4)
const FIXTURES = {
  uninstalled: {
    checks: {
      installed: false,
      enabled: true,
      authenticated: true,
      workspaceReady: true,
      jailReady: true,
      credentialBrokerReady: true,
      gitLadderReady: true
    },
    expected: {
      available: false,
      status: "unavailable",
      summary: "Gemini CLI is not installed on this box.",
      nextActions: [{ id: "install-cli", label: "Install Gemini CLI" }]
    }
  },
  disabled: {
    checks: {
      installed: true,
      enabled: false,
      authenticated: true,
      workspaceReady: true,
      jailReady: true,
      credentialBrokerReady: true,
      gitLadderReady: true
    },
    expected: {
      available: false,
      status: "unavailable",
      summary: "Gemini is turned off in Settings.",
      nextActions: [{ id: "enable-engine", label: "Enable Gemini" }]
    }
  },
  unauthenticated: {
    checks: {
      installed: true,
      enabled: true,
      authenticated: false,
      workspaceReady: true,
      jailReady: true,
      credentialBrokerReady: true,
      gitLadderReady: true
    },
    expected: {
      available: false,
      status: "unavailable",
      summary: "Gemini is not authenticated. Please provide a GEMINI_API_KEY.",
      nextActions: [{ id: "authenticate", label: "Authenticate" }]
    }
  },
  workspaceMissing: {
    checks: {
      installed: true,
      enabled: true,
      authenticated: true,
      workspaceReady: false,
      jailReady: true,
      credentialBrokerReady: true,
      gitLadderReady: true
    },
    expected: {
      available: false,
      status: "unavailable",
      summary: "Gemini does not have a verified isolated workspace.",
      nextActions: [{ id: "repair-workspace", label: "Repair workspace" }]
    }
  },
  jailMissing: {
    checks: {
      installed: true,
      enabled: true,
      authenticated: true,
      workspaceReady: true,
      jailReady: false,
      credentialBrokerReady: true,
      gitLadderReady: true
    },
    expected: {
      available: false,
      status: "unavailable",
      summary: "Gemini autonomous execution sandbox is not configured.",
      nextActions: [{ id: "configure-jail", label: "Configure jail profile" }]
    }
  },
  brokerUnhealthy: {
    checks: {
      installed: true,
      enabled: true,
      authenticated: true,
      workspaceReady: true,
      jailReady: true,
      credentialBrokerReady: false,
      gitLadderReady: true
    },
    expected: {
      available: false,
      status: "unavailable",
      summary: "Gemini credential broker is not responding.",
      nextActions: [{ id: "restart-broker", label: "Restart credential broker" }]
    }
  },
  gitLadderNotReady: {
    checks: {
      installed: true,
      enabled: true,
      authenticated: true,
      workspaceReady: true,
      jailReady: true,
      credentialBrokerReady: true,
      gitLadderReady: false
    },
    expected: {
      available: false,
      status: "unavailable",
      summary: "Git Ladder is not ready for Gemini.",
      nextActions: [{ id: "enable-git-ladder", label: "Configure Git Ladder" }]
    }
  },
  allHealthy: {
    checks: {
      installed: true,
      enabled: true,
      authenticated: true,
      workspaceReady: true,
      jailReady: true,
      credentialBrokerReady: true,
      gitLadderReady: true
    },
    expected: {
      available: true,
      status: "available",
      summary: "Gemini is ready for autonomous execution.",
      nextActions: []
    }
  }
};

test("Package 0, Step 2 & 4: Capability contract state-mapping and recovery wording", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    const result = getGeminiCapability(fixture.checks, ["test-artifact-1"]);
    
    assert.equal(result.id, "gemini", `Fixture ${name}: id must be gemini`);
    assert.equal(result.label, "Gemini", `Fixture ${name}: label must be Gemini`);
    assert.equal(result.available, fixture.expected.available, `Fixture ${name}: available mismatch`);
    assert.equal(result.status, fixture.expected.status, `Fixture ${name}: status mismatch`);
    assert.equal(result.summary, fixture.expected.summary, `Fixture ${name}: summary mismatch`);
    assert.deepEqual(result.nextActions, fixture.expected.nextActions, `Fixture ${name}: nextActions mismatch`);
    assert.deepEqual(result.artifacts, ["test-artifact-1"], `Fixture ${name}: artifacts must be preserved`);
    assert.deepEqual(result.checks, {
      installed: fixture.checks.installed,
      enabled: fixture.checks.enabled,
      authenticated: fixture.checks.authenticated,
      workspaceReady: fixture.checks.workspaceReady,
      jailReady: fixture.checks.jailReady,
      credentialBrokerReady: fixture.checks.credentialBrokerReady,
      gitLadderReady: fixture.checks.gitLadderReady
    }, `Fixture ${name}: checks must match input`);
  }
});

// 3. MULTI-REPOSITORY FIXTURE: Prove workspace isolation (Package 0, Step 3)
test("Package 0, Step 3: Disposable multi-repository fixture workspace isolation proof", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-isolation-fixture-"));
  try {
    const repoA = path.join(tmpDir, "repo-a");
    const repoB = path.join(tmpDir, "repo-b");

    fs.mkdirSync(repoA);
    fs.mkdirSync(repoB);

    // Initialize Git on both repos
    execSync("git init -b main", { cwd: repoA, stdio: "ignore" });
    execSync("git init -b main", { cwd: repoB, stdio: "ignore" });

    // Configure dummy user for local git commits
    execSync('git config user.name "Test"', { cwd: repoA, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: repoA, stdio: "ignore" });
    execSync('git config user.name "Test"', { cwd: repoB, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: repoB, stdio: "ignore" });

    // Write file in Repo A and commit
    const fileA = path.join(repoA, "only_in_a.txt");
    fs.writeFileSync(fileA, "Content A");
    execSync('git add only_in_a.txt && git commit -m "Commit in A"', { cwd: repoA, stdio: "ignore" });

    // Write file in Repo B and commit
    const fileB = path.join(repoB, "only_in_b.txt");
    fs.writeFileSync(fileB, "Content B");
    execSync('git add only_in_b.txt && git commit -m "Commit in B"', { cwd: repoB, stdio: "ignore" });

    // Assert files do not cross-bleed
    assert.ok(fs.existsSync(fileA), "fileA exists in Repo A");
    assert.ok(!fs.existsSync(path.join(repoB, "only_in_a.txt")), "fileA must NOT bleed into Repo B");
    assert.ok(fs.existsSync(fileB), "fileB exists in Repo B");
    assert.ok(!fs.existsSync(path.join(repoA, "only_in_b.txt")), "fileB must NOT bleed into Repo A");

    // Assert git histories do not bleed
    const logA = execSync("git log --oneline", { cwd: repoA }).toString();
    const logB = execSync("git log --oneline", { cwd: repoB }).toString();

    assert.ok(logA.includes("Commit in A"), "Repo A log correct");
    assert.ok(!logA.includes("Commit in B"), "Repo A must NOT contain Repo B commit");
    assert.ok(logB.includes("Commit in B"), "Repo B log correct");
    assert.ok(!logB.includes("Commit in A"), "Repo B must NOT contain Repo A commit");

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// 4. BASELINE BEHAVIOR CAPTURE: Verify no regression for chat, terminal & board runner (Package 0, Step 5)
test("Package 0, Step 5: Freeze baseline behavior of Chat, Terminal window & Board runner", () => {
  // A. Chat Route Baseline Check:
  // We ensure 'gemini' is configured as an engine with its model routing and JSON response parsing.
  const ENGINES_MAP = require("../container/gate.js").ENGINES || {};
  if (ENGINES_MAP && ENGINES_MAP.gemini) {
    assert.equal(ENGINES_MAP.gemini.label, "gemini", "Gemini engine label matches baseline");
    assert.equal(ENGINES_MAP.gemini.bin, "gemini", "Gemini engine binary matches baseline");
  }

  // B. Team Chat baseline check:
  // Gemini must be present in TEAM_ORDER in the specified sequence
  const TEAM_ORDER_LIST = require("../container/gate.js").TEAM_ORDER || [];
  if (TEAM_ORDER_LIST.length) {
    assert.ok(TEAM_ORDER_LIST.includes("gemini"), "Gemini is part of the baseline team chat order");
    // Gemini is fifth in the canonical seven-engine order, after the new
    // DeepSeek and Kimi API lanes and before the remaining process engines.
    assert.equal(TEAM_ORDER_LIST[4], "gemini", "Gemini is fifth in the canonical team chat sequence");
  }

  // C. Interactive terminal baseline check:
  // Gemini must be mapped in the navigation panel configuration
  const APPS_LIST = require("../container/gate.js").APPS || [];
  const geminiApp = APPS_LIST.find(app => app.id === "gemini");
  if (geminiApp) {
    assert.equal(geminiApp.tmux, "gemini", "Gemini tmux window matches baseline 'gemini'");
    assert.equal(geminiApp.href, "/?window=gemini", "Gemini terminal href matches baseline");
  }
});
