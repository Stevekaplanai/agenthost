"use strict";

// Foundation B chat-engine RUNNER (root-side). The root authority owns this; gate
// (uid 999) is a pure client. Given a validated request {runId, engineId, prompt,
// withContinue, sessionId}, the runner:
//   1. looks up the FIXED profile (maintenance-chat-profiles.js) — unknown engineId
//      fast-fails, so gate can never name an arbitrary bin;
//   2. validates sessionId against the profile's anchored grammar (a bad id is
//      DROPPED, never reaching argv — for codex the "--" terminator is a second wall);
//   3. substitutes {prompt}/{promptWithCharter}/{sessionId} into a COPY of the
//      template as single argv ELEMENTS (never concatenated, never a flag);
//   4. builds env from the profile's NAME allowlist (from the runner's OWN root env)
//      plus credentialNames read BY NAME from secrets.env root-side — it NEVER merges
//      the whole gate-writable secrets.env, so a planted LD_PRELOAD/NODE_OPTIONS/
//      BASH_ENV can't reach the engine (closes the loadBoxSecrets injection class);
//   5. drops to uid agent via setpriv (--init-groups keeps agent's supplementary
//      groups incl. boxstate; --no-new-privs preserved) and execs the engine, which
//      then runs AS AGENT with agent's real HOME — the whole point;
//   6. streams child stdout/stderr/exit(code+signal) back via onOutput/onExit.
//
// This mirrors how PID-1 already spawns the agent stack (setpriv --reuid=agent),
// and the tmux seam's boundary (gate expresses a fixed request; the owning side
// executes; gate injects nothing). NO native-C change. --no-new-privs intact.

const fs = require("node:fs");
const nodePath = require("node:path");
const {
  launchProcessTreeContained,
  launchSetuidBwrapProcessTreeContained,
  teardown,
} = require("./maintenance-containment.js");
const { proveGone: proveChildGone } = require("./maintenance-child-observe.js");
const { buildBwrapReadJail, redactSecrets } = require("./chains-lib.js");
const { relayCapabilityForRun } = require("./dsh-inference-relay.js");
const { createAgentLaneArbiter } = require("./maintenance-agent-lane.js");
const { execFileSync } = require("node:child_process");

// Where the granted worktree appears INSIDE the jail. Codex is pointed here with
// -C, and it is the only writable path the model is given besides CODEX_HOME.
const JAIL_WORKSPACE = "/workspace";
const CODEX_CLI = "/usr/local/bin/codex";
const DSH_RUNNER = "/opt/agenthost/dsh-headless-runner.js";
const DSH_RUNTIME = "/opt/deepseek-harness";
const DSH_PATCH = "/opt/agenthost/dsh-secure.patch.yml";
const DSH_EMPTY_ENV = "/opt/agenthost/dsh-empty.env";
const DSH_JAIL_RELAY = "/run/agenthost-dsh/relay.sock";
const SETUID_BWRAP_LAUNCH = Symbol("setuid-bwrap-launch");

// The autonomous codex command line, authored ROOT-SIDE and by absolute path.
// A static array for the same reason maintenance-chat-profiles.js keeps the chat
// templates static: the gate must never be able to name a bin or a flag. The
// prompt is the LAST element, after "--", so it can never reach flag position.
function autonomousCodexArgv(prompt) {
  return [
    CODEX_CLI,
    "exec", "--json", "--ephemeral",
    "--sandbox", "workspace-write",
    "--ignore-user-config", "--strict-config", "--ignore-rules",
    "-c", 'approval_policy="never"',
    "--skip-git-repo-check", "-C", JAIL_WORKSPACE,
    "--color", "never", "--", prompt,
  ];
}

// The engine identity to drop to. Agent is 1001 on the box; kept injectable for tests.
const DEFAULT_AGENT_UID = 1001;
const DEFAULT_AGENT_GID = 1001;

// A per-run hard timeout: even if gate never sends kill (or dies), a hung engine is
// SIGKILLed so it can't wedge agent resources forever. 30 min covers the longest
// legitimate chat/cron turn with headroom.
const CHAT_HARD_MS = 30 * 60 * 1000;
const AGENT_LANE_BUSY_ERROR = "agent_lane_busy";
const AGENT_USER = "agent";

// Read specific credential NAMES from secrets.env, root-side. Returns {NAME: value}
// for ONLY the requested names — never the whole file, so unrequested (and
// dangerous-loader) names are structurally excluded.
function readCredentials(secretsPath, names, readFileSync = fs.readFileSync) {
  if (!names || names.length === 0) return {};
  const want = new Set(names);
  const out = {};
  let text;
  try { text = readFileSync(secretsPath, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]{2,63})=(.*)$/.exec(line.trim());
    if (m && want.has(m[1])) out[m[1]] = m[2];
  }
  return out;
}

// Build the engine env: ONLY the allowlisted NAMES from the runner's own env, plus
// the requested credential names read root-side. Never a blanket merge.
function buildEngineEnv(profile, { rootEnv, secretsPath, readFileSync, agentHome } = {}) {
  const env = {};
  const src = rootEnv || process.env;
  const allowed = new Set(profile.envAllowlist || []);
  for (const name of allowed) {
    if (Object.prototype.hasOwnProperty.call(src, name) && src[name] !== undefined) env[name] = src[name];
  }
  const credentials = readCredentials(secretsPath, profile.credentialNames || [], readFileSync);
  Object.assign(env, credentials);
  // Fixed profile values are authored in the root-owned profile table, never
  // copied from the caller or secrets.env. Assist uses this to disable Claude's
  // optional thinking trace without widening its environment allowlist.
  if (profile.fixedEnv && typeof profile.fixedEnv === "object") Object.assign(env, profile.fixedEnv);
  // GITHUB_TOKEN is the one operator-entered value. `gh` and the official
  // GitHub MCP use different names, so derive both aliases without reading or
  // accepting extra secret-file keys. Only profiles that explicitly allow an
  // alias receive it, and a protected value replaces stale root-env aliases.
  if (Object.prototype.hasOwnProperty.call(credentials, "GITHUB_TOKEN")) {
    for (const alias of ["GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"]) {
      if (allowed.has(alias)) env[alias] = credentials.GITHUB_TOKEN;
    }
  }
  // COMMON_ALLOW contains HOME, USER and LOGNAME, and the source it copies from
  // is ROOT'S env -- this runner is spawned by PID 1 -- so the engine inherited
  // HOME=/root and announced itself as root. setpriv then dropped it to uid
  // agent, which cannot write /root (drwx------ root root), and every engine
  // died reaching for its own config directory:
  //   hermes -> /root/.hermes/.env            PermissionError
  //   codex  -> /root/.codex/config.toml      Permission denied
  //   cursor -> /root/.cursor/projects/...    EACCES
  //   claude -> /root/.claude/session-env/... EACCES
  // Gemini and Kimi were unaffected only because they authenticate from an API
  // key and never open a credential file, which is why exactly those two
  // answered for a full day while the other four looked broken.
  //
  // deliver() below has always hardcoded HOME/USER/LOGNAME to the agent for the
  // channel path. The engine path read them from the allowlist instead. Same
  // file, ~130 lines apart, one correct and one not. Force the identity here so
  // the call site's own comment -- "the engine runs AS AGENT with its real HOME"
  // -- is finally true.
  if (agentHome) {
    env.HOME = agentHome;
    env.USER = AGENT_USER;
    env.LOGNAME = AGENT_USER;
  }
  return env;
}

