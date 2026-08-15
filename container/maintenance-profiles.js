"use strict";

// Dormant Foundation-B candidate: the concrete §8 profile definitions for the
// governed AUTONOMOUS lane (BUILD-PLAN Phase 1f, Step 4c — the values). Scope
// decision (Steve, 2026-07-23): Foundation B governs the autonomous lane only;
// the interactive terminal/ttyd is untouched. First-activation surface is
// deliberately minimal + safest: the primary autonomous engine, Claude, running
// board work in a hard jail. Additional engines (gemini/codex/hermes) are
// additive follow-on profiles — each new profile re-freezes the contract digest,
// a controlled coordinated redeploy, so we do not front-load them.
//
// The repo identifiers and the worker uid/gid are DEPLOYMENT inputs (the user's
// chosen REPOS, the box's reserved jail uid), so this is a parametric factory,
// not a hardcoded literal: `buildFoundationProfiles({ repos, workerUid, workerGid })`.
// Feed it the deployment's compiled repo ids and it yields profile definitions
// the §8 compiler (maintenance-profile-catalog.js) validates + freezes; the
// resulting contract digest is deterministic for a given (repos, uid) input.
//
// DORMANT: imported by no boot path. Steve confirms the concrete repos/uid + the
// resulting digest at activation.

const AUTONOMOUS_RUN_KINDS = Object.freeze([
  "board_task", "board_runner", "git_ladder", "multi_loop", "loop", "wake_check", "mail_cycle", "brain",
]);

// Conservative ceilings for one governed autonomous worker. These are the fixed
// worst-case the launcher reserves against; they cap a runaway autonomous run.
const CLAUDE_LIMITS = Object.freeze({
  maxTokenUnits: 2_000_000,       // ~ a long autonomous task
  maxCostMicros: 10_000_000,      // $10 hard ceiling per worker
  maxLifetimeMs: 3_600_000,       // 1 hour wall-clock
  maxOutputBytes: 4_194_304,      // 4 MiB of captured output
});

// buildFoundationProfiles({ repos, workerUid?, workerGid? }) -> profile[]
//   repos      : the deployment's compiled repo ids (repo_<hex>) the autonomous
//                lane may operate on.
//   workerUid  : the reserved jail uid governed workers run as (default 10001 —
//                a non-agent, non-root id; the box provisions it at activation).
function buildFoundationProfiles({ repos, workerUid = 10001, workerGid = 10001 } = {}) {
  if (!Array.isArray(repos) || repos.length === 0) throw new Error("buildFoundationProfiles requires the deployment's repos");

  const claude = {
    id: "board_claude",
    engine: "claude",
    // {objective} is substituted by the launcher from the run's objective; the
    // arg template is FIXED — the caller never injects flags.
    // --dangerously-skip-permissions is REQUIRED for a headless run, exactly as
    // every proven gate.js `claude -p` run uses it (gate.js agentSpawnArgs): a
    // headless -p has no human to answer tool-use permission prompts, so without
    // it the worker blocks on the first gated tool and hangs to its deadline. The
    // JAIL is the boundary here (PID+mount ns, scrubbed env, worktree), so the
    // in-jail permission skip is the intended containment model, not a weakening.
    argvTemplate: ["claude", "-p", "{objective}", "--dangerously-skip-permissions"],
    runKinds: [...AUTONOMOUS_RUN_KINDS],
    repos: [...repos],
    uid: workerUid,
    gid: workerGid,
    caps: [],                        // no Linux capabilities
    supplementaryGroups: [],
    noNewPrivs: true,                // cannot regain privilege (setuid inert)
    envAllowlist: ["HOME", "PATH", "TERM", "LANG"],
    credential: "CLAUDE_CODE_OAUTH_TOKEN", // subscription-billed default (Cardinal Rule 9)
    workspace: "workspaces/board",   // beneath the trusted dir handle, no symlinks
    readOnlyMounts: ["/opt/agenthost"],
    writableMounts: ["workspaces/board"],
    // DECLARED-NOT-YET-ENFORCED (Rule 11 copy-vs-code): this states the INTENT —
    // the model API only, no general egress — but nothing in the boot path yet
    // reads it: launchContainedWithWorktree does NOT add `--net`/a netns and there
    // is no egress proxy. The D2 env scrub removed the high-value secret TARGETS
    // from the worker; the CHANNEL stays open (residual: worktree + the one OAuth
    // token). Enforcement (netns + inference-host allowlist proxy) is box-side work
    // that BLOCKS the flip. Until it lands, no user-facing copy may claim egress is
    // locked. See docs/PROD-FIX-PLAN-AND-RULE-CONSTITUTION §FIX2 step 3.
    network: "inference_only",
    limits: { ...CLAUDE_LIMITS },
  };

  return [claude];
}

module.exports = { buildFoundationProfiles, AUTONOMOUS_RUN_KINDS };
