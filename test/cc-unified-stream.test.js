// Generated AgentHost Workspace integration guards.
//
// The handwritten Command Center is gone. These checks pin the equivalent live
// contracts in the one generated shell: board/thread composition, scoped
// terminal switching, phone navigation, honest engine capability copy, and
// uncacheable delivery.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const CONTAINER = path.join(ROOT, "container");
const gate = fs.readFileSync(path.join(CONTAINER, "gate.js"), "utf8");
const seam = fs.readFileSync(path.join(CONTAINER, "tmux-seam.sh"), "utf8");
const startSh = fs.readFileSync(path.join(CONTAINER, "start.sh"), "utf8");
const commandCenter = fs.readFileSync(path.join(ROOT, "dashboard", "components", "agenthost", "command-center.tsx"), "utf8");
const workView = fs.readFileSync(path.join(ROOT, "dashboard", "components", "agenthost", "work-view.tsx"), "utf8");
const agentsView = fs.readFileSync(path.join(ROOT, "dashboard", "components", "agenthost", "agents-view.tsx"), "utf8");
const agenthostData = fs.readFileSync(path.join(ROOT, "dashboard", "lib", "agenthost-data.ts"), "utf8");
const sidebar = fs.readFileSync(path.join(ROOT, "dashboard", "components", "agenthost", "sidebar.tsx"), "utf8");
const primitives = fs.readFileSync(path.join(ROOT, "dashboard", "components", "agenthost", "primitives.tsx"), "utf8");
const shell = fs.readFileSync(path.join(CONTAINER, "dashboard-ui", "index.html"), "utf8");

test("the generated workspace composes board, activity, and one attached thread", () => {
  assert.match(commandCenter, /const boardState = useBoard\(\)/);
  assert.match(commandCenter, /const audit = useAudit\(nav === "activity"\)/);
  assert.match(commandCenter, /const chat = useChat\(\)/);
  assert.match(commandCenter, /<ThreadRail[\s\S]*messages=\{chat\.messages\}/);
  assert.match(commandCenter, /<WorkView[\s\S]*board=\{boardState\.board\}/);
});

test("SECURITY: terminal switching remains select-only on both sides", () => {
  const switchStart = gate.indexOf("function handleSwitch");
  const send = gate.slice(switchStart, gate.indexOf("// ---- 2FA", switchStart));
  assert.match(send, /seamSend\(win === "claude" \? "ensure-claude" : "select " \+ win\)/,
    "the gate writes only ensure-claude or select <validated-name>");
  assert.match(send, /if \(!seamSend\([\s\S]*?res\.writeHead\(503/,
    "the gate must not claim a terminal switch when the tmux seam rejected it");
  assert.match(send, /Terminal switch failed:[^"`]*tmux seam/i,
    "the failed switch names the real seam cause");
  assert.match(send, /\^\[a-z0-9\]\[a-z0-9-\]\{0,31\}\$/, "the bounded window name is validated before it is written");
  assert.match(seam, /"ensure-claude"\)/);
  assert.match(seam, /select\\ \*\)/);
  assert.match(seam, /\*\) drop ;;/, "anything else is dropped, not executed");
  assert.doesNotMatch(seam.replace(/^\s*#.*$/gm, ""), /send-keys/);
  assert.match(workView, /method: "POST"/, "the generated UI uses the consequence-bearing switch route");
  assert.doesNotMatch(workView, /send-keys|run-shell|\/exec/);
});

for (const [id, label] of [["kimi", "Kimi"], ["cursor", "Cursor"]]) {
  test(`${label}'s terminal is reachable from generated UI to tmux`, () => {
    assert.match(startSh, new RegExp(`new-window -t agent -n ${id}`));
    assert.ok(gate.includes(`id: "${id}"`) && gate.includes(`href: "/?window=${id}"`) && gate.includes(`tmux: "${id}"`));
    assert.match(workView, /\.\.\.ROSTER\.map\(\(\{ id, name \}\) => \(\{ id, label: name \}\)\)/);
    assert.match(agenthostData, new RegExp(`\\{ id: "${id}", name: "${label}"`));
    assert.match(workView, /terminalSwitchPath\}\?window=\$\{encodeURIComponent\(next\)\}/);
  });
}

test("no engine capability is asserted by static copy", () => {
  const visible = [commandCenter, workView, agentsView].join("\n").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(visible, /No terminal window|chat-only engine/i);
  assert.match(agentsView, /agent\.statusDetail|profile\.capabilities/,
    "observed capability detail comes from live data rather than a handwritten engine panel");
});

test("the phone shell owns a visible bottom navigation and contained horizontal rails", () => {
  assert.match(sidebar, /fixed inset-x-0 bottom-0/);
  assert.match(sidebar, /env\(safe-area-inset-bottom\)/);
  assert.match(sidebar, /backdrop-blur-\[12px\]/);
  assert.match(primitives, /phone-scroll flex snap-x snap-mandatory/);
  assert.match(primitives, /overflow-x-auto/);
});

test("the surface is AgentHost Workspace, not the retired Command Center page", () => {
  assert.match(shell, /<title>AgentHost Workspace \| Your governed agent team<\/title>/);
  assert.match(shell, /aria-label="Primary navigation"/);
  assert.doesNotMatch(shell, /agenthost-(?:appshell|nav)\.js|\/apps\.json/);
});

test("the generated workspace shell is served uncacheable", () => {
  assert.match(gate, /const HTML_HEADERS = \{[\s\S]*?no-store[\s\S]*?\}/);
  assert.match(gate, /must-revalidate/);
  assert.match(gate, /const FRAMEABLE_HTML_HEADERS = \{[\s\S]*?\.\.\.HTML_HEADERS[\s\S]*?frame-ancestors 'self'[\s\S]*?\}/);
  assert.match(gate, /function serveDashboardDocument\(res\) \{[\s\S]*?res\.writeHead\(200, FRAMEABLE_HTML_HEADERS\)[\s\S]*?res\.end\(skinHtml\(DASHBOARD_INDEX\)\)/);
  const lines = gate.split("\n");
  const definition = lines.findIndex((line) => line.includes("const FRAMEABLE_HTML_HEADERS"));
  const use = lines.findIndex((line) => line.includes("res.writeHead(200, FRAMEABLE_HTML_HEADERS)"));
  assert.ok(definition >= 0 && definition < use, "headers are declared before their first use");
});