// Substitute the sentinels into a template copy, each as ONE argv element.
function resolveArgv(template, { prompt, promptWithCharter, sessionId }) {
  return template.map((a) => {
    if (a === "{prompt}") return prompt;
    if (a === "{promptWithCharter}") return promptWithCharter;
    if (a === "{sessionId}") return sessionId;
    return a;
  });
}

// Pick the template for this run: claude fresh/continue; hermes/codex fresh/resume.
function selectTemplate(profile, { withContinue, hasValidSession }) {
  if (profile.supportsContinue && withContinue && profile.argvTemplateContinue) return profile.argvTemplateContinue;
  if (hasValidSession && profile.argvTemplateResume) return profile.argvTemplateResume;
  return profile.argvTemplate;
}

function promptStdinProfileError(profile, template) {
  if (profile.stdin !== "prompt") return null;
  if (profile.promptSentinel !== "{prompt}" && profile.promptSentinel !== "{promptWithCharter}") {
    return "prompt_stdin_profile_invalid: unsupported prompt sentinel";
  }
  if (!Array.isArray(template)) return "prompt_stdin_profile_invalid: argv template is not an array";
  if (template.some((arg) => arg === "{prompt}" || arg === "{promptWithCharter}")) {
    return "prompt_stdin_profile_invalid: argv template contains a prompt sentinel";
  }
  return null;
}

