"use strict";

// Foundation B chat-engine profiles — the SECURITY CORE of the gate->agent
// engine dispatch. Each profile is a pure-data record describing how ONE named
// engine is launched. gate (uid 999) never supplies argv, env, a flag, or a bin;
// it supplies only {engineId, prompt, withContinue, sessionId}, and the ROOT
// runner (maintenance-chat-runner.js) rebuilds the launch from THESE templates,
// substituting the prompt/sessionId as single argv ELEMENTS (never concatenated,
// never a flag). This is what makes the claim true FOR THIS PATH: a compromised
// gate cannot run arbitrary code as agent THROUGH THE CHAT RUNNER, because the
// command that runs is authored here, not received.
//
// Scope it that way and no wider. The gate also proxies the writable web
// terminal (ttyd on loopback:7681), and handing an authenticated human a
// terminal as the agent is that proxy's DESIGNED job -- so the gate necessarily
// holds ttyd's credential. Chat-path hardening does not, and cannot, remove
// that. Any blanket "a compromised gate cannot act as agent" is inaccurate
// while the terminal proxy exists.
//
// The argvTemplate for each engine reproduces gate.js ENGINES[x].args(...)
// BYTE-FOR-BYTE, but as a static array with sentinels instead of a function. The
// drift-guard test (test/maintenance-chat-profiles.test.js) asserts the two
// stay identical, so editing ENGINES.args without editing the profile is caught.
//
// SENTINELS (substituted by the runner, as one argv element each):
//   "{prompt}"            — the raw user prompt (claude: charter rides a separate flag)
//   "{promptWithCharter}" — withCharter(charter, prompt) (hermes/codex/gemini: no system-prompt flag)
//   "{sessionId}"         — a resume id, ONLY after the runner validates it against sessionIdGrammar
//
// ENV (built root-side by the runner): the runner drops to agent via setpriv, so
// the engine inherits the AGENT STACK's env (which already carries HOME, PATH,
// the API keys, GITHUB_TOKEN, HERMESENV_*, etc. — confirmed on box 2026-07-25).
// The runner adds ONLY the names in envAllowlist from its own root env, and reads
// credentialNames BY NAME from secrets.env root-side — it NEVER merges the whole
// gate-writable secrets.env, so a planted LD_PRELOAD/NODE_OPTIONS/BASH_ENV line
// can never reach the engine (closes the loadBoxSecrets injection class).

