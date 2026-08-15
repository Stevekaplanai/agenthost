// Cursor chat-tier integration. This locks the complete path from the pinned
// image package to a real gate chat turn, while proving Cursor never enters an
// unattended/autonomous execution set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, "..");
const CONTAINER = path.join(ROOT, "container");
const GATE = path.join(CONTAINER, "gate.js");
const dockerfile = fs.readFileSync(path.join(CONTAINER, "Dockerfile"), "utf8");
const startSh = fs.readFileSync(path.join(CONTAINER, "start.sh"), "utf8");
const cursorTerminal = fs.readFileSync(path.join(CONTAINER, "cursor-terminal.sh"), "utf8");
const gateSrc = fs.readFileSync(GATE, "utf8");
const dashboardChat = fs.readFileSync(path.join(ROOT, "dashboard", "components", "agenthost", "workspace-chat.tsx"), "utf8");
const dashboardAgents = fs.readFileSync(path.join(ROOT, "dashboard", "components", "agenthost", "agents-view.tsx"), "utf8");
const dashboardDialogs = fs.readFileSync(path.join(ROOT, "dashboard", "components", "agenthost", "dialogs.tsx"), "utf8");
const dashboardSettings = fs.readFileSync(path.join(ROOT, "dashboard", "components", "agenthost", "settings.tsx"), "utf8");
const dashboardWork = fs.readFileSync(path.join(ROOT, "dashboard", "components", "agenthost", "work-view.tsx"), "utf8");
const dashboardData = fs.readFileSync(path.join(ROOT, "dashboard", "lib", "agenthost-data.ts"), "utf8");
const settingsLib = fs.readFileSync(path.join(CONTAINER, "settings-lib.js"), "utf8");
const profiles = fs.readFileSync(path.join(CONTAINER, "maintenance-chat-profiles.js"), "utf8");
const kanbanBridge = fs.readFileSync(path.join(CONTAINER, "kanban-bridge.js"), "utf8");
const boardEvents = fs.readFileSync(path.join(CONTAINER, "board-events-lib.js"), "utf8");
const chains = fs.readFileSync(path.join(CONTAINER, "chains-lib.js"), "utf8");
const charter = fs.readFileSync(path.join(CONTAINER, "team-charter.md"), "utf8");
const boardOverlay = fs.readFileSync(path.join(ROOT, "control-plane", "overlay", "web", "src", "lib", "agenthostBoard.ts"), "utf8");
const gateLib = require("../container/gate.js");

test("Cursor package is pinned, checksum-verified, system-wide, and build-tested", () => {
  assert.match(dockerfile,
    /https:\/\/downloads\.cursor\.com\/lab\/2026\.07\.23-e383d2b\/linux\/x64\/agent-cli-package\.tar\.gz/,
    "the image downloads one reviewed Cursor Agent build");
  assert.match(dockerfile,
    /702ad595213bee5df0268be9f80a19f29fcceaa2a42fc55e39f2b5199051f0c4\s+\/tmp\/cursor-agent\.tar\.gz/,
    "the official archive is locked to its verified SHA-256");
  assert.match(dockerfile, /\/usr\/local\/bin\/cursor-agent/,
    "the agent user gets a system-wide Cursor binary, not root's ~/.local install");
  assert.match(dockerfile, /\/usr\/local\/bin\/cursor-agent --disable-auto-update --version/,
    "the image build executes the installed binary without enabling its updater");
  assert.match(dockerfile, /COPY cursor-terminal\.sh \/opt\/agenthost\/cursor-terminal\.sh/);
  assert.match(dockerfile, /chmod \+x [^\n]*\/opt\/agenthost\/cursor-terminal\.sh/,
    "the exact-secret terminal launcher is executable in the image");
  assert.doesNotMatch(dockerfile, /curl[^|\n]*cursor\.com\/install[^|\n]*\|\s*(?:ba)?sh/,
    "the image never pipes Cursor's moving installer into a shell");
});