// createChatRunner({ profiles, secretsPath, withCharter, uid?, gid?, onOutput, onExit, spawn?, now? })
//   profiles   : frozen map from buildChatProfiles
//   secretsPath: /data/home/agent/.agenthost/secrets.env (read root-side, by name only)
//   withCharter: (prompt) => charter-prefixed prompt (bound to EFFECTIVE_CHARTER)
//   onOutput   : (runId, stream:"stdout"|"stderr", text) => void
//   onExit     : (runId, { exitCode, signalName }) => void
function createChatRunner({
  profiles, secretsPath, withCharter,
  uid = DEFAULT_AGENT_UID, gid = DEFAULT_AGENT_GID,
  onOutput = () => {}, onExit = () => {},
  agentLaneArbiter,
  assistLaneArbiter = null,
  launchContained = launchProcessTreeContained,
  launchSetuidBwrapContained = launchSetuidBwrapProcessTreeContained,
  teardownContained = teardown,
  proveGone = proveChildGone,
  now = Date.now, rootEnv = process.env, readFileSync = fs.readFileSync,
  relaySocketStat = fs.lstatSync,
  relayCapability = relayCapabilityForRun,
  openSource = fs.openSync,
  closeSource = fs.closeSync,
  statSource = fs.fstatSync,
  agentHome = "/data/home/agent",
  hardMs = CHAT_HARD_MS,
} = {}) {
  if (!profiles) throw new Error("createChatRunner requires profiles");
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error("createChatRunner requires numeric uid/gid");
  if (!agentLaneArbiter || typeof agentLaneArbiter.acquire !== "function" ||
      typeof agentLaneArbiter.release !== "function" || typeof agentLaneArbiter.trip !== "function") {
    throw new Error("createChatRunner requires a root agent-lane arbiter");
  }
  const assistArbiter = assistLaneArbiter || createAgentLaneArbiter();
  const ownProfile = (engineId) => (
    typeof engineId === "string" && Object.prototype.hasOwnProperty.call(profiles, engineId)
      ? profiles[engineId]
      : null
  );

  // The engine credential's own bytes, read ROOT-SIDE, for the output filter
  // below. Cached because it is read per run and the file changes only when the
  // engine rotates its token; a rotation mid-run would at worst miss the new
  // value for one run, which is why the cache is short-lived rather than
  // permanent.
  //
  // Values shorter than 20 characters are ignored: redactSecrets already skips
  // under 8, and anything short enough to collide with ordinary output would
  // corrupt legitimate text while protecting nothing. Reading is best-effort --
  // a missing or unparsable file yields an empty list and the filter becomes a
  // no-op, never an error that stops a run.
  let secretCache = { at: 0, values: [] };
  let secretReadWarned = false;
  function engineSecretValues() {
    const nowMs = now();
    if (secretCache.values.length && nowMs - secretCache.at < 60000) return secretCache.values;
    const found = [];
    try {
      const raw = readFileSync(agentHome + "/.codex/auth.json", "utf8");
      const walk = (v) => {
        if (typeof v === "string") { if (v.length >= 20) found.push(v); return; }
        if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k]);
      };
      walk(JSON.parse(raw));
    } catch (e) {
      // A SECURITY CONTROL THAT TURNS ITSELF OFF MUST SAY SO.
      //
      // Failing open here is right -- an unreadable credential must not stop a
      // run -- but a bare `catch {}` meant the filter could silently become a
      // no-op and nothing would ever indicate it. That is the same shape as the
      // discarded stderr that cost six hours on 2026-08-01, applied to a
      // control rather than a diagnosis.
      //
      // Warned ONCE per runner, not per run: this is read on every run, and a
      // line per run would bury the signal it exists to give.
      if (!secretReadWarned) {
        secretReadWarned = true;
        console.error("[runner] output redaction inactive: cannot read the engine credential ("
          + String((e && e.message) || e).slice(0, 120) + ")");
      }
    }
    secretCache = { at: nowMs, values: found };
    return found;
  }

  const runs = new Map(); // runId -> { child, timer }
  let laneOwnerRunId = null;
  let assistLaneOwnerRunId = null;

  // Per-call onOutput/onExit override the constructor defaults — the chat server
  // multiplexes many runs over one connection and needs per-run demux callbacks.
  function run({
    runId, engineId, prompt, withContinue = false, sessionId = null,
    onOutput: outCb, onExit: exitCb,
    prepared = null, laneKind = "chat",
  } = {}) {
    const emitOut = outCb || onOutput;
    const emitExit = exitCb || onExit;
    if (!runId) throw new Error("run requires a runId");
    const isAssist = engineId === "claude-assist";
    const lane = isAssist ? assistArbiter : agentLaneArbiter;
    const laneKindName = isAssist ? "assist" : laneKind;
    const laneBusyError = isAssist ? "assist_lane_busy" : AGENT_LANE_BUSY_ERROR;
    const laneOwner = () => isAssist ? assistLaneOwnerRunId : laneOwnerRunId;
    const setLaneOwner = (value) => {
      if (isAssist) assistLaneOwnerRunId = value;
      else laneOwnerRunId = value;
    };
    if (runs.has(runId) || laneOwner() === runId) {
      // A duplicate must never receive a terminal frame with the live owner's
      // id; that could impersonate the real child exit at the gateway.
      return { runId, duplicate: true };
    }
    if (laneOwner() !== null) {
      emitExit(runId, {
        exitCode: null,
        signalName: null,
        error: laneBusyError,
      });
      return { runId, accepted: false };
    }
    const profile = prepared ? prepared.profile : ownProfile(engineId);
    // Unknown/forbidden engineId: fast-fail, spawn NOTHING. gate can never name a bin.
    if (!profile) { emitExit(runId, { exitCode: null, signalName: null, error: "unknown_engine" }); return { runId }; }

    // Validate the resume id against the profile's anchored grammar; a bad id is
    // dropped (run fresh), never substituted into argv.
    let validSession = null;
    if (sessionId != null && profile.sessionIdGrammar && profile.sessionIdGrammar.test(String(sessionId))) {
      validSession = String(sessionId);
    }
    const hasValidSession = validSession !== null;

    const template = prepared ? [] : selectTemplate(profile, { withContinue, hasValidSession });
    const promptProfileError = promptStdinProfileError(profile, template);
    if (promptProfileError) {
      emitExit(runId, { exitCode: null, signalName: null, error: promptProfileError });
      return { runId, accepted: false };
    }

    // Compose the prompt server-side exactly as gate.js does.
    const rawPrompt = String(prompt == null ? "" : prompt);
    const promptWithCharter = withCharter ? withCharter(rawPrompt) : rawPrompt;

    const argv = prepared
      ? prepared.argv
      : resolveArgv(template, { prompt: rawPrompt, promptWithCharter, sessionId: validSession });

    // A prompt-stdin profile carries NO prompt sentinel in its template, so the
    // resolved argv above is already prompt-free. The same composed text the
    // sentinel would have received is written to the child instead, byte for
    // byte -- the transport changes, the content does not.
    const promptForStdin = profile.stdin === "prompt"
      ? (profile.promptSentinel === "{promptWithCharter}" ? promptWithCharter : rawPrompt)
      : "";
    const stdinPayload = prepared && typeof prepared.stdinPrefix === "string"
      ? `${prepared.stdinPrefix}\n${promptForStdin}`
      : promptForStdin;

    const env = prepared
      ? prepared.env
      : buildEngineEnv(profile, { rootEnv, secretsPath, readFileSync, agentHome });

    // Drop to agent via setpriv. --init-groups keeps agent's supplementary groups
    // (incl. boxstate); --no-new-privs preserved (never weaken the split). The engine
    // runs AS AGENT with its real HOME (env.HOME from the allowlist), so it can write
    // .claude/.gemini/.codex/.hermes — the whole fix.
    // Reserve through the ONE boot-owned arbiter shared with Foundation-B
    // work.start. The opaque lease is retained through namespace terminal proof.
    const laneLease = lane.acquire(`${laneKindName}:${runId}`);
    if (!laneLease) {
      emitExit(runId, {
        exitCode: null,
        signalName: null,
        error: laneBusyError,
      });
      return { runId, accepted: false };
    }

    let handle;
    let child;
    setLaneOwner(runId);
    const sourceFds = [];
    try {
      const launchStdin = profile.stdin === "ignore" ? "ignore" : profile.stdin === "prompt" ? "pipe" : "inherit";
      if (prepared && prepared.launchAuthority === SETUID_BWRAP_LAUNCH) {
        if (argv[0] !== "/usr/bin/bwrap" || !Array.isArray(prepared.sourcePaths)
            || prepared.sourcePaths.length !== 1 || !Array.isArray(prepared.sourceIdentities)
            || prepared.sourceIdentities.length !== prepared.sourcePaths.length) {
          const error = new Error("dsh_root_launch_contract_invalid");
          error.conclusiveNoChild = true;
          throw error;
        }
        const flags = fs.constants.O_RDONLY
          | (fs.constants.O_DIRECTORY || 0)
          | (fs.constants.O_NOFOLLOW || 0);
        let fd;
        try {
          fd = openSource(prepared.sourcePaths[0], flags);
          sourceFds.push(fd);
        } catch {
          const error = new Error("dsh_worktree_pin_open_failed");
          error.conclusiveNoChild = true;
          throw error;
        }
        let pinned;
        try {
          pinned = statSource(fd);
        } catch {
          const error = new Error("dsh_worktree_pin_stat_failed");
          error.conclusiveNoChild = true;
          throw error;
        }
        const expected = prepared.sourceIdentities[0];
        if (!pinned.isDirectory() || !expected
            || String(pinned.dev) !== String(expected.dev) || String(pinned.ino) !== String(expected.ino)) {
          const error = new Error("dsh_worktree_pin_not_directory");
          if (pinned.isDirectory()) error.message = "dsh_worktree_pin_identity_changed";
          error.conclusiveNoChild = true;
          throw error;
        }
        const pinnedBranchTarget = process.platform === "linux"
          ? `/proc/${process.pid}/fd/${fd}`
          : prepared.sourcePaths[0];
        const pinnedBranch = worktreeBranch(pinnedBranchTarget, prepared.sourcePaths[0]);
        if (!pinnedBranch) {
          const error = new Error("dsh_worktree_pin_branch_unreadable");
          error.conclusiveNoChild = true;
          throw error;
        }
        if (pinnedBranch !== expected.branch) {
          const error = new Error("dsh_worktree_pin_branch_changed");
          error.conclusiveNoChild = true;
          throw error;
        }
        handle = launchSetuidBwrapContained({
          bwrapArgs: argv.slice(1),
          sourceFds,
          uid,
          gid,
          cwd: profile.cwd,
          env,
          stdin: launchStdin,
        });
      } else {
        handle = launchContained({
          argv: prepared ? argv : [profile.bin, ...argv],
          uid,
          gid,
          cwd: profile.cwd,
          env,
          stdin: launchStdin,
        });
      }
      child = handle.child;
    } catch (error) {
      if (error && error.conclusiveNoChild === true) {
        lane.release(laneLease);
        if (laneOwner() === runId) setLaneOwner(null);
      } else {
        lane.trip(`${laneKindName}_namespace_launch_unproven`);
        const uncertainChild = error && error.containmentHandle && error.containmentHandle.child;
        if (uncertainChild && typeof uncertainChild.on === "function") uncertainChild.on("error", () => {});
        if (error && typeof error.launcherFailureCause === "function") {
          // The launcher is observed synchronously, so its pipe callbacks run
          // only after this stack unwinds. Emit the bounded real stderr one tick
          // later while still withholding a forged terminal exit frame.
          setTimeout(() => {
            let detail = "";
            try { detail = String(error.launcherFailureCause() || "").slice(0, 240); } catch {}
            const cause = String((error && error.message) || "dsh_namespace_launch_unproven").slice(0, 80);
            try { emitOut(runId, "stderr", `${cause}${detail ? `: ${detail}` : ""}\n`); } catch {}
          }, 25);
        }
        // No root exit frame: an unproven process tree is not a terminal event.
        // The root latch + missing terminal frame force the gate watchdog to
        // quarantine instead of accepting a forged completion.
        return { runId, accepted: false };
      }
      emitExit(runId, {
        exitCode: null,
        signalName: null,
        error: String(error.code || error),
      });
      return { runId, accepted: false };
    } finally {
      // The child received duplicates at fd 3+n. Root must not retain an open
      // directory capability for the duration of an untrusted task.
      for (const fd of sourceFds) {
        try { closeSource(fd); } catch {}
      }
    }

    const rec = { child, handle, laneLease, timer: null };
    runs.set(runId, rec);

    let settled = false;
    let flushOutput = () => {};
    const settle = (info) => {
      if (settled) return; settled = true;
      if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
      runs.delete(runId);
      if (laneOwner() === runId) setLaneOwner(null);
      let terminalProven = false;
      try { terminalProven = proveGone(handle.namespaceIdentity) === true; } catch {}
      if (!terminalProven) {
        lane.trip(`${laneKindName}_namespace_terminal_unproven`);
        // Never convert uncertainty into a trustworthy terminal frame.
        return;
      }
      if (!lane.release(laneLease)) {
        lane.trip(`${laneKindName}_lane_release_rejected`);
        // Never convert a rejected root release into terminal proof.
        return;
      }
      try { flushOutput(); } catch {}
      try { emitExit(runId, info); } catch {}
    };
    // Emit BOTH code AND signalName so the caller can tell a killed run from a real
    // nonzero exit (the first-message -c retry needs this).
    let processError = null;
    let outputOverflowed = false;
    try {
      // Attach terminal listeners first. Nothing after spawn may claim an exit
      // unless this close event arrives.
      child.once("close", (code, signal) => settle({
        exitCode: outputOverflowed ? null : code,
        signalName: signal || null,
        ...(processError ? { error: processError } : {}),
      }));
      child.once("error", (err) => {
        processError = String((err && err.code) || err);
        // Spawn failures have no child pid and are terminal. An error from a
        // process that already exists (including a failed kill) is not exit proof;
        // retain ownership until close or the broker connection is quarantined.
        // A contained engine already has an observed namespace init. An error is
        // never terminal proof; retain ownership until the containment closes.
      });

      // CLOSE STDIN. These are one-shot runs: the prompt is argv, nothing is ever
      // written to the child, and an open stdin means the engine waits for input
      // that will never arrive. Codex says so out loud -- "Reading additional input
      // from stdin..." -- and then never completes its turn, so the verdict event
      // is never emitted. On 2026-08-09 that took autonomous dispatch down for
      // hours: the classifier streamed a preamble, timed out at 10s, gated the
      // card and parked it, while the engine sat blocked. Four correct fixes to
      // the settle path, the decoder, the timeout and the mount were all
      // irrelevant -- there was never an answer to put through them.
      //
      // Verified by hand on the box hours earlier and not connected: the identical
      // hang, cured by `codex exec ... </dev/null`. This is that redirect, applied
      // where every engine gets it.
      //
      // ONE profile writes before it closes: a prompt-stdin engine. Its prompt
      // is built from attacker-controlled website text, so it must never reach
      // argv, where a process list would expose a customer's site content and
      // the OS argv cap would truncate it. It still ends immediately after the
      // single write, so the one-shot contract above is unchanged.
      if (child.stdin) {
        try {
          if (profile.stdin === "prompt") {
            // A broken pipe here is the engine dying before it read; that is
            // reported by the exit path. What must not happen is an unhandled
            // error event taking the gate down with it.
            child.stdin.on("error", (err) => {
              if (!processError) processError = "prompt stdin " + String((err && err.code) || err);
            });
            child.stdin.write(stdinPayload);
          }
          child.stdin.end();
        } catch (err) {
          if (!processError) processError = "prompt stdin " + String((err && err.code) || err);
        }
      }
      // THE ENGINE'S OWN CREDENTIAL MUST NOT LEAVE ON ITS STDOUT.
      //
      // The gate cannot open auth.json -- that boundary holds and is the point of
      // the identity split. But a compromised gate does not need to open it: it
      // can ask the engine, which runs AS AGENT and must read the file to
      // authenticate, to print it. The bytes then come back through this exact
      // pipe as ordinary output. No permission is broken anywhere in that chain.
      //
      // Root is the only party that can see BOTH the file and the stream, so
      // root is where the filter belongs. redactSecrets already covers base64,
      // base64url (padded and unpadded) and lowercase hex, not just the literal
      // value.
      //
      // THIS IS A MITIGATION, NOT A FIX, and the limits are stated rather than
      // implied:
      //   - it cannot catch an arbitrary transformation a model invents
      //     (reversed, chunked into words, described in prose);
      //   - a value split ACROSS two stream chunks is not matched, because each
      //     chunk is filtered independently. Holding a tail back to catch that
      //     would delay streaming output and needs a flush-on-exit path; it is
      //     deliberately not done here rather than done badly.
      // The real fix is a scoped, short-lived token so the value on disk is not
      // worth exfiltrating.
      const profileEnvSecrets = (profile.redactEnvNames || [])
        .map((name) => env[name])
        .filter((value) => typeof value === "string" && value.length >= 20);
      const secretForms = [...new Set([...engineSecretValues(), ...profileEnvSecrets])];
      const scrub = (text) => {
        if (!secretForms.length) return text;
        try { return redactSecrets(text, secretForms); } catch { return text; }
      };
      const buffered = profile.bufferOutputUntilExit === true ? { stdout: "", stderr: "" } : null;
      const lineBuffered = profile.lineBufferedOutput === true ? { stdout: "", stderr: "" } : null;
      const outputBufferMaxChars = Math.min(
        Number.isInteger(profile.outputBufferMaxChars) && profile.outputBufferMaxChars > 0
          ? profile.outputBufferMaxChars
          : 65536,
        1024 * 1024,
      );
      const captureOutput = (stream, chunk) => {
        const text = chunk.toString();
        if (lineBuffered) {
          lineBuffered[stream] += text;
          if (lineBuffered[stream].length > outputBufferMaxChars) {
            processError = `${laneKindName} output exceeded ${outputBufferMaxChars} characters without a line boundary`;
            try { teardownContained(handle); } catch {}
            return;
          }
          let newline;
          while ((newline = lineBuffered[stream].indexOf("\n")) !== -1) {
            const complete = lineBuffered[stream].slice(0, newline + 1);
            lineBuffered[stream] = lineBuffered[stream].slice(newline + 1);
            try { emitOut(runId, stream, scrub(complete)); } catch {}
          }
          return;
        }
        if (!buffered) {
          try { emitOut(runId, stream, scrub(text)); } catch {}
          return;
        }
        const remaining = outputBufferMaxChars - buffered[stream].length;
        if (remaining > 0) buffered[stream] += text.slice(0, remaining);
        if (!outputOverflowed && text.length > Math.max(0, remaining)) {
          outputOverflowed = true;
          processError = `${profile.engineId} ${stream} exceeded the ${outputBufferMaxChars}-character buffer`;
          try { teardownContained(handle); } catch {}
        }
      };
      flushOutput = () => {
        if (lineBuffered) {
          for (const stream of ["stdout", "stderr"]) {
            if (!lineBuffered[stream]) continue;
            try { emitOut(runId, stream, scrub(lineBuffered[stream])); } catch {}
            lineBuffered[stream] = "";
          }
          return;
        }
        if (!buffered) return;
        if (outputOverflowed) {
          buffered.stdout = "";
          buffered.stderr = "";
          return;
        }
        for (const stream of ["stdout", "stderr"]) {
          if (!buffered[stream]) continue;
          try { emitOut(runId, stream, scrub(buffered[stream])); } catch {}
          buffered[stream] = "";
        }
      };
      if (child.stdout) child.stdout.on("data", (b) => captureOutput("stdout", b));
      if (child.stderr) child.stderr.on("data", (b) => captureOutput("stderr", b));

      // Belt: SIGKILL a hung engine even if the caller never sends kill.
      rec.timer = setTimeout(() => { try { teardownContained(handle); } catch {} }, prepared && prepared.hardMs || hardMs);
      if (rec.timer.unref) rec.timer.unref();
    } catch (error) {
      processError = String((error && error.code) || error || "runner setup failed");
      try { teardownContained(handle); } catch {}
      // If close-listener setup itself failed, no exit frame is emitted. The
      // gate-side socket loss/watchdog then marks termination unproven and
      // quarantines instead of launching a replacement.
    }

    return { runId, accepted: true };
  }

  // Fixed-purpose delivery verb for the authenticated gate socket. The gate may
  // supply only data; root chooses the executable, argv shape, identity, cwd,
  // and environment. OpenClaw reads agent-owned configuration, so it must run as
  // uid agent and never as the token-holding gate identity.
  function deliver({ runId, channel, target, message, onOutput: outCb, onExit: exitCb } = {}) {
    const emitExit = exitCb || onExit;
    if (!runId) throw new Error("delivery requires a runId");
    const targetValid = channel === "telegram"
      ? typeof target === "string" && /^(?:-?\d{1,32}|@[A-Za-z0-9_]{1,64})$/.test(target)
      : channel === "discord"
        && typeof target === "string" && /^(?:user|channel):\d{1,32}$/.test(target);
    if ((channel !== "telegram" && channel !== "discord")
        || !targetValid
        || typeof message !== "string" || message.length < 1 || message.length > 4096
        || message.includes("\0")) {
      emitExit(runId, { exitCode: null, signalName: null, error: "invalid_delivery" });
      return { runId, accepted: false };
    }
    const env = {
      HOME: agentHome,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      USER: "agent",
      LOGNAME: "agent",
      SHELL: "/bin/bash",
      LANG: rootEnv.LANG || "C.UTF-8",
      TERM: rootEnv.TERM || "dumb",
      NO_COLOR: "1",
      OPENCLAW_HOST: "127.0.0.1",
      ...readCredentials(secretsPath, ["OPENCLAW_GATEWAY_TOKEN"], readFileSync),
    };
    return run({
      runId,
      prompt: "",
      onOutput: outCb,
      onExit: exitCb,
      laneKind: "delivery",
      prepared: {
        profile: { cwd: agentHome, stdin: "ignore" },
        argv: [
          "/usr/local/bin/openclaw",
          "message", "send", "--channel", channel,
          "--target=" + target,
          "--message=" + message,
        ],
        env,
        hardMs: 30_000,
      },
    });
  }

  // Kill a run (SIGTERM by default; SIGKILL for a stuck one). The root runner is the
  // true parent across the setpriv drop, so it can signal the agent-uid child.
  function kill(runId, sig = "SIGTERM") {
    const rec = runs.get(runId);
    if (!rec || !rec.handle) return false;
    try { teardownContained(rec.handle); return true; } catch { return false; }
  }

  function activeCount() { return runs.size; }

  // The kernel-stable identity (pid + /proc start time + boot id) of a run's
  // contained process tree, or null if this runner does not currently own that
  // runId.
  //
  // It is exposed so a caller that is ABOUT TO KILL a run can capture what it
  // will later need to prove the child is gone. The capture has to happen first:
  // the record is deleted the moment the child closes, and an identity that was
  // never captured can never be proven terminal -- which correctly leaves the
  // lane quarantined, but for a reason nobody can act on.
  //
  // Read-only and non-authorizing. A pid integer alone never authorizes a
  // signal; this is the identity that makes a later absence check meaningful,
  // and the only thing a holder can do with it is ask /proc a question.
  function childIdentity(runId) {
    const rec = runs.get(runId);
    return (rec && rec.handle && rec.handle.namespaceIdentity) || null;
  }

  // "Could this engine run right now?" — the readiness question, answered by
  // ROOT because only root can read the agent's credential files. Returns a
  // BOOLEAN and nothing else: no token, no path, no reason string. The gate
  // asks; it never learns why the answer is no, and never holds the secret.
  //
  // This exists because board dispatch gates on codexAuthLauncherAvailable().
  // Under Foundation B the gate (uid 999) cannot open agent-owned
  // ~/.codex/auth.json (0600), so that check was false forever and every codex
  // card was silently dropped from dispatch. Widening the credential to
  // group-readable would have fixed it by handing the network-facing process an
  // OAuth token — exactly what the identity split exists to prevent.
  //
  // A profile declares its own readiness probe (readyCheck); an engine with no
  // probe needs no credential and is ready as soon as its profile exists.
  // READINESS IS ABOUT CREDENTIALS, NOT ABOUT THE LANE.
  // (READINESS-CACHE-POISONED-NOT-CODEX, 2026-08-10.)
  //
  // This used to begin:
  //
  //   if (laneOwnerRunId !== null || agentLaneArbiter.isBusy()
  //       || agentLaneArbiter.isQuarantined()) return false;
  //
  // which answered two unrelated questions through one boolean:
  //
  //   1. does this engine have working credentials?  -- slow, correctly cacheable
  //   2. is the shared agent lane free RIGHT NOW?    -- fast, must never be cached
  //
  // The gate asks the first and CACHES the answer (gate.js engineReadyCache).
  // So any refresh that happened to land while the lane was busy or quarantined
  // recorded "this engine has no credentials" -- a fact that was never about
  // credentials -- and the gate then failed closed until something invalidated
  // it. Measured on the live box: the broker answered `codex ready=true` while
  // the gate's cache had said `codex_readiness_not_ready` for over an hour, and
  // there were 18 quarantine events that night. That is the whole of the
  // weekend's "codex is deadlocked".
  //
  // Removing the lane check does NOT let a run start on a busy lane. run() guards
  // it twice and unconditionally, before launching anything:
  //   line ~151  laneOwnerRunId !== null      -> AGENT_LANE_BUSY_ERROR
  //   line ~191  arbiter.acquire() returns no lease -> AGENT_LANE_BUSY_ERROR
  // Verified before this change rather than assumed. Lane availability belongs
  // to the dispatcher, which checks it per attempt and never caches it.
  function engineReady(engineId) {
    const profile = ownProfile(engineId);
    if (!profile) return false;                       // unknown engine: never ready
    if (typeof profile.readyCheck !== "function") return true;
    try { return profile.readyCheck({ readFileSync, rootEnv }) === true; }
    catch { return false; }                           // a throwing probe fails closed
  }

  // AUTONOMOUS AUTHORING, ROOT-COMPOSED, AGENT-UID.
  // (P0-BUILD-CODEX-AUTHOR, 2026-08-10.)
  //
  // codex cannot author from the gate's own jailed path: that run executes as the
  // GATE uid (bwrap cannot setuid), and ~/.codex/auth.json is 0600 agent. So codex
  // cannot read its own login, fails before it starts, and reports only "WARNING:
  // proceeding, even though we could not create PATH aliases" -- an error that
  // names neither the credential nor the identity.
  //
  // Widening the credential is the one move the identity split exists to prevent,
  // and #320 already proved chown does not help: it changes the group, not the
  // 0600 mode. The run must therefore execute AS AGENT, and only root can drop to
  // agent.
  //
  // This composes the launch ROOT-SIDE and hands it to run() through `prepared` --
  // the same mechanism deliver() already uses in production to launch openclaw as
  // agent with a root-authored argv. The gate supplies a prompt and a worktree
  // PATH; it never names a bin, a flag, or a mount.
  //
  // The bwrap read-jail is PRESERVED, which is the whole reason to compose here
  // rather than route the author down the plain chat path: a reviewer reads, an
  // author writes, and only the granted worktree is writable.
  // Returns the RESOLVED worktree path when the grant is legitimate, else null.
  // It returns the resolved path rather than a boolean so the caller mounts the
  // exact path that was validated -- checking one string and mounting a different
  // one is how a symlink check gets bypassed by the thing it was meant to stop.
  // The branch a worktree is on, read by ROOT, or null if it cannot be read.
  //
  // This check used to live gate-side, and it could not work there: the gate is
  // uid 997 and the worktree is agent-owned, so git could not even chdir into it
  // ("cannot change to ...: Permission denied"). The empty answer failed the
  // comparison, the ladder reported "did not grant a writable worktree", and the
  // real cause -- a permission boundary two layers down -- appeared nowhere.
  //
  // Root can read it, verified on the live box. safe.directory is set explicitly
  // rather than relied upon: git refuses repositories owned by another user, and
  // whether root is exempt has varied across git versions. Pinning it makes the
  // result depend on the repo, not on the git build.
  //
  // Read-only, no config written, and a timeout so a wedged git cannot hold the
  // dispatch open.
  function worktreeBranch(dir, safeDirectory = dir) {
    try {
      const out = execFileSync("git", ["-c", "safe.directory=" + safeDirectory, "-C", dir, "branch", "--show-current"],
        { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
      return String(out || "").trim() || null;
    } catch { return null; }
  }

  function autonomousWorktreeOk(worktree, engineId) {
    if (typeof worktree !== "string" || !nodePath.isAbsolute(worktree)) return null;
    if (worktree.includes("\0") || worktree.includes("..")) return null;
    // The ONE gate-supplied string in this path, so it is confined to the tree
    // agent worktrees actually live in. Anything else is a new authority surface
    // arriving through a mount instead of an argv.
    const root = agentHome + "/workspaces/";
    if (!worktree.startsWith(root) || worktree.length <= root.length) return null;
    // A path that PASSES the prefix check can still point outside the tree, because
    // statSync FOLLOWS symlinks: `<root>/x` -> `/` is a directory, its prefix is
    // clean, and bwrap then mounts the TARGET writable as /workspace -- handing an
    // author write access to everything the agent uid can reach. So resolve first,
    // then re-check the prefix on the RESOLVED path.
    //
    // Both sides get resolved. Comparing a resolved worktree against an unresolved
    // root would reject every legitimate path the moment any component of the root
    // (/data, for instance) is itself a symlink.
    //
    // Containment is decided by path.relative rather than a string prefix: realpath
    // returns the platform's own separators, so a "/"-built prefix silently rejects
    // every legitimate path off-Linux -- which would leave this branch untestable
    // anywhere but the box. A relative path that is empty, absolute, or climbs out
    // with ".." means the target is not inside the root.
    try {
      const realRoot = fs.realpathSync(root);
      const real = fs.realpathSync(worktree);
      const rel = nodePath.relative(realRoot, real);
      if (!rel || nodePath.isAbsolute(rel)) return null;
      if (rel === ".." || rel.startsWith(".." + nodePath.sep)) return null;
      const flags = fs.constants.O_RDONLY
        | (fs.constants.O_DIRECTORY || 0)
        | (fs.constants.O_NOFOLLOW || 0);
      const validationFd = openSource(real, flags);
      try {
        const initialStat = statSource(validationFd);
        if (!initialStat.isDirectory()) return null;
      // EXACTLY <engine>/<repo>, and the engine segment must be THIS engine.
      // Without it, a codex run could be handed claude's worktree -- still inside
      // the allowed tree, so every check above passes, while one engine writes
      // into another's private workspace.
      const parts = rel.split(nodePath.sep);
      if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
      // REQUIRED, not "checked if supplied". These were `if (engineId && ...)`,
      // which fails OPEN: a caller that omitted the engine skipped both the
      // ownership and the branch check and could be handed any valid two-segment
      // worktree, including another engine's. A security check conditional on
      // its own input being present is not a check. (Found by Codex reviewing
      // this change.)
      if (typeof engineId !== "string" || !engineId) return null;
      if (parts[0] !== engineId) return null;
      // THE BRANCH, checked by the side that can actually read it. This is the
      // control the gate was failing to enforce, moved rather than dropped: an
      // author may only write on its own work branch, never on whatever happened
      // to be checked out.
      //
      // TWO legitimate branch shapes, and requiring only the first was a
      // regression I introduced with this check:
      //
      //   <engine>/work            the engine's standing private worktree
      //   <engine>/task-<id>       a STRUCTURED GIT PROPOSAL's task branch
      //
      // The proposal path builds a per-task worktree
      // (<repo>--task-<id>) on a per-task branch, and it is the path the
      // governed-write proof runs on. Live, 2026-08-10:
      //
      //   agenthost-ladder-proof--task-t_43bbaa58 -> codex/task-t_43bbaa58
      //   agenthost-ladder-proof                  -> codex/work
      //
      // Demanding "/work" rejected every proposal, and the run surfaced as
      // "the reviewer wrote nothing to stdout and nothing to stderr" -- a
      // refusal three layers from its cause. It went unnoticed because the
      // proposal path had never once executed before today.
      //
      // Still matched as a PATTERN root derives itself, never against a branch
      // name the gate supplies: a compromised gate naming its own branch would
      // reinstate exactly the authority this check removes.
      // NO INTERPOLATION INTO A REGEX. The first version built the pattern with
      // `new RegExp("^" + engineId + "/task-...")`, which lets a metacharacter in
      // the engine id weaken the anchoring and admit a foreign branch. (Found by
      // Codex reviewing this change.) engineId is currently constrained by
      // runAutonomous, but relying on the caller is what produced the fail-open
      // this same function already had to fix once.
      //
      // The suffix is matched by a FIXED regex against the remainder after an
      // exact string prefix, so nothing derived from input reaches the pattern.
        // On the production Linux box, Git chdirs through the already-open
        // directory descriptor. A same-UID rename can change the pathname but
        // cannot change which repository this branch check reads.
        const branchTarget = process.platform === "linux"
          ? `/proc/${process.pid}/fd/${validationFd}`
          : real;
        const branch = String(worktreeBranch(branchTarget, real) || "");
      const taskPrefix = engineId + "/task-";
      const allowed = branch === engineId + "/work"
        || (branch.startsWith(taskPrefix)
            && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(branch.slice(taskPrefix.length)));
      if (!allowed) return null;
        const finalStat = statSource(validationFd);
        if (!finalStat.isDirectory() || String(finalStat.dev) !== String(initialStat.dev)
            || String(finalStat.ino) !== String(initialStat.ino)) return null;
        return Object.freeze({ path: real, dev: finalStat.dev, ino: finalStat.ino, branch });
      } finally {
        closeSource(validationFd);
      }
    } catch { return null; }
  }

  function runAutonomous({ runId, engineId, prompt, worktree, onOutput: outCb, onExit: exitCb } = {}) {
    const emitExit = exitCb || onExit;
    if (!runId) throw new Error("runAutonomous requires a runId");
    if (engineId !== "codex" && engineId !== "deepseek") {
      emitExit(runId, { exitCode: null, signalName: null, error: "autonomous_engine_unsupported" });
      return { runId, accepted: false };
    }
    const worktreeGrant = autonomousWorktreeOk(worktree, engineId);
    if (!worktreeGrant) {
      // Name the refusal. A silent fallback here would hand back the same empty
      // output this whole task exists to explain. (Rule 16.)
      emitExit(runId, { exitCode: null, signalName: null, error: "autonomous_worktree_rejected" });
      return { runId, accepted: false };
    }

    if (engineId === "deepseek") {
      if (rootEnv.AGENTHOST_FOUNDATION_B !== "1") {
        emitExit(runId, { exitCode: null, signalName: null, error: "dsh_foundation_b_required" });
        return { runId, accepted: false };
      }
      // The relay socket name is derived, not supplied by gate. It must already
      // be listening before root grants the worktree, otherwise the run fails by
      // name without ever launching DSH.
      let relaySocket;
      let relayToken;
      try {
        ({ socketPath: relaySocket, relayToken } = relayCapability(runId));
      } catch {
        emitExit(runId, { exitCode: null, signalName: null, error: "dsh_relay_capability_unavailable" });
        return { runId, accepted: false };
      }
      try {
        const stat = relaySocketStat(relaySocket);
        if (!stat || typeof stat.isSocket !== "function" || !stat.isSocket()) {
          throw new Error("not a socket");
        }
      } catch {
        emitExit(runId, { exitCode: null, signalName: null, error: "dsh_relay_socket_unavailable" });
        return { runId, accepted: false };
      }

      // Exact allowlist. The credential is deliberately fake: the in-jail HTTP
      // bridge strips it, and only the gate-side Unix relay ever sees the real
      // provider key.
      const env = {
        HOME: "/hm",
        DSH_HOME: "/hm/dsh",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        USER: AGENT_USER,
        LOGNAME: AGENT_USER,
        SHELL: "/bin/bash",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TERM: "dumb",
        NO_COLOR: "1",
        DSH_TELEMETRY_DISABLED: "1",
        // The outer allowlist jail is authoritative. Avoid an inner user-
        // namespace sandbox fighting the setuid outer bwrap; only /workspace is
        // writable and no real network interface exists.
        DSH_PERMISSION_MODE: "danger-full-access",
        DSH_TOOLS_MODE: "native",
        DEEPSEEK_API_KEY: "agenthost-relay-not-a-real-key",
        // Consumed only by the root bridge. buildDshEnv deliberately omits both
        // when it drops the actual Harness child to the agent identity.
        DSH_RUN_AS_UID: String(uid),
        DSH_RUN_AS_GID: String(gid),
      };
      const jail = buildBwrapReadJail("/usr/bin/setpriv", [
        "--no-new-privs", "--", "/usr/local/bin/node", DSH_RUNNER,
      ], {
        env,
        unshareNet: true,
        dshRootBridgeCapabilities: true,
        chdir: JAIL_WORKSPACE,
        // The inherited directory is child fd 3. --bind-fd mounts that exact
        // inode; using --bind /proc/self/fd/3 would re-resolve a magic link and
        // recreate the same-UID rename race fixed by CVE-2024-42472.
        requiredRwBindFdAt: [{ fd: 3, dest: JAIL_WORKSPACE }],
        requiredRoBindAt: [
          { src: DSH_RUNTIME, dest: DSH_RUNTIME },
          { src: DSH_RUNNER, dest: DSH_RUNNER },
          { src: DSH_PATCH, dest: DSH_PATCH },
          // DSH loads cwd/.env before boot. The immutable empty image file masks
          // any checkout dotenv, including files added after admission.
          { src: DSH_EMPTY_ENV, dest: JAIL_WORKSPACE + "/.env" },
          { src: relaySocket, dest: DSH_JAIL_RELAY },
        ],
      });
      if (jail.bin !== "/usr/bin/bwrap") {
        emitExit(runId, { exitCode: null, signalName: null, error: "dsh_jail_composition_failed" });
        return { runId, accepted: false };
      }
      return run({
        runId,
        prompt,
        onOutput: outCb,
        onExit: emitExit,
        laneKind: "autonomous",
        prepared: {
          profile: { cwd: "/", stdin: "prompt", promptSentinel: "{promptWithCharter}" },
          argv: [jail.bin, ...jail.args],
          env,
          hardMs,
          launchAuthority: SETUID_BWRAP_LAUNCH,
          sourcePaths: [worktreeGrant.path],
          sourceIdentities: [{
            dev: worktreeGrant.dev,
            ino: worktreeGrant.ino,
            branch: worktreeGrant.branch,
          }],
          stdinPrefix: relayToken,
        },
      });
    }

    // Fixed root-side, not read from the profile allowlist: this env crosses into
    // a --clearenv jail, so every name in it is one root chose to admit.
    const codexHome = agentHome + "/.codex";
    const env = {
      HOME: agentHome,
      CODEX_HOME: codexHome,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      USER: AGENT_USER,
      NO_COLOR: "1",
    };

    // THE CHARTER RIDES THE AUTHOR RUN TOO. Dropping it was a real defect in the
    // dispatch, and the review layer caught it before I did.
    //
    // The local path this replaced applied it — `codexAutonomousArgs(prompt,
    // EFFECTIVE_CHARTER, ...)` — and the chat path applies it a few hundred lines
    // up. The author path did not, so codex ran with the task and none of the
    // standing orders, including the handoff contract that says what a result
    // must contain.
    //
    // Observed live, 2026-08-10, card t_a823daf8: codex did the work correctly
    // (wrote LADDER-PROOF.md with `PROOF 2026-08-10`) and reported a plain
    // summary. Gemini rejected it — "missing the raw artifact (diff/file
    // contents) and the VERIFY command's actual output as required by the
    // handoff contract" — for failing a contract codex had never been shown. The
    // engine was blamed for an instruction the transport dropped.
    const chartered = withCharter
      ? withCharter(String(prompt == null ? "" : prompt))
      : String(prompt == null ? "" : prompt);
    const argv = autonomousCodexArgv(chartered);
    const jail = buildBwrapReadJail(argv[0], argv.slice(1), {
      env,
      // Both binds are REQUIRED (`--bind`, not `--bind-try`), because the run is
      // worthless without either and a best-effort mount for something the engine
      // cannot start without is a silent failure by construction (P1-F4).
      //   /workspace  -- the granted worktree, the only place the author may write.
      //   CODEX_HOME  -- bound at the SAME path the env names, because bwrap builds
      //                  a fresh root: an unbound CODEX_HOME simply does not exist
      //                  inside the jail. It is READ-WRITE because codex writes its
      //                  PATH aliases under it at startup, and a read-only one
      //                  produces the exact "could not create PATH aliases" warning
      //                  that made this bug look like a wrong diagnosis for a day.
      requiredRwBindAt: [
        { src: worktreeGrant.path, dest: JAIL_WORKSPACE },
        { src: codexHome, dest: codexHome },
      ],
      // /scratch is created and chdir'd into by buildBwrapReadJail itself, on the
      // jail's own tmpfs root -- writable, ephemeral, and gone when the run ends.
    });

    return run({
      runId,
      prompt: "",
      onOutput: outCb,
      onExit: emitExit,
      laneKind: "autonomous",
      prepared: {
        profile: { cwd: worktreeGrant.path, stdin: "ignore" },
        argv: [jail.bin, ...jail.args],
        env,
        hardMs,
      },
    });
  }

  return Object.freeze({ run, deliver, kill, activeCount, childIdentity, engineReady, runAutonomous, _autonomousWorktreeOk: autonomousWorktreeOk, _readCredentials: readCredentials, _buildEngineEnv: buildEngineEnv });
}

module.exports = { createChatRunner, readCredentials, buildEngineEnv, resolveArgv, selectTemplate, CHAT_HARD_MS, AGENT_LANE_BUSY_ERROR };
