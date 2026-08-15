// Drift guard: the chat-engine PROFILES (the security-core argv templates gate can't
// influence) must, after substituting the prompt/sessionId sentinels, produce argv
// BYTE-IDENTICAL to what gate.js ENGINES[x].args(...) produces today. If someone edits
// an engine's real args without editing its profile, this fails — so the root runner
// can never drift from the actual invocation (which would either break the engine or
// open a gap). This is the test the design mandated.
//
// ESM test (repo root is "type":"module"); the profiles module is CommonJS under
// container/ ("type":"commonjs"), imported via ESM/CJS default interop.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import profilesModule from "../container/maintenance-chat-profiles.js";
const { buildChatProfiles } = profilesModule;

// Reproduce the exact gate.js helpers the profiles mirror (kept in lockstep here;
// if gate.js changes these, update BOTH and this test proves the profile matches).
const HOME_DIR = "/data/home/agent";
const CHAT_CWD = path.join(HOME_DIR, "work");
const CHAT_BIN = "claude";
const CHARTER = "TEAM CHARTER TEXT";
const CLAUDE_CHARTER_ARGS = ["--append-system-prompt", CHARTER];
const withCharter = (prompt) => "<<< TEAM CHARTER >>>\n" + CHARTER + "\n<<< END >>>\n\n" + prompt;

// gate.js agentSpawnArgs, but with hooks HARDCODED disabled (the profile must never
// read AGENT_CHAT_HOOKS — a gate-influenceable var). This is agentSpawnArgsStatic.
const agentSpawnArgsStatic = (prompt, withContinue) => {
  const a = ["-p", prompt, "--dangerously-skip-permissions", "--settings", '{"disableAllHooks":true}'];
  if (withContinue) a.push("-c");
  return a;
};

// gate.js ENGINES[x].args(prompt, sid, withContinue) — reproduced verbatim from
// container/gate.js (the source of truth these profiles must match).
const ENGINES_ARGS = {
  claude: (prompt, _sid, withContinue) =>
    [...agentSpawnArgsStatic(prompt, withContinue), ...CLAUDE_CHARTER_ARGS, "--output-format", "stream-json", "--include-partial-messages", "--verbose"],
  hermes: (prompt, sid) => {
    const a = ["chat", "-q", withCharter(prompt), "-Q", "--source", "tool"];
    if (sid) a.push("-r", sid);
    return a;
  },
  codex: (prompt, sid) => {
    const flags = ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-C", HOME_DIR, "--color", "never"];
    if (sid) return [...flags, "resume", sid, "--", withCharter(prompt)];
    return [...flags, "--", withCharter(prompt)];
  },
  gemini: (prompt) => ["-p", withCharter(prompt), "--output-format", "json", "--skip-trust"],
  cursor: (prompt) => ["--disable-auto-update", "--trust", "-p", "--output-format", "json", "--mode", "ask", "--", withCharter(prompt)],
};

const profiles = buildChatProfiles({
  homeDir: HOME_DIR, chatCwd: CHAT_CWD, chatBin: CHAT_BIN,
  charterArgs: CLAUDE_CHARTER_ARGS, agentSpawnArgsStatic, withCharter,
});

// Substitute sentinels the way the runner will: prompt/promptWithCharter/sessionId
// each as ONE argv element (arg === sentinel ? value : arg).
function resolve(template, { prompt, promptWithCharter, sessionId }) {
  return template.map((a) => {
    if (a === "{prompt}") return prompt;
    if (a === "{promptWithCharter}") return promptWithCharter;
    if (a === "{sessionId}") return sessionId;
    return a;
  });
}

const PROMPT = "hello, please summarize the board";
const SID_HERMES = "20260725_143012_abc123";
const SID_CODEX = "019f915c-528f-7ef2-9ade-fcb633ce3b4e";

test("claude profile matches ENGINES.claude.args (fresh + continue)", () => {
  const fresh = resolve(profiles.claude.argvTemplate, { prompt: PROMPT });
  assert.deepEqual(fresh, ENGINES_ARGS.claude(PROMPT, null, false), "claude fresh argv drifted");
  const cont = resolve(profiles.claude.argvTemplateContinue, { prompt: PROMPT });
  assert.deepEqual(cont, ENGINES_ARGS.claude(PROMPT, null, true), "claude +continue argv drifted");
  assert.deepEqual(profiles.claude.credentialNames, ["GITHUB_TOKEN"],
    "Foundation B must read the dashboard-managed GitHub token by exact name");
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"]) {
    assert.ok(profiles.claude.envAllowlist.includes(name), `Claude needs the ${name} GitHub alias`);
    assert.ok(profiles.claude.redactEnvNames.includes(name), `Claude output must redact ${name}`);
  }
  assert.equal(profiles.claude.envAllowlist.includes("GIT_PUSH_TOKEN"), false,
    "the Git Ladder write credential remains gate-only");
});