test("Cursor has a human terminal window but no dedicated writable workspace", () => {
  const start = startSh.indexOf("#     Cursor (Anysphere)");
  const end = startSh.indexOf("# service_enabled", start);
  const block = startSh.slice(start, end);
  assert.ok(start >= 0 && end > start, "start.sh has a dedicated Cursor block");
  assert.match(block, /\[ -x \/usr\/local\/bin\/cursor-agent \]/);
  assert.match(block, /new-window -t agent -n cursor -c "\$HOME"/,
    "Cursor opens outside the shared repo and without a new worktree");
  assert.match(block, /\/usr\/bin\/env -i HOME=\/data\/home\/agent PATH=\/usr\/local\/bin:\/usr\/bin:\/bin TERM=screen USER=agent LOGNAME=agent SHELL=\/bin\/bash[\s\S]*?\/opt\/agenthost\/cursor-terminal\.sh/,
    "tmux crosses a clean exec boundary before the long-lived Cursor wrapper");
  assert.match(block, /\/opt\/agenthost\/cursor-terminal\.sh/,
    "the interactive window delegates to the fixed exact-secret launcher");
  assert.doesNotMatch(block, /secrets\.env|set -a|source|\.\s+"/,
    "start.sh never evaluates the secret file");
  assert.match(cursorTerminal, /while IFS='=' read -r name value/);
  assert.match(cursorTerminal, /AGENTHOST_BOX_SECRETS_FILE:-\/data\/agenthost-secrets\/secrets\.env/,
    "the launcher reads the protected production store, with a hermetic test override");
  assert.match(cursorTerminal, /\[ "\$name" = "CURSOR_API_KEY" \]/,
    "the launcher reads only Cursor's named credential as data");
  assert.match(cursorTerminal, /export CURSOR_API_KEY="\$cursor_key"/,
    "the key enters the child environment through a shell builtin, never argv");
  assert.match(cursorTerminal, /\/usr\/local\/bin\/cursor-agent --disable-auto-update --trust --mode ask/,
    "the interactive binary trusts only its fixed home workspace and stays outside writable Agent mode");
  assert.doesNotMatch(cursorTerminal, /cursor_env|CURSOR_API_KEY=.*cursor-agent/,
    "no external environment helper can expose the key in process arguments");
  assert.doesNotMatch(cursorTerminal, /(?:^|\s)(?:source|\.)\s+.*secrets\.env|eval/,
    "the launcher never sources or evaluates a secret value");
  assert.doesNotMatch(block, /workspaces\/cursor|--force|--yolo|--background|--worktree/,
    "the terminal block adds no workspace or unattended/write flags");
});

