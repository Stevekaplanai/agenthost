// E2E tests against the REAL gate.js for the Command Center aggregate route.
// Closes the gap the adversarial review flagged: the UI test rig's /cc/state
// fixture is a HAND-COPIED mirror of handleCommandCenter's response shape --
// nothing exercised the real route, so a field rename there (e.g. gate.js
// reverting to Hermes's native gateway_running instead of the camelCased
// gatewayRunning) would pass every test while the Command Center panels
// silently broke in production. This file hits the real /cc and /cc/state.
//
// No tmux/Hermes/Ollama process exists in this sandbox -- that's the point:
// it proves the "a dead backend renders as down, never a broken page"
// contract holds when EVERY backend is down, not just the tested happy path.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const SHELL = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "dashboard-ui", "index.html"), "utf8");
const KEY = "gate-cc-test-key";
const INVENTORY_SECRET = "inventory-secret-value-1234567890";
const INVENTORY_SHORT_SECRET = "s3cr3t7";
const INVENTORY_SKILL_TOKEN = ["ghp", "123456789012345678901234567890123456"].join("_");
const INVENTORY_SLACK_TOKEN = "xoxb-1234567890-inactive-secret";
const INVENTORY_SLACK_APP_TOKEN = `xapp-${"A".repeat(24)}`;
const INVENTORY_SLACK_ROTATED_TOKEN = `xoxe.${"B".repeat(24)}`;
const INVENTORY_AWS_TOKEN = "AKIA1234567890ABCDEF";
const INVENTORY_AWS_SECRET_METADATA = `AWS_SECRET_ACCESS_KEY=${"C".repeat(24)}`;
const INVENTORY_GOOGLE_TOKEN = `AIza${"A".repeat(35)}`;
const INVENTORY_GOOGLE_OAUTH_SECRET = `GOCSPX-${"D".repeat(24)}`;
const INVENTORY_JWT = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiJpbnZlbnRvcnktdGVzdCJ9",
  "c2lnbmF0dXJlMTIzNDU2",
].join(".");
const INVENTORY_NAME_JWT = ["eyJabcdefgh", "eyJijklmnop", "eyJqrstuvwx"].join(".");
const INVENTORY_BEARER = "Bearer abcdefghijklmnopqrstuvwxyz123456";
const INVENTORY_CREDENTIAL_NAME = "token=abcd1234";

const boxes = { dev: {}, legal: {} };

function bootGate(home, extraEnv) {
  const child = spawn("node", [GATE], {
    env: {
      ...process.env, HOME: home,
      AGENTHOST_BOX_SECRETS_FILE: path.join(home, ".agenthost", "secrets.env"),
      TTYD_PASSWORD: KEY, AGENT_CHAT_BIN: "/bin/true", GATE_PORT: "0", ...extraEnv,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = new Promise((resolve, reject) => {
    let out = "";
    const to = setTimeout(() => reject(new Error("gate did not report its port; got: " + out)), 5000);
    child.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/listening on (\d+)/);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
    child.on("exit", () => { clearTimeout(to); reject(new Error("gate exited before listening; got: " + out)); });
  });
  return { child, port };
}

before(async () => {
  for (const [name, env] of [["dev", {
    INVENTORY_TEST_SECRET: INVENTORY_SECRET,
    INVENTORY_SHORT_SECRET,
  }], ["legal", { LEGAL_MODE: "api" }]]) {
    const home = fs.mkdtempSync(path.join(import.meta.dirname, `.gatecc-${name}-`));
    fs.mkdirSync(path.join(home, "work"), { recursive: true });
    if (name === "dev") {
      fs.mkdirSync(path.join(home, ".agenthost"), { recursive: true });
      fs.writeFileSync(path.join(home, ".agenthost", "settings.json"), JSON.stringify({
        providers: { moonshot: { enabled: true } },
      }));
      fs.writeFileSync(path.join(home, ".agenthost", "secrets.env"), "KIMI_API_KEY=kimi-command-center-fixture-key\n");
    }
    // Seed the inventory sources: a settings.json whose permissions.allow hides a
    // TOKEN inside a Bash arg (the /cc/inventory tools panel must strip it to a
    // name), a skills dir, and an mcp.json. Only for the dev box (legal has no CC).
    if (name === "dev") {
      fs.mkdirSync(path.join(home, ".claude", "skills", "gap-finder"), { recursive: true });
      fs.mkdirSync(path.join(home, ".claude", "skills", "research"), { recursive: true });
      for (let index = 1; index <= 8; index++) {
        fs.mkdirSync(path.join(home, ".claude", "skills", `skill-${String(index).padStart(2, "0")}`), { recursive: true });
      }
      fs.mkdirSync(path.join(home, ".claude", "skills", INVENTORY_SKILL_TOKEN), { recursive: true });
      fs.mkdirSync(path.join(home, ".claude", "skills", INVENTORY_SLACK_TOKEN), { recursive: true });
      fs.mkdirSync(path.join(home, ".claude", "skills", INVENTORY_SLACK_APP_TOKEN), { recursive: true });
      fs.mkdirSync(path.join(home, ".claude", "skills", INVENTORY_SLACK_ROTATED_TOKEN), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude", "skills", "gap-finder", "SKILL.md"),
        "---\nname: gap-finder\ndescription: Finds missing pieces before work ships.\n---\n");
      fs.writeFileSync(path.join(home, ".claude", "skills", "research", "SKILL.md"),
        `---\nname: research\ndescription: Reviews ${INVENTORY_SECRET} and ${INVENTORY_SHORT_SECRET} under ${home} without exposing them.\n---\n`);
      const unsafeSkillDescriptions = {
        "leaky-token": `Carries ${INVENTORY_SLACK_TOKEN}, ${INVENTORY_SLACK_APP_TOKEN}, ${INVENTORY_SLACK_ROTATED_TOKEN}, ${INVENTORY_GOOGLE_OAUTH_SECRET}, ${INVENTORY_AWS_SECRET_METADATA}, and ${INVENTORY_JWT}.`,
        "path-home": "Reads ~/.ssh/id_rsa when asked.",
        "path-unix": "Reads /var/lib/app/.env when asked.",
        "path-unc": "Reads \\\\server\\share\\secret.txt when asked.",
        "path-file": "Reads file:///etc/passwd when asked.",
      };
      for (const [skill, description] of Object.entries(unsafeSkillDescriptions)) {
        const dir = path.join(home, ".claude", "skills", skill);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "SKILL.md"),
          `---\nname: ${skill}\ndescription: ${description}\n---\n`);
      }
      for (const [dir, description] of [
        [path.join(home, ".hermes", "skills", "hermes-research"), "Researches a question with Hermes."],
        [path.join(home, ".agents", "skills", "shared-planning"), "Plans work for any agent."],
        [path.join(home, "work", "sample", ".claude", "skills", "project-audit"), "Audits the current project."],
        [path.join(home, ".claude", "plugins", "cache", "market", "toolkit", "1.0.0", "skills", "plugin-audit"), "Audits through an installed plugin."],
      ]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "SKILL.md"),
          `---\ndescription: ${description}\n---\n`);
      }
      fs.mkdirSync(path.join(home, ".claude", "commands", "review"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude", "commands", "release.md"),
        "---\ndescription: Prepare and verify a release.\n---\n");
      fs.writeFileSync(path.join(home, ".claude", "commands", `${INVENTORY_NAME_JWT}.md`),
        "---\ndescription: Must never become an inventory row.\n---\n");
      fs.writeFileSync(path.join(home, ".claude", "commands", "review", "security.md"),
        "# Security review\nPrivate command instructions stay private.\n");
      fs.mkdirSync(path.join(home, ".codex", "prompts"), { recursive: true });
      fs.writeFileSync(path.join(home, ".codex", "prompts", "review.md"),
        "---\ndescription: Review a change with Codex.\n---\n");
      fs.writeFileSync(path.join(home, ".codex", "config.toml"),
        "[tools]\nweb_search = true\ndisabled_tool = false\n\n[mcp_servers.codexgraph]\ncommand = \"contains-private-args\"\n\n[mcp_servers.phantom.http_headers]\nAuthorization = \"contains-private-args\"\n");
      fs.mkdirSync(path.join(home, ".codex", "plugins", "codex-toolkit"), { recursive: true });
      fs.mkdirSync(path.join(home, ".codex", "plugins", "cache", "agentmemory", "agentmemory", "0.9.29"), { recursive: true });
      fs.mkdirSync(path.join(home, ".codex", "plugins", INVENTORY_AWS_TOKEN), { recursive: true });
      fs.mkdirSync(path.join(home, ".codex", "plugins", INVENTORY_CREDENTIAL_NAME), { recursive: true });
      fs.writeFileSync(path.join(home, ".hermes", "config.yaml"), [
        "toolsets:",
        "  - hermes-cli",
        "  - browser",
        "agent:",
        "  disabled_toolsets:",
        "    - browser",
        "mcp_servers:",
        "  hermes-search:",
        "    command: contains-private-args",
      ].join("\n"));
      fs.mkdirSync(path.join(home, ".gemini", "commands"), { recursive: true });
      fs.writeFileSync(path.join(home, ".gemini", "commands", "analyze.toml"),
        "description = \"Analyze a problem with Gemini.\"\nprompt = \"private body\"\n");
      fs.writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify({
        tools: { core: ["run_shell_command", "google_web_search"] },
        mcpServers: {
          "gemini-search": { command: "contains-private-args" },
          [INVENTORY_GOOGLE_TOKEN]: { command: "contains-private-args" },
          [INVENTORY_GOOGLE_OAUTH_SECRET]: { command: "contains-private-args" },
        },
      }));
      fs.mkdirSync(path.join(home, "work", "sample", ".claude", "commands"), { recursive: true });
      fs.writeFileSync(path.join(home, "work", "sample", ".claude", "commands", "project-release.md"),
        "---\ndescription: Release the current project.\n---\n");
      fs.writeFileSync(path.join(home, "work", "sample", ".mcp.json"), JSON.stringify({
        mcpServers: { "project-tools": { command: "contains-private-args" } },
      }));
      const pluginCommands = path.join(home, ".claude", "plugins", "cache", "market", "toolkit", "1.0.0", "commands");
      fs.mkdirSync(pluginCommands, { recursive: true });
      fs.writeFileSync(path.join(pluginCommands, "plugin-check.md"),
        "---\ndescription: Check work through an installed plugin.\n---\n");
      fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({ plugins: ["registry-only@local", "superpowers@superpowers-marketplace"] }));
      fs.mkdirSync(path.join(home, ".hermes", "plugins", "hermes-toolkit"), { recursive: true });
      fs.mkdirSync(path.join(home, ".hermes", "plugins", "local-helper@private-marketplace"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
        enabledPlugins: {
          "superpowers@superpowers-marketplace": true,
          "local-helper@private-marketplace": false,
        },
        permissions: { allow: [
          "Bash(claude mcp add-env coupler COUPLER_ACCESS_TOKEN rC4W0YfSECRETvalue1234567890abcdef)",
          "WebSearch", "Bash(git push origin main)", "Read", "Write",
          INVENTORY_BEARER,
          "mcp__obsidian__vault_read", "mcp__obsidian__search_simple",
          "mcp__019ff47c-eb10-7d21-abb1-a610d171b303__vault_read",
        ] },
      }));
      fs.writeFileSync(path.join(home, ".claude", "mcp.json"), JSON.stringify({
        mcpServers: { obsidian: { url: "http://127.0.0.1:27123" }, tolaria: { command: "x" } },
      }));
    }
    const { child, port } = bootGate(home, env);
    boxes[name].home = home;
    boxes[name].gate = child;
    boxes[name].base = `http://127.0.0.1:${await port}`;
    boxes[name].cookie = (await mintOperatorSession(boxes[name].base, KEY)).cookie;
  }
});

after(async () => {
  for (const b of Object.values(boxes)) {
    await stopChild(b.gate);
    if (b.home) fs.rmSync(b.home, { recursive: true, force: true });
  }
});