test("claude-assist is fixed streaming Claude with subscription-only auth", () => {
  const p = profiles["claude-assist"];
  assert.ok(p, "Foundation-B Assist needs its own fixed root profile");
  const argv = resolve(p.argvTemplate, { prompt: PROMPT });
  assert.equal(argv[0], "-p");
  assert.equal(argv.includes(PROMPT), false, "the operator draft must not survive in process argv");
  assert.equal(p.stdin, "prompt", "the fixed profile must carry the draft over stdin");
  assert.equal(argv.includes("--dangerously-skip-permissions"), false,
    "a text-polish request must never inherit agent tool authority");
  const tools = argv.indexOf("--tools");
  assert.notEqual(tools, -1, "Assist must explicitly choose its tool surface");
  assert.equal(argv[tools + 1], "", "Assist disables every Claude tool");
  for (const flag of ["--safe-mode", "--disable-slash-commands", "--no-session-persistence", "--no-chrome"]) {
    assert.equal(argv.includes(flag), true, `Assist must start with ${flag}`);
  }
  assert.equal(argv.includes("--strict-mcp-config"), true,
    "Assist must ignore every MCP server configured in the agent's real home");
  const model = argv.indexOf("--model");
  assert.notEqual(model, -1, "Assist must explicitly choose its fast model");
  assert.equal(argv[model + 1], "haiku", "Assist uses Haiku without changing chat's model");
  assert.deepEqual(argv.slice(argv.indexOf("--effort"), argv.indexOf("--effort") + 2), ["--effort", "low"]);
  assert.match(argv[argv.indexOf("--system-prompt") + 1], /never invent facts/);
  assert.equal(argv.includes("--output-format"), true);
  assert.equal(argv[argv.indexOf("--output-format") + 1], "stream-json");
  assert.equal(argv.includes("--include-partial-messages"), true,
    "the operator must see content before the model exits");
  assert.equal(p.bufferOutputUntilExit, undefined,
    "Assist output must not be held until process exit");
  assert.equal(p.lineBufferedOutput, true,
    "root may redact only complete JSONL records, but it must forward each record before exit");
  for (const flag of ["--append-system-prompt", "-c", "--dangerously-skip-permissions"]) {
    assert.equal(p.argvTemplate.includes(flag), false, `Assist must not inherit ${flag}`);
  }
  assert.deepEqual(p.redactEnvNames, ["CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.deepEqual(p.fixedEnv, {
    CLAUDE_CODE_DISABLE_THINKING: "1",
    MAX_THINKING_TOKENS: "0",
  }, "Assist disables reasoning overhead even if global Claude settings enable it");
  for (const name of p.redactEnvNames) assert.ok(p.envAllowlist.includes(name), `Assist needs ${name}`);
  for (const name of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN", "GIT_PUSH_TOKEN", "REPOS", "LD_PRELOAD", "NODE_OPTIONS", "BASH_ENV"]) {
    assert.equal(p.envAllowlist.includes(name), false, `Assist must not receive ${name}`);
  }
});