test("Cursor terminal treats its exact key as data and strips every other secret", {
  skip: process.platform === "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(import.meta.dirname, ".cursor-terminal-"));
  try {
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const marker = path.join(root, "secret-was-executed");
    const loaderMarker = path.join(root, "loader-was-executed");
    const loader = path.join(root, "loader.sh");
    const secretsFile = path.join(root, "protected", "secrets.env");
    fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
    fs.mkdirSync(bin);
    const literalKey = `$(touch ${marker})=literal`;
    fs.writeFileSync(secretsFile, [
      "GITHUB_TOKEN=must-not-reach-cursor",
      "NODE_OPTIONS=must-not-reach-cursor",
      "BASH_ENV=must-not-reach-cursor",
      `CURSOR_API_KEY=${literalKey}`,
      "",
    ].join("\n"));
    fs.writeFileSync(loader, `touch '${loaderMarker}'\n`);
    const fake = path.join(bin, "cursor-agent");
    fs.writeFileSync(fake, [
      "#!/bin/sh",
      'printf "ARGS=%s\\n" "$*"',
      'printf "PARENT_ENV_START\\n"',
      "/usr/bin/tr '\\0' '\\n' < /proc/$PPID/environ",
      'printf "PARENT_ENV_END\\n"',
      "/usr/bin/env",
      "exit 0",
      "",
    ].join("\n"));
    fs.chmodSync(fake, 0o755);
    const launcher = path.join(root, "cursor-terminal.sh");
    fs.writeFileSync(launcher,
      cursorTerminal.replaceAll("/usr/local/bin/cursor-agent", fake.replaceAll("\\", "/")));
    fs.chmodSync(launcher, 0o755);

    const result = spawnSync("timeout", [
      "1s",
      "/usr/bin/env", "-i",
      `HOME=${home}`,
      `AGENTHOST_BOX_SECRETS_FILE=${secretsFile}`,
      `PATH=${bin}:/usr/bin:/bin`,
      "TERM=screen",
      "USER=agent",
      "LOGNAME=agent",
      "SHELL=/bin/bash",
      launcher,
    ], {
      env: {
        PATH: "/usr/bin:/bin",
        OTHER_FLY_SECRET: "must-not-reach-cursor",
        GITHUB_TOKEN: "must-not-reach-cursor",
        NODE_OPTIONS: "must-not-reach-cursor",
        BASH_ENV: loader,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 124, "the harness timeout stops the terminal's intentional restart loop");
    assert.match(result.stdout, /ARGS=--disable-auto-update --trust --mode ask/);
    assert.match(result.stdout, new RegExp(`CURSOR_API_KEY=${literalKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      "the exact stored key reaches Cursor literally");
    const parentEnv = result.stdout.match(/PARENT_ENV_START\n([\s\S]*?)PARENT_ENV_END\n/);
    assert.ok(parentEnv, "the fake Cursor can inspect its long-lived wrapper's initial environment");
    assert.doesNotMatch(parentEnv[1], /CURSOR_API_KEY|GITHUB_TOKEN|NODE_OPTIONS|BASH_ENV|OTHER_FLY_SECRET/,
      "the wrapper's /proc environment contains no credential or inherited Fly secret");
    assert.doesNotMatch(result.stdout, /GITHUB_TOKEN|NODE_OPTIONS|BASH_ENV|OTHER_FLY_SECRET/,
      "no unrelated box or loader variable reaches Cursor");
    assert.equal(fs.existsSync(marker), false, "shell metacharacters in the key were never executed");
    assert.equal(fs.existsSync(loaderMarker), false,
      "the clean exec boundary strips BASH_ENV before the wrapper's Bash starts");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor is routed through fixed ask-mode chat and never through autonomous execution", () => {
  const registry = gateSrc.slice(gateSrc.indexOf("const ENGINES = {"), gateSrc.indexOf("for (const id of TEAM_ORDER)"));
  const cursorStart = registry.indexOf("\n  cursor: {");
  const cursor = registry.slice(cursorStart, registry.indexOf("\n  // ---- Kimi", cursorStart));
  assert.match(cursor, /bin:\s*"\/usr\/local\/bin\/cursor-agent"/);
  assert.match(cursor, /const flags = \["--disable-auto-update",\s*"--trust",\s*"-p",\s*"--output-format",\s*"json",\s*"--mode",\s*"ask"\];[\s\S]*return \[\.\.\.flags, "--", withCharter/,
    "the gate pre-trusts its fixed home workspace while retaining read-only Q&A mode and the argv boundary");
  for (const forbidden of ["--api-key", "--force", "--yolo", "--background", "autoArgs", "autoEnv", "autoJail"]) {
    assert.ok(!cursor.includes(forbidden), "Cursor chat entry must not contain " + forbidden);
  }
  assert.equal((gateSrc.match(/env:\s*engineChatEnv\(/g) || []).length, 2,
    "direct chat and the single sequential team-chat spawn must apply Cursor's exact environment boundary");

  assert.match(profiles, /cursor:\s*\{[\s\S]*?bin:\s*"\/usr\/local\/bin\/cursor-agent"/);
  assert.match(profiles, /credentialNames:\s*\["CURSOR_API_KEY"\]/,
    "Foundation B reads only the named Cursor credential");
  assert.match(profiles, /envAllowlist:\s*\[\.\.\.COMMON_ALLOW,\s*"CURSOR_API_KEY"\]/);
  assert.match(profiles, /"--",\s*PROMPT_C/,
    "the root profile keeps the prompt behind an argv terminator");

  const execSet = gateSrc.match(/const AUTONOMOUS_EXEC_ENGINES = new Set\(\[([^\]]*)\]\)/);
  const reviewSet = gateSrc.match(/const REVIEW_ENGINES = new Set\(\[([^\]]*)\]\)/);
  const multiSet = gateSrc.match(/const MULTI_SHOWN_ENGINES = \[([^\]]*)\]/);
  assert.ok(execSet && !execSet[1].includes("cursor"), "Cursor has no unattended executor");
  assert.ok(reviewSet && !reviewSet[1].includes("cursor"), "Cursor has no autonomous reviewer role");
  assert.ok(multiSet && !multiSet[1].includes("cursor"), "Cursor is absent from unattended multi-loops");
  assert.match(gateSrc, /if \([^\n]*engId === "cursor"[^\n]*\)[\s\S]{0,800}?wake_skip/,
    "the unattended boot wake pass explicitly skips Cursor");
});

test("Cursor is a first-class human-directed chat, roster, terminal, and board target", () => {
  assert.deepEqual([...gateLib.TEAM_ORDER],
    ["claude", "codex", "deepseek", "kimi", "gemini", "hermes", "cursor"]);
  const cursorApp = gateLib.APPS.find((app) => app.id === "cursor");
  assert.deepEqual(cursorApp && { href: cursorApp.href, tmux: cursorApp.tmux, nav: cursorApp.nav },
    { href: "/?window=cursor", tmux: "cursor", nav: false });

  const roster = dashboardData.slice(dashboardData.indexOf("export const ROSTER"), dashboardData.indexOf("export const AGENT_IDS"));
  assert.match(roster, /\{ id: "cursor", name: "Cursor"/,
    "the generated shell's seven-engine roster includes Cursor");
  assert.match(dashboardChat, /\.\.\.roster\.map\(\(a\) => \(\{ id: a\.id as string, label: a\.name \}\)\)/,
    "the Workspace engine selector is driven by that live roster");
  assert.match(dashboardChat, /return AGENT_IDS\.has\(name\) \? name : fallback/,
    "a leading @cursor is accepted through the same seven-engine allowlist");
  assert.match(dashboardAgents, /\{roster\.map\(\(rosterAgent\) => \(/,
    "the generated Agents room renders Cursor from the observed roster");
  assert.match(dashboardWork, /\.\.\.ROSTER\.map\(\(\{ id, name \}\) => \(\{ id, label: name \}\)\)/,
    "the Work terminal selector exposes every exact roster tmux window, including Cursor");
  assert.match(dashboardSettings, /"llm\.roster\.cursor\.active", "llm\.roster\.cursor\.inChat"/,
    "generated Settings controls Cursor's work and chat participation");
  assert.match(settingsLib, /cursor:\s*\{\s*active:\s*true,\s*inChat:\s*true\s*\}/);
  const inventoryMeta = gateSrc.slice(gateSrc.indexOf("const INVENTORY_AGENT_META"), gateSrc.indexOf("const INVENTORY_TOOL_DESCRIPTIONS"));
  assert.match(inventoryMeta, /cursor:\s*\{[\s\S]*?label:\s*"Cursor",\s*bin:\s*"cursor-agent"/,
    "server inventory describes the actual Cursor binary");
  assert.match(charter, /Cursor[\s\S]*?chat-only/,
    "the standing team charter names Cursor and its current boundary");

  assert.match(gateSrc, /\^\(claude\|codex\|deepseek\|kimi\|gemini\|hermes\|cursor\)\$/,
    "the server review route accepts Cursor");
  assert.match(kanbanBridge, /new Set\(\[[^\]]*"cursor"[^\]]*\]\)/,
    "the kanban bridge accepts Cursor");
  const roomEngines = kanbanBridge.match(/const ROOM_LIFECYCLE_ENGINES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(roomEngines && !roomEngines[1].includes("cursor"),
    "human board assignment never admits Cursor to external Agent Room lifecycle");
  assert.match(boardEvents, /new Set\(\[[^\]]*"cursor"[^\]]*\]\)/,
    "board event attribution accepts Cursor");
  assert.match(boardOverlay, /BOARD_AGENTS = \[[^\]]*"cursor"[^\]]*\]/,
    "the desktop control-plane board offers Cursor");
  const assignControls = dashboardDialogs.slice(
    dashboardDialogs.indexOf('{expanded === "assign"'),
    dashboardDialogs.indexOf('{expanded === "approve"'),
  );
  assert.match(assignControls, /\{ROSTER\.map\(\(a\) => \(/,
    "the generated task dialog offers every roster engine, including Cursor, as a reassign target");
  assert.match(assignControls, /onClick=\{\(\) => setAssignTarget\(a\.id\)\}/,
    "selecting a roster engine records the exact reassign target");
  assert.match(assignControls, /assignTarget && \([\s\S]*runVerb\("assign", \{ engine: assignTarget \}\)/,
    "the selected engine reaches the real assign verb only after confirmation");
});

test("autonomous HANDOFF grammar deliberately still excludes Cursor", () => {
  const chainHandoff = chains.match(/const HANDOFF_RE = ([^\n]+)/);
  const gateHandoff = gateSrc.match(/const HANDOFF_RE = ([^\n]+)/);
  assert.ok(chainHandoff && !chainHandoff[1].includes("cursor"),
    "chains-lib cannot create an autonomous Cursor child");
  assert.ok(gateHandoff && !gateHandoff[1].includes("cursor"),
    "gate's duplicate autonomous parser stays equally closed");
  assert.match(gateSrc, /HANDOFF: <claude\|codex\|deepseek\|kimi\|gemini\|hermes>/,
    "the autonomous prompt never tells an engine Cursor is an executable target");
  assert.doesNotMatch(chains, /HANDOFF:\\s\*\(claude\|hermes\|codex\|cursor\)/);
});

function sseEvents(text) {
  return text.split("\n\n").map((block) => {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    return { event, data };
  }).filter((entry) => entry.data !== "");
}

test("real gate sends one Cursor ask-mode prompt and parses Cursor's JSON result shape", async () => {
  const root = fs.mkdtempSync(path.join(import.meta.dirname, ".cursor-gate-"));
  const home = path.join(root, "home");
  const fixtureContainer = path.join(root, "container");
  let gate;
  try {
    fs.mkdirSync(path.join(home, "work"), { recursive: true });
    fs.mkdirSync(path.join(home, ".agenthost"), { recursive: true });
    fs.writeFileSync(path.join(home, ".agenthost", "secrets.env"), [
      "CURSOR_API_KEY=cursor-test-key-not-real",
      "GITHUB_TOKEN=cursor-must-not-see-this",
      "ANTHROPIC_API_KEY=cursor-must-not-see-this",
      "NODE_OPTIONS=cursor-must-not-see-this",
      "BASH_ENV=cursor-must-not-see-this",
      "",
    ].join("\n"));
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "cursor-agent"), "");
    fs.cpSync(CONTAINER, fixtureContainer, { recursive: true });
    fs.writeFileSync(path.join(fixtureContainer, "team-charter.md"),
      "# Test charter\n\nCursor chat is human-triggered Ask mode only.\n");
    const fake = path.join(root, "fake-cursor.mjs");
    fs.writeFileSync(fake, [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const all = process.argv.slice(2);',
      'const bin = String(all[0] || "");',
      'const argv = all.slice(1);',
      'const boundary = argv.lastIndexOf("--");',
      'const prompt = boundary >= 0 ? argv[boundary + 1] : "";',
      'fs.writeFileSync(path.join(process.env.HOME, "cursor-spawn.json"), JSON.stringify({',
      '  bin, argv, promptCount: argv.filter((arg) => arg === prompt).length,',
      '  keyPresent: Boolean(process.env.CURSOR_API_KEY),',
      '  forbiddenEnv: ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "NODE_OPTIONS", "BASH_ENV", "OTHER_FLY_SECRET"].filter((name) => Object.prototype.hasOwnProperty.call(process.env, name)),',
      '}));',
      'process.stdout.write(JSON.stringify({',
      '  type: "result", subtype: "success", is_error: false,',
      '  result: "Cursor real-shape reply", session_id: "cursor-test-session",',
      '}) + "\\n");',
      "",
    ].join("\n"));

    gate = spawn("node", [path.join(fixtureContainer, "gate.js")], {
      env: {
        ...process.env,
        HOME: home,
        AGENTHOST_BOX_SECRETS_FILE: path.join(home, ".agenthost", "secrets.env"),
        TTYD_PASSWORD: "cursor-gate-key",
        OTHER_FLY_SECRET: "cursor-must-not-see-this",
        AGENTHOST_DEV_WRAP: fake,
        PATH: binDir + path.delimiter + process.env.PATH,
        WAKE_CHECKIN: "off",
        GATE_PORT: "0",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const port = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("gate did not report a port; got: " + out)), 5000);
      gate.stdout.on("data", (chunk) => {
        out += chunk.toString();
        const match = out.match(/listening on (\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      gate.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("gate exited before listening; got: " + out));
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const { cookie } = await mintOperatorSession(base, "cursor-gate-key");

    const profilesResponse = await fetch(`${base}/profiles/data`, { headers: { cookie } });
    assert.equal(profilesResponse.status, 200);
    const profileData = await profilesResponse.json();
    const cursorProfile = profileData.agents.find((agent) => agent.id === "cursor");
    assert.ok(cursorProfile, "the live control-plane profile endpoint includes Cursor");
    assert.equal(cursorProfile.capabilities.chat.state, "available");
    assert.equal(cursorProfile.capabilities.unattended.state, "unavailable");

    const response = await fetch(`${base}/chat/stream?engine=cursor&msg=${encodeURIComponent("--force is prompt text")}`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const events = sseEvents(await response.text());
    const reply = events.filter((entry) => entry.event === "message")
      .map((entry) => JSON.parse(entry.data)).join("");
    assert.equal(reply, "Cursor real-shape reply", "the browser receives only result text, never raw JSON");
    const done = events.find((entry) => entry.event === "done");
    assert.equal(JSON.parse(done.data).engine, "cursor");

    const spawnRecord = JSON.parse(fs.readFileSync(path.join(home, "cursor-spawn.json"), "utf8"));
    assert.equal(spawnRecord.bin, "/usr/local/bin/cursor-agent");
    assert.equal(spawnRecord.keyPresent, true, "the API key reaches Cursor only through its environment");
    assert.deepEqual(spawnRecord.forbiddenEnv, [],
      "default chat strips every unrelated box and loader secret before spawning Cursor");
    assert.equal(spawnRecord.promptCount, 1, "the full chartered prompt is one argv element");
    assert.ok(spawnRecord.argv.includes("--mode") && spawnRecord.argv.includes("ask"));
    assert.ok(spawnRecord.argv.includes("--trust"),
      "one-shot chat bypasses only Cursor's workspace trust prompt");
    assert.ok(spawnRecord.argv.includes("--disable-auto-update"),
      "runtime updates cannot replace the checksum-pinned binary");
    assert.ok(spawnRecord.argv.includes("--"), "an argv boundary precedes the prompt");
    for (const forbidden of ["--api-key", "--force", "--yolo", "--background", "--worktree"]) {
      assert.equal(spawnRecord.argv.includes(forbidden), false, forbidden + " is never an engine flag");
    }
    assert.equal(spawnRecord.argv.includes("cursor-test-key-not-real"), false,
      "the key is absent from process arguments");

    fs.writeFileSync(path.join(home, ".agenthost", "settings.json"),
      JSON.stringify({ llm: { roster: { cursor: { inChat: false } } } }));
    const offProfilesResponse = await fetch(`${base}/profiles/data`, { headers: { cookie } });
    const offProfiles = await offProfilesResponse.json();
    const offCursor = offProfiles.agents.find((agent) => agent.id === "cursor");
    assert.equal(offCursor.capabilities.chat.state, "unavailable");
    assert.equal(offCursor.capabilities.chat.reasonCode, "DISABLED",
      "the control plane honors the same inChat switch as the chat route");
    const ccStateResponse = await fetch(`${base}/cc/state?tz=0`, { headers: { cookie } });
    const ccState = await ccStateResponse.json();
    assert.equal(ccState.engines.cursor.state, "not_configured");
    assert.match(ccState.engines.cursor.summary, /Settings/i,
      "Cursor is never advertised as Chat ready while inChat is off");
    const blockedResponse = await fetch(`${base}/chat/stream?engine=cursor&msg=plain`, {
      headers: { cookie },
    });
    const blockedEvents = sseEvents(await blockedResponse.text());
    const blockedDone = blockedEvents.find((entry) => entry.event === "done");
    assert.match(JSON.parse(blockedDone.data).error, /turned off in chat settings/i);
  } finally {
    if (gate) await stopChild(gate, "SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