// The engine bins + prompt-composition helpers must be passed in from gate.js so
// this file has no import cycle and reproduces the exact same values.
function buildChatProfiles({
  homeDir,          // HOME_DIR (/data/home/agent)
  chatCwd,          // CHAT_CWD (HOME/work) — claude's cwd (continuity is cwd-keyed)
  chatBin,          // CHAT_BIN ("claude")
  charterArgs,      // CLAUDE_CHARTER_ARGS (the --append-system-prompt pair, or [])
  agentSpawnArgsStatic, // (promptSentinel, withContinue) => argv, MATCHING gate.js agentSpawnArgs but hooks HARDCODED disabled
  withCharter,      // (prompt) => charter-prefixed prompt (uses EFFECTIVE_CHARTER already bound)
} = {}) {
  for (const [k, v] of Object.entries({ homeDir, chatCwd, chatBin, charterArgs, agentSpawnArgsStatic, withCharter })) {
    if (v === undefined || v === null) throw new Error(`buildChatProfiles requires ${k}`);
  }

  const PROMPT = "{prompt}";
  const PROMPT_C = "{promptWithCharter}";
  const SID = "{sessionId}";

  // Non-secret env names the engines need that the runner must carry from its own
  // env if present (the agent stack has these; the root runner may not inherit all
  // — confirmed via the box env-diff 2026-07-25). Credentials come via
  // credentialNames, read from secrets.env root-side, NOT here.
  const COMMON_ALLOW = ["HOME", "PATH", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME", "SHELL", "REPOS"];
  const ASSIST_ALLOW = [
    "HOME", "PATH", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME", "SHELL",
    "CLAUDE_CODE_OAUTH_TOKEN", "DISABLE_AUTOUPDATER",
  ];
  // Separate on purpose: AI Assist may change transport/model flags without
  // changing the plain JSON contract Brand DNA consumes.
  const BRAND_DNA_ALLOW = [
    "HOME", "PATH", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME", "SHELL",
    "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "DISABLE_AUTOUPDATER",
  ];

  const profiles = {
    // ---- claude ------------------------------------------------------------
    // gate.js: [...agentSpawnArgs(prompt, withContinue), ...CLAUDE_CHARTER_ARGS,
    //           "--output-format","stream-json","--include-partial-messages","--verbose"]
    // agentSpawnArgs = ["-p", prompt, "--dangerously-skip-permissions",
    //           "--settings",'{"disableAllHooks":true}' (hooks HARDCODED off here —
    //           NEVER read AGENT_CHAT_HOOKS, which is gate-influenceable), (-c iff withContinue)]
    // -c is conditional, so ship TWO templates selected by withContinue (a bool the
    // runner resolves), NOT by gate passing a "-c" string.
    claude: {
      engineId: "claude",
      bin: chatBin,
      argvTemplate: [...agentSpawnArgsStatic(PROMPT, false), ...charterArgs, "--output-format", "stream-json", "--include-partial-messages", "--verbose"],
      argvTemplateContinue: [...agentSpawnArgsStatic(PROMPT, true), ...charterArgs, "--output-format", "stream-json", "--include-partial-messages", "--verbose"],
      promptSentinel: PROMPT,        // raw prompt; charter is in the flag slot
      cwd: chatCwd,
      stdin: "inherit",
      supportsContinue: true,
      sessionIdGrammar: null,        // claude is cwd-keyed; carries no resume id
      // OAuth stays inherited, while the dashboard-managed GitHub PAT is read
      // by exact name from the protected store. The runner derives the two
      // allowlisted GitHub aliases from this canonical value.
      credentialNames: ["GITHUB_TOKEN"],
      envAllowlist: [...COMMON_ALLOW, "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "DISABLE_AUTOUPDATER", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"],
      redactEnvNames: ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"],
    },

    // ---- AI Assist --------------------------------------------------------
    // Assist has its own fast, streaming, tool-free profile. It uses the user's
    // Claude subscription OAuth identity, never the metered API-key fallback.
    // Haiku is scoped to this profile only; ordinary chat keeps its configured
    // model. No charter, continuation, Git credential, bin or flag is caller-
    // controlled. Complete JSONL lines are buffered at the root redaction seam,
    // which preserves token streaming while closing cross-chunk secret splits.
    "claude-assist": {
      engineId: "claude-assist",
      bin: chatBin,
      argvTemplate: [
        "-p",
        "--safe-mode", "--disable-slash-commands", "--no-session-persistence", "--no-chrome",
        "--system-prompt", "You rewrite operator drafts. Follow the user's instructions exactly, return only the rewritten draft, and never invent facts.",
        "--model", "haiku", "--effort", "low",
        "--tools", "", "--strict-mcp-config",
        "--output-format", "stream-json", "--include-partial-messages", "--verbose",
      ],
      promptSentinel: PROMPT,
      cwd: chatCwd,
      stdin: "prompt",
      supportsContinue: false,
      sessionIdGrammar: null,
      credentialNames: [],
      envAllowlist: ASSIST_ALLOW,
      fixedEnv: {
        CLAUDE_CODE_DISABLE_THINKING: "1",
        MAX_THINKING_TOKENS: "0",
      },
      redactEnvNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
      lineBufferedOutput: true,
      outputBufferMaxChars: 65536,
    },

    // ---- Brand DNA from URL ---------------------------------------------
    // Website evidence is attacker-controlled and the caller expects one raw
    // JSON object, not Assist's transport envelope. Keep this profile distinct
    // so Assist can independently adopt stream-json or a different model.
    "claude-brand-dna": {
      engineId: "claude-brand-dna",
      bin: chatBin,
      // The prompt is NOT in this template. It is written to the child's stdin
      // (stdin: "prompt" below), because it is built from website copy the box
      // did not author: argv is visible to anything that can list processes,
      // and it is length-capped by the OS -- a real client site blew past that
      // cap on Windows at roughly 60k characters. `-p` with no argument makes
      // the CLI read the prompt from stdin, so the engine sees the same bytes.
      argvTemplate: [
        ...agentSpawnArgsStatic(PROMPT, false)
          .filter((arg) => arg !== "--dangerously-skip-permissions" && arg !== PROMPT),
        "--tools", "", "--strict-mcp-config",
        "--no-session-persistence",
      ],
      promptSentinel: PROMPT,
      cwd: chatCwd,
      stdin: "prompt",
      supportsContinue: false,
      sessionIdGrammar: null,
      credentialNames: [],
      envAllowlist: BRAND_DNA_ALLOW,
      redactEnvNames: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
      bufferOutputUntilExit: true,
      outputBufferMaxChars: 65536,
    },

    // ---- hermes ------------------------------------------------------------
    // gate.js: ["chat","-q", withCharter(prompt), "-Q","--source","tool"] (+ "-r", sid if sid)
    hermes: {
      engineId: "hermes",
      bin: homeDir + "/.local/bin/hermes",
      argvTemplate: ["chat", "-q", PROMPT_C, "-Q", "--source", "tool"],
      argvTemplateResume: ["chat", "-q", PROMPT_C, "-Q", "--source", "tool", "-r", SID],
      promptSentinel: PROMPT_C,      // charter prepended into the prompt
      cwd: homeDir,
      stdin: "inherit",
      supportsContinue: false,
      // hermes session_id: <YYYYMMDD_HHMMSS_hex> (sessionFrom regex in gate.js)
      sessionIdGrammar: /^[0-9]{8}_[0-9]{6}_[0-9a-f]+$/,
      credentialNames: [],           // hermes reads its own ~/.hermes/.env
      envAllowlist: [...COMMON_ALLOW, "HERMES_HOME"],
    },

    // ---- codex -------------------------------------------------------------
    // gate.js flags: ["exec","--json","--sandbox","read-only","--skip-git-repo-check","-C",HOME,"--color","never"]
    //   resume: [...flags,"resume",sid,"--", withCharter(prompt)]
    //   fresh:  [...flags,"--", withCharter(prompt)]
    // The "--" terminator is ALWAYS present so a malformed prompt/sid can NEVER reach flag position.
    codex: (() => {
      const flags = ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-C", homeDir, "--color", "never"];
      return {
        engineId: "codex",
        bin: "codex",
        argvTemplate: [...flags, "--", PROMPT_C],
        argvTemplateResume: [...flags, "resume", SID, "--", PROMPT_C],
        promptSentinel: PROMPT_C,
        cwd: homeDir,
        stdin: "ignore",             // codex hangs on an open non-TTY stdin (issue #20919)
        supportsContinue: false,
        // codex thread_id is a UUID (confirmed on box: 019f915c-528f-7ef2-9ade-fcb633ce3b4e)
        sessionIdGrammar: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        placeSessionBeforeDashDash: true,
        credentialNames: [],         // codex uses ~/.codex/auth.json (OAuth), no env cred
        envAllowlist: [...COMMON_ALLOW],
        // Readiness, answered ROOT-side. The gate asks "is codex ready?" over
        // the chat socket and gets back a BOOLEAN — it never opens this file,
        // never sees a token, never learns why the answer is no.
        //
        // Why: board dispatch gates on codex's saved ChatGPT login. Under
        // Foundation B the gate (999) cannot open agent-owned auth.json (0600),
        // so that check was false forever and every codex card was silently
        // dropped from dispatch (diagnosed live 2026-07-26). The obvious fix --
        // chmod the credential group-readable -- would hand the network-facing
        // process an OAuth token, which is exactly what the identity split
        // exists to prevent. Root already reads this file to launch codex, so
        // answering a yes/no about it grants no new authority.
        //
        // Mirrors gate.js readCodexChatGptAuth's own validation so the two
        // cannot disagree about what "ready" means.
        readyCheck: ({ readFileSync }) => {
          try {
            const raw = readFileSync(homeDir + "/.codex/auth.json", "utf8");
            if (!raw || raw.length < 2 || raw.length > 1024 * 1024) return false;
            const a = JSON.parse(raw);
            if (a.auth_mode !== "chatgpt") return false;
            if (a.OPENAI_API_KEY != null && String(a.OPENAI_API_KEY).length > 0) return false;
            const t = a.tokens;
            return !!t
              && typeof t.access_token === "string" && t.access_token.length >= 20
              && typeof t.refresh_token === "string" && t.refresh_token.length > 0;
          } catch { return false; }
        },
      };
    })(),

    // ---- gemini ------------------------------------------------------------
    // gate.js: ["-p", withCharter(prompt), "--output-format","json","--skip-trust"]
    gemini: {
      engineId: "gemini",
      bin: "gemini",
      argvTemplate: ["-p", PROMPT_C, "--output-format", "json", "--skip-trust"],
      promptSentinel: PROMPT_C,
      cwd: homeDir,
      stdin: "ignore",
      supportsContinue: false,
      sessionIdGrammar: null,
      credentialNames: ["GEMINI_API_KEY"],   // read root-side from secrets.env by NAME
      envAllowlist: [...COMMON_ALLOW, "GEMINI_API_KEY"],
    },

    // ---- cursor ------------------------------------------------------------
    // gate.js: ["--disable-auto-update","--trust","-p","--output-format","json","--mode","ask","--",withCharter(prompt)]
    // `--trust` trusts this fixed home workspace (Cursor may persist that
    // decision); `ask` remains Cursor's explicit read-only Q&A mode. The `--`
    // boundary keeps a prompt beginning with a flag-looking token in data
    // position. Never put the key in argv and never add --force/--yolo here.
    cursor: {
      engineId: "cursor",
      bin: "/usr/local/bin/cursor-agent",
      argvTemplate: ["--disable-auto-update", "--trust", "-p", "--output-format", "json", "--mode", "ask", "--", PROMPT_C],
      promptSentinel: PROMPT_C,
      cwd: homeDir,
      stdin: "ignore",
      supportsContinue: false,
      sessionIdGrammar: null,
      credentialNames: ["CURSOR_API_KEY"],
      envAllowlist: [...COMMON_ALLOW, "CURSOR_API_KEY"],
    },

    // kimi: DELIBERATELY ABSENT. Kimi has no uid-crossing CLI spawn in the chat
    // path (runKimiChat is an in-gate HTTP API call), so it never needs the runner.
    // Leave its existing in-gate path untouched.
  };

  return Object.freeze(profiles);
}

module.exports = { buildChatProfiles };