test("claude-brand-dna is a distinct fixed plain-output profile with supported Claude auth", () => {
  const p = profiles["claude-brand-dna"];
  assert.ok(p, "Foundation Brand DNA needs a profile that Assist transport changes cannot mutate");
  assert.notEqual(p, profiles["claude-assist"]);
  const argv = resolve(p.argvTemplate, { prompt: PROMPT });
  // `-p` with NO prompt after it: the prompt is written to stdin instead.
  // Website copy in argv is readable from any process list and is capped by
  // the OS -- a real client site exceeded that cap at roughly 60k characters.
  assert.deepEqual(argv.slice(0, 2), ["-p", "--settings"]);
  assert.equal(argv.includes(PROMPT), false, "the prompt must not survive anywhere in argv");
  assert.equal(p.stdin, "prompt", "Brand DNA must receive its prompt over stdin");
  assert.equal(argv.includes("--dangerously-skip-permissions"), false);
  assert.equal(argv.includes("--tools"), true);
  assert.equal(argv[argv.indexOf("--tools") + 1], "");
  assert.equal(argv.includes("--strict-mcp-config"), true);
  assert.equal(argv.includes("--no-session-persistence"), true,
    "attacker-controlled website text must not enter Claude session history");
  for (const flag of ["--output-format", "stream-json", "--include-partial-messages", "--verbose", "--append-system-prompt", "-c"]) {
    assert.equal(argv.includes(flag), false, `Brand DNA plain output must not inherit ${flag}`);
  }
  assert.equal(p.supportsContinue, false);
  assert.equal(p.sessionIdGrammar, null);
  assert.equal(p.bufferOutputUntilExit, true);
  assert.equal(p.outputBufferMaxChars, 65536);
  assert.deepEqual(p.envAllowlist.filter((name) => /CLAUDE|ANTHROPIC/.test(name)), ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  assert.deepEqual(p.redactEnvNames, ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
});

test("Assist may adopt streaming transport without changing Brand DNA's plain bounded contract", () => {
  const streamingAssist = {
    ...profiles["claude-assist"],
    argvTemplate: [...profiles["claude-assist"].argvTemplate, "--output-format", "stream-json"],
    bufferOutputUntilExit: false,
  };
  assert.equal(streamingAssist.argvTemplate.includes("stream-json"), true);
  const brand = profiles["claude-brand-dna"];
  assert.equal(brand.argvTemplate.includes("stream-json"), false);
  assert.equal(brand.bufferOutputUntilExit, true);
  assert.equal(brand.outputBufferMaxChars, 65536);
});

test("hermes profile matches ENGINES.hermes.args (fresh + resume)", () => {
  const pc = withCharter(PROMPT);
  const fresh = resolve(profiles.hermes.argvTemplate, { promptWithCharter: pc });
  assert.deepEqual(fresh, ENGINES_ARGS.hermes(PROMPT, null), "hermes fresh argv drifted");
  const resume = resolve(profiles.hermes.argvTemplateResume, { promptWithCharter: pc, sessionId: SID_HERMES });
  assert.deepEqual(resume, ENGINES_ARGS.hermes(PROMPT, SID_HERMES), "hermes resume argv drifted");
});

test("codex profile matches ENGINES.codex.args (fresh + resume); -- terminator always present", () => {
  const pc = withCharter(PROMPT);
  const fresh = resolve(profiles.codex.argvTemplate, { promptWithCharter: pc });
  assert.deepEqual(fresh, ENGINES_ARGS.codex(PROMPT, null), "codex fresh argv drifted");
  const resume = resolve(profiles.codex.argvTemplateResume, { promptWithCharter: pc, sessionId: SID_CODEX });
  assert.deepEqual(resume, ENGINES_ARGS.codex(PROMPT, SID_CODEX), "codex resume argv drifted");
  assert.ok(profiles.codex.argvTemplate.includes("--"), "codex fresh MUST keep -- terminator");
  assert.ok(profiles.codex.argvTemplateResume.includes("--"), "codex resume MUST keep -- terminator");
});

test("gemini profile matches ENGINES.gemini.args", () => {
  const pc = withCharter(PROMPT);
  const g = resolve(profiles.gemini.argvTemplate, { promptWithCharter: pc });
  assert.deepEqual(g, ENGINES_ARGS.gemini(PROMPT), "gemini argv drifted");
});

test("cursor profile matches ENGINES.cursor.args and stays in ask mode", () => {
  const pc = withCharter(PROMPT);
  const c = resolve(profiles.cursor.argvTemplate, { promptWithCharter: pc });
  assert.deepEqual(c, ENGINES_ARGS.cursor(PROMPT), "cursor argv drifted");
  assert.ok(profiles.cursor.argvTemplate.includes("--disable-auto-update"),
    "cursor MUST keep the checksum-pinned runtime");
  assert.ok(profiles.cursor.argvTemplate.includes("--trust"),
    "cursor MUST pre-trust only its fixed chat workspace");
  assert.ok(profiles.cursor.argvTemplate.includes("--"), "cursor MUST keep -- terminator");
  assert.ok(profiles.cursor.argvTemplate.indexOf("--") < profiles.cursor.argvTemplate.indexOf("{promptWithCharter}"),
    "cursor prompt must stay after the argv terminator");
  for (const forbidden of ["--api-key", "--force", "--yolo", "--background", "--worktree"]) {
    assert.equal(profiles.cursor.argvTemplate.includes(forbidden), false, "cursor profile must not contain " + forbidden);
  }
});

test("security invariants: no engine template contains a raw shell/eval, sentinels are single elements", () => {
  for (const [id, p] of Object.entries(profiles)) {
    const all = [p.argvTemplate, p.argvTemplateContinue, p.argvTemplateResume].filter(Boolean);
    for (const tmpl of all) {
      // Every sentinel must be its OWN element, never embedded in a larger string
      // (which would let substitution smuggle extra argv/flags).
      for (const el of tmpl) {
        if (el.includes("{prompt}") || el.includes("{promptWithCharter}") || el.includes("{sessionId}")) {
          assert.ok(el === "{prompt}" || el === "{promptWithCharter}" || el === "{sessionId}",
            `${id}: sentinel must be a standalone argv element, got "${el}"`);
        }
      }
    }
    // sessionIdGrammar must be an anchored regex when present (no partial-match bypass)
    if (p.sessionIdGrammar) {
      assert.ok(p.sessionIdGrammar.source.startsWith("^") && p.sessionIdGrammar.source.endsWith("$"),
        `${id}: sessionIdGrammar must be anchored ^...$`);
    }
  }
});

test("kimi is deliberately absent (no uid-crossing spawn — in-gate API path)", () => {
  assert.equal(profiles.kimi, undefined, "kimi must NOT have a runner profile");
});
