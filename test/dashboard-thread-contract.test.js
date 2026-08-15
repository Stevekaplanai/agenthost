import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "dashboard");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const data = read("lib", "agenthost-data.ts");
const api = read("lib", "api.ts");
const live = read("lib", "live.ts");
const presenter = read("components", "agenthost", "thread-message.tsx");
const team = read("components", "agenthost", "thread-rail.tsx");
const workspace = read("components", "agenthost", "workspace-chat.tsx");
const commandCenter = read("components", "agenthost", "command-center.tsx");

test("the attached thread remains one canonical stream with typed presentation targets", () => {
  assert.match(api, /fetchThread\(\): Promise<\{ entries: ThreadEntry\[\] \}>/);
  assert.match(live, /const \{ data, error, observedAt, refetch \} = usePolled\(fetchThread, 5000\)/);
  assert.match(live, /usePolled\(fetchChatRuns, 3000\)/);
  assert.match(live, /const effectiveActiveRunId = activeRunId \?\? durableActiveRunId/);
  assert.match(data, /export function threadTargets\(e: ThreadEntry\)/);
  assert.match(data, /eventKind: "human" \| "agent" \| "relay" \| "cause"/);
  assert.match(data, /kind: "task"/);
  assert.match(data, /kind: "artifact"/);
  assert.match(data, /kind: "agent"/);
  assert.match(data, /kind: "cause"/);
  assert.match(data, /for \(const match of text\.matchAll\(TASK_ID_RE\)\) add\(\{ kind: "task", id: match\[1\] \}\)/);
  assert.match(data, /body: String\(e\.text \|\| ""\)/);
  assert.match(data, /const isRelay = Boolean\(agent\)/);
});

test("task target extraction only emits real t_-shaped board ids", () => {
  const literal = data.match(/const TASK_ID_RE = (\/[^/]+\/[a-z]+)/)?.[1];
  assert.ok(literal, "the source must keep one explicit task-id matcher");
  const matcher = Function(`return ${literal}`)();
  assert.equal(matcher.flags, "g");
  const ids = (text) => [...text.matchAll(matcher)].map((match) => match[1]);
  assert.deepEqual(ids("Task complete."), []);
  assert.deepEqual(ids("task done — merged to main"), []);
  assert.deepEqual(ids("Board task t_1 is queued."), ["t_1"]);
  assert.deepEqual(ids("Working on task 42 now."), []);
  assert.deepEqual(ids("t_done and task-t_9"), ["t_done", "t_9"]);
  assert.deepEqual(ids("T_ABC is not a canonical task id."), []);
});
test("full and compact thread surfaces share the same message presenter", () => {
  assert.match(presenter, /export function ThreadMessage/);
  assert.match(team, /import \{ ThreadMessage \} from "\.\/thread-message"/);
  assert.match(team, /<ThreadMessage[\s\S]*compact/);
  assert.match(workspace, /import \{ ThreadMessage \} from "\.\/thread-message"/);
  assert.match(workspace, /<ThreadMessage[\s\S]*onOpenTask=\{onOpenTask\}/);
  for (const prop of ["onOpenAgent", "onOpenTask", "onOpenCause"]) {
    assert.match(commandCenter, new RegExp(`function openThread${prop.slice(2)}|${prop}`));
    assert.match(presenter, new RegExp(prop));
  }
});

test("every attached-thread phone control has a 44px receiving target", () => {
  assert.match(team, /size-11[\s\S]*aria-label="Close team thread"/);
  assert.match(team, /min-h-11[\s\S]*Open full thread/);
  assert.match(team, /min-h-11 flex-1[\s\S]*\{item\}/);
  assert.match(team, /aria-label="Route this message to"[\s\S]*className="min-h-11/);
  assert.match(team, /className="grid size-11[\s\S]*aria-label="Send message"/);
});

test("thread links use canonical task and artifact routes", () => {
  assert.match(api, /export function taskDeepLinkUrl\(id: string\)/);
  assert.match(api, /return `\$\{BASE\}\/\?task=\$\{encodeURIComponent\(id\)\}`/,
    "task links must open the new shell at the canonical root");
  assert.doesNotMatch(api, /\/desk\?task=/,
    "task links must not create the retired desk entry path");
  assert.match(api, /export function artifactViewUrl\(name: string, contentVersion\?: string\): string/);
  assert.match(api, /const url = `\$\{BASE\}\/artifacts\/view\?p=\$\{encodeURIComponent\(name\)\}`/);
  assert.match(api, /if \(contentVersion === undefined\) return url/);
  assert.match(api, /return `\$\{url\}&v=\$\{contentVersion\}`/);
  assert.match(presenter, /href=\{taskDeepLinkUrl\(target\.id\)\}/);
  assert.match(presenter, /href=\{artifactViewUrl\(target\.name\)\}/);
});