function get(box, p) {
  return fetch(box.base + p, { headers: { cookie: box.cookie }, redirect: "manual" });
}
function postReview(box, p, body) {
  return fetch(box.base + p, { method: "POST", headers: { cookie: box.cookie, origin: box.base, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "manual" });
}

test("dev: /bridge/text validates and requires login", async () => {
  // no auth -> 401
  const noauth = await fetch(boxes.dev.base + "/bridge/text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }), redirect: "manual" });
  assert.equal(noauth.status, 401, "bridge/text requires login");
  // empty text -> 400 (before any bridge call)
  const empty = await postReview(boxes.dev, "/bridge/text", { text: "   " });
  assert.equal(empty.status, 400, "empty text rejected");
  // no bridge configured in this sandbox -> 503 (never a 500)
  const nobridge = await postReview(boxes.dev, "/bridge/text", { text: "real message" });
  assert.equal(nobridge.status, 503, "no bridge configured -> 503, not a crash");
});

test("dev: /board/task/:id/review validates the action before touching the board", async () => {
  // No Hermes CLI in this sandbox, so a VALID action 503s at the CLI step --
  // but INPUT validation happens first and returns 400. That's what we assert:
  // the guardrails can't be bypassed regardless of whether Hermes is present.
  const bad = await postReview(boxes.dev, "/board/task/t_abc123/review", { action: "nuke" });
  assert.equal(bad.status, 400, "unknown action rejected");
  const noReason = await postReview(boxes.dev, "/board/task/t_abc123/review", { action: "reject" });
  assert.equal(noReason.status, 400, "reject requires a reason");
  const badEngine = await postReview(boxes.dev, "/board/task/t_abc123/review", { action: "reassign", engine: "gpt5" });
  assert.equal(badEngine.status, 400, "reassign requires a valid engine");
  const noEngine = await postReview(boxes.dev, "/board/task/t_abc123/review", { action: "reassign" });
  assert.equal(noEngine.status, 400, "reassign requires an engine");

  const deepseek = await postReview(boxes.dev, "/board/task/t_abc123/review", { action: "reassign", engine: "deepseek" });
  assert.equal(deepseek.status, 503,
    "DeepSeek passes route validation and reaches the board command boundary in this no-Hermes fixture");
  assert.match((await deepseek.json()).error, /could not reassign to deepseek/,
    "the downstream board failure names the accepted target");
});

test("DeepSeek board reassignment stays human-reachable and unattended-readiness-gated", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const reviewRoute = src.slice(src.indexOf("POST /board/task/:id/review"), src.indexOf("POST /board/task/:id/freeze"));
  assert.ok(reviewRoute.includes('/^(claude|codex|deepseek|kimi|gemini|hermes|cursor)$/.test(engine)'),
    "the human route admits DeepSeek while retaining the closed assignee list");
  assert.match(reviewRoute,
    /if \(action === "reassign"\) steps\.push\(\["reassign", taskId, engine, "--reclaim"\]\)/,
    "the operator route emits exactly reassign <task> <engine> --reclaim");

  const runner = src.slice(src.indexOf("async function boardRunnerTick"), src.indexOf("setTimeout(() => { boardRunnerTick"));
  const readinessAt = runner.indexOf('if (eng2 === "deepseek")');
  const refusalAt = runner.indexOf("if (why) {", readinessAt);
  const validation = runner.slice(readinessAt, refusalAt);
  assert.match(validation,
    /if \(eng2 === "deepseek"\) \{\s*const readiness = deepseekAutonomousReadiness\(\);\s*if \(!readiness\.ready\) return "deepseek is unavailable: " \+ readiness\.reason;\s*\}/,
    "Gemini's unattended runner rejects DeepSeek unless the live readiness predicate passes and preserves its named cause");
  const executeCommentAt = runner.indexOf("// Execute.", refusalAt);
  const refusal = runner.slice(refusalAt, executeCommentAt);
  assert.match(refusal,
    /if \(why\) \{[\s\S]*?rejected\.push\(action \+ " " \+ id \+ ": " \+ why\);[\s\S]*?audit\("board_runner_reject", action \+ " " \+ id \+ ": " \+ why[\s\S]*?continue;\s*\}/,
    "a failed readiness decision is named, audited, and exits the action");
  const execute = runner.slice(executeCommentAt, runner.indexOf("// Cooldown stamp", executeCommentAt));
  assert.match(execute, /await hermesKanban\(\["reassign", id, eng2, "--reclaim"\]\)/,
    "only the post-validation execution block can issue the fixed reassign command");
});

test("dev: /board/task/:id/review accepts the new promote + archive actions (feed one-tap)", async () => {
  // promote + archive are VALID actions, so they pass input validation and reach
  // the CLI step (never a 400 for a bad action, never a 500). In this no-Hermes
  // sandbox every CLI call resolves null:
  //   - promote MUST prove the task moved. A missing CLI cannot do that, so it
  //     returns an actionable error instead of the old false 200.
  //   - archive REQUIRES its verb to land (the dismiss must be real), so a null
  //     archive 503s -- never a false success.
  const promote = await postReview(boxes.dev, "/board/task/t_abc123/review", { action: "promote" });
  assert.equal(promote.status, 503, "promote cannot claim success when the board cannot confirm the transition");
  const promoteBody = await promote.json();
  assert.equal(promoteBody.status, "error");
  assert.equal(promoteBody.error.code, "task_unavailable");
  assert.ok(promoteBody.error.safe_retry, "the operator gets a safe retry instruction");
  const archive = await postReview(boxes.dev, "/board/task/t_abc123/review", { action: "archive" });
  assert.equal(archive.status, 503, "archive must land -> a failed archive 503s, never a false 200");
  const stillBad = await postReview(boxes.dev, "/board/task/t_abc123/review", { action: "delete" });
  assert.equal(stillBad.status, 400, "an action outside the allowlist is still rejected");
});

test("dev: task override endpoint rejects broad approval and requires an exact task", async () => {
  const broad = await postReview(boxes.dev, "/board/task/t_abc123/override", { issue: "all_safety", decision: "run_once" });
  assert.equal(broad.status, 400, "there is no broad safety-off issue");
  const badDecision = await postReview(boxes.dev, "/board/task/t_abc123/override", { issue: "wording_gate", decision: "always" });
  assert.equal(badDecision.status, 400, "only one-run authority exists");
  const noBoard = await postReview(boxes.dev, "/board/task/t_abc123/override", { issue: "wording_gate", decision: "run_once" });
  assert.equal(noBoard.status, 503, "a task-specific override cannot be minted without reading the exact task");
  const body = await noBoard.json();
  assert.equal(body.status, "error");
  assert.equal(body.error.code, "task_unavailable");
  const consequenceNoBoard = await postReview(boxes.dev, "/board/task/t_abc123/override", { issue: "consequence_gate", decision: "approve_once" });
  assert.equal(consequenceNoBoard.status, 503, "a consequence approval also requires the exact current task");
});

test("dev: only / serves the generated workspace; old Box Console roots are gone", async () => {
  const current = await get(boxes.dev, "/");
  assert.equal(current.status, 200);
  assert.equal(await current.text(), SHELL);

  for (const pathname of ["/cc", "/cc/legacy"]) {
    const retired = await get(boxes.dev, pathname);
    assert.equal(retired.status, 410, pathname);
    assert.equal(retired.headers.get("location"), null, pathname);
    assert.match(await retired.text(), /standalone application route was retired.*no redirect or compatibility UI/i, pathname);
  }
});

test("dev: /api/capabilities fails closed without a Gemini execution broker", async () => {
  const r = await get(boxes.dev, "/api/capabilities");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await r.json();
  const gemini = body.engines.find((engine) => engine.id === "gemini");
  assert.ok(gemini, "Gemini capability is present");
  assert.equal(gemini.available, false);
  assert.equal(gemini.checks.jailReady, false);
  assert.equal(gemini.reasons.jail, "sandbox_binary_missing");
  assert.equal(gemini.checks.credentialBrokerReady, false);
  assert.equal(gemini.reasons.credentialBroker, "gemini_inference_broker_unavailable");
  assert.equal(gemini.nextActions.some((action) => action.id === "restart-broker"), false,
    "the route must not offer a restart for a broker that does not exist");
});

test("dev: /profiles/data never offers work or review to software that is not installed", async () => {
  const response = await get(boxes.dev, "/profiles/data");
  assert.equal(response.status, 200);
  const body = await response.json();
  const hermes = body.agents.find((agent) => agent.id === "hermes");
  assert.ok(hermes, "Hermes remains an observed roster entry");
  assert.equal(hermes.installed, false, "the isolated fixture has no Hermes binary");
  for (const capability of ["chat", "terminal", "unattended", "review"]) {
    assert.equal(hermes.capabilities[capability].state, "unavailable", capability);
    assert.equal(hermes.capabilities[capability].reasonCode, "NOT_INSTALLED", capability);
  }
  const deepseek = body.agents.find((agent) => agent.id === "deepseek");
  assert.ok(deepseek, "DeepSeek remains an observed roster entry");
  assert.equal(typeof deepseek.provider, "string", "provider labels are render-safe text, never React-crashing objects");
  assert.match(deepseek.provider, /^deepseek \/ /);
  assert.equal(deepseek.workspace, "~/workspaces/deepseek");
  assert.notEqual(deepseek.isolationStatus, "proven",
    "an isolated workspace is not claimed proven until the live checkout passes readiness");
});

test("dev: GET /cc/state returns the real aggregate shape with every backend down", async () => {
  const r = await get(boxes.dev, "/cc/state?tz=-240");
  assert.equal(r.status, 200);
  const st = await r.json();
  // day + usage: no chat turns recorded in this fresh sandbox.
  assert.match(st.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(st.usage, {}, "no usage yet on a fresh box");
  // windows: tmuxWindows() reads the agent-published seam file (windows.state);
  // absent in this sandbox -> null, not a thrown error. (Under Foundation B gate
  // never spawns tmux; the seam is the only read path.)
  assert.equal(st.windows, null, "tmuxWindows() degrades to null when the seam state file is absent");
  assert.equal(Object.prototype.hasOwnProperty.call(st, "hermes"), false,
    "the retired Hermes dashboard does not survive as a parallel status source");
  assert.equal(typeof st.ollama.up, "boolean");
  assert.ok(Array.isArray(st.ollama.loaded));
  assert.ok(st.ollama.pulled === null || typeof st.ollama.pulled === "number");
  assert.ok(st.engines && typeof st.engines === "object", "the browser receives one authoritative engine-state map");
  for (const id of ["claude", "codex", "gemini", "cursor", "hermes", "kimi", "openclaw", "ollama", "term"]) {
    assert.ok(st.engines[id], `${id} has a status record`);
    assert.ok(["working", "ready", "restarting", "down", "not_installed", "not_configured"].includes(st.engines[id].state));
  }
  assert.equal(st.engines.kimi.state, "ready", "an enabled Moonshot route with its box credential is online even without a Kimi CLI inventory row");
  assert.equal(st.engines.kimi.summary, "Moonshot route ready");
  const gemini = st.engines.gemini;
  assert.equal(typeof gemini.workspaceReady, "boolean", "Gemini workspace readiness is a server-owned status field");
  assert.equal(gemini.capability.available, false, "an interactive Gemini terminal never implies unattended authority");
  assert.equal(gemini.capability.status, "unavailable");
  assert.equal(gemini.capability.checks.workspaceReady, gemini.workspaceReady, "capability checks match the visible workspace state");
  // feed: empty audit log -> empty array, not an error.
  assert.deepEqual(st.feed, [], "no audit events yet");
  // channels (CONT-05): a fresh box has every channel off by default (settings-lib
  // DEFAULTS), so ready/credentialPresent are false without a probe ever reporting
  // an error -- the same "down renders as down, never a thrown error" contract.
  assert.ok(st.channels && typeof st.channels === "object");
  for (const [ch, owner] of [["telegram", "openclaw"], ["discord", "openclaw"], ["whatsapp", "hermes"]]) {
    assert.equal(st.channels[ch].enabled, false, `${ch} is off by default`);
    assert.equal(st.channels[ch].owner, owner, `${ch}'s default owner matches settings-lib`);
    assert.equal(st.channels[ch].ready, false, `${ch} is not ready with no tmux/config in this sandbox`);
    assert.equal(st.channels[ch].credentialPresent, false, `${ch} has no ~/.openclaw/openclaw.json here`);
  }
});

test("dev: GET /cc/inventory returns complete, descriptive, secret-safe inventory", async () => {
  const r = await get(boxes.dev, "/cc/inventory");
  assert.equal(r.status, 200);
  const inv = await r.json();
  // agents: the roster, each with install/route booleans.
  assert.deepEqual(inv.agents.map((agent) => agent.id).sort(),
    ["claude", "codex", "cursor", "deepseek", "gemini", "hermes", "kimi", "openclaw"],
    "the complete current agent roster is returned");
  const claude = inv.agents.find((a) => a.id === "claude");
  assert.equal(claude.routed, true, "claude answers in chat");
  assert.equal(typeof claude.installed, "boolean");
  assert.ok(claude.description && claude.source && claude.status, "agent rows carry useful details");
  // Skills: every safe installed skill across the agent harnesses, project
  // checkouts, and plugin bundles is returned -- not a Claude-only sample.
  assert.equal(inv.skills.count, 19, "all safe seeded skill dirs across harnesses");
  assert.equal(inv.skills.items.length, 19, "every installed skill is available to browse");
  assert.deepEqual(inv.skills.names, inv.skills.items.map((skill) => skill.name));
  assert.ok(!JSON.stringify(inv.skills).includes(INVENTORY_SKILL_TOKEN), "token-shaped names are not exposed");
  const gapFinder = inv.skills.items.find((skill) => skill.name === "gap-finder");
  assert.equal(gapFinder.description, "Finds missing pieces before work ships.");
  for (const [name, source] of [
    ["hermes-research", /Hermes/],
    ["shared-planning", /Shared/],
    ["project-audit", /Project/],
    ["plugin-audit", /plugin/i],
  ]) {
    const skill = inv.skills.items.find((item) => item.name === name);
    assert.ok(skill, `${name} is discovered outside Claude's user skill folder`);
    assert.match(skill.source, source, `${name} identifies its generic source without a private path`);
  }
  const research = inv.skills.items.find((skill) => skill.name === "research");
  assert.ok(!research.description.includes(INVENTORY_SECRET), "skill metadata redacts secret values");
  assert.ok(!research.description.includes(INVENTORY_SHORT_SECRET), "short password-shaped values are also redacted");
  assert.ok(!research.description.includes(boxes.dev.home), "skill metadata does not expose absolute home paths");
  for (const name of ["leaky-token", "path-home", "path-unix", "path-unc", "path-file"]) {
    assert.match(inv.skills.items.find((skill) => skill.name === name).description, /No description/,
      `${name} fails closed instead of displaying suspicious metadata`);
  }
  // MCPs: union the safe names from Claude, Codex, Gemini, Hermes, and projects.
  assert.deepEqual(inv.mcps.map((m) => m.name).sort(),
    ["codexgraph", "gemini-search", "hermes-search", "obsidian", "project-tools", "tolaria"]);
  const obsidian = inv.mcps.find((m) => m.name === "obsidian");
  assert.deepEqual(obsidian.tools, ["search_simple", "vault_read"], "connector exposes only safe tool names");
  assert.ok(obsidian.description && obsidian.source && obsidian.status, "connector rows carry useful details");
  assert.equal(obsidian.configured, true);
  assert.equal(obsidian.available, null);
  assert.equal(obsidian.runtimeConnected, null, "configuration is not reported as a live connection");
  assert.equal(Object.prototype.hasOwnProperty.call(obsidian, "connected"), false,
    "the legacy connected alias cannot turn configuration into a false runtime claim");
  assert.ok(!inv.mcps.some((m) => m.name.includes("phantom") || m.name.includes("http_headers")),
    "nested Codex TOML tables do not invent MCP servers");
  assert.match(inv.mcps.find((m) => m.name === "codexgraph").source, /Codex/);
  assert.match(inv.mcps.find((m) => m.name === "gemini-search").source, /Gemini/);
  assert.match(inv.mcps.find((m) => m.name === "hermes-search").source, /Hermes/);
  assert.match(inv.mcps.find((m) => m.name === "project-tools").source, /Project/);
  // tools: NAMES ONLY -- the token in the Bash arg must NOT survive anywhere.
  const blob = JSON.stringify(inv.tools);
  assert.ok(inv.tools.includes("Bash") && inv.tools.includes("WebSearch"), "tool names kept");
  assert.ok(!blob.includes("COUPLER") && !blob.includes("SECRET") && !blob.includes("rC4W0Yf"),
    "no token/secret leaks into the tools panel");
  for (const [name, source] of [
    ["hermes-cli", /Hermes/],
    ["web_search", /Codex/],
    ["run_shell_command", /Gemini/],
  ]) {
    const tool = inv.toolDetails.find((item) => item.name === name);
    assert.ok(tool, `${name} is represented outside Claude's permission file`);
    assert.match(tool.source, source);
  }
  assert.ok(!inv.tools.includes("browser"), "globally disabled Hermes toolsets stay hidden");
  assert.ok(inv.toolDetails.every((tool) => tool.description && tool.source && tool.status),
    "every tool row carries useful details");
  assert.ok(!inv.tools.some((tool) => tool.includes("019ff47c-eb10-7d21-abb1-a610d171b303")),
    "unresolved UUID connector heads are omitted");

  assert.ok(Array.isArray(inv.items) && inv.items.length > 0, "the endpoint includes normalized inventory items");
  const normalizedObsidian = inv.items.find((item) => item.key === "mcp:obsidian");
  assert.ok(normalizedObsidian, "the normalized connector row is reachable by its stable key");
  assert.deepEqual(normalizedObsidian.sources,
    ["Claude MCP configuration"], "sources are explicit and deterministic");
  assert.equal(normalizedObsidian.configured, true);
  assert.equal(normalizedObsidian.available, null);
  assert.equal(normalizedObsidian.runtimeConnected, null);

  const superpowers = inv.plugins.find((plugin) => plugin.id === "superpowers@superpowers-marketplace");
  assert.ok(superpowers && superpowers.status === "Enabled" && /planning/i.test(superpowers.description),
    "known enabled plugin uses truthful starter metadata");
  assert.equal(superpowers.available, true, "later registry evidence proves a configured plugin is installed");
  assert.match(superpowers.source, /Claude plugin configuration/);
  assert.match(superpowers.source, /Claude plugin registry/);
  const normalizedSuperpowers = inv.items.find((item) =>
    item.key === "plugin:superpowers@superpowers-marketplace");
  assert.ok(normalizedSuperpowers, "plugin normalization uses the stable plugin ID, not its display name");
  assert.equal(normalizedSuperpowers.available, true);
  assert.equal(inv.proposal.rows.find((row) =>
    row.key === "plugin:superpowers@superpowers-marketplace")?.recommendation, "keep",
  "the curated plugin ID matches the normalized inventory key");
  const localHelper = inv.plugins.find((plugin) => plugin.id === "local-helper@private-marketplace");
  assert.ok(localHelper && localHelper.status === "Disabled" && /No description/.test(localHelper.description),
    "unknown plugin uses a neutral fallback");
  assert.equal(localHelper.available, true, "later directory evidence proves a configured plugin is installed");
  assert.match(localHelper.source, /Claude plugin configuration/);
  assert.match(localHelper.source, /Hermes plugin directory/);
  assert.ok(inv.plugins.some((plugin) =>
    plugin.id === "registry-only@local" &&
    plugin.status === "Installed"), "registry-only plugins remain visible");
  assert.ok(inv.plugins.some((plugin) =>
    plugin.id === "hermes-toolkit" &&
    plugin.status === "Installed" &&
    /Hermes/.test(plugin.source) &&
    /No description/.test(plugin.description)), "Hermes plugin inventory is included with neutral metadata");
  assert.ok(inv.plugins.some((plugin) =>
    plugin.id === "codex-toolkit" &&
    plugin.status === "Installed" &&
    /Codex/.test(plugin.source)), "Codex plugin identities are included");
  const cachedAgentMemory = inv.plugins.find((plugin) => plugin.id === "agentmemory@agentmemory");
  assert.ok(cachedAgentMemory && cachedAgentMemory.available === true,
    "Codex cache marketplace/plugin/version paths normalize to the stable plugin ID");
  assert.equal(inv.proposal.rows.find((row) =>
    row.key === "plugin:agentmemory@agentmemory")?.recommendation, "keep",
  "a live cached curated plugin matches its starter-stack identity");

  const commandKeys = inv.commands.map((command) => command.key);
  for (const key of [
    "/brain", "/claude", "/hermes", "/codex", "/gemini", "/cursor", "/loops", "/skills",
    "/release", "/review/security", "/prompts:review", "/analyze", "/project-release", "/plugin-check",
  ]) {
    assert.ok(commandKeys.includes(key), `${key} is browsable`);
  }
  assert.equal(inv.commands.find((command) => command.key === "/release").description,
    "Prepare and verify a release.");
  assert.equal(inv.commands.find((command) => command.key === "/prompts:review").description,
    "Review a change with Codex.");
  assert.equal(inv.commands.find((command) => command.key === "/analyze").description,
    "Analyze a problem with Gemini.");
  assert.match(inv.commands.find((command) => command.key === "/project-release").source, /Project/);
  assert.match(inv.commands.find((command) => command.key === "/plugin-check").source, /plugin/i);
  assert.match(inv.commands.find((command) => command.key === "/review/security").description,
    /No description/, "missing command metadata gets a neutral fallback");

  for (const section of [inv.agents, inv.skills.items, inv.plugins, inv.mcps, inv.toolDetails, inv.commands]) {
    assert.ok(section.every((item) => item.description && item.source && item.status),
      "every returned inventory item has description, source, and status");
  }
  const responseBlob = JSON.stringify(inv);
  assert.ok(!responseBlob.includes(INVENTORY_SECRET), "response never exposes an environment secret");
  assert.ok(!responseBlob.includes(INVENTORY_SHORT_SECRET), "response never exposes a short environment secret");
  assert.ok(!responseBlob.includes(INVENTORY_SLACK_TOKEN), "response never exposes an inactive Slack credential");
  assert.ok(!responseBlob.includes(INVENTORY_SLACK_APP_TOKEN), "response never exposes a Slack app credential");
  assert.ok(!responseBlob.includes(INVENTORY_SLACK_ROTATED_TOKEN), "response never exposes a rotated Slack credential");
  assert.ok(!responseBlob.includes(INVENTORY_AWS_TOKEN), "response never exposes an AWS credential");
  assert.ok(!responseBlob.includes(INVENTORY_AWS_SECRET_METADATA), "response never exposes AWS secret metadata");
  assert.ok(!responseBlob.includes(INVENTORY_GOOGLE_TOKEN), "response never exposes a Google credential");
  assert.ok(!responseBlob.includes(INVENTORY_GOOGLE_OAUTH_SECRET), "response never exposes a Google OAuth credential");
  assert.ok(!responseBlob.includes(INVENTORY_JWT), "response never exposes a JWT-shaped credential");
  assert.ok(!responseBlob.includes(INVENTORY_NAME_JWT), "response never exposes a JWT-shaped command name");
  assert.ok(!responseBlob.includes(INVENTORY_BEARER), "response never exposes a bearer credential");
  assert.ok(!responseBlob.includes(INVENTORY_CREDENTIAL_NAME), "response never exposes credential syntax as a name");
  assert.ok(!responseBlob.includes(boxes.dev.home), "response never exposes the private fixture path");
  assert.ok(!responseBlob.includes("~/.ssh/id_rsa"), "response never exposes a home-relative private path");
  assert.ok(!responseBlob.includes("/var/lib/app/.env"), "response never exposes an arbitrary Unix path");
  assert.ok(!responseBlob.includes("\\\\server\\share"), "response never exposes a UNC path");
  assert.ok(!responseBlob.includes("file:///etc/passwd"), "response never exposes a file URL");
  assert.ok(!responseBlob.includes("git push origin main"), "response never exposes raw tool arguments");

  const paletteResponse = await get(boxes.dev, "/commands");
  assert.equal(paletteResponse.status, 200);
  const palette = await paletteResponse.json();
  assert.ok(Array.isArray(palette.skills) && palette.skills.length > 0,
    "the existing chat skill palette remains compatible");
  assert.ok(palette.commands.some((command) => command.key === "/release"),
    "the shared command source includes installed slash commands");
  assert.ok(palette.commands.some((command) => command.key === "/prompts:review"),
    "the chat palette includes Codex prompts from the same complete command source");
});

test("legal: GET /cc/inventory is 404 (no Command Center on a single-engine box)", async () => {
  const r = await get(boxes.legal, "/cc/inventory");
  assert.equal(r.status, 404);
});

test("dev: /cc/state completes promptly even though every backend is unreachable (no hang)", async () => {
  const t0 = Date.now();
  const r = await get(boxes.dev, "/cc/state");
  assert.equal(r.status, 200);
  await r.text();
  // Well under the 2.5s localJson timeout -- ECONNREFUSED (no listener) is
  // immediate, unlike the mid-response-death case the localJson fix targets.
  assert.ok(Date.now() - t0 < 2400, "connection-refused backends resolve fast, not via the 2.5s timeout path");
});

test("dev: chat_run and brain_run audit lines carry a structured eng field, not a text prefix", async () => {
  // A message on the default engine (claude): starting with text that LOOKS
  // like an engine prefix must not be misread by the feed -- this is the
  // exact collision the adversarial review found (a prefix baked into
  // `detail` could be forged by the user's own query text).
  await get(boxes.dev, "/chat/stream?msg=" + encodeURIComponent("/brain hermes: gateway config"));
  const r = await get(boxes.dev, "/cc/state");
  const st = await r.json();
  const brainEvents = st.feed.filter((e) => e.what.includes("searched the brain"));
  assert.equal(brainEvents.length, 1);
  assert.equal(brainEvents[0].eng, "claude", "engine comes from audit()'s structured field, not parsed from the query text");
  assert.ok(brainEvents[0].what.includes("hermes: gateway config"), "the query text is preserved verbatim, not eaten as a false prefix");
});

test("legal: the canonical root serves the branded workspace and /cc is retired without redirecting", async () => {
  const root = await get(boxes.legal, "/");
  assert.equal(root.status, 200);
  assert.match(await root.text(), /<body data-brand="legal"/);

  const retired = await get(boxes.legal, "/cc");
  assert.equal(retired.status, 410);
  assert.equal(retired.headers.get("location"), null);
  assert.equal(retired.headers.get("set-cookie"), null);
  assert.doesNotMatch(await retired.text(), /__next_f|agenthost-dashboard-root/);
});

test("legal: /cc/state 404s (mirrors /cc's brand gate -- no live endpoint for a surface that doesn't exist)", async () => {
  const r = await get(boxes.legal, "/cc/state");
  assert.equal(r.status, 404);
});

// ---- V2 autonomy control ----------------------------------------------------
function post(box, p, body) {
  return fetch(box.base + p, {
    method: "POST", headers: { cookie: box.cookie, origin: box.base, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
    body: JSON.stringify(body), redirect: "manual",
  });
}

test("dev: /autonomy is OFF by default and toggles on/off (the STOP switch)", async () => {
  const g = await get(boxes.dev, "/autonomy");
  assert.equal(g.status, 200);
  const st = await g.json();
  assert.equal(st.on, false, "autonomy is OFF on a fresh box (safe default)");
  assert.ok(Array.isArray(st.chains), "chains list present");
  // Turn it on.
  const on = await (await post(boxes.dev, "/autonomy", { on: true })).json();
  assert.equal(on.on, true, "POST {on:true} enables autonomy");
  assert.equal((await (await get(boxes.dev, "/autonomy")).json()).on, true, "state persists");
  // STOP it.
  const off = await (await post(boxes.dev, "/autonomy", { on: false })).json();
  assert.equal(off.on, false, "POST {on:false} is the STOP switch");
  assert.equal((await (await get(boxes.dev, "/autonomy")).json()).on, false, "stopped state persists");
});

test("legal: /autonomy 404s (single-engine box has no autonomy surface)", async () => {
  assert.equal((await get(boxes.legal, "/autonomy")).status, 404);
  assert.equal((await post(boxes.legal, "/autonomy", { on: true })).status, 404);
});

// SECURITY INVARIANT (sandboxed-only auto-execute). The load-bearing safety
// property: EVERY engine in the exec set MUST run sandboxed. codex runs
// --sandbox read-only + the Bubblewrap allowlist jail; claude runs the read-jail (autoJail +
// autoEnv: plan mode, scrubbed env, no MCP, chroot into an allowlist-only root),
// verified sound by a 3-round red-team. hermes, gemini, and kimi run the Bubblewrap
// allowlist jail (autoBwrapJail). Steve added claude 2026-07-18, gemini 2026-08-06,
// kimi 2026-08-07. This guard fails CI if the set ever contains an engine WITHOUT
// a filesystem sandbox profile.
test("sandboxed-only auto-execute: every exec engine has a contained execution path", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const m = src.match(/const AUTONOMOUS_EXEC_ENGINES = new Set\((\[[^\]]*\])\)/);
  assert.ok(m, "AUTONOMOUS_EXEC_ENGINES is defined");
  const execEngines = JSON.parse(m[1]);
  assert.deepEqual([...execEngines].sort(), ["claude", "codex", "deepseek", "gemini", "hermes", "kimi"],
    "exec set is exactly the six approved non-Cursor engines");
  // Process-backed engines define their allowlist filesystem-jail profile in
  // ENGINES. DeepSeek uses the stricter root-owned DSH runner instead.
  const enginesStart = src.indexOf("const ENGINES = {");
  const nextEngine = { claude: "hermes", codex: "gemini", gemini: "kimi", hermes: "codex", kimi: "cursor" };
  const engineBlocks = {};
  for (const e of execEngines.filter((id) => id !== "deepseek")) {
    const start = src.indexOf("  " + e + ": {", enginesStart);
    const end = src.indexOf("  " + nextEngine[e] + ": {", start);
    assert.ok(start >= enginesStart && end > start, `${e} engine block is present`);
    const block = src.slice(start, end);
    engineBlocks[e] = block;
    assert.ok(/autoJail:\s*true/.test(block) || /autoBwrapJail:\s*true/.test(block),
      `${e} in the exec set MUST define an allowlist jail`);
  }
  const dshStart = src.indexOf("function runDeepSeekAutonomousTask");
  const dshEnd = src.indexOf("function runAutonomousTask", dshStart);
  assert.ok(dshStart !== -1 && dshEnd > dshStart, "the bounded DeepSeek autonomous function exists");
  const dshRun = src.slice(dshStart, dshEnd);
  assert.match(dshRun, /createDshInferenceRelay[\s\S]*?runReviewViaChatSocket\("deepseek"/,
    "DeepSeek runs only through its gate-owned relay and root-contained DSH profile");
  const readinessStart = src.indexOf("function deepseekAutonomousReadiness");
  const readinessEnd = src.indexOf("function autonomousEngineReady", readinessStart);
  assert.ok(readinessStart !== -1 && readinessEnd > readinessStart,
    "the bounded DeepSeek readiness function exists");
  const readiness = src.slice(readinessStart, readinessEnd);
  assert.match(readiness, /"\/usr\/bin\/bwrap"/,
    "DeepSeek refuses unattended work unless its outer Bubblewrap jail exists");
  assert.match(readiness, /"\/opt\/deepseek-harness\/apps\/cli\/lib\/bin\.js"/,
    "DeepSeek readiness checks the exact DSH CLI path copied into the image");
  // The dispatch-eligibility filter gates on the EXEC set, never the review set.
  assert.ok(
    /BOARD_COLUMN\[t\.status\] === "queued" &&\s*AUTONOMOUS_EXEC_ENGINES\.has/.test(src),
    "the queued-task dispatch filter uses AUTONOMOUS_EXEC_ENGINES",
  );
  // The old blanket AUTONOMOUS_ENGINES set is fully gone (no accidental reuse).
  assert.ok(!/\bAUTONOMOUS_ENGINES\b/.test(src), "the old blanket AUTONOMOUS_ENGINES set no longer exists");
  // claude has the READ-JAIL profile wired: autoArgs (plan-mode locked argv),
  // autoEnv (scrubbed env), and autoJail (the chroot read-jail -- allowlist binds,
  // /home + secret paths ABSENT). Verified escape-proof on the box.
  const claudeBlock = engineBlocks.claude;
  // autoArgs = the locked plan-mode argv (chains.claudeAutonomousArgs), now with
  // the team charter spread onto the end in Claude's system slot.
  assert.ok(/autoArgs:\s*\(prompt, scratch, repoDir\)\s*=>\s*\[\.\.\.chains\.claudeAutonomousArgs\(prompt, scratch, repoDir\), \.\.\.CLAUDE_CHARTER_ARGS\]/.test(claudeBlock),
    "claude defines autoArgs -> chains.claudeAutonomousArgs (+ charter system args)");
  assert.ok(/autoEnv:\s*\(env\)\s*=>\s*chains\.sandboxedClaudeEnv/.test(claudeBlock),
    "claude defines autoEnv -> chains.sandboxedClaudeEnv");
  assert.ok(/autoJail:\s*true/.test(claudeBlock),
    "claude defines autoJail:true (the chroot read-jail)");
  // runAutonomousTask MUST use the locked args + scrubbed env, jail a jailed
  // engine, and MUST NOT fall back to raw process.env / chat args.
  const rat = src.slice(src.indexOf("function runAutonomousTask"), src.indexOf("function autonomousPrompt"));
  assert.ok(/const usesAutoArgs = typeof eng\.autoArgs === "function"/.test(rat),
    "runAutonomousTask detects a locked-argv engine by autoArgs");
  // The scrubbed env (autoEnv) is still the base; the narrow social-posting key
  // allowlist (autonomySocialEnv -> POSTIZ_API_KEY only) is spread on top so a
  // board social-posting task can reach Postiz unattended. Both must be present.
  assert.ok(/typeof eng\.autoEnv === "function"\)\s*\?\s*\{ \.\.\.eng\.autoEnv\(process\.env\), \.\.\.autonomySocialEnv\(\) \}\s*:\s*\{ \.\.\.process\.env, \.\.\.autonomySocialEnv\(\) \}/.test(rat),
    "runAutonomousTask uses the scrubbed autoEnv as the base, plus the social-key allowlist");
  assert.ok(/const AUTONOMY_SOCIAL_KEYS = \["POSTIZ_API_KEY"\]/.test(src),
    "the autonomous social-key allowlist is EXACTLY POSTIZ_API_KEY (no broader secret leak into the jail)");
  assert.ok(/if \(eng\.autoJail\)/.test(rat) && /chains\.buildReadJail\(eng\.bin, runArgs/.test(rat),
    "runAutonomousTask runs a jailed engine (claude) in the chroot read-jail");
  // The sanitized repo stage: jailed runs get ~/work code at /repo, but ONLY
  // through stageJailRepos (which strips .env/.git/keys) -- never a direct bind
  // of the real work dir (whose .env files hold live Fly secrets).
  assert.ok(/stageJailRepos\(path\.join\(HOME_DIR, "work"\), repoStage\)/.test(rat),
    "the jail's repo view comes from stageJailRepos (sanitized copy), sourced from ~/work");
  assert.ok(/\{ src: repoStage, dest: JAIL_REPO \}/.test(rat),
    "the sanitized stage (not ~/work itself) is what gets bound at /repo");
  assert.ok(!/roBindsAt:[^\]]*HOME_DIR, "work"/.test(rat),
    "the real ~/work dir is never bound into the jail directly");
  assert.ok(/if \(repoStage\) \{ try \{ fs\.rmSync\(repoStage/.test(rat),
    "the repo stage is cleaned up with the run");
  assert.ok(/if \(eng\.autoJail \|\| eng\.autoBwrapJail\) runEnv = \{ \.\.\.runEnv, HOME: "\/hm" \}/.test(rat),
    "a jailed engine's HOME points inside the jail (/hm), not the host HOME");
  // Codex uses the Bubblewrap outer jail (rather than the weaker legacy mask).
  // Its private state directory is mounted only inside that jail, while the
  // locked inner profile blocks model commands from reading it.
  const codexBlock = engineBlocks.codex;
  assert.ok(/autoBwrapJail:\s*true/.test(codexBlock), "codex defines the Bubblewrap allowlist jail (not the mask)");
  assert.ok(/autoEnv:\s*\(env\)\s*=>\s*codexAutonomousEnv\(env\)/.test(codexBlock), "codex uses the scrubbed subscription-auth environment helper");
  assert.ok(!/autoJailRwBinds:/.test(codexBlock), "codex has no host auth-directory bind");
  assert.ok(/autoBin:\s*CODEX_AUTH_ONCE/.test(codexBlock), "codex starts through the native auth-once launcher");
  assert.ok(/const CODEX_AUTH_ONCE = "\/usr\/local\/bin\/codex-auth-once"/.test(src), "Codex uses the native one-run auth launcher");
  assert.ok(/\{ src: codexAuthHome, dest: "\/codex" \}/.test(rat), "the private persistent Codex state directory is mounted only for the autonomous launcher");
  assert.ok(!/createCodexAuthProxy/.test(src), "no bearer-token proxy exists for a model command to reuse");
});

// Handoff-laundering fix: a proposed child from an autonomous run must NOT be
// immediately auto-execute-eligible -- it's created `blocked` (which boardTick
// never dispatches) and a human must promote it. A regression back to `todo`
// (which maps to `queued` -> auto-runs) is a real escalation, so guard it here.
test("handoff children are created blocked (human-gated), never todo/queued", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  // 4000-char window: the circuit breaker (2026-07-20) prepends its cap/park
  // decision to this function, so the create call now sits ~3.2K in -- widen the
  // slice so this source guard still captures it (and the promote-body below).
  const fn = src.slice(src.indexOf("function createProposedHandoffs"), src.indexOf("function createProposedHandoffs") + 4000);
  assert.ok(/"--initial-status", "blocked"/.test(fn), "handoff child is created with --initial-status blocked");
  assert.ok(!/"--initial-status", "todo"/.test(fn), "handoff child is NOT created todo (would auto-run)");
  assert.ok(/human must promote/i.test(fn), "the child body tells a human to promote it before it runs");
});

// ---- Team charter: loaded from the image, injected into EVERY engine turn -----
// The charter is the box agents' standing orders. Two guards: (1) the pure
// injection helpers behave (empty charter -> no-op; non-empty -> the right
// shape); (2) every engine entry point in gate.js actually threads the charter,
// so a future edit can't silently drop it from an engine or a run path.

test("charter helpers: claudeCharterArgs / withCharter behave (empty = no-op, set = injected)", async () => {
  const gate = await import("../container/gate.js");
  // Claude: system-slot flag pair, empty on no charter (never an empty flag).
  assert.deepEqual(gate.claudeCharterArgs(""), []);
  assert.deepEqual(gate.claudeCharterArgs("RULES"), ["--append-system-prompt", "RULES"]);
  // Hermes/Codex: prompt-prefix, delimited; empty charter passes the prompt through.
  assert.equal(gate.withCharter("", "do X"), "do X");
  const injected = gate.withCharter("CHARTER BODY", "do X");
  assert.ok(injected.includes("CHARTER BODY"), "prompt-prefix carries the charter text");
  assert.ok(injected.endsWith("do X"), "the real task follows the charter block");
  assert.ok(/TEAM CHARTER/.test(injected), "the block is fenced so it reads as standing context");
});

// ---- Autonomy readiness fixes (audit 2026-07-18) ----------------------------
// These three failures made unattended autonomy impossible: the loop could die
// silently (B1), a failed run was scored as a success (B2), and failures never
// reached the operator's feed/phone (B3). Guard the wiring so a refactor can't
// silently reopen any of them.

test("B1: the watchdog quarantines every unproven process lane without force-releasing it", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  // The watchdog block: from AGENT_HARD_MAX_MS to its setInterval close.
  const wd = src.slice(src.indexOf("AGENT_HARD_MAX_MS ="), src.indexOf("}, 30 * 1000).unref();"));
  const autonomous = wd.slice(wd.indexOf('if (agentBusyKind === "autonomy")'), wd.indexOf("quarantineAgentLane("));
  assert.ok(/autonomy_claim_quarantined/.test(autonomous), "an overdue autonomous claim is audited as quarantined");
  assert.ok(/boardBusyAutonomous = true/.test(autonomous), "the autonomous dispatch guard stays closed");
  assert.ok(!/agentBusy = false/.test(autonomous) && !/agentRunToken\+\+/.test(autonomous),
    "the autonomous watchdog does not free a lane while its worker may still exist");
  assert.match(wd, /quarantineAgentLane\(/,
    "chat, wake, cron, and autonomy all use the same no-replacement fail-safe");
  assert.ok(!/agentBusy = false/.test(wd) && !/agentRunToken\+\+/.test(wd) && !/dispatchAgentSlot/.test(wd),
    "the watchdog never launches replacement work without terminal process proof");
});

test("B2: finishWorkRun trusts result.ranClean, never 'is text non-empty' (a failed run is a failure, not a success)", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const fwr = src.slice(src.indexOf("function finishWorkRun"), src.indexOf("function finishWorkRun") + 2900);
  assert.ok(/if \(!result \|\| !result\.ranClean\)/.test(fwr),
    "the failure gate branches on ranClean (B2), not on empty text");
  assert.ok(!/if \(!result \|\| !result\.text\)/.test(fwr),
    "the old '!result.text' failure gate is gone (it scored every error as done)");
  // ranClean is produced by runAutonomousTask only on a genuinely clean exit.
  const rat = src.slice(src.indexOf("function runAutonomousTask"), src.indexOf("function finishWorkRun"));
  assert.ok(/const ranClean = code === 0 && !timedOut && !processError && hadRealOutput/.test(rat),
    "ranClean requires exit 0, no timeout or process error, and real (non-fallback) output");
  assert.ok(/finish\(\{ text:.*ranClean \}\)/.test(rat), "runAutonomousTask returns ranClean on the result");
  assert.ok(/let timedOut = false;/.test(rat) && /timedOut = true;[\s\S]{0,100}?try \{ child\.kill/.test(rat),
    "a timed-out run is marked so it can't be scored clean");
});

test("B3: failure/attention events render on the feed and fire pushes (the bad news is no longer invisible)", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const feed = src.slice(src.indexOf("function ccFeedFromLines"), src.indexOf("// Lib mode"));
  for (const ev of ["autonomy_run_failed", "autonomy_blocked", "autonomy_handoff_proposed"]) {
    assert.ok(feed.includes('e.event === "' + ev + '"'), "ccFeed renders " + ev + " (B3)");
  }
  assert.ok(/bad: true/.test(feed), "failure rows carry bad:true so the client can flag them");
  // A run that fails now pushes (was silent), and a proposed handoff child pushes.
  const fwr = src.slice(src.indexOf("function finishWorkRun"), src.indexOf("function finishWorkRun") + 2900);
  // Assert the BEHAVIOUR (a push fires, carrying the task) rather than the exact
  // copy -- the wording moved through pushPayload() on 2026-07-25 so notifications
  // fit a phone screen, and pinning literal strings just breaks on every reword.
  assert.ok(/sendToAllSubs\(pushPayload\([^)]*hit an error/.test(fwr), "a failed run pushes (B3)");
  assert.ok(/sendToAllSubs\(pushPayload\([^)]*promote\?/.test(src), "a proposed handoff child pushes (B3)");
});

// ---- Actionable feed (Steve 2026-07-19): one-tap acts on an alert row -------
// The activity feed surfaced bad:true rows but they were read-only text. Now
// each actionable row carries a taskId (threaded through audit -> ccFeed) and a
// kind, and the board action endpoint gained archive + promote. Guard the whole
// chain: id threading, the new endpoint actions + their CLI verbs, per-kind
// button logic, and the injection guard on the threaded id.

test("actionable feed: audit() stamps a shape-validated task id as `tid`", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  // audit() takes the id as its 5th arg and stores it as `tid` only if it passes
  // safeTaskId (the same charset the /board/task/:id routes accept). A bad id is
  // dropped, so a poison id can never ride the feed into the shell.
  assert.ok(/function audit\(event, detail, req, eng, taskId\)/.test(src), "audit() accepts a taskId arg");
  assert.ok(/const tid = safeTaskId\(taskId\);\s*\n\s*if \(tid\) entry\.tid = tid;/.test(src), "audit() stamps a validated tid field");
  assert.ok(/const TASK_ID_RE = \/\^\[A-Za-z0-9_-\]\{1,64\}\$\/;/.test(src), "safeTaskId enforces the safe id shape");
  assert.ok(/function safeTaskId\(id\) \{[^}]*TASK_ID_RE\.test\(s\) \? s : ""/.test(src), "safeTaskId returns '' for a bad id (dropped, never stored)");
});

test("actionable feed: the bad rows thread their task id + kind through ccFeed", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const feed = src.slice(src.indexOf("function ccFeedFromLines"), src.indexOf("// Lib mode"));
  // Every actionable event now carries taskId (from e.tid) + a kind the client
  // maps to a button set. board_loop_detected is now rendered too (it was
  // audited + pushed but invisible on the feed).
  for (const [ev, kind] of [
    ["autonomy_run_failed", "failed"],
    ["autonomy_gated", "gated"],
    ["autonomy_blocked", "blocked"],
    ["autonomy_handoff_proposed", "handoff"],
    ["autonomy_review_noverdict", "review"],
    ["board_loop_detected", "loop"],
  ]) {
    assert.ok(feed.includes('e.event === "' + ev + '"'), "ccFeed renders " + ev);
    assert.ok(feed.includes('kind: "' + kind + '"'), "ccFeed tags " + ev + ' as kind "' + kind + '"');
  }
  assert.ok((feed.match(/taskId: tid/g) || []).length >= 6, "each actionable row carries the revalidated task id");
  assert.ok(/const tid = CC_TASK_ID_RE\.test\(tidRaw\) \? tidRaw : null;/.test(feed), "ccFeed re-validates the stored tid at read time (defense in depth) -> a bad id becomes null (no buttons)");
  // The audit call-sites feed the id in: the loop cluster uses a representative
  // card, the others their own task/child id.
  assert.ok(/audit\("board_loop_detected"[^;]*cl\.ids && cl\.ids\[0\]\)/.test(src), "loop-detected threads a representative cluster card id");
  assert.ok(/audit\("autonomy_handoff_proposed"[^;]*childId\)/.test(src), "handoff threads the child id");
  assert.ok(/audit\("autonomy_await_review", id[^;]*, id\)/.test(src), "await-review threads the parked card id");
});

test("actionable feed: the board endpoint gained archive + promote with the right CLI verbs", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const h = src.slice(src.indexOf('/^\\/board\\/task\\/([A-Za-z0-9_-]{1,64})\\/review$/'), src.indexOf('if (url.pathname === "/board/task" && req.method === "POST")'));
  assert.ok(/\["approve", "promote", "reject", "reassign", "archive"\]\.includes\(action\)/.test(h), "the action allowlist now includes promote + archive");
  // archive -> `hermes kanban archive <id>`, and its failure surfaces (503), never
  // a 200-with-the-card-still-there (the dismiss must actually land).
  assert.ok(/if \(action === "archive"\) \{[\s\S]*?hermesKanban\(\["archive", taskId\]\)/.test(h), "archive shells to `kanban archive <id>`");
  assert.ok(/hermesKanban\(\["archive", taskId\]\)\.then\(\(out\) => \{\s*if \(out === null\) \{\s*releaseMutation\(\);\s*return sendJson\(res, 503/.test(h), "a failed archive releases the mutation lease and returns 503, not a false success");
  // promote -> unblock (a proposed handoff sits `blocked`; unblock -> ready runs it),
  // the same proven transition approve uses.
  assert.ok(/promote \(proposed handoff, `blocked`\)[\s\S]*?steps\.push\(\["unblock", taskId\]\)/.test(h), "promote uses the unblock transition");
  // Every new verb still runs through hermesKanban (spawn/argv, no shell) with
  // the route-validated id -- same injection posture as the existing actions.
  assert.ok(!/exec\(|execSync\(/.test(h), "no shell exec in the endpoint (argv-only)");
});

test("B4: a capability-gap block is parked to the awaiting lane (gets the reassign button), not the buttonless pile", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  // The reject path's capability-gap branch must route through parkForReview
  // (awaiting lane + reassign control), never forceBlock (plain blocked).
  const rej = src.slice(src.indexOf("const next = capGap"), src.indexOf("const next = capGap") + 400);
  assert.ok(/const next = capGap[\s\S]*?\?\s*parkForReview\(task,/.test(rej), "capability gap -> parkForReview (awaiting lane, reassign button) (B4)");
  assert.ok(!/const next = capGap[\s\S]*?\?\s*forceBlock/.test(rej), "capability gap no longer routes to the buttonless forceBlock");
});

test("B5: the durable claim precedes Hermes + orphaned running cards never reclaim protected ownership", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const dispatchStart = src.indexOf("const durableClaim = boardClaimStore.tryAcquire");
  const dispatchEnd = src.indexOf("runAutonomousTask(eng", dispatchStart);
  const dispatch = src.slice(dispatchStart, dispatchEnd);
  assert.ok(/claimStoreHealthy\(\)/.test(src.slice(dispatchStart - 500, dispatchEnd)), "a healthy durable store is required before the board claim");
  assert.ok(dispatch.indexOf("boardClaimStore.tryAcquire") < dispatch.indexOf('hermesKanban(["claim"'),
    "the durable claim is persisted before Hermes changes the card");
  assert.ok(/launchPermitted !== true/.test(dispatch) && /release\(\);\s*return;/.test(dispatch),
    "a denied durable claim skips engine launch");
  assert.ok(/if \(claimOut === null\)/.test(dispatch) && /releaseUnstartedBoardClaim/.test(dispatch),
    "a failed Hermes claim releases only the unstarted private claim and never runs the engine");
  // An untracked running card could be a worker that survived a restart. Its
  // in-memory holder is gone, but an existing durable row still protects it.
  assert.ok(/String\(t\.status\) === "running"[\s\S]*?canonicalBoard\.orphanProtection\(t, tracked, durable, Date\.now\(\)\)/.test(src),
    "the sweep targets running cards through the canonical ownership guard");
  const orphan = src.slice(src.indexOf("const tracked = new Set"), src.indexOf("writeChains(s);", src.indexOf("const tracked = new Set")));
  assert.ok(orphan.indexOf("durableBoardClaimState(t.id)") < orphan.indexOf("noClaimOrphans.push"),
    "the sweep reads durable ownership before it schedules any legacy no-row quarantine");
  assert.match(orphan, /if \(protection === "unknown"\)[\s\S]*?autonomy_orphan_claim_unknown[\s\S]*?continue/,
    "an unreadable claim store leaves the running card and sidecar untouched");
  assert.match(orphan, /if \(protection === "durable"\)[\s\S]*?autonomy_orphan_claim_protected[\s\S]*?continue/,
    "a live or recovering durable owner is never quarantined, blocked, or replaced by the orphan sweep");
  assert.match(orphan, /noClaimOrphans\.push\(\{ task: t, reason \}\)/,
    "only an explicit no-row legacy path is queued for quarantine after the snapshot writes");
  assert.match(src, /writeChains\(s\);\s*for \(const orphan of noClaimOrphans\) quarantineBoardClaim\(orphan\.task, orphan\.reason, \{ requireNoClaim: true \}\)/,
    "the actual orphan quarantine re-check happens after the stale snapshot is written and requires the row to remain absent");
  assert.ok(!/\["reclaim"/.test(orphan), "the orphan sweep never reclaims a running card");
});

test("Phase 4 claim wiring preserves a private holder through review and only releases after a terminal board state", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const lifecycle = src.slice(src.indexOf("const BOARD_CLAIM_FILE"), src.indexOf("function runAutonomousTask"));
  assert.match(lifecycle, /BOARD_CLAIM_TTL_MS = 2 \* 60 \* 60 \* 1000/, "the two-hour claim covers the 90-minute chain plus terminal slack");
  assert.match(lifecycle, /Expiry quarantines the task -- it never renews/, "expiry is not an automatic replacement launch");
  assert.match(lifecycle, /boardClaimHolders = new Map\(\)/, "private holders stay in scheduler memory, not the board sidecar");
  assert.match(lifecycle, /boardClaimStore\.isCurrent\(holder, \{ taskId: id, state: inspected\.claim\.state, nowMs \}\)/,
    "a scheduler holder must still match the durable private digest/version, not only a public inspect row");
  assert.match(lifecycle, /boardTaskIsTerminal\(task\.id\)[\s\S]*?boardClaimStore\.release\(holder/, "release happens only after the board terminal state is checked");
  const work = src.slice(src.indexOf("const runningClaim = boardClaimStore.transition"), src.indexOf("function runCorrectionPhase"));
  assert.match(work, /from: "active", to: "running"/, "the holder advances only after Hermes confirmed the board claim");
  assert.match(work, /from: "running", to: "awaiting_review"/, "author completion advances into the shared review/correction lifecycle");
  assert.match(work, /liveClaim\.state !== "awaiting_review"/, "a correction requires the existing awaiting-review holder instead of making a new claim");
  const phases = src.slice(src.indexOf("const sidecar0 = readChains"), src.indexOf("const bset = sset"));
  assert.match(phases, /boardClaimHolder\(t\.id, "awaiting_review"\)/, "every author/review/correction phase requires the current private holder");
  assert.match(phases, /quarantineBoardClaim\(t, claim\.reason\)/, "missing, expired, or unreadable claim data quarantines the card");
});

test("Phase 4 rejects stale async results before they can mutate budget, Git, or board state", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const work = src.slice(src.indexOf("function finishWorkRun"), src.indexOf("function runCorrectionPhase"));
  assert.ok(work.indexOf("requireLiveBoardClaim(task, holder, release") < work.indexOf("const cur = readChains"),
    "author result ownership is checked before any chain read or usage mutation");
  assert.ok(work.indexOf("requireLiveBoardClaim(task, holder, release") < work.indexOf("chains.recordChainUsage"),
    "a stale author cannot spend the chain budget");
  assert.match(work, /createProposedHandoffs\([^\n]*holder\)\.then\(\(\) => \{\s*if \(!requireLiveBoardClaim/,
    "a stale author cannot write review state after asynchronous handoff work");
  const correction = src.slice(src.indexOf("function runCorrectionPhase"), src.indexOf("function createProposedHandoffs"));
  assert.match(correction, /runAutonomousTask\([\s\S]*?\.then\(\(result\) => \{\s*if \(!requireLiveBoardClaim/,
    "a stale correction result is rejected before its Git/result tail");
  assert.match(correction, /requireLiveBoardClaim\(task, holder, release, "the correction result cannot advance Git/,
    "a correction revalidates before advancing Git");
  const review = src.slice(src.indexOf("function runReviewPhase"), src.indexOf("function runGitReviewPhase"));
  assert.ok(review.indexOf("requireLiveBoardClaim(task, holder, release") < review.indexOf("const cur = readChains"),
    "a stale reviewer cannot spend budget or alter pending state");
  const gitReview = src.slice(src.indexOf("function runGitReviewPhase"), src.indexOf("setTimeout(() => setInterval(boardTick"));
  assert.match(gitReview, /fetchGitPullRequest\(change\)\.then\(async \(live\) => \{\s*if \(!requireLiveBoardClaim/,
    "Git-review fetches are revalidated before state changes");
  assert.match(gitReview, /runAutonomousTask\([\s\S]*?\.then\(async \(result\) => \{\s*if \(!requireLiveBoardClaim/,
    "a stale Git-review result is rejected before sidecar or board changes");
  assert.match(gitReview, /requireLiveBoardClaim\(task, holder, release, "the Git review cannot merge/,
    "Git merge is preceded by the current holder check");
});

test("Phase 4 revalidates a claim after Git board callbacks before parking", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const work = src.slice(src.indexOf("function finishWorkRun"), src.indexOf("function runCorrectionPhase"));
  const gitLadderStop = work.slice(work.indexOf("if (result.gitLadderError)"), work.indexOf("// Orchestrator-owned handoffs"));
  assert.match(gitLadderStop, /hermesKanban\([\s\S]*?\.then\(\(\) => \{\s*if \(!requireLiveBoardClaim\(task, holder, release, "the Git Ladder stop comment returned after its durable claim changed"\)\) return;\s*return parkForReview/,
    "a Git-error comment callback revalidates before parking the task");

  const gitReview = src.slice(src.indexOf("function runGitReviewPhase"), src.indexOf("setTimeout(() => setInterval(boardTick"));
  const noVerdict = gitReview.slice(gitReview.indexOf("if (!result || !result.ranClean || !verdict)"), gitReview.indexOf('if (verdict === "REJECT")'));
  assert.match(noVerdict, /hermesKanban\([\s\S]*?\.then\(\(\) => \{\s*if \(!requireLiveBoardClaim\(task, holder, release, "the Git review no-verdict comment returned after its durable claim changed"\)\) return;\s*return parkForReview/,
    "a no-verdict comment callback revalidates before parking the task");

  const rejection = gitReview.slice(gitReview.indexOf('if (verdict === "REJECT")'), gitReview.indexOf("const current = await fetchGitPullRequest(change)"));
  assert.match(rejection, /hermesKanban\([\s\S]*?\.then\(\(\) => \{\s*if \(overCap && !requireLiveBoardClaim\(task, holder, release, "the Git review rejection comment returned after its durable claim changed"\)\) return;\s*const next = overCap\s*\? parkForReview/,
    "an over-cap rejection comment callback revalidates before parking the task");

  const completion = gitReview.slice(gitReview.indexOf("const complete = (merged, note) =>"), gitReview.indexOf("if (gitLadderGate({ action: \"mergePR\""));
  assert.match(completion, /hermesKanban\(\["complete",[\s\S]*?\.then\(\(out\) => \{\s*if \(out === null\) \{\s*if \(!requireLiveBoardClaim\(task, holder, release, "the Git review board completion returned after its durable claim changed"\)\) return;\s*boardLedgerGate\([\s\S]*?return parkForReview/,
    "a failed board completion revalidates and records its durable gate before parking the task");
});

test("Phase 4 forceBlock refuses to re-claim a durable autonomous card", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const force = src.slice(src.indexOf("function forceBlock"), src.indexOf("function parkForReview"));
  assert.match(force, /const durable = durableBoardClaimState\(id\)/, "forceBlock reads the durable claim state before any board mutation");
  assert.match(force, /if \(!durable\.readable\)[\s\S]*?block and fallback claim skipped/, "forceBlock fails closed when it cannot read the durable claim");
  assert.match(force, /const claimManaged = durable\.kind === "live-or-recovering"/, "any existing durable row is protected from fallback claim");
  assert.ok(force.indexOf("if (claimManaged)") < force.indexOf('hermesKanban(["claim", id'),
    "a claim-managed task cannot fall through to the legacy claim-and-block fallback");
  assert.match(force, /durable claim was not re-claimed/, "failed direct blocking is audited as a quarantine, not retried as ownership transfer");
});

test("Phase 4 board state actions cannot disturb a card while its durable worker claim exists", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const route = src.slice(src.indexOf("POST /board/task/:id/review"), src.indexOf("POST /board/task/:id/freeze"));
  assert.ok(route.indexOf("acquireBoardMutationLock(taskId)") < route.indexOf("durableBoardClaimState(taskId)"),
    "review locks the card before checking its durable claim, closing check-to-dispatch races");
  assert.match(route, /if \(!durable\.readable\)[\s\S]*?claim_store_unavailable/,
    "review actions fail closed with an honest retryable error if the claim store is unreadable");
  assert.match(route, /durable\.kind === "live-or-recovering"/,
    "approve, promote, reject, reassign, and archive guard every existing durable row before disturbing the card");
  assert.match(route, /claim_recovery_required/, "the operator gets an honest quarantine response");
  assert.doesNotMatch(route, /board_review_claim_override|operator override/,
    "a human board action cannot discard a live worker's private scheduler claim");
  assert.match(route, /Package 1 cannot recover or relaunch this quarantined claim yet/,
    "the response does not pretend an unavailable recovery path exists");
  const freeze = src.slice(src.indexOf("POST /board/task/:id/freeze"), src.indexOf('if (url.pathname === "/board/task"'));
  assert.ok(freeze.indexOf("acquireBoardMutationLock(taskId)") < freeze.indexOf("durableBoardClaimState(taskId)"),
    "freeze/unfreeze lock the card before checking durable ownership");
  assert.match(freeze, /if \(!durable\.readable\)[\s\S]*?claim_store_unavailable/,
    "freeze/unfreeze fail closed with an honest retryable error when claim state is unreadable");
  assert.match(freeze, /durable\.kind === "live-or-recovering"/,
    "freeze and unfreeze cannot make a claimed or recovering worker look stopped or resume it elsewhere");
  assert.match(freeze, /claim_recovery_required/, "freeze/unfreeze report the same explicit recovery boundary");
  const runner = src.slice(src.indexOf("async function boardRunnerTick"), src.indexOf("function boardActionError"));
  assert.match(runner, /mutationIds = action === "merge_dup" \? \[id, clip\(a && a\.dupOfTaskId, 64\)\]/,
    "duplicate cleanup locks both the duplicate and survivor together");
  assert.ok(runner.indexOf("acquireBoardMutationLock(mutationIds)") < runner.indexOf("const why = validate()"),
    "the cleanup runner locks before it checks claim state");
  assert.match(runner, /if \(status === "running"\) return "card is running"/,
    "the automated runner also refuses a running card");
  assert.match(runner, /pending\[id\]/,
    "the automated runner refuses a card in the author/review/correction pipeline");
  assert.match(runner, /const durable = durableBoardClaimState\(id\);[\s\S]*?if \(!durable\.readable\) return "durable claim store is unavailable";[\s\S]*?if \(durable\.kind === "live-or-recovering"\) return "card has a durable scheduler claim"/,
    "the automated runner cannot reclaim, unblock, or reassign a claim-managed card");
  assert.match(runner, /const survivorClaim = durableBoardClaimState\(dupOf\);[\s\S]*?if \(!survivorClaim\.readable\) return "survivor durable claim store is unavailable";[\s\S]*?if \(survivorClaim\.kind === "live-or-recovering"\) return "survivor has a durable scheduler claim"/,
    "duplicate cleanup cannot mutate a claim-managed survivor either");
  const intents = src.slice(src.indexOf("function runBoardIntents"), src.indexOf("let boardBusyAutonomous"));
  assert.ok(intents.indexOf("acquireBoardMutationLock(it.id)") < intents.indexOf("durableBoardClaimState(it.id)"),
    "chat/autonomous state intents lock before checking durable ownership");
  assert.match(intents, /if \(!durable\.readable\)[\s\S]*?board_intent_denied[\s\S]*?if \(durable\.kind === "live-or-recovering"\)/,
    "chat/autonomous board intents may narrate but cannot complete or block a claim-managed task");
  assert.doesNotMatch(src, /hasDurableBoardClaim\(/, "no caller can silently turn an unreadable claim store into 'unclaimed'");
});

test("Phase 4 treats recovery and unreadable claim state as protected, never as a stale callback's permission", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const lifecycle = src.slice(src.indexOf("function durableBoardClaimState"), src.indexOf("function boardTaskIsTerminal"));
  assert.match(lifecycle, /status === "warning" && inspected\.rootCause === "claim_not_found"[\s\S]*?kind: "none"/,
    "only an explicit not-found result means no durable claim exists");
  assert.match(lifecycle, /status === "success" && inspected\.claim[\s\S]*?kind: "live-or-recovering"/,
    "every existing row, including expired or recovering rows, stays protected");
  assert.match(lifecycle, /kind: "unreadable", readable: false/,
    "an inspect failure has its own fail-closed state instead of looking unclaimed");
  assert.match(lifecycle, /const currentOwner = inspected\.claim\.state === "recovering" \|\|/,
    "a recovery in progress is treated as foreign protected ownership");
  const stale = lifecycle.slice(lifecycle.indexOf("function requireLiveBoardClaim"), lifecycle.indexOf("function quarantineBoardClaim"));
  assert.match(stale, /if \(live\.ok \|\| live\.liveOwner\)[\s\S]*?discardStaleBoardCallback/,
    "a stale callback only audits and releases when a recovery/replacement owns the row");
  assert.match(stale, /if \(durable\.kind === "live-or-recovering"\)[\s\S]*?discardStaleBoardCallback/,
    "failed CAS/release likewise cannot quarantine a recovery or replacement owner");
  const pending = src.slice(src.indexOf("const sidecar0 = readChains"), src.indexOf("const bset = sset"));
  assert.match(pending, /if \(claim\.liveOwner\)[\s\S]*?discardStaleBoardCallback/,
    "the queued review/correction pipeline also drops a recovered claim without board or sidecar mutation");
  const quarantine = lifecycle.slice(lifecycle.indexOf("function quarantineBoardClaim"));
  assert.ok(quarantine.indexOf("if (!durable.readable)") < quarantine.indexOf("boardClaimHolders.delete(id)"),
    "an unreadable claim store returns before deleting a holder or rewriting any pipeline sidecar");
  assert.match(quarantine, /quarantine signal could not be persisted safely[\s\S]*?Promise\.resolve\(null\)/,
    "a quarantine on unreadable storage emits an audit-only signal instead of a board or sidecar mutation");
  assert.match(quarantine, /options\.requireNoClaim && durable\.kind !== "none"[\s\S]*?durable claim appeared before the orphan quarantine[\s\S]*?Promise\.resolve\(null\)/,
    "the orphan path re-checks that a durable row did not appear before it mutates board or sidecar state");
});

test("Phase 4 Package 1 keeps in-box recovery unavailable while room cleanup stays scoped", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const inBox = src.slice(src.indexOf("const BOARD_CLAIM_FILE"), src.indexOf("// Desktop agent rooms"));
  assert.doesNotMatch(inBox, /boardClaimStore\.(?:beginRecovery|recordRecovery|reclaim)\(/,
    "the in-box scheduler does not expose recovery without child/bind proof");
  assert.match(src,
    /function recoverExpiredExternalBoardTask[\s\S]*?workerKilled[\s\S]*?workerReaped[\s\S]*?writableBindRevoked/,
    "external room cleanup is a separate supervisor-proof path");
  assert.match(src, /Package 1 cannot recover or relaunch this quarantined claim yet/,
    "operator text truthfully says a quarantined claim has no recovery/relaunch path yet");
});

test("the tailnet board bridge uses the gate's scheduler-visible mutation lock", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const bridge = src.slice(
    src.indexOf("createKanbanBridgeHandler({"),
    src.indexOf("tailscaleUserLogin: KANBAN_BRIDGE_USER"),
  );
  assert.match(bridge, /acquireTaskMutation:\s*acquireBoardMutationLock/,
    "desktop human actions and the scheduler must coordinate through the same task lock");
});

test("board runs have stable per-attempt ids and a fresh budget cannot collide with an old attempt", async () => {
  const gate = await import("../container/gate.js");
  const first = gate.boardLedgerRunId("task-1", "chain-task-1", "1000:1");
  assert.equal(first, gate.boardLedgerRunId("task-1", "chain-task-1", "1000:1"));
  assert.notEqual(first, gate.boardLedgerRunId("task-1", "chain-task-1", "1000:2"));
  assert.notEqual(first, gate.boardLedgerRunId("task-1", "chain-task-1", "2000:1"), "an operator budget reset creates a new durable attempt");
  assert.match(first, /^board_task:[a-f0-9]{32}$/);
});

test("board work is recorded before execution and stays attached through independent review", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const tick = src.slice(src.indexOf("function boardTick"), src.indexOf("function finishWorkRun"));
  const acceptAt = tick.indexOf("boardLedgerAccept(task");
  const startAt = tick.indexOf("ledgerStart(runId");
  const executeAt = tick.indexOf("runAutonomousTask(eng");
  assert.ok(acceptAt >= 0 && startAt > acceptAt && executeAt > startAt, "accept + start are durable before the board engine launches");
  assert.match(tick, /autonomy_ledger_refused[\s\S]*?hermesKanban\(\["reclaim", String\(task\.id\)\]\)/, "a failed durable checkpoint returns the card instead of running it");

  const finish = src.slice(src.indexOf("function finishWorkRun"), src.indexOf("function createProposedHandoffs"));
  assert.match(finish, /phase: "review"[\s\S]*?runId/, "ordinary review keeps the original run id");
  assert.match(finish, /phase: "git_review"[\s\S]*?runId/, "Git review keeps the original run id");

  const review = src.slice(src.indexOf("function runReviewPhase"), src.indexOf("function runGitReviewPhase"));
  assert.match(review, /ledgerStart\(runId,[\s\S]*?engines: \[author, reviewer\]/, "the reviewer is added to the same durable run");
  assert.match(review, /ledgerFinish\(runId, "completed"/, "review approval records the terminal outcome");

  const route = src.slice(src.indexOf("const finishOk = (state, summary)"), src.indexOf("// Promote is the action", src.indexOf("const finishOk = (state, summary)")));
  assert.match(route, /boardActiveLedgerRun\(taskId\)[\s\S]*?ledgerFinish\(activeRun\.id, "cancelled"/, "operator intervention closes the old attempt before a fresh run starts");
});

test("unattended maintenance work uses the durable ledger without a browser", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const wake = src.slice(src.indexOf("function startWakeRound"), src.indexOf("if (!WAKE_CHECKIN_OFF"));
  assert.match(wake, /kind: "wake_check"[\s\S]*?queueWakeRoundStep\(\{/, "wake checks are durably accepted before entering the background line");
  assert.match(wake, /function runWakeRound[\s\S]*?ledgerStart\(runId[\s\S]*?runOneTeamTurn\(/, "wake checks start durably only after acquiring their first slot");
  assert.match(wake, /status: "waiting"[\s\S]*?queueWakeRoundStep\(state\)/, "yielded wake work is recorded as waiting, not actively running");
  assert.match(wake, /ledgerFinish\(runId,[\s\S]*?releaseAgent\(token\)/, "wake checks record a terminal outcome before releasing the slot");

  const stuckSweep = src.slice(src.indexOf("async function stuckTick"), src.indexOf("// ---- Gemini board runner"));
  assert.match(stuckSweep, /id: `system:stuck:\$\{stamp\}`[\s\S]*?ledgerStart\(accepted\.run\.id/, "stuck sweeps have one durable identity per interval");

  const runner = src.slice(src.indexOf("async function boardRunnerTick"), src.indexOf("// Live status text"));
  assert.match(runner, /kind: "board_runner"[\s\S]*?ledgerStart\(accepted\.run\.id[\s\S]*?runGeminiOnce\(prompt, runnerToken\)/, "Gemini board maintenance persists before its agent starts");

  const mailCycle = src.slice(src.indexOf("async function mailTick"), src.indexOf("// ---- V2 autonomy control"));
  assert.match(mailCycle, /kind: "mail_cycle"[\s\S]*?ledgerStart\(accepted\.run\.id[\s\S]*?await mailSend/, "mail maintenance persists before any due send");
  assert.match(mailCycle, /finally \{[\s\S]*?ledgerFinish\(runId, runStatus/, "mail maintenance always records its terminal result");
});

test("one-run approvals are rechecked before claim and consumed before engine execution", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const dispatchStart = src.indexOf("const taskGateReason =");
  const dispatch = src.slice(dispatchStart, src.indexOf("runAutonomousTask(eng", dispatchStart));
  assert.match(dispatch, /const taskGateIssue = taskGateReason === "wording" \? "wording_gate" : taskGateReason === "consequence" \? "consequence_gate" : null/,
    "the latest persisted grant is checked immediately before claim");
  assert.match(dispatch, /consumeTaskOverrides\(sidecar, task, Date\.now\(\)\)/,
    "the grant is consumed against the exact task after a successful claim");
  assert.match(dispatch, /!consumedIssues\.includes\(taskGateIssue\)[\s\S]*?quarantineBoardClaim\(task, "the exact one-run approval expired after the durable claim/,
    "an override that expires during claim quarantines the card instead of starting or re-claiming it");
});

test("Gemini's board cleanup runner cannot mutate a structured Git proposal", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const runner = src.slice(src.indexOf("async function boardRunnerTick"), src.indexOf("setTimeout(() => { boardRunnerTick"));
  assert.match(runner, /const t = byId\[id\];[\s\S]*?if \(gitChangeForTask\(t\)\) return "structured Git proposal is gate-owned";[\s\S]*?if \(action === "comment"\)/,
    "the runner rejects every action before its comment, unblock, merge, or reassign branches");
  assert.match(runner, /const survivor = byId\[dupOf\];[\s\S]*?if \(!survivor \|\| dupOf === id\) return "bad survivor id";[\s\S]*?if \(gitChangeForTask\(survivor\)\) return "structured Git proposal is gate-owned";/,
    "a non-Git duplicate cannot mutate a Git proposal selected as its survivor");
});

test("Hermes is an interactive terminal target and no dashboard backend survives", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  assert.match(src, /id: "hermes"[^\n]+href: "\/\?window=hermes"[^\n]+tmux: "hermes"/);
  assert.doesNotMatch(src, /HERMES_PORT|HERMES_DASH_TOKEN|hermes-dashboard\.token|ccHermesLastGood|CC_HERMES_RESTART_GRACE_MS|127\.0\.0\.1:9119/);
});

test("serious-batch: correction carries the prior draft; approve verifies complete landed before announcing done", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  // The reject-under-cap sidecar entry keeps the prior draft; the correction prompt feeds it back.
  assert.ok(/priorDraft: rawResult\.slice/.test(src), "reject preserves the prior draft for the re-run");
  const correctionStart = src.indexOf("function runCorrectionPhase");
  const corr = src.slice(correctionStart, src.indexOf("function createProposedHandoffs", correctionStart));
  assert.ok(/pend\.priorDraft/.test(corr) && /edit this to address the feedback/.test(corr), "the correction prompt feeds the draft so the engine edits, not regenerates");
  // Approve checks the complete result before pushing "done".
  const done = src.slice(src.indexOf('hermesKanban(["complete"'), src.indexOf('hermesKanban(["complete"') + 1000);
  assert.ok(/if \(completeOut === null\)/.test(done), "the complete result is checked");
  assert.ok(/autonomy_done_failed/.test(done) && /parkForReview\(task,/.test(done), "a complete that didn't land is parked, not announced as done");
});

test("F1: stageJailRepos content-scrubs hardcoded secret shapes (not just secret-named files)", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  assert.ok(/function scrubSecretContent/.test(src), "a content-scrub helper exists (F1)");
  const res = src.slice(src.indexOf("JAIL_SECRET_CONTENT_RES"), src.indexOf("JAIL_SECRET_CONTENT_RES") + 900);
  for (const shape of ["AKIA", "AIza", "ghp_", "PRIVATE KEY"]) {
    assert.ok(res.includes(shape), "the scrub covers the " + shape + " shape");
  }
  // The stager runs text files through the scrub instead of a blind copy.
  const stager = src.slice(src.indexOf("function stageJailRepos"), src.indexOf("function stageJailRepos") + 2000);
  assert.ok(/JAIL_TEXT_EXT_RE\.test\(e\.name\)/.test(stager) && /scrubSecretContent\(raw\)/.test(stager), "text files are scrubbed; binaries copied verbatim");
});

// The sanitized repo stage feeding the read-jail's /repo mount: code makes it
// in, every secret shape (and anything a symlink could smuggle) does not.
test("stageJailRepos: code survives; .env/.git/keys/creds/symlinks/big binaries are stripped", async () => {
  const gate = await import("../container/gate.js");
  const work = fs.mkdtempSync(path.join(import.meta.dirname, ".jailrepo-work-"));
  const stage = fs.mkdtempSync(path.join(import.meta.dirname, ".jailrepo-stage-"));
  try {
    const repo = path.join(work, "alpha");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "node_modules", "lib"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "index.js"), "export const ok = true;");
    fs.writeFileSync(path.join(repo, "README.md"), "# alpha");
    fs.writeFileSync(path.join(repo, ".env"), "STRIPE_KEY=rk_live_SECRETSECRETSECRET");
    fs.writeFileSync(path.join(repo, ".env.production"), "DB_URL=postgres://user:hunter2@db/x");
    fs.writeFileSync(path.join(repo, ".git", "config"), "url = https://x-access-token:ghp_SECRET@github.com/o/r");
    fs.writeFileSync(path.join(repo, "node_modules", "lib", "a.js"), "junk");
    fs.writeFileSync(path.join(repo, "server.pem"), "-----BEGIN PRIVATE KEY-----");
    fs.writeFileSync(path.join(repo, "id_rsa"), "ssh secret");
    fs.writeFileSync(path.join(repo, "google-credentials.json"), '{"private_key":"SECRET"}');
    fs.writeFileSync(path.join(repo, ".npmrc"), "//registry.npmjs.org/:_authToken=SECRET");
    fs.writeFileSync(path.join(repo, "big.bin"), Buffer.alloc(4096));
    // F1: a secret HARDCODED inside a normal config file (not a secret-named
    // file) -- must be content-scrubbed in place, but the surrounding code kept.
    // The fixture key is assembled at runtime rather than written contiguously:
    // a literal sk_live_ followed by 24+ alphanumerics is what GitHub's push
    // protection detects, and it blocked the public export on 2026-08-15 even
    // though this value is synthetic. Split here, identical at runtime -- the
    // scrubber is still exercised against a realistic 25-character key.
    const fakeStripeKey = "sk_" + "live_ABCDEF1234567890hardcoded";
    fs.writeFileSync(path.join(repo, "config.js"), `export const cfg = { port: 3000, stripe: "${fakeStripeKey}", region: "us" };`);
    // A symlink pointing OUTSIDE the repo must be skipped, never followed.
    const outside = path.join(work, "outside-secret.txt");
    fs.writeFileSync(outside, "OUTSIDE_SECRET");
    let symlinked = false;
    try { fs.symlinkSync(outside, path.join(repo, "link.txt")); symlinked = true; } catch {} // Windows may refuse symlink creation
    const staged = gate.stageJailRepos(work, stage, { maxFileBytes: 1024 });
    assert.deepEqual(staged, ["alpha"], "the repo staged under its own name");
    const s = path.join(stage, "alpha");
    assert.equal(fs.readFileSync(path.join(s, "src", "index.js"), "utf8"), "export const ok = true;", "code copied intact");
    assert.ok(fs.existsSync(path.join(s, "README.md")), "docs copied");
    for (const gone of [".env", ".env.production", ".git", "node_modules", "server.pem", "id_rsa", "google-credentials.json", ".npmrc", "big.bin"]) {
      assert.ok(!fs.existsSync(path.join(s, gone)), gone + " must be stripped from the stage");
    }
    if (symlinked) assert.ok(!fs.existsSync(path.join(s, "link.txt")), "symlinks are not copied");
    // Belt: not a single known secret string anywhere in the staged tree.
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [fs.readFileSync(path.join(d, e.name), "utf8")]);
    const blob = walk(s).join("\n");
    for (const secret of ["rk_live_", "hunter2", "ghp_SECRET", "_authToken", "OUTSIDE_SECRET"]) {
      assert.ok(!blob.includes(secret), "no trace of " + secret + " in the staged tree");
    }
    // F1: the hardcoded key inside config.js is scrubbed, but the file survives
    // with its surrounding code intact (redact in place, don't drop the file).
    const cfgStaged = fs.readFileSync(path.join(s, "config.js"), "utf8");
    assert.ok(!cfgStaged.includes("sk_live_ABCDEF"), "hardcoded key content-scrubbed from config.js (F1)");
    assert.ok(cfgStaged.includes("[REDACTED-SECRET]"), "the scrub leaves a redaction marker");
    assert.ok(cfgStaged.includes("port: 3000") && cfgStaged.includes('region: "us"'), "the surrounding code is preserved");
    // A box with no ~/work (REPOS unset) stages nothing and never throws.
    assert.deepEqual(gate.stageJailRepos(path.join(work, "missing"), stage), []);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

// The team-chat waterfall fix (CCC 2026-07-18: "nobody can see replies after
// a message to ALL"): the persistent thread puts every engine's past replies in
// front of every engine, so engine #1 is no longer permanently blind to #2..#4.
test("teamPrompt: the shared thread makes the group chat two-way (first engine sees last turn's replies)", async () => {
  const gate = await import("../container/gate.js");
  const history = [
    { who: "steve", text: "yesterday: plan the launch" },
    { who: "codex", text: "codex-reply-about-launch" },
    { who: "gemini", text: "gemini-reply-about-launch" },
  ];
  // FIRST engine of a NEW turn: no same-turn replies yet, but the thread is there.
  const first = gate.teamPrompt("new question", "claude", [], history);
  assert.ok(first.includes("codex-reply-about-launch") && first.includes("gemini-reply-about-launch"),
    "engine #1 sees replies that historically came after its own turn -- the waterfall is fixed");
  assert.ok(first.indexOf("TEAM THREAD") < first.indexOf("Steve said:"), "thread context precedes the new message");
  // A later engine gets the thread AND this turn's earlier replies.
  const later = gate.teamPrompt("new question", "gemini", [{ eng: "claude", text: "fresh-claude-reply" }], history);
  assert.ok(later.includes("codex-reply-about-launch") && later.includes("fresh-claude-reply"),
    "later engines see both the thread and the current turn");
  // No history -> the original shape, no empty thread block.
  assert.ok(!gate.teamPrompt("q", "claude", [], []).includes("TEAM THREAD"), "no thread block on a fresh box");
  // A huge thread stays budgeted (newest entries win) so it can't crowd the task.
  const big = Array.from({ length: 100 }, (_, i) => ({ who: "codex", text: "entry#" + i + " " + "x".repeat(900) }));
  const bounded = gate.teamPrompt("q", "claude", [], big);
  assert.ok(bounded.length < 9000, "thread embed is budgeted (" + bounded.length + " chars)");
  assert.ok(bounded.includes("entry#99"), "the newest entry survives the budget");
  assert.ok(!bounded.includes("entry#0 "), "the oldest entries fall off first");
});

test("permanent seven-engine roster is ordered, routed, and attributed as itself", async () => {
  const gate = await import("../container/gate.js");
  assert.deepEqual([...gate.TEAM_ORDER], ["claude", "codex", "deepseek", "kimi", "gemini", "hermes", "cursor"],
    "the canonical team order contains all seven engines exactly once");

  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const registry = src.slice(src.indexOf("const ENGINES = {"), src.indexOf("// Gemini's --output-format"));
  for (const id of gate.TEAM_ORDER) {
    assert.match(registry, new RegExp("\\n  " + id + ": \\{"), id + " has a real ENGINES entry");
  }
  assert.match(src, /for \(const id of TEAM_ORDER\)[\s\S]*?permanent team engine/, "startup checks roster/registry parity");

  const feed = gate.ccFeedFromLines([
    { t: "2026-07-21T12:00:00.000Z", event: "chat_run", eng: "gemini" },
    { t: "2026-07-21T12:01:00.000Z", event: "brain_run", eng: "gemini", detail: "team memory" },
    { t: "2026-07-21T12:02:00.000Z", event: "chat_run", eng: "cursor" },
  ]);
  assert.deepEqual(feed.map((row) => row.eng), ["cursor", "gemini", "gemini"],
    "Gemini and Cursor activity are not mislabeled as Claude");

  const charter = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "team-charter.md"), "utf8");
  assert.match(charter, /Claude[\s\S]*Codex[\s\S]*DeepSeek[\s\S]*Kimi[\s\S]*Gemini[\s\S]*Hermes[\s\S]*Cursor[\s\S]*You seven are one unit/,
    "the standing charter names all seven permanent teammates");
  assert.match(charter, /@claude[\s\S]*@codex[\s\S]*@deepseek[\s\S]*@kimi[\s\S]*@gemini[\s\S]*@hermes[\s\S]*@cursor/,
    "the standing charter documents direct routing to all seven engines");
  assert.match(charter, /HANDOFF: <claude\|codex\|deepseek\|kimi\|gemini\|hermes>/,
    "autonomous handoffs name every approved non-Cursor executor");
  assert.match(charter, /Cursor is deliberately absent because it remains chat-only and human-directed/,
    "chat membership does not silently grant Cursor unattended execution");
});

// B2 (launch-eve handoff, 2026-07-26): Gemini fabricated board state — archived
// cards reported as live work, a done card called blocked, invented assignees —
// and described itself as "read-only jailed" (false: it simply has NO shell,
// running one non-interactive `gemini -p` turn). The charter now carries a hard
// capability declaration; this pins it, and rule-manifest.json points here.
test("charter: Gemini board honesty — no shell, never reports board state from memory (B2)", () => {
  const charter = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "team-charter.md"), "utf8");
  assert.match(charter, /Gemini: you cannot read the board/,
    "the charter carries the hard Gemini capability declaration (rule-manifest marker)");
  assert.match(charter, /no shell at all/,
    "the declaration names the real limit (no shell), not a fictional read-only jail");
  assert.match(charter, /label it belief/,
    "an unverifiable board claim must be labeled belief, never asserted as the board");
  assert.match(charter, /hand the read off/,
    "the declaration routes board reads to an engine that can actually read (Claude/Hermes in chat)");
});

test("team thread persists: runTeamChat appends steve + every reply and feeds history into every prompt", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const rtc = src.slice(src.indexOf("function runTeamChat"), src.indexOf("function runOneTeamTurn"));
  assert.ok(/const history = loadTeamThread\(\)/.test(rtc), "history loads once per team turn");
  // Router slice 1: both appends carry an idempotent id derived from the
  // durable run id, so an at-least-once resend can never double-post.
  assert.ok(/appendTeamThread\("steve", msg, \{ id: res && res\.runId \}\)/.test(rtc), "Steve's message lands in the thread");
  assert.ok(/appendTeamThread\(engId, outcome\.reply, \{[\s\S]*?id: res && res\.runId \? res\.runId \+ "-r-" \+ engId : null,[\s\S]*?\}\)/.test(rtc), "every buffered engine reply (or skip note) lands in the thread");
  assert.ok(/teamPrompt\(msg, engId, replies, history\)/.test(rtc), "every engine's prompt carries the shared history");
  // The thread lives on the volume (AGENTHOST_DIR) and is pruned, not unbounded.
  assert.ok(/function teamThreadFile\(\) \{ return path\.join\(AGENTHOST_DIR, "team-thread\.jsonl"\); \}/.test(src),
    "thread file rides the persistent volume");
  assert.ok(/retainedTeamThreadLines\(lines\)/.test(src),
    "thread file is pruned by the retained-history policy");
});

test("team chat: API adapters may overlap while process-spawning engines stay sequential on a 4 GB box", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const disp = src.slice(src.indexOf("function runTeamChat"), src.indexOf("function runTeamSequential"));
  assert.ok(/audit\("chat_run_team", "interleave", req\)/.test(disp), "the audit records the memory-safe mode");
  assert.ok(/runTeamSequential\(msg, res, token, tzOffsetMin, history\)/.test(disp),
    "first turns and follow-ups both use the hybrid API-first, process-sequential path");
  assert.doesNotMatch(src, /function runTeamParallel|function streamOneEngine|hasCpuHeadroom/,
    "the unsafe fan-out path cannot be re-entered by an idle-CPU heuristic");
  const sequential = src.slice(src.indexOf("function runTeamSequential"), src.indexOf("function runOneTeamTurn"));
  assert.match(sequential, /renewAgentLease\(token\)/,
    "each settled engine renews the team lease so the global watchdog cannot overlap a later run");
  assert.match(sequential, /if \(!renewAgentLease\(token\)\)[\s\S]*?sse\(res, "done", \{ error: "Team chat lost its execution slot\.", recovery: "retry" \}\)/,
    "a genuinely lost lease is terminalized as retryable failure, never completed");
  const advance = sequential.slice(sequential.indexOf("const advance ="), sequential.indexOf("// Resolve the engine defensively"));
  const leaseCheck = advance.indexOf("if (!renewAgentLease(token))");
  const outcomeRecord = advance.indexOf("recordTeamOutcome(engId");
  assert.ok(leaseCheck !== -1 && outcomeRecord !== -1 && leaseCheck < outcomeRecord,
    "stale-token validation precedes usage, history, board, and artifact side effects");
  assert.match(sequential, /streamKimiTeam\(withCharter\(EFFECTIVE_CHARTER, teamPrompt/,
    "Kimi's sequential adapter still receives the standing team charter");
  // Autonomy/cron are untouched -- one slot token is held for the whole team
  // turn, so they still cannot interleave a run into the middle of it.
  assert.ok(/acquireAgent\("chat"\)/.test(src.slice(src.indexOf('engineId === "team"'), src.indexOf('engineId === "team"') + 120)),
    "a team turn holds the single chat slot for its whole duration");
});

test("boot wake: background check-ins yield between engines and human chat has priority", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const dispatch = src.slice(src.indexOf("function dispatchAgentSlot"), src.indexOf("function dispatchAgentSlot") + 400);
  assert.match(dispatch, /chatWaiters\.shift\(\)[\s\S]*wakeWaiters\.shift\(\)/,
    "a queued human chat is selected before a background wake step");
  const wake = src.slice(src.indexOf("function startWakeRound"), src.indexOf("// The slot is busy"));
  assert.match(wake, /acquireAgent\("wake"\)/, "wake owns a distinct, truthful busy kind");
  assert.match(wake, /wakeWaiters\.push/, "the next wake agent returns to the low-priority line");
  assert.match(wake, /releaseAgent\(token\)/, "the wake slot is released after each engine instead of after the whole roster");
  const queue = src.slice(src.indexOf("function queueChatRun"), src.indexOf("function handleChat"));
  assert.match(queue, /agentBusyKind === "wake"/, "the phone is told it is waiting on wake-up work, not another human chat");
});

test("team-turn resilience: proven skips advance, but an unproven exit quarantines the lane", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const rtc = src.slice(src.indexOf("function runTeamSequential"), src.indexOf("function runOneTeamTurn"));
  // Every segment funnels through one idempotent advance(). Proven failures can
  // continue, while an unproven exit must stop before another heavyweight spawn.
  assert.ok(/const advance = \(text, usage, skipped, options\) =>/.test(rtc), "each segment has an idempotent advance()");
  assert.ok(/if \(advanced\) return;\s*advanced = true;/.test(rtc), "advance fires at most once per segment");
  assert.ok((rtc.match(/next\(\);/g) || []).length >= 1 && /advance[\s\S]*next\(\);/.test(rtc), "advance ends by moving to the next engine");
  assert.match(rtc, /if \(options && options\.unprovenTermination\)[\s\S]*?quarantineAgentLane\(/,
    "an unproven process exit quarantines the lane before next() can run");
  // resolveEngine is defensive: an unresolvable engine skips, not throws the turn.
  assert.ok(/try \{ eng = resolveEngine\(engId\); \} catch \{\}/.test(rtc), "engine resolution can't throw the turn away");
  assert.ok(/advance\("", null, "engine unavailable"\)/.test(rtc), "an unavailable engine is skipped with a note");
  // A hung segment may still be alive after its kill request. It must stop the
  // roster rather than overlap the next heavyweight process.
  assert.match(rtc, /quarantineAgentLane\(token, engId \+ " Team segment timed out without terminal process proof"\)/,
    "a hung engine quarantines Team Chat instead of force-starting the next engine");
  assert.doesNotMatch(rtc, /setTimeout\(\(\) => advance\(""/,
    "the timeout path cannot bypass terminal process proof");
  // A synchronous throw in the run still advances.
  assert.ok(/runOneTeamTurn\([\s\S]*?\} catch \{[\s\S]*?advance\("", null, "run error"\)/.test(rtc),
    "a run-error still advances to the next engine");
  // The client learns a segment was skipped (engine_done carries skipped).
  assert.ok(/sse\(res, "engine_done", \{ eng: engId, usage: usage \|\| null, skipped: skipped \|\| null \}\)/.test(rtc),
    "engine_done reports whether the segment was skipped");
  const one = src.slice(src.indexOf("function runOneTeamTurn"), src.indexOf("// ---- Wake-up check-in"));
  assert.match(one, /done\("", null, "spawn failed"\)/, "a spawn failure is not mislabeled as an empty success");
  assert.match(one, /failure = "no response \(timed out\)"/, "a killed timeout is reported honestly");
  assert.match(one, /done\(full, usage, full\.trim\(\) \? null : failure, options \|\| null\)/,
    "the sequential caller receives the engine failure reason");
});

test("dev seam: AGENTHOST_DEV_WRAP affects engine spawns only; HTTP surfaces stay canonical", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  // The seam reads an env var that is NEVER set on the box.
  assert.ok(/const DEV_WRAP = process\.env\.AGENTHOST_DEV_WRAP \|\| "";/.test(src), "DEV_WRAP comes from an env var, empty by default");
  // devSpawn falls through to a plain spawn when the seam is off.
  const ds = src.slice(src.indexOf("function devSpawn"), src.indexOf("function devSpawn") + 300);
  assert.ok(/if \(DEV_WRAP\) return spawn\(process\.execPath, \[DEV_WRAP, bin, \.\.\.args\], opts\);/.test(ds), "when set, spawns run through the wrapper");
  assert.ok(/return spawn\(bin, args, opts\);/.test(ds), "when unset, spawns are byte-identical to before (production path)");
  // The chat/team/cron engine spawns route through devSpawn; the AUTONOMOUS jail
  // spawn does NOT (it must never be mock-wrapped -- it's the security-critical path).
  const rat = src.slice(src.indexOf("function runAutonomousTask"), src.indexOf("function runAutonomousTask") + 8000);
  assert.ok(!/devSpawn\(/.test(rat), "the autonomous read-jail spawn is never routed through the dev seam");
  // Page entries and the isolated terminal failure use the same contract in
  // every environment; the dev spawn wrapper cannot fork an HTTP surface.
  assert.ok(!/DEV_WRAP && url\.pathname === "\/"/.test(src),
    "the local mirror cannot replace the shell root with a redirect");
  assert.match(src, /SHELL_ENTRY_PATHS\.has\(url\.pathname\)[\s\S]*?serveDashboardDocument\(res\)/,
    "the shell entry handler runs independently of DEV_WRAP");
  assert.doesNotMatch(src, /Local mirror — no terminal|if \(DEV_WRAP\) \{[\s\S]*?terminal/i,
    "the mirror cannot resurrect a handwritten terminal page");
  assert.match(src, /Terminal unavailable: the ttyd backend request failed/,
    "the canonical terminal failure names the missing ttyd backend");
});

test("gate-brokered board tool: parser accepts only safe self-scoped verbs; wiring is narration-only in autonomy (2026-07-19)", async () => {
  const gate = await import("../container/gate.js");
  // Parser: comment/note/done/complete/block with a valid id; drops everything else.
  const intents = gate.parseBoardIntents([
    "BOARD: comment t_a1 RT-6 is closed",
    "BOARD: done t_a1 verified RT-6 through RT-9",
    "BOARD: note t_b2 reading the ARD",
    "BOARD: block t_c3 need the schema pin",
    "BOARD: reassign t_d4 to hermes",   // NOT a board-tool verb -> dropped
    "BOARD: delete t_e5",               // dropped
    "just some prose about BOARD: stuff", // not a leading BOARD: line -> dropped
  ].join("\n"));
  assert.deepEqual(intents.map((i) => i.verb + ":" + i.id),
    ["comment:t_a1", "done:t_a1", "note:t_b2", "block:t_c3"], "only the 4 safe verbs, ids captured");
  assert.equal(intents[0].text, "RT-6 is closed", "the trailing text is captured");
  // A bogus id shape is not matched (argv safety: id is [A-Za-z0-9_]{2,40}).
  assert.deepEqual(gate.parseBoardIntents("BOARD: done ../../etc/passwd oops"), [], "an id with path chars doesn't match");

  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  // runBoardIntents runs each verb via hermesKanban (spawn/argv, no shell) and
  // scopes to the acting engine's own cards.
  const rbi = src.slice(src.indexOf("function runBoardIntents"), src.indexOf("function runBoardIntents") + 1400);
  // The optional literal caller label (2026-08-11) sits beside the argv, not in
  // it, so the fixed read-only argv this line is really pinning is unchanged.
  assert.ok(/hermesKanban\(\["list", "--json"\](?:, \{ caller: "[a-zA-Z]+" \})?\)/.test(rbi),
    "chat mode fetches the board to scope by ownership");
  assert.ok(/if \(!a \|\| a === by\) ok\.add/.test(rbi), "an engine may only touch its own (or unassigned) cards");
  assert.ok(/board_intent_denied/.test(rbi), "an out-of-scope intent is denied + audited");
  // B3 (2026-07-26): a denial is never silent. Every board_intent_denied audit
  // has a matching in-band denied.push, the function resolves { applied, denied },
  // the operator gets a push on a denied turn, and an autonomous result comment
  // names exactly which intents were denied.
  const rbiFull = src.slice(src.indexOf("function runBoardIntents"), src.indexOf("let boardBusyAutonomous"));
  assert.equal((rbiFull.match(/denied\.push\(/g) || []).length, (rbiFull.match(/board_intent_denied/g) || []).length,
    "every denial audit collects a matching in-band denial (silent denial regression)");
  assert.ok(/return \{ applied, denied \};/.test(rbiFull), "runBoardIntents returns its denials in-band");
  assert.ok(/Board write denied/.test(rbiFull), "a denied turn push-notifies the operator");
  assert.ok(/board intents DENIED this run/.test(src), "an autonomous result comment names its denied intents");
  // B4 (2026-07-26): the operator's freeze holds through completion. Every
  // pipeline board-complete is preceded by a FRESH frozen re-read (a mid-run
  // freeze postdates the run's own sidecar snapshot), and the hold is audited.
  const completeSites = [...src.matchAll(/hermesKanban\(\["complete", task\.id/g)].map((mm) => mm.index);
  assert.ok(completeSites.length >= 2, "both pipeline completion sites exist");
  for (const at of completeSites) {
    assert.ok(/readChains\(\)\.frozen/.test(src.slice(Math.max(0, at - 3000), at)),
      "a fresh frozen check precedes the pipeline board-complete at index " + at);
  }
  assert.ok((src.match(/autonomy_frozen_hold/g) || []).length >= 2, "the frozen hold is audited on both completion paths");
  // AUTONOMOUS path: narration only (comment/note) -- done/block are the review
  // pipeline's job there, so they're filtered out.
  const finishStart = src.indexOf("function finishWorkRun");
  const fwr = src.slice(finishStart, src.indexOf("function runCorrectionPhase", finishStart));
  assert.ok(/parseBoardIntents\(result\.text\)\.filter\(\(i\) => i\.verb === "comment" \|\| i\.verb === "note"\)/.test(fwr),
    "an autonomous run's BOARD: intents are NARRATION only (comment/note), scoped to its own task");
  assert.ok(/runBoardIntents\(boardIntents, assignee, \[task\.id\]\)/.test(fwr), "autonomous intents are scoped to the single task");
  // CHAT paths (team + 1:1) run the FULL broker.
  assert.ok((src.match(/runBoardIntents\(parseBoardIntents\(reply\), engId, null\)/g) || []).length >= 1,
    "the memory-safe team chat path brokers board work for the engine");
  assert.ok(/runBoardIntents\(parseBoardIntents\(replyAll\), eng\.label, null\)/.test(src), "1:1 chat brokers board work too");
});

test("silently-gated task is surfaced (why 'Claude didn't pick it up'): feed event + push, not silent (2026-07-19)", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  // The eligibility-empty branch finds a queued+exec-assigned task excluded by
  // the categorized gate, while a valid one-run wording override makes that
  // exact task eligible. Consequence approvals are exact-task, one-run grants.
  // Sliced to the branch's own terminator, NOT a fixed character count. The
  // original window was 2600 chars, which silently stopped covering these
  // assertions the moment the branch grew (the gated-backlog reminder, 2026-08-08)
  // — a test that passes or fails on how much comment text sits above it is
  // measuring formatting, not behaviour.
  const tickStart = src.indexOf("if (!eligible.length)");
  const tickEnd = src.indexOf("return release();", tickStart);
  assert.ok(tickStart >= 0 && tickEnd > tickStart, "the eligibility-empty branch and its terminator both exist");
  const tick = src.slice(tickStart, tickEnd);
  assert.ok(/gateReasonFor\(t\) !== null && !gateOverrideFor\(t\)/.test(tick) && /announcedGated\.has\(String\(gated\.id\)\)/.test(tick), "detects a gated ready task without a matching override, deduped per id");
  assert.ok(/"autonomy_gated" : "autonomy_consequence_gated"/.test(tick) && /Wording blocks auto-run/.test(tick),
    "a gated task is announced (feed + push), not left silent");
  assert.ok(!/parkForReview\(gated/.test(tick), "it is NOT auto-parked (an approve would just re-hit the gate -> loop)");
  // The feed renders it as a bad row.
  const feed = src.slice(src.indexOf("function ccFeedFromLines"), src.indexOf("// Lib mode"));
  assert.ok(/e\.event === "autonomy_gated"/.test(feed) && /wording needs your review/.test(feed), "ccFeed renders the gated event");
});

test("charter is baked into the image and non-trivial (the real file the gate loads)", () => {
  const charter = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "team-charter.md"), "utf8");
  assert.ok(charter.length > 2000, "team-charter.md is present and substantial (not an empty stub)");
  // Anchor a few load-bearing, code-verified facts so a gutted charter fails here.
  assert.ok(/read-jail/.test(charter), "charter explains the autonomous read-jail");
  assert.ok(/HANDOFF:/.test(charter), "charter documents the HANDOFF: line mechanism");
  assert.ok(/\/data\/home\/agent|~\/\.hermes/.test(charter), "charter carries the real box paths");
});

test("every engine turn threads the charter (chat + autonomous + cron), none dropped", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  // Boot: the charter file is read once and Claude's system args are pre-built.
  // AGENT_CHARTER_FILE (2026-08-03) is a test/dev seam in the AGENT_CHAT_BIN
  // family -- the deployed default is still ASSET_DIR/team-charter.md, which is
  // what this line pins.
  assert.ok(/process\.env\.AGENT_CHARTER_FILE \|\| path\.join\(ASSET_DIR, "team-charter\.md"\)/.test(src), "gate reads team-charter.md at boot (seam-overridable for tests only)");
  // EFFECTIVE_CHARTER = applyMode(TEAM_CHARTER) — the charter with the operator's
  // current mode folded in. Asserting the raw TEAM_CHARTER here was stale: it
  // would now FAIL on the correct code and PASS on a regression that dropped the
  // mode. What matters is that the args are pre-built from the effective one.
  assert.ok(/const CLAUDE_CHARTER_ARGS = claudeCharterArgs\(EFFECTIVE_CHARTER\)/.test(src), "Claude's charter args are pre-built from the effective (mode-applied) charter");
  assert.ok(/const EFFECTIVE_CHARTER = applyModePack\(applyMode\(TEAM_CHARTER\)\)/.test(src), "the effective charter is the loaded charter with the mode applied -- both the Modes-v2 symlink and the mode pack's deployed mode.toml");
  // Claude: chat args + autonomous autoArgs both spread CLAUDE_CHARTER_ARGS.
  const claudeBlock = src.slice(src.indexOf("claude: {"), src.indexOf("hermes: {"));
  assert.ok(/\.\.\.CLAUDE_CHARTER_ARGS/.test(claudeBlock), "claude chat args include the charter (system slot)");
  assert.ok(/autoArgs:.*CLAUDE_CHARTER_ARGS/s.test(claudeBlock), "claude autonomous autoArgs include the charter");
  // Hermes: chat args prepend the charter via withCharter.
  const hermesBlock = src.slice(src.indexOf("hermes: {"), src.indexOf("codex: {"));
  assert.ok(/withCharter\(EFFECTIVE_CHARTER,\s*prompt\)/.test(hermesBlock), "hermes chat args prepend the charter");
  // Codex: chat args AND autonomous autoArgs both prepend the charter.
  const codexBlock = src.slice(src.indexOf("codex: {"), src.indexOf("codex: {") + 2600);
  const codexHits = (codexBlock.match(/withCharter\(EFFECTIVE_CHARTER,\s*prompt\)/g) || []).length;
  assert.ok(codexHits >= 2, `codex threads the charter in both args and autoArgs (found ${codexHits})`);
  // Cron/Loops: the direct claude spawn also carries the charter.
  assert.ok(/agentSpawnArgs\(job\.prompt, false\), \.\.\.CLAUDE_CHARTER_ARGS/.test(src), "cron/Loops runs carry the charter too");
});

// Handoff contract (team post-mortem 2026-07-18): the charter carries the
// canonical-envelope + required-fields contract, and BOTH gate creation paths
// (human quick-add, autonomous handoff child) stamp the template so no task
// ever starts field-less.
test("handoff contract: charter documents it and both create paths stamp the template", () => {
  const charter = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "team-charter.md"), "utf8");
  assert.ok(/handoff contract/i.test(charter), "charter has the handoff-contract section");
  for (const f of ["GOAL:", "DONE:", "NEEDS:", "FILES:", "VERIFY:"]) {
    assert.ok(charter.includes(f), "charter template includes " + f);
  }
  assert.ok(/ONE board task/.test(charter) && /canonical/.test(charter), "charter states the canonical single-record rule");
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const scaffolds = (src.match(/GOAL: /g) || []).length;
  assert.ok(scaffolds >= 2, "gate stamps the template in both create paths (quick-add + handoff child), found " + scaffolds);
  assert.ok(/HANDOFF_TEMPLATE/.test(src), "quick-add path defines the scaffold");
});

// A card that already reached a terminal state (done/completed/archived) can
// never satisfy promotePostcondition, so the Activity-Feed Approve used to 409
// "transition_not_confirmed" forever while the feed kept offering buttons —
// live loop on t_a7d65836, 2026-07-27, found by the box Point. The approve path
// must mirror /override's clearStale: clear the stale warning and succeed.
test("approve on an already-terminal card clears the stale warning instead of 409ing forever", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const block = src.split("if (!promotePostcondition(after))").pop() || "";
  assert.ok(/BOARD_TERMINAL_STATES\.includes\(termState\)/.test(block),
    "the approve postcondition has the terminal-state branch (removing it re-opens the forever-409 loop)");
  const g = createRequire(import.meta.url)(path.join(import.meta.dirname, "..", "container", "gate.js"));
  assert.deepEqual(g.BOARD_TERMINAL_STATES, ["done", "completed", "archived"],
    "the terminal set is exactly the states promotePostcondition can never accept");
  assert.ok(/board_attention_cleared[^\n]*already/.test(block),
    "the terminal branch audits board_attention_cleared so the feed's warning row clears");
  assert.ok(/transition_not_confirmed/.test(block),
    "the genuine not-runnable 409 still exists for non-terminal cards");
});

// Tailscale stays operator-opt-in: entrypoint arms tailscaled ONLY behind the
// /data/tailscale state-dir flag (no dir -> dormant, the Dockerfile invariant).
test("tailscaled boot hook is gated on the /data/tailscale opt-in dir with state on the persistent volume", () => {
  const ep = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "entrypoint.sh"), "utf8");
  assert.ok(/\[ -x \/usr\/sbin\/tailscaled \] && \[ -d \/data\/tailscale \]/.test(ep), "the opt-in guard exists");
  assert.ok(/--state=\/data\/tailscale\/tailscaled\.state/.test(ep), "node identity persists on /data across deploys");
  assert.ok(/--tun=userspace-networking/.test(ep), "userspace networking (no TUN on Fly)");
});

// The stub-vs-real trap that hid the envelope bug: E2E stubs returned a bare
// task object while the REAL `hermes kanban show --json` returns an envelope
// { task, comments, events, runs } — so every Approve/Promote read undefined
// off the envelope and failed on every card while tests stayed green
// (found live by the box Point, 2026-07-27, fix ab0ba64). Pin both shapes.
test("boardTaskFromShow unwraps the real CLI envelope and tolerates a bare task", () => {
  const g = createRequire(import.meta.url)(path.join(import.meta.dirname, "..", "container", "gate.js"));
  const envelope = JSON.stringify({ task: { id: "t_c758643c", status: "triage" }, comments: [], events: [], runs: [] });
  assert.equal(g.boardTaskFromShow(envelope).id, "t_c758643c");
  assert.equal(g.promotePostcondition(g.boardTaskFromShow(envelope)), true, "a triage card approves");
  assert.equal(g.boardTaskFromShow(JSON.stringify({ id: "t_x", status: "done" })).id, "t_x", "bare task tolerated");
  assert.equal(g.boardTaskFromShow("{not json"), null);
  assert.equal(g.promotePostcondition(JSON.parse(envelope)), false, "the raw envelope must NEVER be fed to the postcondition again");
});
import { createRequire } from "node:module";

// ttyd ran --writable on loopback TCP with NO credential at all (found
// 2026-07-27): every local process, including the gate uid under Foundation B,
// could open its socket and type as the agent. A command-line credential would
// NOT have fixed it -- /proc/<pid>/cmdline is world-readable on the live box
// (-r--r--r--), so argv is not a secret store. It listens on a UNIX socket now
// and file permissions are the check. Pin every half.
test("ttyd listens on a permissioned UNIX socket, never loopback TCP, and never a credential in argv", () => {
  const sh = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "start.sh"), "utf8");
  const ttyd = sh.slice(sh.indexOf("ttyd -i"));
  assert.ok(/ttyd -i "\$TTYD_SOCK" -U "agent:boxstate" --writable/.test(ttyd),
    "ttyd binds the UNIX socket and hands it to agent + the boxstate group");
  assert.ok(!sh.includes("ttyd -p 7681") && !sh.includes("-i 127.0.0.1"),
    "the loopback TCP listener is GONE -- reachable by any local process was the bug");
  assert.ok(!/-c "agenthost:/.test(sh),
    "no credential in argv: /proc/<pid>/cmdline is world-readable, so argv is not a secret store");
  assert.ok(/chmod 750 "\$TTYD_SOCK_DIR"/.test(sh) && /chgrp boxstate "\$TTYD_SOCK_DIR"/.test(sh),
    "the containing dir is the second, independent gate (0750 agent:boxstate)");
  assert.ok(/rm -f "\$TTYD_SOCK"/.test(sh), "a stale socket from the last boot cannot block the bind");

  const g = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  assert.ok(/const TTYD_SOCK = /.test(g) && /"ttyd", "ttyd\.sock"/.test(g),
    "the gate proxies the same socket path start.sh binds");
  assert.ok(!/TTYD_PORT/.test(g), "no TCP port constant survives to be reconnected by accident");
  assert.ok(/\{ socketPath: TTYD_SOCK, path: terminalPath/.test(g), "HTTP hop goes over the socket");
  assert.ok(/net\.connect\(TTYD_SOCK, onUp\)/.test(g), "WebSocket upgrade hop goes over the socket");
});

// The claim that outran the code: chat-path hardening was documented as "a
// compromised gate cannot act as agent", but the gate proxies the writable
// terminal by design and holds ttyd's credential. Copy matches code.
test("the compromised-gate claim stays scoped to the chat path", () => {
  const profiles = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "maintenance-chat-profiles.js"), "utf8");
  assert.ok(/THROUGH THE CHAT RUNNER/.test(profiles), "the claim names the path it covers");
  assert.ok(/blanket "a compromised gate cannot act as agent" is inaccurate/.test(profiles),
    "and explicitly rejects the blanket version");
});

// The board reads through ~/.hermes, and Hermes's own Python startup keeps
// chmod'ing that dir back to 0700 while it boots -- which strips the gate uid's
// group traversal and makes the board unreadable. The ticker heals it, but on a
// flat 30s cadence the heal lost the race twice on the 2026-07-27 boot. Pin the
// fast boot window so nobody "simplifies" it back to one interval.
test("the ~/.hermes re-share ticker polls fast through the boot window", () => {
  const sh = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "start.sh"), "utf8");
  const ticker = sh.slice(sh.indexOf("# 1b-seam. Board re-share ticker"));
  assert.ok(/if \[ "\$ticks" -lt 90 \]; then sleep 2; else sleep 30; fi/.test(ticker),
    "2s for ~3 minutes of boot, then the cheap 30s steady state");
  assert.ok(/ticks=\$\(\(\$\{ticks:-0\} \+ 1\)\)/.test(ticker),
    "the counter is what advances the cadence -- without it the branch never flips");
  assert.ok(/chmod 2770 "\$HOME\/\.hermes"/.test(ticker),
    "and it still re-asserts setgid + group rwx, which is the actual repair");
});
